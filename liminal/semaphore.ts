/**
 * A minimal async counting semaphore, for bounding the concurrency of
 * expensive work (typically subprocess spawns) at the point where it is
 * DONE rather than at every call site.
 *
 * Motivating case: a from-cold publish renders every page, each render
 * requests its derived audio, and every request spawns sox/lame - with no
 * gate that meant thousands of concurrent encoder processes.  Callers can
 * fan out as wide as they like; the semaphore holds the actual spawns to
 * `limit` and the rest wait as cheap pending promises.
 *
 * Waiters are served FIFO.  A released permit is handed directly to the
 * next waiter (never returned to the pool while anyone waits), so the
 * concurrency bound cannot be jumped by a caller arriving between a
 * release and the waiter's wake-up microtask.
 */
export class Semaphore {
    private available: number;
    private waiters: (() => void)[] = [];

    constructor(readonly limit: number) {
        if(!Number.isInteger(limit) || limit < 1)
            throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
        this.available = limit;
    }

    /** Run `fn` once a permit is free, releasing the permit when it settles. */
    async use<T>(fn: () => Promise<T>|T): Promise<T> {
        if(this.available > 0)
            this.available--;
        else
            await new Promise<void>(resolve => this.waiters.push(resolve));
        try {
            return await fn();
        } finally {
            const next = this.waiters.shift();
            if(next) next(); else this.available++;
        }
    }
}
