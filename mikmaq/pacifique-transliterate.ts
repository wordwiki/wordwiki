/**
 * Pacifique (mm-pm) -> Listuguj (mm-li) transliteration rules, derived
 * BY MEASUREMENT from the PDM ref gold headword pairs (~1,260 rtr<->rtl
 * pairs; pdmRefCorpus in transliterate-pairs.ts) - the watson rules
 * program: every rule justified by the harness's train-fold miss-miner,
 * holdout untouched until scoring.
 *
 * v2 derivation notes (train counts in brackets):
 *  - macron vowels = Listuguj LENGTH (V'), breves fold plain [v1].
 *  - tj -> j [x118].
 *  - UVULARITY: g -> q after a (before a/t/s/end) and after o [x228+x90],
 *    but NOT before i/w/n/u [the v1 overshoot, x44 q->g backs it out].
 *  - o is /u/: stays o ADJACENT TO the uvular q, glides to w before
 *    vowels after e/a/start, gu+i but gw+a/e after g, u elsewhere
 *    before consonants and finally [x427+x278 o->u, x363+x72 o->w,
 *    x31 w->u after g].
 *  - u between vowels -> w [x76].
 *  - final elisions tem/gen/gem -> tm/gn/gm [x124].
 */
export const PM_LI_VERSION = 'pm-li/rules-v3';

import { Pattern, parsePattern, enumeratePattern } from '../wordwiki/transliterate-pattern.ts';
import { compileRules, reRule, type TransliterationRule,
         type TransliterationTrace } from '../wordwiki/transliterate-rules.ts';

/** The pm-li rules as an ordered, individually-named list (I4): the same
 *  regexes in the same order as the original imperative chain - each
 *  `.replace()` is one correspondence rule - so `compileRules` reproduces
 *  the old output byte-for-byte while ALSO yielding an explain plan.  The
 *  measured train-fold justifications are in the module doc above and in
 *  each rule's note. */
export const PM_LI_RULES: TransliterationRule[] = [
    // Long vowels -> length apostrophe (o-macron before g/m stays plain).
    reRule("ā → a' (long a)", /ā/g, "a'"),
    reRule("ē → e' (long e)", /ē/g, "e'"),
    reRule("ī → i' (long i)", /ī/g, "i'"),
    reRule("ō → o before g/m", /ō(?=[gm])/g, 'o', 'o-macron before g/m written plain in the gold'),
    reRule("ō → o' (long o)", /ō/g, "o'"),
    reRule("ū → u' (long u)", /ū/g, "u'"),
    reRule("breves → plain vowels", /[ăĕĭŏŭ]/g, m => 'aeiou'['ăĕĭŏŭ'.indexOf(m)]),
    // Palatal.
    reRule("tj → j (palatal)", /tj/g, 'j', 'x118'),
    // Uvularity: g -> q after a (not before i/w/n/u); og -> oq only oqo.
    reRule("ag → aq (uvular after a)", /ag(?=[atsp]|$)/g, 'aq', 'x228'),
    reRule("og → oq (oqo family)", /og(?=o)/g, 'oq'),
    // eol -> ewul (the o is both glide and vowel there; x48 e_l).
    reRule("eo → ewu before l", /eo(?=l)/g, 'ewu', 'x48 e_l'),
    // o/u before a vowel: gw/gu split after g, w after e/a/start, u else.
    reRule("go → gw before a/e", /go(?=[ae])/g, 'gw'),
    reRule("go → gu before i", /go(?=i)/g, 'gu'),
    reRule("o/u → w after e/a/start", /(^|[ea])[ou](?=[aeiou])/g, '$1w', 'x363+x72 o->w'),
    reRule("o → u before vowel", /o(?=[aeiou])/g, 'u', 'x427+x278 o->u'),
    // u between vowels is the glide.
    reRule("u → w between vowels", /([aei])u(?=[aeiou])/g, '$1w', 'x76'),
    // /u/: o -> u except adjacent to the uvular q (either side).
    reRule("o → u (/u/, not by q)", /o(?![']?q)(?<!q[']?)(?=[^aeiou']|$)/g, 'u'),
    // Elisions (all positions - x101 medial): tem/gem/gel/nem clusters.
    reRule("tem → tm (syncope)", /tem/g, 'tm', 'x124'),
    reRule("gem → gm (syncope)", /gem/g, 'gm'),
    reRule("gel → gl (syncope)", /gel/g, 'gl'),
    reRule("nem → nm (syncope)", /nem/g, 'nm'),
    reRule("gen → gn (final syncope)", /gen$/, 'gn'),
];

const pmLi = compileRules(PM_LI_RULES, {pairId: 'pm-li', version: PM_LI_VERSION});

export function transliteratePmToLi(word: string): string {
    return pmLi.transliterate(word);
}

/** The pm-li derivation for one word (I4): which rules fired, in order. */
export function explainPmToLi(word: string): TransliterationTrace {
    return pmLi.explain(word);
}

/** The AMBIGUITY pattern: Pacifique does not write vowel length, so the
 *  Listuguj length apostrophe is underspecified - the largest measured
 *  residual class (x260 inserts after a/e/i before t/s/g/q).  Branch
 *  order = rank: plain first (the commoner case), length second. */
export function pmLiPattern(word: string): Pattern {
    const base = transliteratePmToLi(word);
    let out = '';
    for(let i = 0; i < base.length; i++) {
        const c = base[i];
        out += c.replace(/([\[\]()|])/g, '');   // reserved chars never appear; belt+braces
        if(/[aei]/.test(c) && /[tsgq]/.test(base[i + 1] ?? '') )
            out += "(|')";
    }
    return parsePattern(out);
}

export function pmLiCandidates(word: string, k = 8): string[] {
    return enumeratePattern(pmLiPattern(word), k);
}
