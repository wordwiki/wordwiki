// deno-lint-ignore-file no-explicit-any
/**
 * getDerived concurrency safety: two concurrent generations of the SAME content
 * id must not share temp files.  Regression for the audio-trim "fell back to the
 * source" failure - the trim's intermediate `<tmp>.pre-fade.wav` (derived from
 * the tmp name) was deleted out from under a racing generation when the tmp name
 * was deterministic.
 */
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "./testing/assert.ts";
import { getDerived } from "./content-store.ts";

const Deno_ = (globalThis as any).Deno;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Mimics trimAudioCmd's two-pass shape: write a sibling intermediate derived
// from the tmp name, pause (widen the race window), read it back (the "fade
// pass"), then remove it.  If two concurrent calls shared the tmp name, the
// intermediate would be removed mid-flight and the read-back would throw.
async function fakeTwoPass(tmpTarget: string): Promise<void> {
    const pre = tmpTarget + '.pre-fade.wav';
    await Deno_.writeTextFile(pre, 'intermediate-bytes-well-over-forty-four-bytes-long-xxxxxxxx');
    await sleep(15);
    const data = await Deno_.readTextFile(pre);   // throws if a racer removed it
    await Deno_.writeTextFile(tmpTarget, data + ' FINAL');
    await Deno_.remove(pre).catch(() => {});
}

test("getDerived: concurrent same-key generation does not clobber temp files", async () => {
    const tmp = await Deno_.makeTempDir({prefix: 'content-store-test-'});
    try {
        const fns = { fakeTwoPass };
        const closure = ['fakeTwoPass'];   // identical key for every caller

        // 8 concurrent generations of the SAME content id.
        const ids = await Promise.all(
            Array.from({length: 8}, () =>
                getDerived(`${tmp}/store`, fns, closure, 'wav')));

        // All resolve to the same content id, and the installed artifact is the
        // real generated output (not a half-written/empty temp).
        assert(ids.every(id => id === ids[0]), 'all callers get the same content id');
        const out = `${tmp}/${ids[0]}`;
        assert(await fileExists(out), 'output artifact installed');
        assertStringIncludes(await Deno_.readTextFile(out), 'FINAL');

        // No stray temp files left behind in the store dir.
        const strays: string[] = [];
        for await (const e of Deno_.readDir(`${tmp}/store/${ids[0].split('/')[1]}`))
            if(e.name.includes('_tmp')) strays.push(e.name);
        assertEquals(strays, []);
    } finally {
        await Deno_.remove(tmp, {recursive: true});
    }
});

async function fileExists(p: string): Promise<boolean> {
    try { await Deno_.stat(p); return true; } catch { return false; }
}
