import { createWireBudgetFactory } from './grpc-stream-ingest-driver'

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
