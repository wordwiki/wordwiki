// deno-lint-ignore-file no-explicit-any
// Tier-1 of the batch-derivation testing plan (batch-derivation-design.md
// §12.1): the WHOLE hard multi-run/crash/resume logic, deterministic and
// fast, against the disk-persisted FakeBatchBackend.
//
// The subprocess scenarios drive liminal/testing/batch-pass-cli.ts as a REAL
// process per run - a "crash" is a genuine process death (crashHook
// Deno.exit mid-flush), a "resume" is a genuine cold start reading only disk
// state.  The in-process tests pin the context-level properties (isolation,
// cache sharing across modes, chunking, retry cap).
//
// This tier OWNS the scheduling/resume/dedup correctness; Tier 2 (the
// multi-day real-API soak, §12.2) validates only transport + timing.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "./testing/assert.ts";
import { BatchContext, DerivationNotAvailable, readPending } from "./batch-derivation.ts";
import { FakeBatchBackend, fakeSucceededMessage } from "./batch-backend.ts";
import { ExtractConfig, ExtractStage, extractTextStage } from "./extract.ts";
import { Llm } from "./llm.ts";

const Deno_ = (globalThis as any).Deno;
const CLI = new URL('./testing/batch-pass-cli.ts', import.meta.url).pathname;

// ---------------------------------------------------------------------------------
// --- The subprocess harness --------------------------------------------------------
// ---------------------------------------------------------------------------------

interface PassReport {
    classification: 'done' | 'progress' | 'pure-wait';
    completed: number;
    deferred: number;
    failed: number;
    failures: string[];
    createCalls: number;
    submitted: number;
}

/** One REAL invocation of the pass subprocess.  Returns the parsed report,
 *  or just the exit code for crash-injected runs. */
async function runPass(tmp: string, scenario: string, env: Record<string, string> = {}):
        Promise<{code: number, report?: PassReport, stderr: string}> {
    const cmd = new Deno_.Command(Deno_.execPath(), {
        args: ['run', '--allow-all', CLI,
               `--store=${tmp}/store`, `--fake=${tmp}/fake`, `--scenario=${scenario}`],
        env,
        stdout: 'piped', stderr: 'piped',
    });
    const {code, stdout, stderr} = await cmd.output();
    const err = new TextDecoder().decode(stderr);
    if(code !== 0)
        return {code, stderr: err};
    const lines = new TextDecoder().decode(stdout).trim().split('\n');
    return {code, report: JSON.parse(lines[lines.length - 1]), stderr: err};
}

function fakeOf(tmp: string): FakeBatchBackend {
    return new FakeBatchBackend(`${tmp}/fake`);
}

async function doneUnits(tmp: string): Promise<string[]> {
    const out: string[] = [];
    try {
        for await (const e of Deno_.readDir(`${tmp}/store`))
            if(e.name.startsWith('unit-') && e.name.endsWith('.done'))
                out.push(e.name.slice('unit-'.length, -'.done'.length));
    } catch { /* no store yet */ }
    return out.sort();
}

async function pendingMarkers(tmp: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
        let entries;
        try { entries = Deno_.readDir(dir); } catch { return; }
        for await (const e of entries) {
            if(e.isDirectory) await walk(`${dir}/${e.name}`);
            else if(e.name.endsWith('.pending')) out.push(`${dir}/${e.name}`);
        }
    };
    await walk(`${tmp}/store/extractions`);
    return out;
}

async function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
    const tmp = await Deno_.makeTempDir({prefix: 'batch-derivation-test-'});
    try {
        await Deno_.mkdir(`${tmp}/store`, {recursive: true});
        await fn(tmp);
    } finally {
        await Deno_.remove(tmp, {recursive: true});
    }
}

// ---------------------------------------------------------------------------------
// --- Subprocess matrix -------------------------------------------------------------
// ---------------------------------------------------------------------------------

