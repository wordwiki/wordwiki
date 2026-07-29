// deno-lint-ignore-file no-explicit-any
/**
 * The Mi'gmaq TRANSLITERATION PAIRS (dz 2026-07-27) - per-pair users of
 * the general mechanism (wordwiki/transliterate-pair.ts), registered at
 * the binary edges by register.ts.
 *
 * - 'li-sf': the mature engine (wordwiki/transliterate.ts rules-v4,
 *   75.9% exact / 84.4% top-5 on holdout), wrapped; its corpus extractor
 *   is the existing sibling-pair export.
 * - 'wsf-wli' (watson-sf -> watson-li): RULES NOT YET DERIVED (identity
 *   v0) - the corpus is rand's 4,613 single-author both-lane entries;
 *   the harness loop derives the rules from its error clusters.
 * - 'wli-mmli' (watson-li -> mm-li): RULES NOT YET DERIVED (identity
 *   v0) - the corpus is the LANDED counterpart pairs ('~rand-mmo-pair'),
 *   confidence-tagged; Watson and Dianne are the review authorities.
 *
 * The future re-derived mm-li -> mm-sf composition lands here too, as a
 * candidateTransliterator on 'li-sf' (the harness compares it against
 * the direct rules on one oracle - disagreements = the mm-sf
 * consistency audit).
 */
import { db } from '../liminal/db.ts';
import { registerTransliterationPair, type CorpusPair } from '../wordwiki/transliterate-pair.ts';
import { transliterateLiToSf, transliterateCandidates,
         CANDIDATE_TRANSLITERATORS, TRANSLITERATOR_VERSION } from '../wordwiki/transliterate.ts';
import { PM_LI_VERSION, transliteratePmToLi, pmLiCandidates, pmLiPattern } from './pacifique-transliterate.ts';
import { transliterateWsfToWli, wsfWliCandidates, wsfWliCandidatePattern,
         wliMmliCandidatePattern, wsfMmliCandidatePattern,
         transliterateWliToMmli,
         transliterateWsfToMmli, transliterateWliToWsf,
         transliterateLiToSfViaWatson, WSF_WLI_VERSION, WLI_MMLI_VERSION,
         WSF_MMLI_VERSION, WLI_WSF_VERSION,
         LISF_VIA_WATSON_VERSION } from './watson-transliterate.ts';
import type { WordWiki } from '../wordwiki/wordwiki.ts';

const EOT = 9007199254740991;

/** rand entries carrying BOTH watson lanes: the single-author sf/li
 *  parallel corpus.  First spelling per lane; multi-spelling entries
 *  contribute their first pair only (clean > big). */
function randBothLanesCorpus(_ww: WordWiki): {pairs: CorpusPair[], notes?: string[]} {
    const rows = db().all<{sf: string, li: string}, Record<string, never>>(
        `SELECT sf.attr1 AS sf, li.attr1 AS li
           FROM (SELECT id1, MIN(assertion_id) AS a, attr1 FROM rand
                  WHERE ty='spl' AND valid_to=${EOT} AND variant='watson-sf'
                    AND attr1<>'' GROUP BY id1) AS sf
           JOIN (SELECT id1, MIN(assertion_id) AS a, attr1 FROM rand
                  WHERE ty='spl' AND valid_to=${EOT} AND variant='watson-li'
                    AND attr1<>'' GROUP BY id1) AS li USING (id1)`, {});
    const seen = new Set<string>();
    const pairs: CorpusPair[] = [];
    for(const r of rows) {
        const k = `${r.sf} ${r.li}`;
        if(seen.has(k)) continue;
        seen.add(k);
        pairs.push({source: r.sf, target: r.li, tag: 'rand-both-lanes'});
    }
    return {pairs};
}

/** PDM ref gold headword pairs: the hand rtr (Pacifique transcription)
 *  vs rtl (Listuguj) first tokens.  Cleaning: leading parentheticals
 *  stripped, up-to-comma, inner parens removed; pairs with FRENCH
 *  accents in the source (gloss leakage - the rtr sometimes leads with
 *  the French) rejected.  ~1,000 pairs. */
