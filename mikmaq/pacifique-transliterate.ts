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

export function transliteratePmToLi(word: string): string {
    let w = word;
    // Long vowels -> length apostrophe (except o-macron before g/m, which
    // the gold writes plain); short breves fold plain.
    w = w.replace(/ā/g, "a'").replace(/ē/g, "e'").replace(/ī/g, "i'")
         .replace(/ō(?=[gm])/g, 'o').replace(/ō/g, "o'").replace(/ū/g, "u'")
         .replace(/[ăĕĭŏŭ]/g, m => 'aeiou'['ăĕĭŏŭ'.indexOf(m)]);
    // Palatal: tj -> j.
    w = w.replace(/tj/g, 'j');
    // Uvularity: g -> q after a (not before i/w/n/u); og -> oq only in
    // the oqo family (final -og is /ug/ - see below).
    w = w.replace(/ag(?=[atsp]|$)/g, 'aq');
    w = w.replace(/og(?=o)/g, 'oq');
    // eol -> ewul (the o is BOTH glide and vowel there; x48 e_l).
    w = w.replace(/eo(?=l)/g, 'ewu');
    // o/u before a vowel: gw/gu split after g, w after e/a/start, u else.
    w = w.replace(/go(?=[ae])/g, 'gw');
    w = w.replace(/go(?=i)/g, 'gu');
    w = w.replace(/(^|[ea])[ou](?=[aeiou])/g, '$1w');
    w = w.replace(/o(?=[aeiou])/g, 'u');
    // u between vowels is the glide.
    w = w.replace(/([aei])u(?=[aeiou])/g, '$1w');
    // /u/: o -> u except adjacent to the uvular q (either side).
    w = w.replace(/o(?![']?q)(?<!q[']?)(?=[^aeiou']|$)/g, 'u');
    // Elisions (all positions - x101 medial): tem/gem/gel/nem clusters.
    w = w.replace(/tem/g, 'tm').replace(/gem/g, 'gm')
         .replace(/gel/g, 'gl').replace(/nem/g, 'nm')
         .replace(/gen$/, 'gn');
    return w;
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
