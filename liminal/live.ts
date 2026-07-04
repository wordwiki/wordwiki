// deno-lint-ignore-file no-explicit-any
/**
 * LiveLog - the server half of opt-in long-poll liveness.
 *
 * An in-memory log of the dirty-key sets emitted by mutations (see dirty.ts;
 * rpcHandler appends each request's final merged set here), plus a park/notify
 * long-poll over it: a browser tab whose page contains 'lm-live' fragments
 * polls with the union of those fragments' dependency keys, and is answered as
 * soon as a mutation emits an intersecting key (or on timeout, so the tab
 * re-parks).  The client then runs the ordinary reload() front door on the
 * changed keys - liveness rides the exact same refresh machinery as the page's
 * own edits (see liminal.md).
 *
 * The wait/notify shape mirrors the proven browser-test bridge
 * (browser-agent.ts BrowserAgentChannel.poll/enqueue): a parked poll is a
 * stored {resolve, timer} continuation, woken by append, with timer-identity
 * checks so a timeout never clears a successor's state.
 *
 * Sequence numbers are per-process and monotonic; `epoch` (a random id minted
 * at construction) lets clients detect a server restart: an epoch mismatch (or
 * a cursor older than the ring's oldest retained entry) answers {resync:true},
 * telling the client to reload ALL its watched keys and adopt the fresh
 * cursor.  The ring is bounded (LOG_CAPACITY) - liveness is a freshness hint,
 * not a durable event stream.
 *
 * HONESTY LIMITS (same trust model as the whole reload contract): the log sees
 * only DECLARED dirties that reach rpcHandler's drain - direct db writes,
 * imports, and other processes are invisible.  And rabid mutations are not
 * transaction-wrapped: a mid-mutation throw can leave committed rows that were
 * never logged (the erroring page doesn't refresh either - consistent - but
 * other viewers stay stale until their next full load).
 */

export interface LiveEntry { seq: number; keys: string[]; }   // keys: selector form ('.-task-7-')

export interface LivePollRequest {
    epoch?: string;
    sinceSeq?: number;
    keys?: string[];
}

export type LivePollAnswer =
    // Entries after sinceSeq that intersect the watch set (empty on timeout).
    | {epoch: string, seq: number, entries: LiveEntry[]}
    // The cursor can't be honoured (restart, first contact, or ring overflow):
    // reload everything you watch and continue from `seq`.
    | {epoch: string, seq: number, resync: true};

interface ParkedWaiter {
    keys: Set<string>;
    resolve: (answer: LivePollAnswer) => void;
    timer: ReturnType<typeof setTimeout>;
}

const LOG_CAPACITY = 512;
const DEFAULT_POLL_TIMEOUT_MS = 25_000;
export const MAX_WATCH_KEYS = 100;

export class LiveLog {

    /** Restart detection: minted once per LiveLog (i.e. per server process). */
    readonly epoch: string = crypto.randomUUID();

    #seq = 0;
    #entries: LiveEntry[] = [];
    #waiters: ParkedWaiter[] = [];

    /** The current high-water sequence number. */
    get seq(): number { return this.#seq; }

    /**
     * Record a mutation's dirty-key set.  Returns the assigned seq (or the
     * current seq unchanged when keys is empty - nothing to tell anyone).
     * Wakes every parked waiter whose watch set intersects.
     */
    append(keys: string[]): number {
        if(keys.length === 0) return this.#seq;
        const entry: LiveEntry = {seq: ++this.#seq, keys: [...keys]};
        this.#entries.push(entry);
        if(this.#entries.length > LOG_CAPACITY)
            this.#entries.splice(0, this.#entries.length - LOG_CAPACITY);

        // Wake intersecting waiters (collect first: resolve() re-entrancy must
        // not see a half-edited waiter list).
        const woken: ParkedWaiter[] = [];
        this.#waiters = this.#waiters.filter(w => {
            if(entry.keys.some(k => w.keys.has(k))) { woken.push(w); return false; }
            return true;
        });
        for(const w of woken) {
            clearTimeout(w.timer);
            w.resolve({epoch: this.epoch, seq: this.#seq, entries: [entry]});
        }
        return this.#seq;
    }

    /**
     * Long-poll: answer immediately when the cursor is stale (resync) or when
     * entries after it intersect the watch set; otherwise park until an
     * intersecting append or the timeout (which answers with zero entries so
     * the client just re-parks from the same cursor).
     */
    poll(req: LivePollRequest, opts: {timeoutMs?: number} = {}): Promise<LivePollAnswer> {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

        // Validate defensively - the request body is client-supplied.  Anything
        // unusable answers as a resync (the safe over-refresh direction).
        const keys = Array.isArray(req?.keys)
            ? req.keys.filter((k): k is string => typeof k === 'string').slice(0, MAX_WATCH_KEYS)
            : [];
        const sinceSeq = typeof req?.sinceSeq === 'number' && Number.isFinite(req.sinceSeq)
            ? req.sinceSeq : undefined;

        if(req?.epoch !== this.epoch || sinceSeq === undefined
           || sinceSeq > this.#seq || this.#cursorEvicted(sinceSeq))
            return Promise.resolve({epoch: this.epoch, seq: this.#seq, resync: true});

        const pending = this.#entries.filter(e =>
            e.seq > sinceSeq && e.keys.some(k => keys.includes(k)));
        if(pending.length > 0)
            return Promise.resolve({epoch: this.epoch, seq: this.#seq, entries: pending});

        if(keys.length === 0 || timeoutMs <= 0)
            return Promise.resolve({epoch: this.epoch, seq: this.#seq, entries: []});

        return new Promise<LivePollAnswer>((resolve) => {
            const waiter: ParkedWaiter = {
                keys: new Set(keys),
                resolve,
                timer: setTimeout(() => {
                    // Identity check (the browser-agent pattern): only remove
                    // OURSELVES - append may already have woken and removed us.
                    this.#waiters = this.#waiters.filter(w => w !== waiter);
                    resolve({epoch: this.epoch, seq: this.#seq, entries: []});
                }, timeoutMs),
            };
            this.#waiters.push(waiter);
        });
    }

    // A cursor older than the oldest retained entry means changes were evicted
    // unseen - the client must resync.  (Equal to the oldest's seq - 1 is fine:
    // that entry is still retained.)
    #cursorEvicted(sinceSeq: number): boolean {
        const oldest = this.#entries[0];
        return oldest !== undefined && sinceSeq < oldest.seq - 1;
    }

    /** Test/introspection hook: number of currently parked waiters. */
    get parkedCount(): number { return this.#waiters.length; }
}