function pdmRefCorpus(_ww: WordWiki): {pairs: CorpusPair[], notes?: string[]} {
    const rows = db().all<{rtr: string, rtl: string}, Record<string, never>>(
        `SELECT (SELECT t.attr1 FROM dict t WHERE t.ty='rtr' AND t.id3=r.id
                   AND t.valid_to=${EOT} AND t.attr1<>'' LIMIT 1) AS rtr,
                (SELECT t.attr1 FROM dict t WHERE t.ty='rtl' AND t.id3=r.id
                   AND t.valid_to=${EOT} AND t.attr1<>'' LIMIT 1) AS rtl
           FROM dict r JOIN bounding_group bg ON r.attr1 = bg.bounding_group_id
           WHERE r.ty='ref' AND r.valid_to=${EOT} AND bg.document_id =
                 (SELECT document_id FROM scanned_document
                  WHERE friendly_document_id='PDM')`, {});
    const headword = (s: string|null): string|undefined => {
        if(!s) return undefined;
        let t = s.trim();
        if(t.startsWith('(')) t = t.replace(/^[\s(]*[^)]*\)\s*/, '');
        t = t.split(/[,;]/)[0].replace(/\([^)]*\)/g, '').trim();
        if(t === '' || t.split(/\s+/).length > 3) return undefined;
        return t;
    };
    const seen = new Set<string>();
    const pairs: CorpusPair[] = [];
    let rejected = 0;
    for(const r of rows) {
        const a = headword(r.rtr), b = headword(r.rtl);
        if(!a || !b) continue;
        // French gloss leakage: accented source, or an English-looking target.
        if(/[éèêëàâîïôûùç]/.test(a) || /\b(the|into|of|and)\b/i.test(b)) { rejected++; continue; }
        // One orthographic mark, two codepoints in the hand data: fold
        // curly apostrophes to ASCII on both sides.
        const na = a.replace(/[\u2019\u02bc]/g, "'"), nb = b.replace(/[\u2019\u02bc]/g, "'");
        const k = `${na} ${nb}`;
        if(seen.has(k)) continue;
        seen.add(k);
        pairs.push({source: na, target: nb, tag: 'pdm-ref'});
    }
    return {pairs, notes: [`${rejected} gloss-leak pair(s) rejected`]};
}

/** The landed counterpart pairs as a watson-li -> mm-li corpus,
 *  confidence-tagged (counterpart-high = the exact/def-verified pairs;
 *  counterpart-medium adds the near-skeleton ones - the most informative
 *  letter-level differences). */
function counterpartCorpus(sourceVariant: string) {
  return (_ww: WordWiki): {pairs: CorpusPair[], notes?: string[]} => {
    const rows = db().all<{src: string, mmli: string, conf: string}, {v: string}>(
        `SELECT src.attr1 AS src, mmli.attr1 AS mmli, mcp.attr2 AS conf
           FROM rand AS mcp
           JOIN (SELECT id1, attr1 FROM rand
                  WHERE ty='spl' AND valid_to=${EOT} AND variant=:v
                    AND attr1<>'' GROUP BY id1) AS src ON src.id1 = mcp.id1
           JOIN (SELECT id1, attr1 FROM dict
                  WHERE ty='spl' AND valid_to=${EOT} AND variant='mm-li'
                    AND attr1<>'' GROUP BY id1) AS mmli ON mmli.id1 = mcp.attr1
          WHERE mcp.ty='mcp' AND mcp.valid_to=${EOT}`, {v: sourceVariant});
    const seen = new Set<string>();
    const pairs: CorpusPair[] = [];
    for(const r of rows) {
        const k = `${r.src} ${r.mmli}`;
        if(seen.has(k)) continue;
        seen.add(k);
        pairs.push({source: r.src, target: r.mmli, tag: `counterpart-${r.conf}`});
    }
    return {pairs};
  };
}

