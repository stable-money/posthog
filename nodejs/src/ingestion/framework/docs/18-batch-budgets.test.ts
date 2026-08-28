/**
 * # Chapter 18: Batch Time Budgets
 *
 * Steps have no time limits of their own. Without a budget, a batch that hits
 * a slow spot runs as long as it runs, and time is enforced by the caller
 * giving up: the caller re-routes the work to another worker while this one
 * keeps processing the same messages. That is duplicate downstream work plus
 * contention exactly where the pipeline was already slow.
 *
 * A budget inverts that. Each fed batch carries a time allowance, and the
 * framework stops starting work once the allowance runs out.
 *
 * ## The budget object
 *
 * `BatchBudget` carries one absolute deadline and one flag:
 *
 * - **soft** (`softAt`, `remainingMs`, `exhausted`, `signal`): the deadline
 *   the checkpoints read. Past it the framework stops starting work; work
 *   already running finishes. It is called soft because it never interrupts
 *   anything — a step that hangs forever is the consumer's ack watchdog to
 *   catch, and that watchdog is the only hard limit in the system.
 * - **`enforce`**: false puts the budget in shadow mode, where every
 *   checkpoint records its metric and changes no result.
 *
 * `BatchBudget.unlimited()` is the neutral element: its signal never fires and
 * its remaining time is `Infinity`, so every checkpoint is a no-op. Because it
 * exists there is no "no budget" state, and no optional-budget branch anywhere
 * in the framework.
 *
 * ## Where the budget comes from
 *
 * `BatchingPipeline` takes a required `budgetFactory` option. It mints one
 * budget per `feed()` from the feed context and stamps it on every element's
 * context, next to the messageId. Pipelines with no time policy pass
 * `unlimitedBudgetFactory`.
 *
 * ```ts
 * newBatchingPipeline(beforeBatch, sub, afterBatch, { budgetFactory: unlimitedBudgetFactory })
 * ```
 *
 * ## The checkpoints
 *
 * Cancellation is cooperative. JavaScript cannot preempt a running `await`, so
 * the framework never kills work; it stops dispatching it at two
 * framework-owned checkpoints. Steps see nothing of the budget, and no
 * existing step changes:
 *
 * 1. **Before each element step** (`StepPipeline`). An exhausted element
 *    returns `timeout('budget exceeded before <step>')`, and the rest of its
 *    chain skips through the existing non-OK short-circuit.
 * 2. **Before a chunk step** (`applyChunkStepToResults`). One chunk can hold
 *    elements from batches with different budgets, so the decision is per
 *    element: exhausted elements become timeouts and pass through, the step
 *    runs on the remainder.
 *
 * Granularity is therefore one step. A step that runs long past the deadline
 * is not interrupted, and the retry wrappers keep retrying to their configured
 * limit, so the overrun a batch can accumulate is bounded by its slowest step
 * rather than by the deadline. `ingestion_batch_budget_overrun_seconds`
 * measures that tail.
 *
 * ## The results a budget produces
 *
 * `TIMEOUT` and `REJECTED` are the **unacked** results: the message is not
 * acked, so its source redelivers it and the whole chain runs again from the
 * top. They split by who stopped the work. `TIMEOUT` is the element's own
 * budget cutting it off. `REJECTED` is an element that was never attempted
 * because processing it would reorder its routing key. Result handling counts
 * both and produces nothing for them, because the redelivery produces it.
 *
 * The count invariant is untouched: N messages in, N results out, and
 * `afterBatch` still runs, committing the writes of the events that did
 * finish. Within one batch, budget exhaustion is monotone, so a routing key's
 * completed events are always a prefix of its feed order.
 */
import { BatchBudget, unlimitedBudgetFactory } from '~/ingestion/framework/batch-budget'
import { newBatchingPipeline, newChunkPipelineBuilder, newPipelineBuilder } from '~/ingestion/framework/builders'
import { createOkContext } from '~/ingestion/framework/helpers'
import { PipelineResult, isOkResult, isTimeoutResult, ok } from '~/ingestion/framework/results'

