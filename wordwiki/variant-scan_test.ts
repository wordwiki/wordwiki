// deno-lint-ignore-file no-explicit-any
/**
 * The variant data scan (variant-scan.ts) over seeded dict rows, against a
 * test schema exercising each flag class: keeper (spl), $notVariant (rec),
 * variant-less (nte).  Also the shared variant-policy helpers and the
 * warn-mode validator invariants (validateVariantInvariants) over the same
 * seeded workspace — scan and validator must agree.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, TestTimeline, mkEntry, mkChild, mkTombstone, type Fixture } from "./testing.ts";
import * as model from "./model.ts";
import { FindingsReport } from "./findings.ts";
import { scanVariants } from "./variant-scan.ts";
import { variantPolicyByTag, allowedVariantValues, variantMatches, variantsOverlap,
         variantMatchSql } from "./variant-policy.ts";
import { validateVariantInvariants, factViewsFromVersionedDb } from "./versioned-db-validate.ts";

const VOCABULARY = ['mm-li', 'mm-sf', 'mm-mp', 'mm-pm', 'mm'];

// Real tags with the target-model flags (independent of whether
// entry-schema.ts carries them yet): spelling is a pure orthographic keeper,
// recording is $notVariant, note has no variant field.
const testSchema = model.Schema.parseSchemaFromCompactJson('dict', {
    $type: 'schema', $name: 'dict', $tag: 'dct',
    entry: {
        $type: 'relation', $tag: 'ent',
        entry_id: {$type: 'primary_key'},
        spelling: {
            $type: 'relation', $tag: 'spl',
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'},
        },
        recording: {
            $type: 'relation', $tag: 'rec',
            recording_id: {$type: 'primary_key'},
            recording: {$type: 'audio', $bind: 'attr1'},
            variant: {$type: 'variant', $notVariant: true},
        },
        note: {
            $type: 'relation', $tag: 'nte',
            note_id: {$type: 'primary_key'},
            note: {$type: 'string', $bind: 'attr1'},
        },
    },
});

// --- policy helpers -----------------------------------------------------------

test("variantPolicyByTag classifies keeper / $notVariant / variant-less tags", () => {
    const policy = variantPolicyByTag(testSchema);
    assertEquals(policy.get('spl')!.flags!.notVariant, false);
    assertEquals(policy.get('rec')!.flags!.notVariant, true);
    assertEquals(policy.get('nte')!.flags, null);
});

test("allowedVariantValues grants 'mm' only under $allowAll", () => {
    assert(!allowedVariantValues({}, VOCABULARY).has('mm'));
    assert(allowedVariantValues({allowAll: true}, VOCABULARY).has('mm'));
    assert(allowedVariantValues({}, VOCABULARY).has('mm-li'));
});

test("variantMatches: exact, 'mm' wildcard, legacy blank tolerance", () => {
    assert(variantMatches('mm-li', 'mm-li'));
    assert(!variantMatches('mm-li', 'mm-sf'));
    assert(variantMatches('mm', 'mm-sf'));      // wildcard renders everywhere
    assert(variantMatches(null, 'mm-sf'));      // legacy blank, pre-migration
    assert(variantMatches('', 'mm-li'));
});

test("variantsOverlap: the pair form", () => {
    assert(variantsOverlap('mm-li', 'mm-li'));
    assert(!variantsOverlap('mm-li', 'mm-sf'));
    assert(variantsOverlap('mm', 'mm-li'));     // the doc's mm-vs-mm-li case
    assert(variantsOverlap(null, 'mm-sf'));
});

test("variantMatchSql: exact without $allowAll, exact-or-'mm' with", () => {
    assertEquals(variantMatchSql({}, 'variant', ':o'), "variant = :o");
    assertEquals(variantMatchSql({allowAll: true}, 'variant', ':o'), "variant IN (:o, 'mm')");
});

// --- seeded scan --------------------------------------------------------------

interface Seeded { dirty: boolean }

function seed(fx: Fixture, {dirty}: Seeded) {
    const tl = new TestTimeline();
    const e = mkEntry(1000, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    const add = (ty: string, id: number, fields: any) =>
        fx.ww.applyTransaction([mkChild(e, ty, id, tl.next(), fields)], {quiet: true});

    add('spl', 1010, {attr1: 'samqwan', variant: 'mm-li'});    // clean keeper
    add('spl', 1011, {attr1: 'samkwan', variant: ''});         // blank (backfill)
    if(dirty) {
        add('spl', 1012, {attr1: 'plamu', variant: "us's'g"}); // spelling text in variant
        add('spl', 1013, {attr1: 'gopit', variant: 'mm'});     // mm without $allowAll
        add('rec', 1020, {attr1: 'r.mp3', variant: 'mm-li'});  // droppable, gate-ok
        add('rec', 1021, {attr1: 'r2.mp3', variant: 'zzz'});   // GATE FAIL
        add('nte', 1030, {attr1: 'a note', variant: 'mm-li'}); // variant-less tag
        // A tombstoned bad row must NOT count (current rows only).
        const bad = mkChild(e, 'spl', 1014, tl.next(), {attr1: 'x', variant: 'garbage'});
        fx.ww.applyTransaction([bad], {quiet: true});
        fx.ww.applyTransaction([mkTombstone(bad, 1015, tl.next())], {quiet: true});
    }
}

test("scan: clean-ish db passes the gate; blanks are findings, not failures", async () => {
    await withTestDb((fx) => {
        seed(fx, {dirty: false});
        const report = new FindingsReport('scan', {quiet: true});
        const {gatePassed} = scanVariants(report, testSchema, VOCABULARY);
        assert(gatePassed);
        const md = report.toMarkdown();
        assertStringIncludes(md, 'Drop gate: PASS');
        // The blank spl is a backfill finding.
        assertStringIncludes(md, "Spelling:");
        assertStringIncludes(md, '1 blank variant(s) of 2 current rows');
    });
});

test("scan: dirty db fails the gate and reports each dirt class with samples", async () => {
    await withTestDb((fx) => {
        seed(fx, {dirty: true});
        const report = new FindingsReport('scan', {quiet: true});
        const {gatePassed} = scanVariants(report, testSchema, VOCABULARY);
        assert(!gatePassed);
        const md = report.toMarkdown();
        assertStringIncludes(md, 'Drop gate: FAIL');
        assertStringIncludes(md, "'zzz' ×1");                    // gate finding
        assertStringIncludes(md, "'us's'g' ×1");                 // off-vocabulary
        assertStringIncludes(md, "'mm' ×1");                     // mm w/o $allowAll
        assertStringIncludes(md, "no variant field but holds 'mm-li'"); // nte
        // Samples carry lexeme links to the owning entry.
        assertStringIncludes(md, '[plamu](/ww/wordwiki.entry(1000))');
        // The tombstoned 'garbage' row is excluded (current rows only).
        assert(!md.includes('garbage'));
    });
});

// --- warn-mode validator invariants over the same workspace --------------------

test("validateVariantInvariants agrees with the scan (current live rows only)", async () => {
    await withTestDb((fx) => {
        seed(fx, {dirty: true});
        const problems = validateVariantInvariants(
            factViewsFromVersionedDb(fx.ww.workspace),
            variantPolicyByTag(testSchema), VOCABULARY);
        const byInvariant = new Map<string, number>();
        for(const p of problems)
            byInvariant.set(p.invariant, (byInvariant.get(p.invariant) ?? 0) + 1);
        assertEquals(byInvariant.get('variant-missing'), 1);            // blank spl
        assertEquals(byInvariant.get('variant-off-vocabulary'), 2);     // us's'g + mm
        assertEquals(byInvariant.get('variant-on-dropped-tag'), 2);     // rec mm-li + zzz
        assertEquals(byInvariant.get('variant-on-variantless-tag'), 1); // nte
        // Tombstoned facts are skipped: nothing mentions the 'garbage' row.
        assert(!problems.some(p => p.detail.includes('garbage')));
    });
});

test("validateVariantInvariants is quiet on clean data", async () => {
    await withTestDb((fx) => {
        const tl = new TestTimeline();
        const e = mkEntry(2000, tl.next());
        fx.ww.applyTransaction([e], {quiet: true});
        fx.ww.applyTransaction([mkChild(e, 'spl', 2010, tl.next(),
                                        {attr1: 'plamu', variant: 'mm-li'})], {quiet: true});
        const problems = validateVariantInvariants(
            factViewsFromVersionedDb(fx.ww.workspace),
            variantPolicyByTag(testSchema), VOCABULARY);
        assertEquals(problems, []);
    });
});

// --- the LIVE cleanup report route ---------------------------------------------

test("cleanup report: renders via dispatch (route declared), live view", async () => {
    await withTestDb(async (fx) => {
        seed(fx, {dirty: false});
        const { as, renderRoute } = await import('./testing.ts');
        const markup = await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.variants.cleanupReport()'));
        const html = (await import('../liminal/markup.ts')).markupToString(markup);
        assertStringIncludes(html, 'Variant (orthography) cleanup');
        assertStringIncludes(html, 'LIVE view');
    });
});