export function registerMikmaqTransliterationPairs(): void {
    registerTransliterationPair({
        id: 'li-sf', sourceLane: 'mm-li', targetLane: 'mm-sf',
        version: TRANSLITERATOR_VERSION,
        transliterate: (w, opts) => transliterateLiToSf(w, opts ?? {}),
        candidates: (w, k) => transliterateCandidates(w, k).map(c => c.text),
        candidateTransliterators: [...CANDIDATE_TRANSLITERATORS,
            // The composition-audit candidate: what Rand's phonetics
            // justify, nothing more (watson-transliterate.ts).
            {name: `${LISF_VIA_WATSON_VERSION} (hub audit)`,
             fn: transliterateLiToSfViaWatson}],
        // The existing export path (cli export-transliteration-pairs with
        // no --pair) keeps its bespoke junk filter; this extractor is the
        // registry face of the same corpus.
        extractCorpus: (ww) => {
            const {pairs} = (ww as any).transliterationReports.corpusPairs();
            return {pairs: pairs.map((p: any) =>
                ({source: p.li, target: p.sf, tag: p.tag, pos: p.pos}))};
        },
    });
    registerTransliterationPair({
        id: 'wsf-wli', sourceLane: 'watson-sf', targetLane: 'watson-li',
        version: WSF_WLI_VERSION,
        transliterate: transliterateWsfToWli,
        candidates: wsfWliCandidates,
        candidatePattern: wsfWliCandidatePattern,
        candidateTransliterators: [
            {name: `${WSF_WLI_VERSION} (current)`, fn: transliterateWsfToWli},
            {name: 'identity (baseline)', fn: (w) => w},
        ],
        extractCorpus: randBothLanesCorpus,
    });
    registerTransliterationPair({
        id: 'wli-mmli', sourceLane: 'watson-li', targetLane: 'mm-li',
        version: WLI_MMLI_VERSION,
        transliterate: transliterateWliToMmli,
        candidatePattern: wliMmliCandidatePattern,
        candidateTransliterators: [
            {name: `${WLI_MMLI_VERSION} (current)`, fn: transliterateWliToMmli},
            {name: 'identity (baseline)', fn: (w) => w},
        ],
        extractCorpus: counterpartCorpus('watson-li'),
    });
    registerTransliterationPair({
        id: 'wsf-mmli', sourceLane: 'watson-sf', targetLane: 'mm-li',
        version: WSF_MMLI_VERSION,
        transliterate: transliterateWsfToMmli,
        // wsf-mmli IS the hub composition wsf->wli->mmli (transliterateWsfToMmli
        // hand-chains exactly these two); declaring it lets the harness score
        // direct-vs-composed automatically - the composed candidate should
        // REPRODUCE the current fn, which is the mechanism's own check.
        composition: ['wsf-wli', 'wli-mmli'],
        candidatePattern: wsfMmliCandidatePattern,
        candidateTransliterators: [
            {name: `${WSF_MMLI_VERSION} (current)`, fn: transliterateWsfToMmli},
            {name: 'identity (baseline)', fn: (w) => w},
        ],
        extractCorpus: counterpartCorpus('watson-sf'),
    });
    registerTransliterationPair({
        id: 'wli-wsf', sourceLane: 'watson-li', targetLane: 'watson-sf',
        version: WLI_WSF_VERSION,
        transliterate: transliterateWliToWsf,
        candidateTransliterators: [
            {name: `${WLI_WSF_VERSION} (current)`, fn: transliterateWliToWsf},
            {name: 'identity (baseline)', fn: (w) => w},
        ],
        // The reversed both-lanes corpus.
        extractCorpus: (ww) => {
            const {pairs, notes} = randBothLanesCorpus(ww);
            return {pairs: pairs.map(p =>
                ({source: p.target, target: p.source, tag: p.tag})), notes};
        },
    });
    registerTransliterationPair({
        id: 'pm-li', sourceLane: 'mm-pm', targetLane: 'mm-li',
        version: PM_LI_VERSION,
        transliterate: transliteratePmToLi,
        candidates: pmLiCandidates,
        candidatePattern: pmLiPattern,
        candidateTransliterators: [
            {name: `${PM_LI_VERSION} (current)`, fn: transliteratePmToLi},
            {name: 'identity (baseline)', fn: (w) => w},
        ],
        extractCorpus: pdmRefCorpus,
    });
}
