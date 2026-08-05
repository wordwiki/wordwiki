// The batch LLM backend interface + the FAKE implementation.
//
// Part of the batch AI derivation build (batch-derivation-design.md).  The
// batch client is an INTERFACE (§12) so the same driver / BatchContext /
// batchImpl code runs against:
//   - AnthropicBatchBackend (batch-backend-anthropic.ts): the real Message
//     Batches API - submit, poll, retrieve a results JSONL by custom_id.
//   - FakeBatchBackend (below): disk-persisted, programmable per-request
//     outcomes, batches complete ONLY when the test says so.  This turns
//     "multiple runs over days" into "multiple invocations against a fake we
//     complete on command" - the Tier-1 harness drives REAL subprocess
//     invocations against it, so crash/resume is a genuine process kill and
//     cold reconnect.
//
// The shapes deliberately mirror the Message Batches API (message batch
// object, per-request results keyed by custom_id) so the fake stays faithful
// and the real backend is a thin transport.
import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";

// ---------------------------------------------------------------------------------
// --- The interface ----------------------------------------------------------------
// ---------------------------------------------------------------------------------

/** One enrolled request: `params` is a complete /v1/messages body (the same
 *  shape buildAnthropicRequest produces), `customId` is the derivation's
 *  content hash - the keystone: deterministic across runs, so results are
 *  idempotently landable regardless of which batch produced them. */
export interface BatchRequest {
    customId: string;
    params: Record<string, unknown>;
}

export interface BatchRequestCounts {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
}

/** The batch object (mirrors the API's message_batch). */
export interface BatchInfo {
    id: string;
    processingStatus: 'in_progress' | 'canceling' | 'ended';
    requestCounts: BatchRequestCounts;
    createdAt: string;          // ISO
    endedAt?: string;
}

export type BatchResultType = 'succeeded' | 'errored' | 'canceled' | 'expired';

/** One per-request result line.  `message` is a full /v1/messages response
 *  body on success (extractToolResult applies unchanged); `error` is the
 *  API's error object otherwise. */
export interface BatchResult {
    customId: string;
    type: BatchResultType;
    message?: unknown;
    error?: unknown;
}

export interface BatchBackend {
    /** Submit one batch.  THE paid operation - callers must gate it with
     *  assertLlmCallsAllowed. */
    create(requests: BatchRequest[]): Promise<BatchInfo>;
    /** Poll one batch's status. */
    status(batchId: string): Promise<BatchInfo>;
    /** Retrieve an ENDED batch's per-request results.  Throws if the batch
     *  has not ended (the real API has no results_url until then). */
    results(batchId: string): Promise<BatchResult[]>;
    /** List recent batches, most recent first - the standard resume path
     *  (design §7): reconnect by scanning for still-needed custom_ids, so
     *  recovery never depends on locally persisted batch ids. */
    list(limit?: number): Promise<BatchInfo[]>;
}

// ---------------------------------------------------------------------------------
// --- The fake ---------------------------------------------------------------------
// ---------------------------------------------------------------------------------

// On-disk state, one JSON file per batch in the fake's state dir, so a fresh
// process (the subprocess harness's reinvocations) sees exactly what a
// crashed predecessor left.  The fake caches nothing in memory.
interface FakeBatchFile {
    info: BatchInfo;
    seq: number;                       // creation order (list() sorts by it)
    requests: BatchRequest[];
    results?: BatchResult[];           // present once completed
}

export type FakeOutcome =
    | {type: 'succeeded', message: unknown}
    | {type: 'errored', error: unknown}
    | {type: 'canceled'}
    | {type: 'expired'};

/** The default succeeded message: a /v1/messages-shaped response whose
 *  forced tool call echoes the custom id - deterministic, checkable, and it
 *  round-trips through extractToolResult like a real response. */
export function fakeSucceededMessage(customId: string, input?: unknown): unknown {
    return {
        content: [{type: 'tool_use', name: 'record_extraction',
                   input: input ?? {fakeEcho: customId}}],
        stop_reason: 'tool_use',
        usage: {input_tokens: 1, output_tokens: 1},
    };
}

/**
 * A disk-persisted fake batch backend.
 *
 * Behaviour under test control:
 *   - create() writes a batch file with status in_progress; batches NEVER
 *     complete on their own ("not done until I say").
 *   - complete(id, outcomeFor?) flips it to ended and materializes per-request
 *     results (default: every request succeeds with fakeSucceededMessage).
 *   - completeAll(outcomeFor?) completes every in-progress batch.
 *   - createCallCount() counts create() invocations ACROSS ALL PROCESSES
 *     (they're files) - the no-double-submit / no-double-spend assertions.
 */
