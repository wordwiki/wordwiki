/**
 * Listuguj → Smith-Francis transliteration (fix-orthographies.md
 * "Auto-transliteration"): the RULE ENGINE behind the editor's
 * auto-transliterate button.
 *
 * THE RULES ARE CORPUS-DERIVED, NOT INVENTED: the dictionary holds ~1,540
 * clean human-authored li/sf sibling pairs (spellings, example texts,
 * alternate forms, regional forms), and every rule below was extracted from
 * and measured against them via the ORACLE HARNESS
 * (transliterate-harness.ts; export via `wordwiki.sh
 * export-transliteration-pairs`) — with a held-out fold, so a rule that
 * only memorizes the training pairs is caught.  rules-v3 (ranked branch
 * decisions) scores 75.9% EXACT on the untouched holdout (v2: 73.8%, v1:
 * 70.1%; 2026-07-07 dev db) - and its top-5 CANDIDATES contain the right
 * answer 84.4% of the time (the click-to-pick chips).  The
 * residual clusters show CONFLICTING demands inside identical character
 * windows (aqantie'umk wants no apostrophe at n_t where weltaq wants one at
 * l_t) — the char-rule ceiling; going further needs morphology/syllable
 * features, i.e. the language experts.  The development loop: edit the
 * rules, bump TRANSLITERATOR_VERSION, run the harness, read the clusters
 * and the baseline diff; in-app, the Transliteration Report scores every
 * candidate and harvests every human correction as a regression case.
 *
 * The VERSION is stamped into change_arg on every proposed fact: it drives
 * the never-re-propose-rejected rule, per-version quality stats, and the
 * retroactive-undo tool's targeting.  Bump it on ANY rule change.
 */

export const TRANSLITERATOR_VERSION = 'li-sf/rules-v3';

// Sonorants that take the schwa/syllabicity apostrophe before a following
// obstruent in Smith-Francis (corpus: l_t ×150, n_t ×89, l_p ×81, n_j ×73…;
// w and k/q contexts measurably DON'T - including them lowers accuracy).
const SONORANTS = 'lnmLNM';
const OBSTRUENTS = 'ptjPTJ';
// rules-v2 refinements, each mined from the oracle (see the harness):
//  - NO insertion at word start ('Lpa' stays Lpa; corpus 6/8);
//  - NO insertion in the u+l+t context (apjelmultimkewei; 52-vs-14 against;
//    u+l+p by contrast is 20/0 FOR insertion, so the exception is exact).
const CLUSTER = new RegExp(`(^|[\\s\\S])([${SONORANTS}])([${OBSTRUENTS}])`, 'g');
function insertClusterApostrophes(s: string): string {
    let prev;
    do {
        prev = s;
        s = s.replace(CLUSTER, (m, before: string, son: string, obs: string) => {
            if(before === '' || /\s/.test(before)) return m;            // word start
            if(before.toLowerCase() === 'u' && son.toLowerCase() === 'l'
               && obs.toLowerCase() === 't') return m;                   // the ult exception
            if(before === "'") return m;                                 // already separated
            return `${before}${son}'${obs}`;
        });
    } while(s !== prev);
    return s;
}

/**
 * WHOLE-WORD lexical exceptions, mined from the oracle (frequency ≥ 4,
 * consistency ≥ 75%, rules-wrong) and the natural place for the language
 * experts to record irregulars directly:
 *   ugjit → wjit (15/18 in the corpus), goqwei → koqwey (7/9).
 * Applied per word (punctuation preserved) BEFORE the character rules.
 */
export const LEXICAL_EXCEPTIONS: Record<string, string> = {
    'ugjit': 'wjit',
    'Ugjit': 'Wjit',
    'goqwei': 'koqwey',
    'Goqwei': 'Koqwey',
};

/**
 * Transliterate Listuguj text to Smith-Francis under the current rules.
 * Deterministic and total (unknown characters pass through) — callers decide
 * whether an output is worth proposing (e.g. skip when identical).
 */
