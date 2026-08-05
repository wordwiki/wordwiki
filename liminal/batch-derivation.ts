// Batch AI derivation through the derived content store - the CORE mechanism
// (batch-derivation-design.md; the four keystones are §11).
//
// The shape: an AI derivation keyed in the store by hash([fnName, ...args])
// can run under TWO implementations selected per call via getDerived's fns
// map - the synchronous API client (interactive; unchanged), or a batchImpl
// built here.  KEYSTONE 0: batch-ness NEVER enters the closure/args, so the
// key is provably identical either way and every already-PAID cached result
// keeps hitting.  The batchImpl does not call the API: it ENROLLS the request
// into a per-run BatchContext (custom_id = the derivation's content hash -
// KEYSTONE 1) and throws DerivationNotAvailable; the run's frontier is
// submitted as ONE batch at flush (KEYSTONE 2), the process exits, and a
// later rerun finds the landed results and completes - React Suspense with a
// ~24h resolve time and a persistent store for state.
//
// Store state per key is an ordinary PEER FILE of the derived output
// (`<contentPath>.pending`): absent = not started; pending {customId,
// batchId?} = enrolled/submitted; done = the output file itself exists.
// Resume never DEPENDS on the pending markers: list-and-reconnect (scan
// recent batches, land results by custom_id) is the standard recovery path
// (§7), markers are an optimization.  MONEY rules: enrollment and submission
// assert the no-llm-calls flag (a cache hit / free result retrieval does
// not); a marker-less custom_id with unaccounted in-progress batches DEFERS
// one cycle rather than risking a duplicate paid submit; per-key retries of
// errored/expired results are CAPPED.
import { assertLlmCallsAllowed } from "./llm.ts";
import { BatchBackend, BatchInfo, BatchRequest, BatchResult } from "./batch-backend.ts";

// ---------------------------------------------------------------------------------
// --- The not-available signal ------------------------------------------------------
// ---------------------------------------------------------------------------------

/** Thrown by a batchImpl when the derivation is enrolled/in-flight rather
 *  than available.  The top loop over units catches this and moves on; the
 *  unit completes on a later run once the batch lands (design §5). */
export class DerivationNotAvailable extends Error {
    constructor(readonly customId: string, note: string) {
        super(`derivation not available yet (enrolled for batch): ${note}`);
        this.name = 'DerivationNotAvailable';
    }
}

// ---------------------------------------------------------------------------------
// --- Pending peer-files ------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface PendingState {
    customId: string;              // = the derivation's content hash
    enrolledAt: string;            // ISO
    batchId?: string;              // absent between enroll and flush
    submittedAt?: string;
    retries?: number;              // errored/expired resubmissions so far
}

export function pendingPath(contentPath: string): string {
    return contentPath + '.pending';
}

export async function readPending(contentPath: string): Promise<PendingState|undefined> {
    try {
        return JSON.parse(await Deno.readTextFile(pendingPath(contentPath)));
    } catch {
        return undefined;          // absent (or torn - reconstructed by reconnect)
    }
}

