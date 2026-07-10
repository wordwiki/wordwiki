// Layer 1 (extract.ts): the minimal schema validator, and the content-addressed
// caching that makes re-runs nearly free.  Uses a real temp derived dir (so getDerived
// actually writes/reads .json files) with a counting fake LLM and a fixed fake image
// source - no network.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "./testing/assert.ts";
import { extractStage, extractAll, validateExtraction,
         type ExtractConfig, type ExtractImageSource, type ExtractStage } from "./extract.ts";
import { type Llm, type LlmImage } from "./llm.ts";

// --- fakes -----------------------------------------------------------------------

const fixedImage: ExtractImageSource = {
    containedBytes: (_p, _w, _h, _r) => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
};

class CountingLlm implements Llm {
    readonly available = true;
    calls = 0;
    lastPrompt = '';
    constructor(private result: unknown) {}
    extract(_m: string, prompt: string, _i: LlmImage, _s: Record<string, unknown>): Promise<unknown> {
        this.calls++; this.lastPrompt = prompt;
        return Promise.resolve(this.result);
    }
}

const ROWS_SCHEMA = {type: 'object', properties: {rows: {type: 'array'}}, required: ['rows']};
const stage = (over: Partial<ExtractStage> = {}): ExtractStage => ({
    name: 'extract', model: 'm', promptVersion: 1, imageBox: 1600,
    schema: ROWS_SCHEMA, prompt: () => 'p', ...over,
});

async function withTempDerivedDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await Deno.makeTempDir({prefix: 'extract_test_'});
    try { await fn(dir); } finally { await Deno.remove(dir, {recursive: true}); }
}

// --- caching ---------------------------------------------------------------------

test("extractStage: identical inputs are a cache hit (LLM called once); result round-trips", async () => {
    await withTempDerivedDir(async (dir) => {
        const llm = new CountingLlm({rows: [{client_name: 'Jo'}]});
        const cfg: ExtractConfig = {derivedDir: dir, image: fixedImage, llm};
        const path = 'content/photos/aaa/aaa.jpg';

        const a = await extractStage(cfg, path, 0, stage(), null);
        assertEquals(a, {rows: [{client_name: 'Jo'}]});
        assertEquals(llm.calls, 1);

        const b = await extractStage(cfg, path, 0, stage(), null);   // same everything
        assertEquals(b, {rows: [{client_name: 'Jo'}]});
        assertEquals(llm.calls, 1, 'second identical call served from the derived-store cache');
    });
});

test("extractStage: rotate / promptVersion / imageBox / model each bust the cache", async () => {
    await withTempDerivedDir(async (dir) => {
        const llm = new CountingLlm({rows: []});
        const cfg: ExtractConfig = {derivedDir: dir, image: fixedImage, llm};
        const path = 'content/photos/bbb/bbb.jpg';

        await extractStage(cfg, path, 0, stage(), null);                          // 1
        assertEquals(llm.calls, 1);
        await extractStage(cfg, path, 90, stage(), null);                         // rotate -> 2
        assertEquals(llm.calls, 2);
        await extractStage(cfg, path, 0, stage({promptVersion: 2}), null);        // promptVersion -> 3
        assertEquals(llm.calls, 3);
        await extractStage(cfg, path, 0, stage({imageBox: 1024}), null);          // box -> 4
        assertEquals(llm.calls, 4);
        await extractStage(cfg, path, 0, stage({model: 'other'}), null);          // model -> 5
        assertEquals(llm.calls, 5);
        // ...and re-running the very first key is still a hit.
        await extractStage(cfg, path, 0, stage(), null);
        assertEquals(llm.calls, 5, 'original key still cached');
    });
});

test("extractStage: different prior-stage input busts the cache (per-stage keys)", async () => {
    await withTempDerivedDir(async (dir) => {
        const llm = new CountingLlm({rows: []});
        const cfg: ExtractConfig = {derivedDir: dir, image: fixedImage, llm};
        const path = 'content/photos/ccc/ccc.jpg';
        await extractStage(cfg, path, 0, stage(), {prior: 'A'});
        await extractStage(cfg, path, 0, stage(), {prior: 'A'});   // hit
        assertEquals(llm.calls, 1);
        await extractStage(cfg, path, 0, stage(), {prior: 'B'});   // different input -> miss
        assertEquals(llm.calls, 2);
    });
});

// --- recipe chaining -------------------------------------------------------------

test("extractAll: stage output feeds the next stage's prompt, in order", async () => {
    await withTempDerivedDir(async (dir) => {
        // The fake echoes each prompt, so we can see stage 2 received stage 1's output.
        const echoLlm: Llm = {
            available: true,
            extract: (_m, prompt) => Promise.resolve({echo: prompt}),
        };
        const cfg: ExtractConfig = {derivedDir: dir, image: fixedImage, llm: echoLlm};
        const recipe: ExtractStage[] = [
            stage({name: 's1', schema: {type: 'object'}, prompt: () => 'S1'}),
            stage({name: 's2', schema: {type: 'object'}, prompt: (input) => 'S2:' + JSON.stringify(input)}),
        ];
        const out = await extractAll(cfg, 'content/photos/ddd/ddd.jpg', 0, recipe) as {echo: string};
        assertStringIncludes(out.echo, 'S2:', 'final result is stage 2');
        assertStringIncludes(out.echo, 'S1', 'stage 2 saw stage 1 output');
    });
});

// --- validation ------------------------------------------------------------------

test("validateExtraction: accepts valid, rejects missing-required / wrong-type / bad-enum", () => {
    const schema = {type: 'object', required: ['client_name', 'service_kind'],
        properties: {
            client_name: {type: 'string'},
            service_kind: {type: 'string', enum: ['diy', 'full', 'other']},
            postal: {type: ['string', 'null']},
        }};
    // valid (postal null allowed by the union type)
    assertEquals(validateExtraction(schema, {client_name: 'Jo', service_kind: 'diy', postal: null}),
        {client_name: 'Jo', service_kind: 'diy', postal: null});

    let threw = (fn: () => void, needle: string) => {
        try { fn(); assert(false, 'should have thrown'); }
        catch (e) { assertStringIncludes(String(e), needle); }
    };
    threw(() => validateExtraction(schema, {service_kind: 'diy'}), "missing required property 'client_name'");
    threw(() => validateExtraction(schema, {client_name: 42, service_kind: 'diy'}), 'expected string');
    threw(() => validateExtraction(schema, {client_name: 'Jo', service_kind: 'bogus'}), 'expected one of');
});

test("validateExtraction: recurses into array items with a JSON path", () => {
    const schema = {type: 'array', items: {type: 'object', required: ['n'], properties: {n: {type: 'integer'}}}};
    assertEquals(validateExtraction(schema, [{n: 1}, {n: 2}]), [{n: 1}, {n: 2}]);
    try {
        validateExtraction(schema, [{n: 1}, {n: 1.5}]);
        assert(false, 'should have thrown');
    } catch (e) {
        assertStringIncludes(String(e), '$[1].n');   // path points at the bad element
        assertStringIncludes(String(e), 'expected integer');
    }
});

test("validateExtraction: no/unknown schema type imposes no structural check", () => {
    assertEquals(validateExtraction({}, {anything: [1, 2]}), {anything: [1, 2]});
    assertEquals(validateExtraction(undefined, 'whatever'), 'whatever');
});
