import { PromiseScheduler } from '~/common/utils/promise-scheduler'
import { PipelineResult, drop, ok, rejected, timeout } from '~/ingestion/framework/results'

import { GrpcIngestPipeline, GrpcStreamIngestDriver, createWireBudgetFactory } from './grpc-stream-ingest-driver'

/** A completed batch carrying one result per message, in feed order. */
function completedBatch(results: PipelineResult<unknown>[]): GrpcIngestPipeline {
    return {
        next: () =>
            Promise.resolve({
                elements: results.map((result) => ({ result, context: {} })),
                batchContext: { grpcStreamId: 7, grpcSeq: 3 },
                sideEffects: [],
            }),
    } as unknown as GrpcIngestPipeline
}

describe('GrpcStreamIngestDriver dispositions', () => {
    it('reports each unacked element by its feed position and counts the rest accepted', async () => {
        // The consumer redelivers exactly what these lists name, so a mix-up
        // between the two — or an accepted count that includes them — either
        // loses messages or resends acked ones.
        const driver = new GrpcStreamIngestDriver(
            completedBatch([
                ok({}),
                timeout('budget exceeded before step'),
                drop('not interesting'),
                rejected('key is waiting for redelivery'),
            ]),
            new PromiseScheduler()
        )

        const completed = (await driver.next())!

        expect(completed.streamId).toBe(7)
        expect(completed.seq).toBe(3)
        expect(completed.timedOut).toEqual([1])
        expect(completed.rejected).toEqual([3])
        // A dropped element is handled, not redelivered, so it counts as accepted.
        expect(completed.accepted).toBe(2)
    })

    it('reports a fully processed batch with no dispositions', async () => {
        const driver = new GrpcStreamIngestDriver(completedBatch([ok({}), ok({})]), new PromiseScheduler())

        const completed = (await driver.next())!

        expect(completed.accepted).toBe(2)
        expect(completed.timedOut).toEqual([])
        expect(completed.rejected).toEqual([])
    })
})

describe('createWireBudgetFactory', () => {
    const context = { grpcStreamId: 1, grpcSeq: 1, armedAt: 1_000, softBudgetMs: 0 }

    it('anchors the deadline at the arming time, not at the mint time', () => {
        const budget = createWireBudgetFactory(true)({ ...context, softBudgetMs: 200 })

        expect(budget.softAt).toBe(1_200)
    })

    it('reads a zero allowance as no deadline', () => {
        expect(createWireBudgetFactory(true)(context).softAt).toBe(Infinity)
    })

    it('carries the rollout gate onto the budget', () => {
        expect(createWireBudgetFactory(false)(context).enforce).toBe(false)
        expect(createWireBudgetFactory(true)(context).enforce).toBe(true)
    })
})