export class FakeBatchBackend implements BatchBackend {
    constructor(readonly stateDir: string) {}

    async create(requests: BatchRequest[]): Promise<BatchInfo> {
        await Deno.mkdir(this.stateDir, {recursive: true});
        const seq = (await this.loadAll()).length + 1;
        const id = `fakebatch-${String(seq).padStart(4, '0')}-${crypto.randomUUID().slice(0, 8)}`;
        const info: BatchInfo = {
            id,
            processingStatus: 'in_progress',
            requestCounts: {processing: requests.length, succeeded: 0,
                            errored: 0, canceled: 0, expired: 0},
            createdAt: new Date().toISOString(),
        };
        await this.save({info, seq, requests});
        return info;
    }

    async status(batchId: string): Promise<BatchInfo> {
        return (await this.load(batchId)).info;
    }

    async results(batchId: string): Promise<BatchResult[]> {
        const b = await this.load(batchId);
        if(b.info.processingStatus !== 'ended')
            throw new Error(`fake batch ${batchId} has not ended - no results yet`);
        return b.results ?? [];
    }

    async list(limit = 20): Promise<BatchInfo[]> {
        const all = await this.loadAll();
        all.sort((a, b) => b.seq - a.seq);       // most recent first
        return all.slice(0, limit).map(b => b.info);
    }

    // --- Test-control surface (used by the harness, not the code under test) ---

    /** Complete a batch: every request gets `outcomeFor(request)` (default:
     *  succeeded with the echo message). */
    async complete(batchId: string,
                   outcomeFor?: (req: BatchRequest) => FakeOutcome): Promise<void> {
        const b = await this.load(batchId);
        if(b.info.processingStatus === 'ended')
            throw new Error(`fake batch ${batchId} already ended`);
        const counts: BatchRequestCounts =
            {processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0};
        b.results = b.requests.map(req => {
            const outcome: FakeOutcome = outcomeFor?.(req)
                ?? {type: 'succeeded', message: fakeSucceededMessage(req.customId)};
            counts[outcome.type]++;
            return {customId: req.customId, type: outcome.type,
                    ...(outcome.type === 'succeeded' ? {message: outcome.message} : {}),
                    ...(outcome.type === 'errored' ? {error: outcome.error} : {})};
        });
        b.info.processingStatus = 'ended';
        b.info.endedAt = new Date().toISOString();
        b.info.requestCounts = counts;
        await this.save(b);
    }

    async completeAll(outcomeFor?: (req: BatchRequest) => FakeOutcome): Promise<string[]> {
        const completed: string[] = [];
        for(const info of await this.list(Number.MAX_SAFE_INTEGER))
            if(info.processingStatus === 'in_progress') {
                await this.complete(info.id, outcomeFor);
                completed.push(info.id);
            }
        return completed;
    }

    /** How many batches have EVER been created (all processes) - each
     *  create() is one file, so this is the double-submit detector. */
    async createCallCount(): Promise<number> {
        return (await this.loadAll()).length;
    }

    /** The enrolled requests of a batch (assertion helper). */
    async requestsOf(batchId: string): Promise<BatchRequest[]> {
        return (await this.load(batchId)).requests;
    }

    // --- Disk state ---

    private path(batchId: string): string {
        return posix.join(this.stateDir, `${batchId}.json`);
    }

    private async save(b: FakeBatchFile): Promise<void> {
        // Write-then-rename so a concurrently reading subprocess never sees a
        // torn file.
        const tmp = this.path(b.info.id) + `.tmp-${crypto.randomUUID().slice(0, 8)}`;
        await Deno.writeTextFile(tmp, JSON.stringify(b, undefined, '  '));
        await Deno.rename(tmp, this.path(b.info.id));
    }

    private async load(batchId: string): Promise<FakeBatchFile> {
        try {
            return JSON.parse(await Deno.readTextFile(this.path(batchId)));
        } catch (e) {
            throw new Error(`fake batch ${batchId} not found in ${this.stateDir}: ${e}`);
        }
    }

    private async loadAll(): Promise<FakeBatchFile[]> {
        const out: FakeBatchFile[] = [];
        let entries;
        try {
            entries = Deno.readDir(this.stateDir);
        } catch {
            return out;                            // no state dir yet: no batches
        }
        for await (const e of entries)
            if(e.isFile && e.name.endsWith('.json'))
                out.push(JSON.parse(await Deno.readTextFile(posix.join(this.stateDir, e.name))));
        return out;
    }
}