async function writePending(contentPath: string, state: PendingState): Promise<void> {
    // tmp+rename: a killed process must never leave a torn marker.
    const p = pendingPath(contentPath);
    const tmp = `${p}.tmp-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.mkdir(p.substring(0, p.lastIndexOf('/')), {recursive: true});
    await Deno.writeTextFile(tmp, JSON.stringify(state, undefined, '  '));
    await Deno.rename(tmp, p);
}

async function removePending(contentPath: string): Promise<void> {
    await Deno.remove(pendingPath(contentPath)).catch(() => {});
}

// ---------------------------------------------------------------------------------
// --- BatchContext ------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface BatchContextOpts {
    listLimit?: number;            // recent batches scanned on reconnect (default 50)
    maxRetries?: number;           // paid resubmissions per key (default 3)
    maxRequestsPerBatch?: number;  // API cap 100k; default well under (default 10000)
    maxBatchBytes?: number;        // API cap 256MB; default 200MB estimated
}

export type Resolution =
    | {kind: 'result', message: unknown}    // available NOW - a landed batch result
    | {kind: 'pending'}                     // enrolled / in flight - throw and defer
    | {kind: 'failed', reason: string};     // hard failure (retries exhausted)

export interface BatchStats {
    landed: number;                // results served from ended batches this run
    enrolled: number;              // new requests enrolled this run
    deferred: number;              // resolve() calls answered 'pending'
    retried: number;               // errored/expired keys re-enrolled
    failedHard: number;            // keys past the retry cap
}

/**
 * One bulk run's batch scope (design §6.1: per-RUN across all units - the
 * cross-unit breadth is what puts the whole frontier in one batch).  Create
 * one per pass invocation, thread it into the batchImpls, flush() once at
 * the end of the run.
 */
export class BatchContext {
    private backend: BatchBackend;
    private listLimit: number;
    private maxRetries: number;
    private maxRequestsPerBatch: number;
    private maxBatchBytes: number;

    private initDone = false;
    private endedUnscanned: BatchInfo[] = [];              // recent first
    private unaccountedInProgress: BatchInfo[] = [];       // in-flight at init, membership unknown
    private landedIndex = new Map<string, BatchResult>();  // customId -> best result seen
    private enrolledRequests = new Map<string, {request: BatchRequest, contentPath: string}>();
    readonly submittedThisRun: BatchInfo[] = [];
    /** Batch ids some deferred key is waiting on - the driver's poll list. */
    readonly blockingBatchIds = new Set<string>();
    readonly stats: BatchStats = {landed: 0, enrolled: 0, deferred: 0, retried: 0, failedHard: 0};

    constructor(backend: BatchBackend, opts: BatchContextOpts = {}) {
        this.backend = backend;
        this.listLimit = opts.listLimit ?? 50;
        this.maxRetries = opts.maxRetries ?? 3;
        this.maxRequestsPerBatch = opts.maxRequestsPerBatch ?? 10000;
        this.maxBatchBytes = opts.maxBatchBytes ?? 200 * 1024 * 1024;
    }

    /**
     * The batchImpl's whole decision (design §3.1): result / pending / failed
     * for the derivation at `contentPath` whose content hash is `customId`.
     * `buildRequest` is called ONLY when actually enrolling (it may do real
     * work - image containment - that a deferred key should skip).
     */
    async resolve(address: {contentPath: string, hash: string},
                  buildRequest: () => Promise<Record<string, unknown>>): Promise<Resolution> {
        await this.ensureInit();
        const customId = address.hash;

        // Already enrolled this run (two units sharing a derivation).
        if(this.enrolledRequests.has(customId)) {
            this.stats.deferred++;
            return {kind: 'pending'};
        }

        const pending = await readPending(address.contentPath);

        // 1. A batch we know about (marker) - poll it live.
        if(pending?.batchId !== undefined) {
            let info: BatchInfo|undefined;
            try {
                info = await this.backend.status(pending.batchId);
            } catch {
                // Unknown/expired batch id: fall through to the scan +
                // re-enroll paths below.
            }
            if(info !== undefined && info.processingStatus !== 'ended') {
                this.blockingBatchIds.add(pending.batchId);
                this.stats.deferred++;
                return {kind: 'pending'};
            }
            if(info !== undefined)
                await this.indexBatchResults(info.id);
        }

        // 2. Scan ended recent batches for this custom_id (list-and-reconnect:
        //    works with NO marker at all - the standard recovery path).
        const found = await this.scanForCustomId(customId);
        if(found?.type === 'succeeded') {
            await removePending(address.contentPath);       // safe: the scan re-finds it
            this.stats.landed++;
            return {kind: 'result', message: found.message};
        }
        if(found !== undefined)                             // errored / expired / canceled
            return await this.retryOrFail(address, pending, buildRequest,
                                          `batch result ${found.type}`);

        // 3. Marker without a batch id (enrolled, flush never recorded) while
        //    batches of UNKNOWN membership are still processing: this key may
        //    already be paid-for in one of them.  DEFER a cycle instead of
        //    risking a duplicate submit (the money property beats latency).
        if(pending !== undefined && pending.batchId === undefined
           && this.unaccountedInProgress.length > 0) {
            for(const b of this.unaccountedInProgress) this.blockingBatchIds.add(b.id);
            this.stats.deferred++;
            return {kind: 'pending'};
        }

        // 4. A genuine miss: enroll into this run's batch.
        return await this.enroll(address, pending?.retries ?? 0, buildRequest);
    }

    private async retryOrFail(address: {contentPath: string, hash: string},
                              pending: PendingState|undefined,
                              buildRequest: () => Promise<Record<string, unknown>>,
                              why: string): Promise<Resolution> {
        const retries = pending?.retries ?? 0;
        if(retries >= this.maxRetries) {
            this.stats.failedHard++;
            return {kind: 'failed',
                    reason: `${why}; retry cap (${this.maxRetries}) reached for ${address.hash}`};
        }
        this.stats.retried++;
        return await this.enroll(address, retries + 1, buildRequest);
    }

    private async enroll(address: {contentPath: string, hash: string},
                         retries: number,
                         buildRequest: () => Promise<Record<string, unknown>>): Promise<Resolution> {
        // THE gate (design §12b): enrollment is the commitment to spend, so a
        // drifted key under no-llm-calls trips HERE, immediately and named -
        // exactly like the sync path - before any marker is written.
        assertLlmCallsAllowed(`batch enroll ${address.hash} (${address.contentPath})`);
        const params = await buildRequest();
        this.enrolledRequests.set(address.hash,
            {request: {customId: address.hash, params}, contentPath: address.contentPath});
        await writePending(address.contentPath, {
            customId: address.hash,
            enrolledAt: new Date().toISOString(),
            ...(retries > 0 ? {retries} : {}),
        });
        this.stats.enrolled++;
        this.stats.deferred++;
        return {kind: 'pending'};
    }

    /**
     * Submit this run's enrolled frontier (design §5: ONE flush at the run
     * barrier).  Chunks only to stay inside the API's per-batch caps.
     * Returns the created batches (empty when nothing was enrolled).
     */
    async flush(): Promise<BatchInfo[]> {
        if(this.enrolledRequests.size === 0)
            return [];
        crashHook('before-flush');
        assertLlmCallsAllowed(`batch flush of ${this.enrolledRequests.size} request(s)`);
        const entries = [...this.enrolledRequests.values()];
        this.enrolledRequests.clear();
        const created: BatchInfo[] = [];
        for(const chunk of this.chunkByLimits(entries)) {
            const info = await this.backend.create(chunk.map(e => e.request));
            crashHook('after-submit');
            created.push(info);
            this.submittedThisRun.push(info);
            this.blockingBatchIds.add(info.id);
            // Record the batch id on each member's marker (an optimization
            // for the next run's polling; recovery works without it).
            for(const e of chunk) {
                const p = await readPending(e.contentPath);
                await writePending(e.contentPath, {
                    customId: e.request.customId,
                    enrolledAt: p?.enrolledAt ?? new Date().toISOString(),
                    batchId: info.id,
                    submittedAt: new Date().toISOString(),
                    ...(p?.retries ? {retries: p.retries} : {}),
                });
            }
        }
        return created;
    }

    private chunkByLimits(entries: {request: BatchRequest, contentPath: string}[]):
            {request: BatchRequest, contentPath: string}[][] {
        const chunks: {request: BatchRequest, contentPath: string}[][] = [];
        let current: {request: BatchRequest, contentPath: string}[] = [];
        let currentBytes = 0;
        for(const e of entries) {
            const bytes = JSON.stringify(e.request).length;
            if(current.length > 0 &&
               (current.length >= this.maxRequestsPerBatch ||
                currentBytes + bytes > this.maxBatchBytes)) {
                chunks.push(current);
                current = [];
                currentBytes = 0;
            }
            current.push(e);
            currentBytes += bytes;
        }
        if(current.length > 0)
            chunks.push(current);
        return chunks;
    }

    // --- Reconnect machinery ---

    private async ensureInit(): Promise<void> {
        if(this.initDone) return;
        this.initDone = true;
        let recent: BatchInfo[] = [];
        try {
            recent = await this.backend.list(this.listLimit);
        } catch (e) {
            console.warn(`batch: could not list recent batches for reconnect: ${e}`);
        }
        this.endedUnscanned = recent.filter(b => b.processingStatus === 'ended');
        this.unaccountedInProgress = recent.filter(b => b.processingStatus === 'in_progress');
    }

    /** Lazily walk ended recent batches (most recent first), indexing their
     *  results, until the custom_id is found or the list is exhausted. */
    private async scanForCustomId(customId: string): Promise<BatchResult|undefined> {
        while(!this.landedIndex.has(customId) && this.endedUnscanned.length > 0) {
            const next = this.endedUnscanned.shift()!;
            await this.indexBatchResults(next.id);
        }
        return this.landedIndex.get(customId);
    }

    private async indexBatchResults(batchId: string): Promise<void> {
        this.endedUnscanned = this.endedUnscanned.filter(b => b.id !== batchId);
        let results: BatchResult[];
        try {
            results = await this.backend.results(batchId);
        } catch (e) {
            console.warn(`batch: could not fetch results of ${batchId}: ${e}`);
            return;
        }
        for(const r of results) {
            // A key can appear in several batches (resubmit races); a
            // succeeded result must never be shadowed by a failed one.
            const existing = this.landedIndex.get(r.customId);
            if(existing === undefined || (existing.type !== 'succeeded' && r.type === 'succeeded'))
                this.landedIndex.set(r.customId, r);
        }
    }
}

// --- Crash injection for the Tier-1 harness (design §12.2's CRASH_AFTER
//     hook): LIMINAL_BATCH_CRASH names a window; hitting it hard-exits the
//     process - a GENUINE die-mid-flush for the subprocess crash tests.
//     Unset in production (the env read costs nothing).
function crashHook(window: 'before-flush' | 'after-submit'): void {
    if(Deno.env.get('LIMINAL_BATCH_CRASH') === window) {
        console.error(`batch: CRASH INJECTION at ${window} (LIMINAL_BATCH_CRASH)`);
        Deno.exit(9);
    }
}

// ---------------------------------------------------------------------------------
// --- The batchImpl builder ---------------------------------------------------------
// ---------------------------------------------------------------------------------

/**
 * Build the impl a wrapper puts in getDerived's fns map when running batched
 * - UNDER THE SAME fn NAME as the sync impl (keystone 0; the closure/key is
 * computed by the caller identically for both).  `postProcess` turns a
 * landed /v1/messages response into the derived file's content - the same
 * transformation the sync impl applies to a live response, so batch bytes ==
 * sync bytes.
 */
export function batchImplFor(batch: BatchContext,
                             address: {contentPath: string, hash: string},
                             buildRequest: () => Promise<Record<string, unknown>>,
                             postProcess: (message: unknown) => string|Promise<string>):
        (target: string) => Promise<string> {
    return async (_target: string) => {
        const resolution = await batch.resolve(address, buildRequest);
        switch(resolution.kind) {
            case 'result':  return await postProcess(resolution.message);
            case 'pending': throw new DerivationNotAvailable(address.hash, address.contentPath);
            case 'failed':  throw new Error(`batch derivation failed: ${resolution.reason}`);
        }
    };
}

/**
 * Await sibling derivations enrolled CONCURRENTLY (design §6.2: enroll
 * independent siblings before unwinding, or X pending would stop Y from even
 * enrolling and the depth bound decays toward count).  All promises settle
 * (so every sibling enrolls and there are no unhandled rejections), then:
 * any real error rethrows; else any DerivationNotAvailable rethrows; else
 * all values return.
 */
export async function awaitAll<T>(promises: Promise<T>[]): Promise<T[]> {
    const settled = await Promise.allSettled(promises);
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    const hardFailure = failures.find(f => !(f.reason instanceof DerivationNotAvailable));
    if(hardFailure !== undefined)
        throw hardFailure.reason;
    if(failures.length > 0)
        throw failures[0].reason;
    return settled.map(s => (s as PromiseFulfilledResult<T>).value);
}

// ---------------------------------------------------------------------------------
// --- The driver (design §8) --------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface BatchUnit {
    id: string;
    run: () => Promise<void>;      // commit-at-end discipline: NO side effects
                                   // before every await has resolved (§6.3)
}

export interface BatchUnitReport {
    unitId: string;
    status: 'completed' | 'deferred' | 'failed';
    error?: string;
}

export type BatchRunClassification = 'done' | 'progress' | 'pure-wait';

/** The §8 classifier, shared by runBatchUnits and passes with their own
 *  unit loops (the reference binder's page loop). */
export function classifyBatchRun(args: {completed: number, deferred: number,
                                        submittedBatches: number, landed: number}):
        BatchRunClassification {
    return args.deferred === 0 ? 'done'
        : (args.completed > 0 || args.submittedBatches > 0 || args.landed > 0) ? 'progress'
        : 'pure-wait';
}

export interface BatchRunOutcome {
    units: BatchUnitReport[];
    completed: number;
    deferred: number;
    failed: number;
    submitted: BatchInfo[];        // batches created at flush
    waitingOn: string[];           // batch ids deferred units are blocked on
    stats: BatchStats;
    classification: BatchRunClassification;
}

/**
 * One run of a bulk pass: execute every unit (catching DerivationNotAvailable
 * = deferred), flush the frontier as one batch, classify:
 *   - 'done':      nothing deferred - the pass is complete (failed units are
 *                  reported, not retried here).
 *   - 'progress':  units completed / results landed / new work submitted -
 *                  rerun when the in-flight batches end.
 *   - 'pure-wait': nothing moved; everything blocked on in-flight batches -
 *                  poll `waitingOn`, rerun on completion, don't spin.
 * Rerun-later is the SAME call as crash-resume (§8) - just invoke again.
 */
export async function runBatchUnits(units: BatchUnit[], batch: BatchContext,
                                    opts: {log?: (line: string) => void} = {}):
        Promise<BatchRunOutcome> {
    const log = opts.log ?? (() => undefined);
    const reports: BatchUnitReport[] = [];
    for(const unit of units) {
        try {
            await unit.run();
            reports.push({unitId: unit.id, status: 'completed'});
        } catch (e) {
            if(e instanceof DerivationNotAvailable) {
                reports.push({unitId: unit.id, status: 'deferred'});
            } else {
                reports.push({unitId: unit.id, status: 'failed', error: String(e)});
                log(`unit ${unit.id} FAILED: ${e}`);
            }
        }
    }
    const submitted = await batch.flush();
    const completed = reports.filter(r => r.status === 'completed').length;
    const deferred = reports.filter(r => r.status === 'deferred').length;
    const failed = reports.filter(r => r.status === 'failed').length;
    const classification = classifyBatchRun(
        {completed, deferred, submittedBatches: submitted.length, landed: batch.stats.landed});
    log(`batch run: ${completed} completed, ${deferred} deferred, ${failed} failed; ` +
        `${submitted.length} batch(es) submitted ` +
        `(${submitted.reduce((n, b) => n + b.requestCounts.processing, 0)} request(s)); ` +
        `${classification}`);
    return {units: reports, completed, deferred, failed, submitted,
            waitingOn: [...batch.blockingBatchIds], stats: batch.stats, classification};
}