test("batch matrix: depth-3 chain completes in EXACTLY 3 flush cycles, levels share one batch", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        // Cycle 1..3: each run enrolls the whole current frontier (3 chains x
        // 1 stage) as ONE batch - no cross-level serialization.
        for(let cycle = 1; cycle <= 3; cycle++) {
            const r = await runPass(tmp, 'chain3');
            assertEquals(r.report!.classification, 'progress', `cycle ${cycle}`);
            assertEquals(r.report!.deferred, 3, `cycle ${cycle} defers all chains`);
            assertEquals(r.report!.createCalls, cycle, `one new batch per cycle`);
            const batches = await fake.list();
            assertEquals((await fake.requestsOf(batches[0].id)).length, 3,
                         `cycle ${cycle}: all 3 chains' frontier in one batch`);
            await fake.completeAll();
        }
        // Cycle 4: everything lands; no new work, no new spend.
        const final = await runPass(tmp, 'chain3');
        assertEquals(final.report!.classification, 'done');
        assertEquals(final.report!.completed, 3);
        assertEquals(final.report!.createCalls, 3);         // still 3: depth, not depth+1
        assertEquals(await doneUnits(tmp), ['chain1', 'chain2', 'chain3']);
        assertEquals(await pendingMarkers(tmp), []);        // all markers cleaned
    });
});

test("batch matrix: fan-out - M independent units, one batch, one cycle", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const r1 = await runPass(tmp, 'fanout');
        assertEquals(r1.report!.deferred, 5);
        assertEquals(r1.report!.createCalls, 1);
        assertEquals((await fake.requestsOf((await fake.list())[0].id)).length, 5);
        await fake.completeAll();
        const r2 = await runPass(tmp, 'fanout');
        assertEquals(r2.report!.classification, 'done');
        assertEquals(r2.report!.completed, 5);
        assertEquals(r2.report!.createCalls, 1);
        assertEquals((await doneUnits(tmp)).length, 5);
    });
});

test("batch matrix: enroll-before-await holds the depth bound; sequential awaits degrade", async () => {
    // The DISCIPLINE (awaitAll): both siblings enroll in cycle 1.
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const r1 = await runPass(tmp, 'sibling');
        assertEquals((await fake.requestsOf((await fake.list())[0].id)).length, 2,
                     'both siblings in the first batch');
        assertEquals(r1.report!.createCalls, 1);
        await fake.completeAll();
        const r2 = await runPass(tmp, 'sibling');
        assertEquals(r2.report!.classification, 'done');    // 1 cycle for 2 siblings
    });
    // The ANTI-pattern (await X; await Y): X's throw unwinds before Y
    // enrolls -> 2 cycles for the same work.  Pins WHY the discipline is a
    // requirement, not a style preference.
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const r1 = await runPass(tmp, 'serial');
        assertEquals((await fake.requestsOf((await fake.list())[0].id)).length, 1,
                     'only sibA enrolled - sibB never reached');
        await fake.completeAll();
        const r2 = await runPass(tmp, 'serial');
        assertEquals(r2.report!.classification, 'progress'); // sibB only NOW enrolls
        assertEquals(r2.report!.createCalls, 2);
        await fake.completeAll();
        const r3 = await runPass(tmp, 'serial');
        assertEquals(r3.report!.classification, 'done');
    });
});

test("batch matrix: crash AFTER submit, before markers - no double-submit, results land", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        // Run 1 dies mid-flush: the batch exists (paid) but no marker knows it.
        const r1 = await runPass(tmp, 'fanout', {LIMINAL_BATCH_CRASH: 'after-submit'});
        assertEquals(r1.code, 9);
        assertEquals(await fake.createCallCount(), 1);
        for(const m of await pendingMarkers(tmp))
            assertEquals(JSON.parse(await Deno_.readTextFile(m)).batchId, undefined,
                         'markers never learned the batch id');

        // Run 2: markers without batch ids + an unaccounted in-progress batch
        // -> conservative DEFER (the money property beats latency): NOTHING
        // resubmitted.
        const r2 = await runPass(tmp, 'fanout');
        assertEquals(r2.report!.classification, 'pure-wait');
        assertEquals(r2.report!.createCalls, 1);            // NO second submit

        // The orphan batch ends; run 3 reconnects by custom_id and completes.
        await fake.completeAll();
        const r3 = await runPass(tmp, 'fanout');
        assertEquals(r3.report!.classification, 'done');
        assertEquals(r3.report!.completed, 5);
        assertEquals(r3.report!.createCalls, 1);            // total spend: ONE batch
    });
});

test("batch matrix: crash BEFORE flush - nothing paid, clean re-enroll", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const r1 = await runPass(tmp, 'fanout', {LIMINAL_BATCH_CRASH: 'before-flush'});
        assertEquals(r1.code, 9);
        assertEquals(await fake.createCallCount(), 0);      // nothing submitted
        const r2 = await runPass(tmp, 'fanout');            // no in-flight batches -> re-enroll
        assertEquals(r2.report!.createCalls, 1);
        await fake.completeAll();
        const r3 = await runPass(tmp, 'fanout');
        assertEquals(r3.report!.classification, 'done');
        assertEquals(r3.report!.createCalls, 1);
    });
});

