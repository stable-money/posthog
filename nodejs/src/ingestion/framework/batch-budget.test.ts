import { BatchBudget, unlimitedBudgetFactory } from './batch-budget'

describe('BatchBudget', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    it('never exhausts and never fires its signal when unlimited', async () => {
        const budget = BatchBudget.unlimited()

        expect(budget.remainingMs).toBe(Infinity)
        expect(budget.exhausted).toBe(false)

        await jest.advanceTimersByTimeAsync(60_000)

        expect(budget.exhausted).toBe(false)
        expect(budget.signal.aborted).toBe(false)
    })

    it('exhausts and fires its signal at the soft deadline', async () => {
        const budget = BatchBudget.softDeadline(Date.now() + 1000)

        expect(budget.remainingMs).toBe(1000)
        expect(budget.exhausted).toBe(false)

        await jest.advanceTimersByTimeAsync(999)
        expect(budget.exhausted).toBe(false)
        expect(budget.signal.aborted).toBe(false)

        await jest.advanceTimersByTimeAsync(1)
        expect(budget.exhausted).toBe(true)
        expect(budget.signal.aborted).toBe(true)
        expect(budget.remainingMs).toBe(0)
    })

    it('exhausts immediately on abort, before the soft deadline', () => {
        const budget = BatchBudget.softDeadline(Date.now() + 1000)

        budget.abort('stream died')

        expect(budget.exhausted).toBe(true)
        expect(budget.signal.aborted).toBe(true)
        expect(budget.signal.reason).toBe('stream died')
        expect(budget.remainingMs).toBe(0)
    })

    it('defaults to enforcing and records shadow mode when asked', () => {
        expect(BatchBudget.softDeadline(Date.now() + 1000).enforce).toBe(true)
        expect(BatchBudget.softDeadline(Date.now() + 1000, { enforce: false }).enforce).toBe(false)
    })

    it('mints an unlimited budget from the unlimited factory', () => {
        const budget = unlimitedBudgetFactory({})

        expect(budget.remainingMs).toBe(Infinity)
        expect(budget.exhausted).toBe(false)
    })
})
