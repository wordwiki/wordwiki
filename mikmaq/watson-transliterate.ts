/**
 * The WATSON-LANE transliteration rules (transliteration-findings.md
 * Part 3): watson-sf → watson-li and watson-li → mm-li, derived from the
 * rand oracle corpora by the harness loop (identity baselines 19.3% /
 * 56.7% train).  watson-sf is the de-facto PHONETIC HUB (Rand's
 * completeness claim) - these are the out-of-hub spokes, so the rules are
 * mostly deterministic RE-ENCODING; ambiguity appears only where the
 * target lane underspecifies (the schwa mark) and is expressed as a
 * ranked PATTERN, never a guess.
 *
 * Rules are written over the phonological classes (language.ts), not
 * letter accidents - reviewable as phonology.
 */
import { VOWELS } from './language.ts';
import { enumeratePattern, type Pattern } from '../wordwiki/transliterate-pattern.ts';

export const WSF_WLI_VERSION = 'wsf-wli/rules-v2';
export const WLI_MMLI_VERSION = 'wli-mmli/rules-v1';

const V = `[${VOWELS}]`;

/** watson-sf → watson-li, all rules EXCEPT the schwa realization: ɨ is
 *  kept as a marker so the candidates path can branch on it.
 *
 *  v2 (measured on the train folds, see transliteration-findings.md):
 *  epenthesis restricted to MEDIAL sites (word-final aqn is 70/76 split
 *  in Watson's own writing - a true ambiguity branch, not a rule); the
 *  possessive rule is w-only (initial u+C targets are genuinely mixed:
 *  us→ugs 9 vs usg 6); word-final -sik → s'g (21:2); initial ln → nn
 *  (12:0 in context ^_n). */
function wsfToWliBase(word: string): string {
    let w = word;
    // Voicing re-encoding: SF writes the plosives voiceless; Listuguj
    // writes g (q is uvular in both lanes and stays).
    w = w.replaceAll('k', 'g').replaceAll('K', 'G');
    // SF y → LI i (word-final -ey → -ei and intervocalic).
    w = w.replaceAll('y', 'i').replaceAll('Y', 'I');
    // Word-final -sik weakens to s'g (post-voicing: sig → s'g).
    w = w.replace(/sig(?=$|\s)/g, "s'g");
    // ECHO-VOWEL epenthesis: q + nasal gets a copy of the preceding
    // vowel written out (apoqnmatiet → apoqonmatiet) - but only where
    // Watson's own writing says so by majority: always after o (9:2),
    // otherwise medially before e/a (19:8, 13:5); word-final aqn is his
    // coin flip (70:76) and other medial contexts lean no.
    w = w.replace(/(o)q(?=[nm][^\s])/g, '$1q$1');
    w = w.replace(/([aeiu])q(?=[nm][ea])/g, '$1q$1');
    // Word-initial w before a consonant is the 3rd-person possessive
    // prefix, written ug- in Listuguj (wtmo'taqan → ugtmo'taqan).
    w = w.replace(new RegExp(`(^|\\s)w(?=[^${VOWELS}'\\sɨ])`, 'g'), '$1ug');
    // Word-initial ln (the 'person/Mi'gmaq' root) is written nn.
    w = w.replace(/(^|\s)ln/g, '$1nn');
    return w;
}

/** The AMBIGUITY pattern for a base form: the two branch points Watson's
 *  own writing leaves genuinely open -
 *  - each SF ɨ site realizes as ' (the ~10:1 majority) or his backtick;
 *  - word-final Vq+nasal takes the echo vowel or not (70:76 - his coin
 *    flip; 'no' is the hair's-breadth default). */
function wsfWliPattern(base: string): Pattern {
    const p: Pattern = [];
    const parts = base.split('ɨ');
    parts.forEach((part, i) => {
        const last = i === parts.length - 1;
        const m = last ? part.match(/^(.*)([aeiou])q([nm])$/) : null;
        if(m) {
            p.push({alternatives: [`${m[1]}${m[2]}q`]});
            p.push({alternatives: ['', m[2]]});
            p.push({alternatives: [m[3]]});
        } else if(part !== '') p.push({alternatives: [part]});
        if(!last) p.push({alternatives: ["'", '`']});
    });
    return p.length ? p : [{alternatives: ['']}];
}

export function transliterateWsfToWli(word: string): string {
    return wsfToWliBase(word).replaceAll('ɨ', "'");
}

export function wsfWliCandidates(word: string, k = 5): string[] {
    return enumeratePattern(wsfWliPattern(wsfToWliBase(word)), k);
}

