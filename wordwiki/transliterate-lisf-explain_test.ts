/**
 * li-sf's explain (I5): faithful to the engine (output == transliterateLiToSf),
 * the deterministic layer is genuine rule-data, and branch decisions carry
 * their measured probability + the alternative they beat.  No db.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { transliterateLiToSf, explainLiToSf, LI_SF_DETERMINISTIC_RULES } from "./transliterate.ts";
import { compileRules, renderTrace } from "./transliterate-rules.ts";

test("explainLiToSf: output is faithful to the engine", () => {
    for(const w of ['weltaq', 'aqantie\'umk', 'ugjit', 'weltag', 'Lpa', 'mijua\'ji\'j'])
        assertEquals(explainLiToSf(w).output, transliterateLiToSf(w), w);
});

test("li-sf deterministic layer is rule-data (lexical + g→k)", () => {
    const det = compileRules(LI_SF_DETERMINISTIC_RULES);
    assertEquals(det.transliterate('ugjit'), 'wjit');       // lexical exception
    assertEquals(det.transliterate('weltag'), 'weltak');    // g → k
    assert(!det.transliterate('weltaq').includes("'"));      // no branch apostrophes here
});

test("explainLiToSf: branch steps carry probability + alternative", () => {
    const t = explainLiToSf('weltaq');
    const branch = t.steps.find(s => s.probability !== undefined);
    assert(branch !== undefined, 'has a branch decision');
    assertEquals(branch!.after, 'wel\'taq');
    assertEquals(branch!.alternative, 'weltaq');            // the beaten branch
    assert(branch!.probability! > 0.5, `chosen branch p=${branch!.probability}`);
    // Steps chain: each after == the next before.
    for(let i = 1; i < t.steps.length; i++)
        assertEquals(t.steps[i].before, t.steps[i-1].after, `chain at ${i}`);
});

test("renderTrace: shows the branch decision annotation", () => {
    const lines = renderTrace(explainLiToSf('weltaq'));
    assert(lines.some(l => l.includes('chose p=') && l.includes('alt weltaq')), lines.join('\n'));
});
