// The REAL Anthropic Message Batches backend (batch-derivation-design.md §9).
//
// A thin transport implementing BatchBackend over the Batches API:
//   create  -> POST /v1/messages/batches   {requests: [{custom_id, params}]}
//   status  -> GET  /v1/messages/batches/{id}
//   results -> GET  /v1/messages/batches/{id}/results   (JSONL, ended only)
//   list    -> GET  /v1/messages/batches?limit=N        (most recent first)
//
// ALL the scheduling / resume / dedup logic lives above the BatchBackend
// interface and is Tier-1 tested against the fake; this file is only shape
// translation (snake_case API <-> our camelCase types) + HTTP.  The pure
// shaping functions are exported for unit tests (llm.ts's request/response
// pattern); nothing here retries - per-request failures come back as typed
// results and the layer above treats errored/expired as cache-misses.
//
// create() is THE paid operation: it asserts the no-llm-calls flag (design
// §3.4) even though BatchContext already gates enrollment - defense in depth
// for the money property.
import { AnthropicCredential, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_ANTHROPIC_VERSION,
         assertLlmCallsAllowed } from "./llm.ts";
import { BatchBackend, BatchInfo, BatchRequest, BatchRequestCounts,
         BatchResult, BatchResultType } from "./batch-backend.ts";

export class AnthropicBatchBackend implements BatchBackend {
    constructor(private cred: AnthropicCredential,
                private fetchImpl: typeof fetch = fetch) {}

    async create(requests: BatchRequest[]): Promise<BatchInfo> {
        assertLlmCallsAllowed(`batch submit of ${requests.length} request(s)`);
        const data = await this.call('POST', '/v1/messages/batches',
                                     buildBatchCreateBody(requests));
        return parseBatchInfo(data);
    }

    async status(batchId: string): Promise<BatchInfo> {
        return parseBatchInfo(await this.call('GET', `/v1/messages/batches/${batchId}`));
    }

    async results(batchId: string): Promise<BatchResult[]> {
        // The API 404s the /results path until processing has ended; status
        // first for a legible error (and to avoid treating "not ready" as
        // any kind of result).
        const info = await this.status(batchId);
        if(info.processingStatus !== 'ended')
            throw new Error(`batch ${batchId} has not ended (status ${info.processingStatus}) - no results yet`);
        const text = await this.callText('GET', `/v1/messages/batches/${batchId}/results`);
        return parseResultsJsonl(text);
    }

    async list(limit = 20): Promise<BatchInfo[]> {
        // Paginate (API caps a page at 100) until `limit` or the end; the
        // API returns most recent first, which list() promises.
        const out: BatchInfo[] = [];
        let afterId: string|undefined = undefined;
        while(out.length < limit) {
            const page = Math.min(100, limit - out.length);
            const url = `/v1/messages/batches?limit=${page}` +
                (afterId ? `&after_id=${afterId}` : '');
            const data = await this.call('GET', url) as
                {data?: unknown[], has_more?: boolean, last_id?: string};
            const batches = (data.data ?? []).map(parseBatchInfo);
            out.push(...batches);
            if(!data.has_more || batches.length === 0 || !data.last_id)
                break;
            afterId = data.last_id;
        }
        return out;
    }

    // --- HTTP ---

    private async call(method: string, path: string, body?: unknown): Promise<unknown> {
        return JSON.parse(await this.callText(method, path, body));
    }

    private async callText(method: string, path: string, body?: unknown): Promise<string> {
        const url = (this.cred.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL) + path;
        const res = await this.fetchImpl(url, {
            method,
            headers: {
                'x-api-key': this.cred.apiKey,
                'anthropic-version': this.cred.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
                ...(body !== undefined ? {'content-type': 'application/json'} : {}),
            },
            ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
        });
        const text = await res.text();
        if(!res.ok)
            throw new Error(`batch: anthropic HTTP ${res.status} on ${method} ${path}: ${text.slice(0, 500)}`);
        return text;
    }
}

// ---------------------------------------------------------------------------------
// --- Pure request/response shaping (no network - unit-tested directly) -------------
// ---------------------------------------------------------------------------------

export function buildBatchCreateBody(requests: BatchRequest[]): Record<string, unknown> {
    return {requests: requests.map(r => ({custom_id: r.customId, params: r.params}))};
}

/** The API's message_batch object -> BatchInfo.  Throws on shapes that would
 *  break the layers above (a legible transport error beats a silent bad
 *  batch id). */
export function parseBatchInfo(data: unknown): BatchInfo {
    const d = data as Record<string, unknown>;
    if(typeof d?.id !== 'string' || typeof d?.processing_status !== 'string')
        throw new Error(`batch: malformed message_batch object: ${JSON.stringify(data).slice(0, 200)}`);
    const rc = (d.request_counts ?? {}) as Record<string, unknown>;
    const counts: BatchRequestCounts = {
        processing: asCount(rc.processing), succeeded: asCount(rc.succeeded),
        errored: asCount(rc.errored), canceled: asCount(rc.canceled),
        expired: asCount(rc.expired),
    };
    return {
        id: d.id,
        processingStatus: d.processing_status as BatchInfo['processingStatus'],
        requestCounts: counts,
        createdAt: typeof d.created_at === 'string' ? d.created_at : '',
        ...(typeof d.ended_at === 'string' ? {endedAt: d.ended_at} : {}),
    };
}

/** The results JSONL -> BatchResult[].  Skips blank lines; throws on a
 *  malformed line (a truncated download must not silently drop results). */
export function parseResultsJsonl(text: string): BatchResult[] {
    const out: BatchResult[] = [];
    for(const line of text.split('\n')) {
        if(line.trim() === '') continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            throw new Error(`batch: malformed results JSONL line (${e}): ${line.slice(0, 200)}`);
        }
        const p = parsed as {custom_id?: unknown, result?: {type?: unknown,
                             message?: unknown, error?: unknown}};
        if(typeof p.custom_id !== 'string' || typeof p.result?.type !== 'string')
            throw new Error(`batch: results line missing custom_id/result.type: ${line.slice(0, 200)}`);
        out.push({
            customId: p.custom_id,
            type: p.result.type as BatchResultType,
            ...(p.result.message !== undefined ? {message: p.result.message} : {}),
            ...(p.result.error !== undefined ? {error: p.result.error} : {}),
        });
    }
    return out;
}

function asCount(v: unknown): number {
    return typeof v === 'number' ? v : 0;
}