test("batch matrix: marker LOSS - list-and-reconnect lands by custom_id, no resubmit", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        await runPass(tmp, 'fanout');
        for(const m of await pendingMarkers(tmp))           // lose EVERY marker
            await Deno_.remove(m);
        await fake.completeAll();
        const r2 = await runPass(tmp, 'fanout');
        assertEquals(r2.report!.classification, 'done');
        assertEquals(r2.report!.completed, 5);
        assertEquals(r2.report!.createCalls, 1);            // recovered, not re-paid
    });
});

test("batch matrix: partial failure - succeeded land; errored/expired retry next run", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        await runPass(tmp, 'partial');
        const b1 = (await fake.list())[0];
        const [q1, q2] = await fake.requestsOf(b1.id);
        await fake.complete(b1.id, req =>
            req.customId === q1.customId ? {type: 'errored', error: {message: 'boom'}}
            : req.customId === q2.customId ? {type: 'expired'}
            : {type: 'succeeded', message: fakeSucceededMessage(req.customId)});

        // Run 2: the success completes its unit; the two failures re-enroll.
        const r2 = await runPass(tmp, 'partial');
        assertEquals(r2.report!.classification, 'progress');
        assertEquals(r2.report!.completed, 1);
        assertEquals(r2.report!.createCalls, 2);
        assertEquals((await fake.requestsOf((await fake.list())[0].id)).length, 2);

        await fake.completeAll();
        const r3 = await runPass(tmp, 'partial');
        assertEquals(r3.report!.classification, 'done');
        assertEquals((await doneUnits(tmp)).length, 3);
    });
});

test("batch matrix: the no-AI flag - primed store rebuilds clean; a miss trips LOUDLY at enrollment", async () => {
    // Fully-landed pass under the ban: zero backend calls, still 'done'.
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        await runPass(tmp, 'fanout');
        await fake.completeAll();
        await runPass(tmp, 'fanout');                       // land everything
        const banned = await runPass(tmp, 'fanout', {LIMINAL_NO_LLM: '1'});
        assertEquals(banned.report!.classification, 'done');
        assertEquals(banned.report!.completed, 5);
        assertEquals(banned.report!.createCalls, 1);        // untouched
    });
    // A MISS under the ban: the §12b acceptance-gate behaviour - enrollment
    // throws immediately, naming itself; nothing submitted, no marker.
    await withTmp(async tmp => {
        const r = await runPass(tmp, 'fanout', {LIMINAL_NO_LLM: '1'});
        assertEquals(r.report!.failed, 5);
        assertStringIncludes(r.report!.failures[0], 'AI call blocked');
        assertEquals(r.report!.createCalls, 0);
        assertEquals(await pendingMarkers(tmp), []);        // gate fires BEFORE the marker
    });
});

test("batch matrix: pure-wait does not spin or spend", async () => {
    await withTmp(async tmp => {
        await runPass(tmp, 'fanout');
        const r2 = await runPass(tmp, 'fanout');            // batch still in flight
        assertEquals(r2.report!.classification, 'pure-wait');
        assertEquals(r2.report!.createCalls, 1);            // nothing new
        assertEquals(r2.report!.submitted, 0);
    });
});

// ---------------------------------------------------------------------------------
// --- In-process properties ---------------------------------------------------------
// ---------------------------------------------------------------------------------

function textStage(name: string): ExtractStage {
    return {name, model: 'fake-model', promptVersion: 1, imageBox: 0,
            schema: {type: 'object'},
            prompt: input => `${name} given ${JSON.stringify(input ?? null)}`};
}

/** A sync Llm stub: records calls, returns a canned object. */
function stubLlm(): Llm & {calls: number} {
    return {
        available: true,
        calls: 0,
        async extract() { (this as any).calls++; return {stubbed: true}; },
    } as any;
}

test("batch: interactive isolation - no batch context means the sync path, no enrollment", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const llm = stubLlm();
        const cfg: ExtractConfig = {
            derivedDir: `${tmp}/store`,
            image: {containedBytes: () => { throw new Error('text-only'); }},
            llm,
        };                                                  // note: NO batch
        const out = await extractTextStage(cfg, textStage('interactive'), {q: 1});
        assertEquals(out, {stubbed: true});
        assertEquals(llm.calls, 1);                         // called synchronously
        assertEquals(await fake.createCallCount(), 0);      // backend untouched
        assertEquals(await pendingMarkers(tmp), []);        // nothing enrolled
    });
});