interface Event {
    key: string
    seq: number
}

type BudgetCtx = { budget?: BatchBudget }
type NoCtx = Record<string, never>

/** Reads the result kinds in feed order, which is how a batch's elements come back. */
function resultKinds<T>(results: { result: PipelineResult<T> }[]): string[] {
    return results.map((element) => {
        if (isOkResult(element.result)) {
            return 'ok'
        }
        return isTimeoutResult(element.result) ? 'timeout' : 'other'
    })
}

describe('Batch Time Budgets', () => {
    /**
     * The element checkpoint. A step that outlasts the batch's allowance does
     * not get cancelled, but the next step never starts: the element completes
     * as a timeout naming the step it was cut off before, and every later step
     * skips on its own.
     */
    it('stops the chain at the next step once the budget is exhausted', async () => {
        const budget = BatchBudget.softDeadline(Date.now() + 1000)
        const ran: string[] = []

        function slowStep(event: Event) {
            ran.push('slowStep')
            // Stands in for the step taking longer than the batch had left.
            budget.abort('soft deadline')
            return Promise.resolve(ok(event))
        }
        function emitStep(event: Event) {
            ran.push('emitStep')
            return Promise.resolve(ok(event))
        }

        const pipeline = newPipelineBuilder<Event, BudgetCtx>().pipe(slowStep).pipe(emitStep).build()
        const result = await pipeline.process(createOkContext<Event, BudgetCtx>({ key: 'a', seq: 1 }, { budget }))

        expect(ran).toEqual(['slowStep'])
        expect(isTimeoutResult(result.result)).toBe(true)
        expect((result.result as { reason: string }).reason).toBe('budget exceeded before emitStep')
    })

    /**
     * The chunk checkpoint. A chunk can hold elements from several fed batches,
     * each with its own budget, so the step still runs for the elements that
     * have time left.
     */
    it('runs a chunk step on the elements that still have time', async () => {
        const spent = BatchBudget.softDeadline(Date.now() - 1)
        const fresh = BatchBudget.softDeadline(Date.now() + 5000)
        let seen: Event[] = []

        function writeChunk(events: Event[]) {
            seen = events
            return Promise.resolve(events.map((event) => ok(event)))
        }

        const pipeline = newChunkPipelineBuilder<Event, BudgetCtx>().pipeChunk(writeChunk).build()
        pipeline.feed([
            createOkContext<Event, BudgetCtx>({ key: 'a', seq: 1 }, { budget: spent }),
            createOkContext<Event, BudgetCtx>({ key: 'b', seq: 1 }, { budget: fresh }),
        ])
        const results = await pipeline.next()

        expect(seen).toEqual([{ key: 'b', seq: 1 }])
        expect(resultKinds(results!)).toEqual(['timeout', 'ok'])
    })

    /**
     * Shadow mode. A budget with `enforce: false` runs every checkpoint and
     * changes no result, so budgets can run in production and be measured
     * before the first event is ever cancelled.
     */
    it('changes no result in shadow mode', async () => {
        const budget = BatchBudget.softDeadline(Date.now() - 1, { enforce: false })
        const ran: string[] = []

        function firstStep(event: Event) {
            ran.push('firstStep')
            return Promise.resolve(ok(event))
        }
        function secondStep(event: Event) {
            ran.push('secondStep')
            return Promise.resolve(ok(event))
        }

        const pipeline = newPipelineBuilder<Event, BudgetCtx>().pipe(firstStep).pipe(secondStep).build()
        const result = await pipeline.process(createOkContext<Event, BudgetCtx>({ key: 'a', seq: 1 }, { budget }))

        expect(ran).toEqual(['firstStep', 'secondStep'])
        expect(isOkResult(result.result)).toBe(true)
    })

    /**
     * The count invariant under expiry. A budget that is already spent when the
     * batch is fed cancels every element, and the batch still returns one
     * result per message and still runs its afterBatch hook — which is what
     * commits the writes of the events that did finish.
     */
    it('returns one result per message and still runs afterBatch when everything times out', async () => {
        let flushedElements = 0

        const pipeline = newBatchingPipeline<Event, Event, NoCtx>(
            (builder) =>
                builder.pipe(function passThroughBefore(input) {
                    return Promise.resolve(ok({ elements: input.elements, batchContext: input.batchContext }))
                }),
            (builder) =>
                builder.sequentially((steps) =>
                    steps.pipe(function emitStep(event: Event) {
                        return Promise.resolve(ok(event))
                    })
                ),
            (builder) =>
                builder.pipe(function flushBatch(input) {
                    flushedElements = input.elements.length
                    return Promise.resolve(ok(input))
                }),
            { budgetFactory: () => BatchBudget.softDeadline(Date.now() - 1), concurrentBatches: 1 }
        )

        await pipeline.feed(
            [
                { key: 'a', seq: 1 },
                { key: 'a', seq: 2 },
                { key: 'b', seq: 1 },
            ].map((event) => createOkContext<Event, NoCtx>(event, {})),
            {}
        )
        const batch = await pipeline.next()

        expect(batch!.elements).toHaveLength(3)
        expect(resultKinds(batch!.elements)).toEqual(['timeout', 'timeout', 'timeout'])
        expect(flushedElements).toBe(3)
    })

    /**
     * The prefix property. Within one batch the budget expires once and never
     * comes back, so a routing key's completed events are always a prefix of
     * its feed order. That is what makes redelivering the remainder safe: the
     * redelivery resumes where the batch stopped, with no gap in the middle.
     */
    it('completes a prefix of each key’s feed order', async () => {
        const budget = BatchBudget.softDeadline(Date.now() + 1000)
        const processed: number[] = []

        function processStep(event: Event) {
            processed.push(event.seq)
            if (processed.length === 2) {
                // Stands in for the second event exhausting the batch's time.
                budget.abort('soft deadline')
            }
            return Promise.resolve(ok(event))
        }

        const pipeline = newBatchingPipeline<Event, Event, NoCtx>(
            (builder) =>
                builder.pipe(function passThroughBefore(input) {
                    return Promise.resolve(ok({ elements: input.elements, batchContext: input.batchContext }))
                }),
            (builder) =>
                builder.concurrentlyPerGroup(
                    (event: Event) => event.key,
                    (group) => group.sequentially((steps) => steps.pipe(processStep))
                ),
            (builder) =>
                builder.pipe(function passThroughAfter(input) {
                    return Promise.resolve(ok(input))
                }),
            { budgetFactory: () => budget, concurrentBatches: 1 }
        )

        await pipeline.feed(
            [1, 2, 3, 4].map((seq) => createOkContext<Event, NoCtx>({ key: 'a', seq }, {})),
            {}
        )
        const batch = await pipeline.next()

        expect(processed).toEqual([1, 2])
        expect(resultKinds(batch!.elements)).toEqual(['ok', 'ok', 'timeout', 'timeout'])
    })

    /**
     * The neutral element. A pipeline with no time policy passes
     * `unlimitedBudgetFactory`, and nothing about its behavior changes.
     */
    it('never cancels anything under the unlimited budget', async () => {
        const pipeline = newBatchingPipeline<Event, Event, NoCtx>(
            (builder) =>
                builder.pipe(function passThroughBefore(input) {
                    return Promise.resolve(ok({ elements: input.elements, batchContext: input.batchContext }))
                }),
            (builder) =>
                builder.sequentially((steps) =>
                    steps.pipe(function emitStep(event: Event) {
                        return Promise.resolve(ok(event))
                    })
                ),
            (builder) =>
                builder.pipe(function passThroughAfter(input) {
                    return Promise.resolve(ok(input))
                }),
            { budgetFactory: unlimitedBudgetFactory, concurrentBatches: 1 }
        )

        await pipeline.feed(
            [{ key: 'a', seq: 1 }].map((event) => createOkContext<Event, NoCtx>(event, {})),
            {}
        )
        const batch = await pipeline.next()

        expect(resultKinds(batch!.elements)).toEqual(['ok'])
    })
})