export function transliterateLiToSf(text: string): string {
    // rules-v3: the top-ranked CANDIDATE (see transliterateCandidates below)
    // - every ambiguous branch decided by its MEASURED context probability
    // instead of a fixed rule.  Holdout: 75.9% (v2's fixed choices: 73.8%).
    return transliterateCandidates(text, 1)[0].text;
}

/** rules-v2, FROZEN for the comparison dashboard: lexical exceptions + g→k
 *  + fixed cluster-apostrophe choices (word-start and u+l+t excepted). */
export function transliterateRulesV2(text: string): string {
    let s = text.replace(/[^\s.,!?]+/g, w => LEXICAL_EXCEPTIONS[w] ?? w);
    s = s.replaceAll('g', 'k').replaceAll('G', 'K');
    return insertClusterApostrophes(s);
}

/** rules-v1, FROZEN for the comparison dashboard (the engine before the
 *  harness-driven v2 refinements). */
export function transliterateRulesV1(text: string): string {
    let s = text.replaceAll('g', 'k').replaceAll('G', 'K');
    const rx = new RegExp(`([${SONORANTS}])([${OBSTRUENTS}])`);
    let prev;
    do { prev = s; s = s.replace(rx, "$1'$2"); } while(s !== prev);
    return s;
}

// --------------------------------------------------------------------------
// --- The previous-generation transliterators (Transliterate.java, ported) --
// --------------------------------------------------------------------------
//
// dz dropped in Transliterate.java: the transliteration rules from the
// previous system, written with a language expert and tuned over feedback
// rounds.  It holds TWO transliterators:
//   A. the RULES PIPELINE (rules 90-170) - the expert-tuned set, staged to
//      "run as replacement transliterator" (its own TODO);
//   B. the older CHARACTER SCANNER (listugujToSmithFrancisOld) - what the
//      previous system actually served.  Its commented-out sonorant-cluster
//      block is exactly the corpus-derived rule in rules-v1 above -
//      independent confirmation from both directions.
// Both are ported FAITHFULLY (each Java rule's inline test is reproduced in
// auto-transliterate_test.ts) and scored against the human li/sf pair corpus
// like every other candidate.

// Java's \C = [a-zA-Z&&[^aeiouAEIOU]]: LETTER consonants (never apostrophe).
const C = "[b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z]";
const V = "[aeiouAEIOU]";

/**
 * Port of the expert rules pipeline (Transliterate.java rules 90-170),
 * applied in id order like the Java driver.  `isNoun` gates rule 100
 * (ey$ -> ei on nouns; no corpus text ends in 'ey', so it is inert on the
 * evaluation set).  `barredI` is rule 170's insertion character - the Java
 * literal is CAPITAL Î (\u00ce); the corpus writes lowercase î, so the
 * scorer tries both.
 */
