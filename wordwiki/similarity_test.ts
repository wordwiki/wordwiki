// deno-lint-ignore-file no-explicit-any
/**
 * Similarity PASS 0 (similarity.ts): normalizers (cross-lane skeleton
 * collision, diacritic folding), definition tokens, the persistent index,
 * and IDF-weighted blocking - forming vs corroborating keys (the
 * 'bear bite' vs 'time' rule), self-pair exclusion, top-N.
 */
import '../mikmaq/register.ts';   // Mi'gmaq normalizers + rules
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { db } from "../liminal/db.ts";
import * as security from "../liminal/security.ts";
import * as dictionaryConfig from "./dictionary-config.ts";
import * as sim from "./similarity.ts";
import { assertionPathToFields } from "./assertion.ts";
import { withTestDb, type Fixture } from "./testing.ts";

const EOT = 9007199254740991;

test("skeleton: cross-lane collision; Rand diacritics fold; marks strip", () => {
    // The same word in Watson's lane (backtick schwa) and MMO's lane
    // (apostrophe) collides - the survey's normalization.
    assertEquals(sim.skeleton("e'w`g", 'watson-li'), sim.skeleton("e'w'g", 'mm-li'));
    assertEquals(sim.skeleton("nmu'j", 'mm-li'), 'nmuj');
    assertEquals(sim.skeleton("gaqigiwto’qwamgwitg", 'mm-li'), 'gaqigiwtoqwamgwitg');
    // Rand's own orthography folds to base letters.
    assertEquals(sim.skeleton('soonŏkteögŭmāāgā', 'rand'), 'soonokteogumaaga');
    assertEquals(sim.skeleton('ĕlămkeegā', 'rand'), 'elamkeega');
    // Unknown lane falls back to the default rules.
    assertEquals(sim.skeleton("Sa'n- Pie'l", undefined), 'sanpiel');
});

test("definitionTokens: stopwords out, plurals + light stemming, deduped", () => {
    assertEquals(sim.definitionTokens('To prepare the stakes for setting up the frame'),
                 ['prepar', 'stak', 'set', 'fram']);
    assertEquals(sim.definitionTokens('bears and a bear'), ['bear']);
    assertEquals(sim.definitionTokens('berries'), ['berry']);
    // The audit pairs: inflections share a key now.
    assertEquals(sim.definitionTokens('finished'), sim.definitionTokens('finish'));
    assertEquals(sim.definitionTokens('encouraging'), sim.definitionTokens('encourage'));
    assertEquals(sim.definitionTokens('freezing'), sim.definitionTokens('freeze'));
});

test("consonantSkeleton: syncope-proof", () => {
    assertEquals(sim.consonantSkeleton(sim.skeleton("g's'talg", 'mm-li')),
                 sim.consonantSkeleton(sim.skeleton('gisatalg', 'watson-li')));
    assertEquals(sim.consonantSkeleton('elsmalatl'), 'lsmltl');
});

