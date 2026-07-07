/**
 * Listuguj → Smith-Francis transliteration (fix-orthographies.md
 * "Auto-transliteration"): the RULE ENGINE behind the editor's
 * auto-transliterate button.
 *
 * THE RULES ARE CORPUS-DERIVED, NOT INVENTED: the dictionary already holds
 * 1,627 human-authored li/sf sibling pairs (spellings, example texts,
 * alternate forms, regional forms), and every rule below was extracted from
 * and measured against them.  rules-v1 scores 69.4% EXACT MATCH on that
 * corpus (2026-07-07 dev db).  The residuals are contextual voicing (some
 * intervocalic g stays g), glide i→y, iʼ→î length marking, and finer schwa
 * placement — linguist territory.  The development loop: edit the rules,
 * bump TRANSLITERATOR_VERSION, and read the accuracy + corrections report
 * (auto-transliterate.ts) — every human correction of an auto proposal
 * becomes a regression case there.
 *
 * The VERSION is stamped into change_arg on every proposed fact: it drives
 * the never-re-propose-rejected rule, per-version quality stats, and the
 * retroactive-undo tool's targeting.  Bump it on ANY rule change.
 */

export const TRANSLITERATOR_VERSION = 'li-sf/rules-v1';

// Sonorants that take the schwa/syllabicity apostrophe before a following
// obstruent in Smith-Francis (corpus: l_t ×150, n_t ×89, l_p ×81, n_j ×73…;
// w and k/q contexts measurably DON'T - including them lowers accuracy).
const SONORANTS = 'lnmLNM';
const OBSTRUENTS = 'ptjPTJ';
const CLUSTER = new RegExp(`([${SONORANTS}])([${OBSTRUENTS}])`);

/**
 * Transliterate Listuguj text to Smith-Francis under the current rules.
 * Deterministic and total (unknown characters pass through) — callers decide
 * whether an output is worth proposing (e.g. skip when identical).
 */
export function transliterateLiToSf(text: string): string {
    // Rule 1: Listuguj ⟨g⟩ is Smith-Francis ⟨k⟩ (1,429 aligned corpus
    // substitutions; the minority contextual g-survivals are a future rule).
    let s = text.replaceAll('g', 'k').replaceAll('G', 'K');
    // Rule 2: insert the apostrophe in sonorant+obstruent clusters, to a
    // fixpoint so runs like 'lnt' resolve fully.
    let prev;
    do { prev = s; s = s.replace(CLUSTER, "$1'$2"); } while(s !== prev);
    return s;
}