export function transliterateJavaRules(text: string,
                                       opts: {isNoun?: boolean, barredI?: string} = {}): string {
    const barredI = opts.barredI ?? '\u00ce';
    let s = text;
    s = s.replaceAll('g', 'k');                                        // 90
    s = s.replaceAll('G', 'K');                                        // 91
    if(opts.isNoun) s = s.replace(/([eE])y$/, '$1i');                  // 100 (nouns)
    s = s.replaceAll('_', ' ');                                        // 110
    s = s.replace(/([ptskPSTK])'/g, '$1');                             // 120
    s = s.replace(new RegExp(`(${C}[lmnLMN])'`, 'g'), '$1');           // 130
    s = s.replace(/^([lL])(?!')/, "$1'");                              // 140
    s = s.replace(new RegExp(`(${V}${C})'(${C})$`), '$1e$2');          // 150
    s = s.replace(new RegExp(`(${C})'`, 'g'), '$1');                   // 160
    s = s.replace(new RegExp(`(${C}${C})(${C})`, 'g'), `$1${barredI}$2`); // 170
    return s;
}

/**
 * Port of the older character scanner (listugujToSmithFrancisOld) - the
 * transliterator the previous system actually served: ei$ -> ey, g -> k,
 * and [gmnpst]' -> letter + barred-i.  `withSonorantCluster` additionally
 * enables the Java source's commented-out [lmn][lmnt] apostrophe insertion
 * (the same rule rules-v1 derived from the corpus).
 */
export function transliterateJavaScanner(src: string,
                                         opts: {barredI?: string,
                                                withSonorantCluster?: boolean} = {}): string {
    const barredI = opts.barredI ?? '\u00ee';
    let out = '';
    for(let i = 0; i < src.length; i++) {
        const c = src[i];
        const clow = c.toLowerCase();
        const peek = i + 1 < src.length ? src[i + 1] : '';
        const peekLow = peek.toLowerCase();
        if(c === 'e' && i + 2 === src.length && peek === 'i') {
            out += 'ey'; i++;
        } else if(c === 'g') {
            if(peek === "'") { out += 'k' + barredI; i++; } else out += 'k';
        } else if(c === 'G') {
            if(peek === "'") { out += 'K' + barredI; i++; } else out += 'K';
        } else if('mnpstMNPST'.includes(c) && peek === "'") {
            out += c + barredI; i++;
        } else if(opts.withSonorantCluster && peek !== ''
                  && 'lmn'.includes(clow) && 'lmnt'.includes(peekLow)) {
            out += c + "'";
        } else {
            out += c;
        }
    }
    return out;
}

/**
 * Every transliterator candidate, for the Transliteration Report's
 * comparison table (measured against the human li/sf pair corpus on every
 * render).  SCORES AT PORT TIME (2026-07-07, 1,631 pairs):
 *   rules-v1 69.5%  ·  java scanner 47.4% (+sonorant 48.9%)  ·  java
 *   pipeline 35.9%.
 * The gap is a CONVENTION finding, not a quality one: the expert pipeline
 * writes the older barred-i Smith-Francis style (t' -> tî, schwa removal),
 * while the corpus - the team's own current SF writing - keeps the
 * apostrophes.  Whether the corpus convention or the barred-i convention is
 * the intended SF target is a language-team decision; the numbers say only
 * "which matches what the team writes TODAY".
 */
export const CANDIDATE_TRANSLITERATORS: Array<{name: string, fn: (li: string) => string}> = [
    { name: `${TRANSLITERATOR_VERSION} (current)`, fn: transliterateLiToSf },
    { name: 'li-sf/rules-v2 (frozen)', fn: transliterateRulesV2 },
    { name: 'li-sf/rules-v1 (frozen)', fn: transliterateRulesV1 },
    { name: 'java pipeline (rules 90-170, î)', fn: (li) => transliterateJavaRules(li, {barredI: '\u00ee'}) },
    { name: 'java scanner', fn: (li) => transliterateJavaScanner(li) },
    { name: 'java scanner + sonorant rule', fn: (li) => transliterateJavaScanner(li, {withSonorantCluster: true}) },
];

// --------------------------------------------------------------------------
// --- Confidence scoring (dz: bands to focus editor attention) --------------
// --------------------------------------------------------------------------

import { CALIBRATION, CALIBRATION_VERSION, BRANCH_PROBABILITIES } from './transliterate-calibration.ts';

/**
 * The RISK MARKERS: mechanically detectable situations (from the oracle
 * harness's residual clusters) where the rules are known to be uncertain.
 * Each marker is measurable - the calibration table records the rules'
 * ACTUAL accuracy on oracle words carrying it - and the marker list itself
 * is the language experts' agenda ("when does lg become l'k?" comes with 81
 * counted examples).  Computed on the SOURCE (Listuguj) text.
 */
export function transliterationRiskMarkers(li: string): string[] {
    const m: string[] = [];
    const low = li.toLowerCase();
    if(/[lnm][ptj]/.test(low)) m.push('sonorant-cluster');
    if(/l[gk]/.test(low)) m.push('l-before-k');
    if(li.split(/\s+/).some(w => w.replace(/[.,!?]+$/, '').toLowerCase().endsWith('ei')))
        m.push('word-final-ei');
    if(/[ptks]'[a-z]/.test(low)) m.push('schwa-cluster');
    if(/ult/.test(low)) m.push('ult');
    if(li.split(/\s+/).some(w => w in LEXICAL_EXCEPTIONS)) m.push('lexical-exception');
    return m.sort();
}

export interface ScoredTransliteration {
    text: string;
    /** The MEASURED accuracy of this word's risk band on the oracle (0..1) -
     *  calibrated, never guessed; 0.5 conservative default when the band has
     *  never been measured. */
    confidence: number;
    /** Display band from the confidence: high / good / uncertain / low. */
    band: 'high' | 'good' | 'uncertain' | 'low';
    markers: string[];
    version: string;
}

export function confidenceBand(confidence: number): ScoredTransliteration['band'] {
    return confidence >= 0.9 ? 'high'
         : confidence >= 0.75 ? 'good'
         : confidence >= 0.5 ? 'uncertain'
         : 'low';
}

/**
 * The scored transliteration: the text plus its calibrated confidence.
 * Lookup: the exact marker combination when the calibration measured it
 * with enough support, else the MINIMUM of the single-marker accuracies
 * (conservative: a word carrying a weak marker is at most as trustworthy as
 * that marker), else 0.5.
 */
export function transliterateLiToSfScored(li: string): ScoredTransliteration {
    const text = transliterateLiToSf(li);
    const markers = transliterationRiskMarkers(li);
    const key = markers.length === 0 ? 'clean' : markers.join(',');
    let confidence: number;
    if(CALIBRATION[key]) {
        confidence = CALIBRATION[key].accuracy;
    } else {
        const singles = markers.map(m => CALIBRATION[m]?.accuracy)
            .filter((a): a is number => a !== undefined);
        confidence = singles.length > 0 ? Math.min(...singles) : 0.5;
    }
    return {text, confidence, band: confidenceBand(confidence), markers,
            version: `${TRANSLITERATOR_VERSION}+${CALIBRATION_VERSION}`};
}

// --------------------------------------------------------------------------
// --- Ranked candidates (dz: top-k + click-to-pick) --------------------------
// --------------------------------------------------------------------------
//
// The residual ambiguities are BINARY BRANCH POINTS (apostrophe or not at a
// sonorant cluster; word-final ei or ey; schwa apostrophe or î), so instead
// of forcing one answer, enumerate both branches of each site, rank the
// combinations by the PRODUCT of the branches\' measured context
// probabilities (mined into BRANCH_PROBABILITIES by the harness
// --calibrate), and return the top k.  Holdout: the correct answer is
// top-1 75.9%, top-2 83.0%, top-5 84.4% - so a click-to-pick UI turns most
// residual corrections into one click.  Each candidate names its branch
// DECISIONS - the annotation for the pick chips, and (once picked) a
// labeled branch decision for the learning loop.

export interface TransliterationCandidate {
    text: string;
    /** Product of the branch probabilities - a RANKING score, not a
     *  calibrated confidence (transliterateLiToSfScored has that). */
    probability: number;
    /** Human-readable branch decisions distinguishing this candidate. */
    decisions: string[];
}

type BranchSite = {kind: 'cluster' | 'ei' | 'schwa', index: number, key: string,
                   label: string};

/** Branch probability for a mined context key: exact when supported (n≥5),
 *  else the per-kind marginal, else 0.5. */
function branchP(kind: string, key: string): number {
    const exact = BRANCH_PROBABILITIES[key];
    if(exact && exact.total >= 5) return exact.taken / exact.total;
    let taken = 0, total = 0;
    for(const [k, v] of Object.entries(BRANCH_PROBABILITIES))
        if(k.startsWith(kind + ':')) { taken += v.taken; total += v.total; }
    return total > 0 ? taken / total : 0.5;
}

/** The branch sites of a base (post lexical-exception, post g→k) text. */
function branchSites(base: string): BranchSite[] {
    const out: BranchSite[] = [];
    const low = base.toLowerCase();
    for(let i = 0; i + 1 < low.length; i++) {
        if(SONORANTS.includes(base[i]) && (OBSTRUENTS + 'kK').includes(base[i+1])) {
            const before = i === 0 ? '' : low[i-1];
            if(before === '' || /\s/.test(before) || before === "'") continue;  // word start / separated
            out.push({kind: 'cluster', index: i,
                      key: `cluster:${before}|${low[i]}|${low[i+1]}`,
                      label: `apostrophe at ${low[i]}·${low[i+1]}`});
        }
    }
    for(const m of base.matchAll(/[eE][iI](?=[\s.,!?]|$)/g))
        out.push({kind: 'ei', index: m.index!, key: 'ei:', label: 'word-final -ey'});
    for(const m of base.matchAll(/[ptksPTKS]'(?=[a-zA-Z])/g))
        out.push({kind: 'schwa', index: m.index! + 1,
                  key: `schwa:${base[m.index!].toLowerCase()}|${base[m.index! + 2].toLowerCase()}`,
                  label: `î for the ${base[m.index!].toLowerCase()}' schwa`});
    return out.slice(0, 6);   // combinatorial cap; >6 sites is sentence territory
}

/**
 * Up to k ranked candidates.  Always at least one (the top-ranked branch
 * combination); a word with no ambiguous sites yields exactly one.
 */
export function transliterateCandidates(li: string, k = 5): TransliterationCandidate[] {
    let base = li.replace(/[^\s.,!?]+/g, w => LEXICAL_EXCEPTIONS[w] ?? w);
    base = base.replaceAll('g', 'k').replaceAll('G', 'K');
    const sites = branchSites(base);
    const combos: {probability: number, bits: number}[] = [];
    for(let bits = 0; bits < (1 << sites.length); bits++) {
        let probability = 1;
        for(let j = 0; j < sites.length; j++) {
            const pTake = branchP(sites[j].kind, sites[j].key);
            probability *= (bits & (1 << j)) ? pTake : 1 - pTake;
        }
        combos.push({probability, bits});
    }
    combos.sort((a, b) => b.probability - a.probability);
    const out: TransliterationCandidate[] = [];
    const seen = new Set<string>();
    for(const {probability, bits} of combos) {
        // Apply taken branches right-to-left so indexes stay valid.
        let text = base;
        const decisions: string[] = [];
        for(let j = sites.length - 1; j >= 0; j--) {
            const site = sites[j];
            const taken = (bits & (1 << j)) !== 0;
            if(sites.length > 0 && branchAmbiguous(site)) 
                decisions.unshift(taken ? site.label : `no ${site.label}`);
            if(!taken) continue;
            if(site.kind === 'cluster')
                text = text.slice(0, site.index + 1) + "'" + text.slice(site.index + 1);
            else if(site.kind === 'ei')
                text = text.slice(0, site.index) + text[site.index] + 'y' + text.slice(site.index + 2);
            else   // schwa: the apostrophe at index becomes î
                text = text.slice(0, site.index) + 'î' + text.slice(site.index + 1);
        }
        if(seen.has(text)) continue;
        seen.add(text);
        out.push({text, probability, decisions});
        if(out.length >= k) break;
    }
    return out;
}

/** A site is worth ANNOTATING when its measured probability is genuinely
 *  uncertain - near-deterministic branches (P ≤ .1 or ≥ .9) would only add
 *  noise to the chip labels. */
function branchAmbiguous(site: BranchSite): boolean {
    const p = branchP(site.kind, site.key);
    return p > 0.1 && p < 0.9;
}
