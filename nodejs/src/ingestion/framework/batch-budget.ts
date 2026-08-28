/**
 * The time allowance one fed batch has, minted by the pipeline from its
 * constructor factory. It carries one soft deadline, absolute epoch
 * milliseconds, and it is the one the framework checkpoints read: when it
 * passes the framework stops starting work, elements the budget cut off
 * complete as `TIMEOUT`, and in-flight steps are allowed to finish. Nothing
 * here bounds a step that never returns — the consumer's ack watchdog is the
 * hard limit.
 *
 * `unlimited()` is the neutral element, so there is no "no budget" state to
 * branch on: its signal never fires on its own and its `remainingMs` is
 * `Infinity`, which makes every checkpoint a no-op.
 */
export class BatchBudget {
    /** Fires at the soft deadline or on `abort()`. */
    readonly signal: AbortSignal

    private readonly controller = new AbortController()
    private readonly timer: ReturnType<typeof setTimeout> | null = null

    private constructor(
        /** Absolute epoch milliseconds, or `Infinity` when there is no soft deadline. */
        readonly softAt: number,
        /** When false the budget runs in shadow mode: checkpoints record metrics and change no result. */
        readonly enforce: boolean
    ) {
        this.signal = this.controller.signal
        if (softAt !== Infinity) {
            this.timer = setTimeout(
                () => this.controller.abort('batch budget soft deadline'),
                Math.max(0, softAt - Date.now())
            )
            // A budget outlives its batch only until the deadline it was armed
            // for, so the timer must not hold the process open in the meantime.
            this.timer.unref?.()
        }
    }

    static softDeadline(softAt: number, opts?: { enforce?: boolean }): BatchBudget {
        return new BatchBudget(softAt, opts?.enforce ?? true)
    }

    static unlimited(): BatchBudget {
        return new BatchBudget(Infinity, true)
    }

    /** Time left before the soft deadline; `Infinity` when unlimited, `0` once exhausted. */
    get remainingMs(): number {
        if (this.signal.aborted) {
            return 0
        }
        if (this.softAt === Infinity) {
            return Infinity
        }
        return Math.max(0, this.softAt - Date.now())
    }

    get exhausted(): boolean {
        return this.signal.aborted || (this.softAt !== Infinity && Date.now() >= this.softAt)
    }

    /**
     * Exhaust the budget now, whatever its deadline says. Used when the work's
     * destination is gone, for example a dead worker stream.
     */
    abort(reason?: string): void {
        if (this.timer) {
            clearTimeout(this.timer)
        }
        this.controller.abort(reason ?? 'batch budget aborted')
    }
}

/**
 * Mints the budget for one fed batch from the feed context. A pipeline holds
 * exactly one, given at construction, so callers never thread budgets per call.
 */
export type BatchBudgetFactory<CFeed> = (batchContext: CFeed) => BatchBudget

/** The factory for pipelines with no time policy. */
export const unlimitedBudgetFactory: BatchBudgetFactory<unknown> = () => BatchBudget.unlimited()