test("batch: the shared cache - sync-primed results serve batch mode and vice versa (keystone 0)", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const stage = textStage('shared');

        // Prime via SYNC.
        const syncLlm = stubLlm();
        const syncCfg: ExtractConfig = {
            derivedDir: `${tmp}/store`,
            image: {containedBytes: () => { throw new Error('text-only'); }},
            llm: syncLlm,
        };
        await extractTextStage(syncCfg, stage, {q: 'sync-primed'});
        assertEquals(syncLlm.calls, 1);

        // The SAME derivation in BATCH mode: a cache hit - no enrollment, no
        // backend call, no sync call, identical value.
        const batchCfg: ExtractConfig = {
            ...syncCfg,
            llm: stubLlm(),                                 // would count if touched
            batch: new BatchContext(fake),
        };
        const out = await extractTextStage(batchCfg, stage, {q: 'sync-primed'});
        assertEquals(out, {stubbed: true});
        assertEquals((batchCfg.llm as any).calls, 0);
        assertEquals(await fake.createCallCount(), 0);
        assertEquals(await pendingMarkers(tmp), []);

        // And the reverse: prime via BATCH...
        const batch2 = new BatchContext(fake);
        const cfg2: ExtractConfig = {...batchCfg, batch: batch2};
        let threw: unknown;
        try { await extractTextStage(cfg2, stage, {q: 'batch-primed'}); }
        catch (e) { threw = e; }
        assert(threw instanceof DerivationNotAvailable, 'first batch call defers');
        await batch2.flush();
        await fake.completeAll();
        const landCfg: ExtractConfig = {...batchCfg, batch: new BatchContext(fake)};
        const landed = await extractTextStage(landCfg, stage, {q: 'batch-primed'});
        assertEquals(landed, {fakeEcho: (landed as any).fakeEcho});   // the fake's echo shape

        // ...then read it in SYNC mode: pure cache hit, llm never called.
        const syncLlm2 = stubLlm();
        await extractTextStage({...syncCfg, llm: syncLlm2}, stage, {q: 'batch-primed'});
        assertEquals(syncLlm2.calls, 0);
    });
});

test("batch: flush chunks to the per-batch caps", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const ctx = new BatchContext(fake, {maxRequestsPerBatch: 2});
        for(let i = 1; i <= 5; i++)
            await ctx.resolve({contentPath: `${tmp}/store/extractions/k${i}.json`, hash: `hash-${i}`},
                              async () => ({model: 'fake-model', n: i}));
        const created = await ctx.flush();
        assertEquals(created.map(b => b.requestCounts.processing), [2, 2, 1]);
        assertEquals(await fake.createCallCount(), 3);
    });
});

test("batch: retry cap - a permanently failing request stops costing money", async () => {
    await withTmp(async tmp => {
        const fake = fakeOf(tmp);
        const address = {contentPath: `${tmp}/store/extractions/bad.json`, hash: 'bad-hash'};
        const failAll = () => fake.completeAll(_req => ({type: 'errored' as const,
                                                        error: {message: 'always bad'}}));

        // Enroll + fail, retry (paid) + fail...
        const c1 = new BatchContext(fake, {maxRetries: 1});
        assertEquals((await c1.resolve(address, async () => ({model: 'm'}))).kind, 'pending');
        await c1.flush();
        await failAll();
        const c2 = new BatchContext(fake, {maxRetries: 1});
        assertEquals((await c2.resolve(address, async () => ({model: 'm'}))).kind, 'pending');
        assertEquals(c2.stats.retried, 1);
        assertEquals((await readPending(address.contentPath))?.retries, 1);
        await c2.flush();
        await failAll();

        // ...cap reached: hard failure, NOT another enrollment.
        const c3 = new BatchContext(fake, {maxRetries: 1});
        const r = await c3.resolve(address, async () => ({model: 'm'}));
        assertEquals(r.kind, 'failed');
        assertStringIncludes((r as any).reason, 'retry cap');
        assertEquals(await ctxEnrolled(c3), 0);
        assertEquals(await fake.createCallCount(), 2);      // spend stopped at the cap
    });
});

async function ctxEnrolled(ctx: BatchContext): Promise<number> {
    return (await ctx.flush()).reduce((n, b) => n + b.requestCounts.processing, 0);
}
