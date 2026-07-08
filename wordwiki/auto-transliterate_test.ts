// deno-lint-ignore-file no-explicit-any
/**
 * Auto-transliteration (auto-transliterate.ts + transliterate.ts): the
 * corpus-derived rules, the proposal verb's button rules (fill gaps only,
 * never re-offer rejected output, version stamp, robot author), approve-all's
 * structural exclusion + the explicit escape hatch, the evidence-in-row, and
 * the corrections report.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { withTestDb, as, bornApprove, renderRoute, invoke,
         TestTimeline, mkEntry, mkChild, type Fixture } from './testing.ts';
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import { transliterateLiToSf, transliterateLiToSfScored, transliterateCandidates,
         transliterationRiskMarkers,
         TRANSLITERATOR_VERSION, transliterateJavaRules,
         transliterateJavaScanner } from './transliterate.ts';
import { pairJunkReason } from './auto-transliterate.ts';
import * as entrySchema from './entry-schema.ts';
import { proposeTransliterations, pureTextRelations,
         AUTO_TRANSLITERATE_USERNAME } from './auto-transliterate.ts';

const EOT = timestamp.END_OF_TIME;

// --- the rules (corpus-verified examples) -------------------------------------

test("rules: g→k and the sonorant-cluster apostrophe (corpus-verified)", () => {
    assertEquals(transliterateLiToSf('angamatl'), 'ankamatl');   // g→k; nk takes no '
    assertEquals(transliterateLiToSf('weltaq'), "wel'taq");      // l before t gains '
    assertEquals(transliterateLiToSf('anawtig'), 'anawtik');     // w+t: NO insertion
    assertEquals(transliterateLiToSf('Gesig'), 'Kesik');         // case preserved
    assertEquals(transliterateLiToSf("gnt"), "kn't");            // n before t gains the apostrophe
    // rules-v2 (oracle-mined): the ult exception, word-start sonorants, and
    // whole-word lexical exceptions.
    assertEquals(transliterateLiToSf('apjelmultimgewei'), 'apjelmultimkewei');
    assertEquals(transliterateLiToSf('Lpa'), 'Lpa');
    assertEquals(transliterateLiToSf('ugjit nemitg'), 'wjit nemitk');
    assertEquals(transliterateLiToSf('alp'), "al'p");            // u+l+p still inserts
});

test("rules: the v1 scope is schema-driven pure variant text relations", async () => {
    await withTestDb((fx) => {
        const tags = [...pureTextRelations(fx.ww.dictSchema).keys()].sort();
        // Pure text: spellings, example texts, alternate forms, regional
        // forms.  NOT the $mixed reference fields, NOT recordings, NOT
        // status/todo ($metaVariant), NOT related_entry (no variant at all).
        assertEquals(tags, ['alx', 'etx', 'orf', 'spl']);
    });
});

// --- the proposal verb ---------------------------------------------------------

function seedWord(fx: Fixture, entry_id = 1000, li = 'angamatl'): void {
    const tl = new TestTimeline();
    const e = mkEntry(entry_id, tl.next());
    fx.ww.applyTransaction([e], {quiet: true});
    fx.ww.applyTransaction([mkChild(e, 'spl', entry_id + 1, tl.next(),
                                    {attr1: li, variant: 'mm-li'})], {quiet: true});
    bornApprove(fx.ww);
}

const sfRows = (entry_id: number) => db().all<any, any>(
    `SELECT * FROM dict WHERE ty = 'spl' AND id1 = :e AND variant = 'mm-sf'
     ORDER BY valid_from, assertion_id`, {e: entry_id});

test("transliterate: proposes a pending robot fact; fill-gaps + rejected rules", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        const r = await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));
        assertEquals(r.action, 'reload');

        const rows = sfRows(1000);
        assertEquals(rows.length, 1);
        const p = rows[0];
        assertEquals(p.attr1, 'ankamatl');                              // the rules ran
        assertEquals(p.change_by_username, AUTO_TRANSLITERATE_USERNAME); // robot author
        assert(String(p.change_arg).startsWith(TRANSLITERATOR_VERSION)); // version stamp (+ conf/band)
        assertEquals(p.published_from, null);                           // pending, not approved

        // FILL GAPS ONLY: a second click proposes nothing (live sf exists).
        const r2 = await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));
        assertEquals(r2.action, 'alert');
        assertEquals(sfRows(1000).length, 1);

        // REJECT the proposal (a revert of a never-published fact = a
        // tombstone), then click again: the SAME output is never re-offered.
        await as(fx, 'djz', () => fx.ww.lexemeOps.revertFact(p.id, 'not a word'));
        const r3 = await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));
        assertEquals(r3.action, 'alert');
        assert(String(r3.message).includes('rejected'), 'names the reason');
        const direct = proposeTransliterations(fx.ww, 1000);
        assertEquals(direct.proposed, 0);
        assertEquals(direct.rejectedBefore, 1);
    });
});

test("transliterate: never proposes over an existing human Smith-Francis text", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        const tl = new TestTimeline();
        const e = {assertion_id: 1000, id: 1000, ty: 'ent', ty0: 'dct', ty1: 'ent', id1: 1000} as any;
        fx.ww.applyTransaction([mkChild(e, 'spl', 1500, tl.next(),
                                        {attr1: 'human-sf', variant: 'mm-sf'})], {quiet: true});
        const stats = proposeTransliterations(fx.ww, 1000);
        assertEquals(stats.proposed, 0);
        assertEquals(stats.filledAlready, 1);
    });
});

// --- approve-all exclusion + escape hatch --------------------------------------

test("approve-all excludes robot proposals; the explicit hatch approves them", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        // A human pending edit AND a robot proposal.
        await as(fx, 'test', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: '1001', replaces_assertion_id: '1001',
            'before-text': 'angamatl', text: 'angamatl2', 'before-variant': 'mm-li', variant: 'mm-li',
        }));
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));

        // The changes bar names the exclusion and offers the hatch.
        const bar = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.metaChangesBarFragment(1000, true)')));
        assert(bar.includes('Approve 1 auto-transliteration'), 'escape hatch offered');

        // Approve all: the human edit publishes, the robot proposal does NOT.
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.approveAllChanges($arg0)`, 1000));
        const li = db().all<any, any>(
            `SELECT * FROM dict WHERE ty='spl' AND id1=1000 AND variant='mm-li'
             AND valid_to = :eot`, {eot: EOT})[0];
        assert(li.published_to === EOT, 'human edit approved');
        const sf = sfRows(1000).at(-1);
        assertEquals(sf.published_from, null, 'robot proposal still pending');

        // The hatch approves it (normal op: robot author, human approver).
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.approveAutoTransliterations($arg0)`, 1000));
        const approved = sfRows(1000).at(-1);
        assertEquals(approved.change_action, 'approved');
        assertEquals(approved.published_to, EOT);
        assertEquals(approved.change_by_username, 'djz');
    });
});

// --- evidence-in-row ------------------------------------------------------------

test("a pending auto fact shows its Listuguj source on the row", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));
        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.renderMetaEntry(1000)')));
        assert(html.includes('from Listuguj:'), 'evidence label');
        assert(html.includes('angamatl'), 'the li source text');
    });
});

// --- the corrections report ------------------------------------------------------

test("corrections report: corrected and rejected proposals become the corpus", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));
        const auto = sfRows(1000)[0];
        // A human CORRECTS the proposal (with the why-note).
        await as(fx, 'djz', () => invoke(fx.ww, 'wordwiki.lexeme.saveTuple($arg0)', {
            entry_id: '1000', fact_id: String(auto.id),
            replaces_assertion_id: String(auto.assertion_id),
            'before-text': 'ankamatl', text: 'ankamatl-fixed',
            'before-variant': 'mm-sf', variant: 'mm-sf',
            change_note: 'irregular form',
        }));

        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.transliterationReports.correctionsReport()')));
        assert(html.includes('angamatl'), 'li source column');
        assert(html.includes('ankamatl'), 'the auto proposal');
        assert(html.includes('ankamatl-fixed'), 'the human correction');
        assert(html.includes('irregular form'), 'the why-note harvested');
        assert(html.includes(TRANSLITERATOR_VERSION), 'per-version stats');
    });
});

// --- the ported previous-generation transliterators (Transliterate.java) -------

test("java ports: faithful behavior (pinned against the source's semantics)", () => {
    // The rules pipeline: g->k first, then rule 170's barred-i (the Java
    // literal is CAPITAL Î) into triple consonant clusters.
    assertEquals(transliterateJavaRules('cgk'), 'ck\u00cek');
    assertEquals(transliterateJavaRules('amalaptqg'), 'amalapt\u00ceqk');
    // Rule 120: schwa removed after p/t/s/k; a vowel's length-apostrophe kept.
    assertEquals(transliterateJavaRules("t'a'x"), "ta'x");
    // A faithful QUIRK of the Java pipeline: rule 140 inserts word-initial
    // l', but rule 160 (remove remaining schwas, C') runs later and strips
    // it again - the isolated per-rule tests in the Java source never see
    // the composition.  Pinned as-is: the port reproduces the pipeline.
    assertEquals(transliterateJavaRules("loll"), 'loll');
    assertEquals(transliterateJavaRules("l'oll"), 'loll');
    // The scanner: C' -> C + lowercase î; ei at word end -> ey.
    assertEquals(transliterateJavaScanner("g'p'ta'nei"), 'k\u00eep\u00eeta\u2019ney'.replaceAll('\u2019', "'"));
    // The commented-out sonorant block, enabled, is rules-v1's second rule.
    assertEquals(transliterateJavaScanner('weltaq', {withSonorantCluster: true}), "wel'taq");
    assertEquals(transliterateJavaScanner('weltaq'), 'weltaq');
});

// --- confidence scoring ----------------------------------------------------------

test("confidence: markers detected; calibrated bands spread; conservative fallback", () => {
    assertEquals(transliterationRiskMarkers('gesatg'), []);                    // clean
    assertEquals(transliterationRiskMarkers('weltaq'), ['sonorant-cluster']);
    assertEquals(transliterationRiskMarkers('algwiluatl'), ['l-before-k']);
    assertEquals(transliterationRiskMarkers('welgtaq nemitg'),
                 ['l-before-k']);
    // The scored pair: text = the plain function; confidence = the band's
    // MEASURED accuracy (clean is the best band; l-before-k the worst).
    const clean = transliterateLiToSfScored('gesatg');
    const hard = transliterateLiToSfScored('algiluatl');   // l-before-k, no cluster
    assertEquals(clean.text, transliterateLiToSf('gesatg'));
    assert(clean.confidence > hard.confidence, 'clean band above l-before-k band');
    assert(hard.band === 'low' || hard.band === 'uncertain', 'lg words are flagged');
    assert(clean.version.includes(TRANSLITERATOR_VERSION), 'version stamped');
});

test("oracle filter: an sf identical to its li DESPITE g is a suspected copy", () => {
    assertEquals(pairJunkReason('angua', 'angua', 'spl'),
                 'identical despite g (suspected unconverted copy)');
    assertEquals(pairJunkReason('samqwan', 'samqwan', 'spl'), undefined);  // legit coincidence
});

test("proposals are stamped with the calibrated band; the report shows per-band outcomes", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);   // li = 'angamatl' (clean: nk takes no marker... has none)
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));
        const p = sfRows(1000)[0];
        assert(String(p.change_arg).startsWith(TRANSLITERATOR_VERSION), 'version first');
        assert(/conf=\d+/.test(p.change_arg), 'confidence stamped');
        assert(/band=\w+/.test(p.change_arg), 'band stamped');

        const html = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.transliterationReports.correctionsReport()')));
        assert(html.includes('Outcomes by confidence band'), 'per-band table');
        // The review row shows the band beside the evidence.
        const row = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.renderMetaEntry(1000)')));
        assert(/~\d+% \w+/.test(row), 'band label on the pending row');
    });
});

// --- ranked candidates + click-to-pick -------------------------------------------

test("candidates: ranked, deduped, decisions named; v3 top-1 is the engine", () => {
    const cands = transliterateCandidates('weltaq');
    assert(cands.length >= 2, 'ambiguous word offers alternates');
    assertEquals(cands[0].text, transliterateLiToSf('weltaq'));   // top-1 IS the engine
    assert(cands.some(c => c.text === "wel'taq") && cands.some(c => c.text === 'weltaq'),
           'both branches offered');
    assert(cands[0].probability >= cands[1].probability, 'ranked');
    assert(cands.some(c => c.decisions.some(d => d.includes('l·t'))), 'decisions named');
    // No ambiguous site: exactly one candidate.
    assertEquals(transliterateCandidates('gesatg').length, 1);
});

test("pick: replaces the robot's text with the chosen candidate and approves it", async () => {
    await withTestDb(async (fx) => {
        seedWord(fx);   // li 'angamatl' at fact 1201's relation
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.transliterate($arg0)`, 1000));
        const sf = sfRows(1000)[0];
        // The row offers pick chips for the alternates.
        const row = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.lexeme.renderMetaEntry(1000)')));
        assert(row.includes('pickTransliteration'), 'chips offered');
        // Pick candidate #1 (an alternate): the fact's text becomes that
        // candidate and it is APPROVED in one act (bounded self-approve).
        const wantAlt = transliterateCandidates('angamatl', 5)[1];
        await as(fx, 'djz', () =>
            invoke(fx.ww, `wordwiki.lexeme.pickTransliteration($arg0, $arg1, 1)`,
                   1000, sf.id));
        const versions = fx.ww.workspace.getTableByTag(entrySchema.DictTag)
            .getTupleById(sf.id)!.tupleVersions.map(v => v.assertion);
        // The chain: robot proposal -> the PICK (human-authored, labeled) ->
        // the approve receipt (published dimension stamped).
        const after = versions.at(-1)!;
        assertEquals(after.attr1, wantAlt.text);
        assert(after.published_from != null, 'pick approves in one act');
        const pick = versions.find(a => a.change_action === 'pick-transliteration')!;
        assert(pick, 'the pick version exists');
        assert(String(pick.change_arg).includes('pick=1'), 'the labeled branch decision');
        assertEquals(pick.attr1, wantAlt.text);
    });
});
