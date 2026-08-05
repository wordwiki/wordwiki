// deno-lint-ignore-file no-explicit-any
// The batch backend surface: the FAKE's contract (it is the Tier-1 net's
// foundation, so its own behaviour is pinned here) + the real backend's pure
// request/response shaping (no network - llm_test.ts's pattern).
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "./testing/assert.ts";
import { BatchRequest, FakeBatchBackend, fakeSucceededMessage } from "./batch-backend.ts";
import { buildBatchCreateBody, parseBatchInfo, parseResultsJsonl } from "./batch-backend-anthropic.ts";

const Deno_ = (globalThis as any).Deno;

function reqs(...ids: string[]): BatchRequest[] {
    return ids.map(customId => ({customId, params: {model: 'fake-model', prompt_for: customId}}));
}

async function assertThrowsAsync(fn: () => Promise<unknown>, includes: string) {
    try {
        await fn();
    } catch (e) {
        assertStringIncludes(String(e), includes);
        return;
    }
    throw new Error(`expected a throw including '${includes}'`);
}

test("fake batch: create/status/complete/results round-trip", async () => {
    const tmp = await Deno_.makeTempDir({prefix: 'batch-backend-test-'});
    try {
        const fake = new FakeBatchBackend(`${tmp}/batches`);
        const info = await fake.create(reqs('aaa', 'bbb'));
        assertEquals(info.processingStatus, 'in_progress');
        assertEquals(info.requestCounts.processing, 2);

        // Not done until the test says so; results are gated on ended.
        assertEquals((await fake.status(info.id)).processingStatus, 'in_progress');
        await assertThrowsAsync(() => fake.results(info.id), 'has not ended');

        await fake.complete(info.id);
        const done = await fake.status(info.id);
        assertEquals(done.processingStatus, 'ended');
        assertEquals(done.requestCounts, {processing: 0, succeeded: 2, errored: 0,
                                          canceled: 0, expired: 0});
        const results = await fake.results(info.id);
        assertEquals(results.map(r => [r.customId, r.type]),
                     [['aaa', 'succeeded'], ['bbb', 'succeeded']]);
        // The default message round-trips like a real /v1/messages response.
        assertEquals((results[0].message as any).content[0].input, {fakeEcho: 'aaa'});
    } finally {
        await Deno_.remove(tmp, {recursive: true});
    }
});

test("fake batch: programmable outcomes + list order + create counting", async () => {
    const tmp = await Deno_.makeTempDir({prefix: 'batch-backend-test-'});
    try {
        const fake = new FakeBatchBackend(`${tmp}/batches`);
        const b1 = await fake.create(reqs('one'));
        const b2 = await fake.create(reqs('err', 'exp', 'ok'));

        // Most recent first; every create is counted (the double-submit detector).
        assertEquals((await fake.list()).map(b => b.id), [b2.id, b1.id]);
        assertEquals(await fake.createCallCount(), 2);

        await fake.complete(b2.id, req =>
            req.customId === 'err' ? {type: 'errored', error: {message: 'bad params'}}
            : req.customId === 'exp' ? {type: 'expired'}
            : {type: 'succeeded', message: fakeSucceededMessage(req.customId)});
        const results = await fake.results(b2.id);
        assertEquals(results.map(r => [r.customId, r.type]),
                     [['err', 'errored'], ['exp', 'expired'], ['ok', 'succeeded']]);
        assertEquals((await fake.status(b2.id)).requestCounts,
                     {processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 1});

        // completeAll sweeps only the still-open batches.
        assertEquals(await fake.completeAll(), [b1.id]);
    } finally {
        await Deno_.remove(tmp, {recursive: true});
    }
});

test("fake batch: state survives a cold reconnect (fresh instance, same dir)", async () => {
    const tmp = await Deno_.makeTempDir({prefix: 'batch-backend-test-'});
    try {
        const b1 = await new FakeBatchBackend(`${tmp}/batches`).create(reqs('persisted'));
        // A separate instance (a reinvoked process in the harness) sees it all.
        const fresh = new FakeBatchBackend(`${tmp}/batches`);
        assertEquals((await fresh.list()).map(b => b.id), [b1.id]);
        assertEquals((await fresh.requestsOf(b1.id)).map(r => r.customId), ['persisted']);
        await fresh.complete(b1.id);
        assertEquals((await fresh.results(b1.id))[0].type, 'succeeded');
    } finally {
        await Deno_.remove(tmp, {recursive: true});
    }
});

// --- The real backend's pure shaping ---------------------------------------------

test("batch shaping: create body / batch info / results JSONL", () => {
    assertEquals(buildBatchCreateBody(reqs('x')),
                 {requests: [{custom_id: 'x', params: {model: 'fake-model', prompt_for: 'x'}}]});

    const info = parseBatchInfo({
        id: 'msgbatch_01', type: 'message_batch', processing_status: 'ended',
        request_counts: {processing: 0, succeeded: 3, errored: 1, canceled: 0, expired: 0},
        created_at: '2026-08-05T00:00:00Z', ended_at: '2026-08-05T01:00:00Z',
    });
    assertEquals(info, {id: 'msgbatch_01', processingStatus: 'ended',
                        requestCounts: {processing: 0, succeeded: 3, errored: 1,
                                        canceled: 0, expired: 0},
                        createdAt: '2026-08-05T00:00:00Z', endedAt: '2026-08-05T01:00:00Z'});

    const lines = [
        JSON.stringify({custom_id: 'h1', result: {type: 'succeeded',
                        message: {content: [], stop_reason: 'tool_use'}}}),
        '',                                                       // blank lines skipped
        JSON.stringify({custom_id: 'h2', result: {type: 'errored',
                        error: {type: 'invalid_request_error', message: 'nope'}}}),
    ].join('\n');
    const results = parseResultsJsonl(lines);
    assertEquals(results.map(r => [r.customId, r.type]),
                 [['h1', 'succeeded'], ['h2', 'errored']]);
    assert((results[1].error as any).message === 'nope');
});

test("batch shaping: malformed shapes throw legibly", () => {
    let threw = '';
    try { parseBatchInfo({nope: true}); } catch (e) { threw = String(e); }
    assertStringIncludes(threw, 'malformed message_batch');

    threw = '';
    try { parseResultsJsonl('{"truncated": '); } catch (e) { threw = String(e); }
    assertStringIncludes(threw, 'malformed results JSONL');

    threw = '';
    try { parseResultsJsonl('{"custom_id": "x"}'); } catch (e) { threw = String(e); }
    assertStringIncludes(threw, 'missing custom_id/result.type');
});