// Two toy dictionaries with controlled key overlap.
function seed(fx: Fixture) {
    const {ww} = fx;
    const mkDict = (table: string, tag: string) => dictionaryConfig.createDictionary(table, {
        $type: 'schema', $name: table, $tag: tag,
        entry: {$type: 'relation', $tag: 'ent', entry_id: {$type: 'primary_key'},
            spelling: {$type: 'relation', $tag: 'spl',
                $style: {$view: {titleRole: 'headword'}},
                spelling_id: {$type: 'primary_key'},
                text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant', $bind: 'variant'}},
            gloss: {$type: 'relation', $tag: 'gls',
                $style: {$view: {titleRole: 'gloss'}},
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1'}}},
    }, {slug: table});
    mkDict('sima', 'tsa');
    mkDict('simb', 'tsb');

    let t = 9000, id = 500;
    const entry = (table: string, tag: string, spelling: string, lane: string,
                   gloss: string|undefined) => {
        const e = ++id;
        const rows: any[] = [{
            ...assertionPathToFields([[tag, 0], ['ent', e]]),
            assertion_id: e, id: e, ty: 'ent', valid_from: t++, valid_to: EOT,
            order_key: `k${e}`, change_by_username: 'test'}];
        const spl = ++id;
        rows.push({...assertionPathToFields([[tag, 0], ['ent', e], ['spl', spl]]),
            assertion_id: spl, id: spl, ty: 'spl', valid_from: t++, valid_to: EOT,
            order_key: `k${spl}`, attr1: spelling, variant: lane,
            change_by_username: 'test'});
        if(gloss !== undefined) {
            const g = ++id;
            rows.push({...assertionPathToFields([[tag, 0], ['ent', e], ['gls', g]]),
                assertion_id: g, id: g, ty: 'gls', valid_from: t++, valid_to: EOT,
                order_key: `k${g}`, attr1: gloss, change_by_username: 'test'});
        }
        for(const r of rows) db().insert(table, r, 'assertion_id');
        return e;
    };

    // sima: the probe dictionary.
    const a1 = entry('sima', 'tsa', "abate'w", 'mm-li', 'to abate a storm');
    const a2 = entry('sima', 'tsa', 'zzz', 'mm-li', 'water only');
    const a3 = entry('sima', 'tsa', "gwan'ji", 'mm-li', 'a rare birchbark kettle');
    // simb: exact-skeleton twin (different lane marks), a definition-only
    // match, and three entries sharing the COMMON token 'water'.
    const b1 = entry('simb', 'tsb', 'abate`w', 'watson-li', undefined);
    const b2 = entry('simb', 'tsb', 'ulaqan', 'mm-li', 'bark kettle for water');
    const b3 = entry('simb', 'tsb', 'w1', 'mm-li', 'water word one');
    const b4 = entry('simb', 'tsb', 'w2', 'mm-li', 'water word two');
    return {ww, a1, a2, a3, b1, b2, b3, b4};
}

test("index + blocking: exact-skel forms; rare defs form; common defs corroborate only", async () => {
    await withTestDb((fx) => security.runSystem(() => {
        try {
            const {ww, a1, a2, a3, b1, b2} = seed(fx);
            const ra = sim.rebuildSimilarityIndex(ww.storeFor('sima'));
            assertEquals(ra.entries, 3);
            sim.rebuildSimilarityIndex(ww.storeFor('simb'));
            // Idempotent: a re-rebuild leaves the same row count.
            const n1 = db().first<{n: number}>(
                `SELECT COUNT(*) AS n FROM similarity_key`, {})!.n;
            sim.rebuildSimilarityIndex(ww.storeFor('sima'));
            assertEquals(db().first<{n: number}>(
                `SELECT COUNT(*) AS n FROM similarity_key`, {})!.n, n1);

            // 'water' appears on 4 entries; with form limit 3 it may only
            // corroborate.  'kettle'/'bark' are rare - they form.
            const limits = {skel: {form: 3, corroborate: 10},
                            cskel: {form: 0, corroborate: 0},
                            def:  {form: 3, corroborate: 10},
                            cat:  {form: 0, corroborate: 10}};
            const cands = sim.candidatePairs('sima', 'simb', {limits});

            // a1 <-> b1: exact skeleton across LANES (backtick vs apostrophe).
            const p11 = cands.find(c => c.entry_id === a1 && c.target_entry_id === b1)!;
            assert(p11 !== undefined && p11.exactSkeleton, 'cross-lane exact-skel pair');

            // a3 <-> b2: formed by the rare tokens (kettle, bark) - no
            // spelling relationship at all.
            const p32 = cands.find(c => c.entry_id === a3 && c.target_entry_id === b2)!;
            assert(p32 !== undefined, 'definition-formed pair');
            assert(p32.evidence.some(ev => ev.kind === 'def' && ev.key === 'kettl'));   // stemmed

            // a2 shares ONLY the common token 'water' with b2/b3/b4 - the
            // 'time' rule: corroborate-only keys never form a pair.
            assertEquals(cands.filter(c => c.entry_id === a2), []);

            // A<->A: self-pairs excluded; the water entries of simb do not
            // pair with each other on 'water' alone either.  (df in the
            // self case counts within ONE dictionary: 'water' is on 3 simb
            // entries, so the form limit must sit below 3 here.)
            const self = sim.candidatePairs('simb', 'simb', {limits: {
                skel: {form: 3, corroborate: 10},
                cskel: {form: 0, corroborate: 0},
                def:  {form: 2, corroborate: 10},
                cat:  {form: 0, corroborate: 10}}});
            assert(self.every(c => c.entry_id !== c.target_entry_id), 'no self pairs');
            assert(!self.some(c =>
                c.evidence.length === 1 && c.evidence[0].key === 'water'),
                'common-token-only pairs never form');
        } finally {
            db().executeStatements(
                'DROP TABLE IF EXISTS sima; DROP TABLE IF EXISTS sima_dict_config;' +
                'DROP TABLE IF EXISTS simb; DROP TABLE IF EXISTS simb_dict_config;' +
                'DROP TABLE IF EXISTS similarity_key;');
        }
    }));
});
