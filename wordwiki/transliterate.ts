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
 * only memorizes the training pairs is caught.  rules-v2 scores 73.8%
 * EXACT on the untouched holdout (v1: 70.1%; 2026-07-07 dev db).  The
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

export const TRANSLITERATOR_VERSION = 'li-sf/rules-v2';

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
    // Rule 0: whole-word lexical exceptions.
    let s = text.replace(/[^\s.,!?]+/g, w => LEXICAL_EXCEPTIONS[w] ?? w);
    // Rule 1: Listuguj ⟨g⟩ is Smith-Francis ⟨k⟩ (1,429 aligned corpus
    // substitutions; the minority contextual g-survivals are a future rule).
    s = s.replaceAll('g', 'k').replaceAll('G', 'K');
    // Rule 2: insert the apostrophe in sonorant+obstruent clusters (with the
    // v2 exceptions above), to a fixpoint so runs like 'lnt' resolve fully.
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
    { name: 'li-sf/rules-v1 (frozen)', fn: transliterateRulesV1 },
    { name: 'java pipeline (rules 90-170, î)', fn: (li) => transliterateJavaRules(li, {barredI: '\u00ee'}) },
    { name: 'java scanner', fn: (li) => transliterateJavaScanner(li) },
    { name: 'java scanner + sonorant rule', fn: (li) => transliterateJavaScanner(li, {withSonorantCluster: true}) },
];
