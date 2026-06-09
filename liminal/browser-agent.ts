// deno-lint-ignore-file no-explicit-any
/**
 * The transient, in-memory half of the browser-test bridge.
 *
 * A logged-in browser that has opted in as a test client runs a long-poll loop:
 * it asks the server for a command (a chunk of JS to run), executes it, and posts
 * back a result envelope.  Server-side test code calls evalInBrowser(js) to push
 * a command onto that loop and await its result - giving us "run JS in a real
 * browser and get the value back" without a separate puppeteer/CDP process.
 *
 * This module owns ONLY the transient plumbing: the parked long-poll and the
 * pending-result promise, keyed by the browser's session_token.  It deliberately
 * holds no identity or liveness state - which browser is "the" test client, and
 * whether it is still alive, lives durably in the session row
 * (last_test_client_opt_in / last_test_client_heartbeat) so it survives a server
 * restart.  When the server restarts this channel is simply empty; the browser's
 * reconnect loop re-parks a poll and we carry on.
 *
 * Protocol invariant: at most one command is in flight per agent at a time.
 * Server-side test code awaits each evalInBrowser() before issuing the next, so
 * commands are naturally serial; an overlapping call is a bug and is rejected
 * rather than silently queued.
 */

export interface BrowserResult {
    ok: boolean;
    value?: any;                                   // present when ok
    error?: { name: string; message: string; stack?: string };  // present when !ok
}

export interface BrowserCommand {
    cmdId: string;
    js: string;
}

interface PendingCommand {
    command: BrowserCommand;
    delivered: boolean;                            // has a poll handed this to the browser yet?
    resolve: (r: BrowserResult) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface ParkedPoll {
    resolve: (c: BrowserCommand | null) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface AgentState {
    pending?: PendingCommand;                      // a command awaiting browser execution + result
    poll?: ParkedPoll;                             // a long-poll waiting for a command
}

export class BrowserAgentBusyError extends Error {
    constructor(agentKey: string) {
        super(`a browser command is already in flight for this test client`);
        this.name = 'BrowserAgentBusyError';
    }
}

export class BrowserEvalError extends Error {
    constructor(message: string, public remote?: BrowserResult['error']) {
        super(message);
        this.name = 'BrowserEvalError';
    }
}

export class BrowserEvalTimeout extends Error {
    constructor(public ms: number) {
        super(`browser did not return a result within ${ms}ms`);
        this.name = 'BrowserEvalTimeout';
    }
}

export class BrowserAgentChannel {
    #agents = new Map<string, AgentState>();
    #seq = 0;

    #state(agentKey: string): AgentState {
        let s = this.#agents.get(agentKey);
        if(!s) { s = {}; this.#agents.set(agentKey, s); }
        return s;
    }

    /**
     * Push a command onto the given agent's loop and return a promise for its
     * result.  Rejects with BrowserAgentBusyError if a command is already in
     * flight for that agent, and with BrowserEvalTimeout if the browser does not
     * post a result within timeoutMs.  The returned promise does NOT itself throw
     * on a remote error - the caller inspects result.ok (evalInBrowser does this).
     */
    enqueue(agentKey: string, js: string, opts: { timeoutMs?: number } = {}): Promise<BrowserResult> {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const s = this.#state(agentKey);
        if(s.pending)
            return Promise.reject(new BrowserAgentBusyError(agentKey));

        const cmdId = String(++this.#seq);
        const command: BrowserCommand = { cmdId, js };

        return new Promise<BrowserResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                if(s.pending?.command.cmdId === cmdId) s.pending = undefined;
                reject(new BrowserEvalTimeout(timeoutMs));
            }, timeoutMs);
            s.pending = { command, delivered: false, resolve, reject, timer };

            // If a poll is already parked, hand the command over immediately.
            if(s.poll) {
                const poll = s.poll;
                s.poll = undefined;
                clearTimeout(poll.timer);
                s.pending.delivered = true;
                poll.resolve(command);
            }
        });
    }

    /**
     * Serve a long-poll for a command.  Resolves immediately if a command is
     * waiting (or in flight - see below), otherwise parks until a command arrives
     * or pollTimeoutMs elapses (then resolves null and the browser re-polls).
     *
     * If a command is already delivered but not yet acked (the browser ran it but
     * its result post was lost, then it re-polled), we re-send the same command:
     * the browser dedups by cmdId and just re-posts the cached result, so this is
     * idempotent rather than a double-execution.
     */
    poll(agentKey: string, opts: { pollTimeoutMs?: number } = {}): Promise<BrowserCommand | null> {
        const pollTimeoutMs = opts.pollTimeoutMs ?? 25_000;
        const s = this.#state(agentKey);

        if(s.pending) {
            s.pending.delivered = true;
            return Promise.resolve(s.pending.command);
        }

        // Replace any stale parked poll (only one browser loop should be polling).
        if(s.poll) {
            const stale = s.poll;
            s.poll = undefined;
            clearTimeout(stale.timer);
            stale.resolve(null);
        }

        return new Promise<BrowserCommand | null>((resolve) => {
            const timer = setTimeout(() => {
                if(s.poll && s.poll.timer === timer) s.poll = undefined;
                resolve(null);
            }, pollTimeoutMs);
            s.poll = { resolve, timer };
        });
    }

    /**
     * Deliver a result the browser posted back.  Returns true if it matched the
     * in-flight command (and resolved its awaiter), false if it was stale/unknown
     * (a duplicate post, or a result for a command that already timed out) - in
     * which case it is harmlessly ignored.
     */
    deliverResult(agentKey: string, cmdId: string, result: BrowserResult): boolean {
        const s = this.#state(agentKey);
        if(s.pending && s.pending.command.cmdId === cmdId) {
            const pending = s.pending;
            s.pending = undefined;
            clearTimeout(pending.timer);
            pending.resolve(result);
            return true;
        }
        return false;
    }

    /** Drop a client entirely (e.g. on logout); rejects any in-flight command. */
    drop(agentKey: string): void {
        const s = this.#agents.get(agentKey);
        if(!s) return;
        if(s.pending) { clearTimeout(s.pending.timer); s.pending.reject(new Error('test client disconnected')); }
        if(s.poll) { clearTimeout(s.poll.timer); s.poll.resolve(null); }
        this.#agents.delete(agentKey);
    }
}