/** The same ambiguity as a Pattern, for orthoMatch's O(1) membership. */
export function wsfWliCandidatePattern(word: string): Pattern {
    return wsfWliPattern(wsfToWliBase(word));
}

export const WLI_WSF_VERSION = 'wli-wsf/rules-v1';

/** watson-li → watson-sf: the INVERSE spoke, derived from the reversed
 *  rand oracle (train-fold counts):
 *  - the apostrophe disambiguates by CLASS: after a consonant it is the
 *    schwa (wsf ɨ; 250:32), after a vowel it is length and stays (1393);
 *  - g → k (Listuguj g is the only velar; wsf writes voiceless);
 *  - word-final/prevocalic -ei → -ey (331:11);
 *  - word-final aqan drops the echo vowel (69:3 - wsf writes aqn);
 *  - initial nn → ln (10:0, Watson's archaic root spelling). */
export function transliterateWliToWsf(word: string): string {
    let w = word;
    w = w.replace(new RegExp(`([^${VOWELS}\\s'])'`, 'g'), '$1ɨ');
    w = w.replaceAll('g', 'k').replaceAll('G', 'K');
    w = w.replace(/ei(?=$|\s|[aeiou])/g, 'ey');
    w = w.replace(/aqa([nm])(?=$|\s)/g, 'aq$1');
    w = w.replace(/(^|\s)nn/g, '$1ln');
    return w;
}

export const LISF_VIA_WATSON_VERSION = 'li-sf/via-watson-hub-v1';

/** mm-li → mm-sf BY THE WATSON CHAIN, for the composition AUDIT against
 *  the direct rules-v4: mm-li ≈ watson-li, route through the hub, land
 *  on TEAM mm-sf conventions (measured on the li-sf oracle: aqan kept
 *  100:0, initial nn kept 2:0, schwa written ' 1245:27) - so Watson's
 *  archaisms (aqn, ln) are SKIPPED, and the schwa round-trip (C-'→ɨ→')
 *  cancels.  What remains is the mapping Rand's phonetics can actually
 *  justify: voicing re-encoding + the -ey re-encoding.  Everything
 *  rules-v4 does beyond this (cluster aspiration apostrophes, lexical
 *  exceptions, pos conditioning) is TEAM CONVENTION the hub cannot see -
 *  the harness diff of the two candidates is exactly that inventory. */
export function transliterateLiToSfViaWatson(word: string): string {
    return word.replaceAll('g', 'k').replaceAll('G', 'K')
        .replace(/ei(?=$|\s|[aeiou])/g, 'ey');
}

export const WSF_MMSF_VERSION = 'wsf-mmsf/bridge-v1';

/** watson-sf → TEAM mm-sf: pure convention alignment (the phonetics
 *  already match) - Watson's ɨ becomes the team's schwa apostrophe, his
 *  archaic ln- becomes nn-, and the echo vowel the team writes in final
 *  aqan is restored.  Used by the triple audit (independent Rand-side
 *  prediction of mm-sf). */
export function transliterateWsfToMmsf(word: string): string {
    let w = word.replaceAll('ɨ', "'");
    w = w.replace(/(^|\s)ln/g, '$1nn');
    w = w.replace(/([aeiou])q([nm])(?=$|\s)/g, '$1q$1$2');
    return w;
}

export const WSF_MMLI_VERSION = 'wsf-mmli/hub-compose-v1';

/** watson-sf → mm-li BY HUB COMPOSITION: the sf lane carries the
 *  information the li spoke lacks (vowel length, q-vs-k uvularity), so
 *  routing sf→wli→mmli should beat the direct wli→mmli rules - this
 *  function IS that experiment (scored on the wsf-mmli oracle). */
export function transliterateWsfToMmli(word: string): string {
    return transliterateWliToMmli(transliterateWsfToWli(word));
}

/** watson-li → mm-li.  The lanes are already close (Watson→Dianne
 *  heritage; identity 79% on high-confidence pairs) - v1 takes only the
 *  fully systematic residue.  The rest of the clusters (vowel-length
 *  apostrophes, g vs q uvularity, vowel quality) need information this
 *  lane does not carry - hub composition or lexicon work, not rules. */
export function transliterateWliToMmli(word: string): string {
    let w = word;
    // Watson's backtick schwa mark → the modern apostrophe.
    w = w.replaceAll('`', "'");
    // The same echo-vowel epenthesis as the sf spoke.
    w = w.replace(new RegExp(`(${V})q(?=[nm])`, 'g'), '$1q$1');
    return w;
}
