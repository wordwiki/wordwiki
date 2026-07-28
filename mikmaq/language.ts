/**
 * THE MI'GMAQ LANGUAGE PACKAGE (dz's packaging rule, 2026-07-27): general
 * algorithms live in wordwiki/; everything Mi'gmaq- or MMO-project-
 * specific lives HERE and reaches the general engines by REGISTRATION at
 * the binary edge (register.ts) or as configuration data - general code
 * never imports this package.
 *
 * This module is the language data itself: the per-orthography
 * normalizers (the orthography survey's rules) and the similarity
 * engine's morphology (similarity-design.md pass 1a) - verb finals, the
 * diminutive, the growing ROOT LEXICON.  EVERY LIST IS FOR LINGUIST
 * REVIEW; iterate freely, re-runs are free (that was the point).
 */
import type { OrthoNormalizer } from '../wordwiki/similarity.ts';
import type { LanguageRules } from '../wordwiki/similarity-rules.ts';

/** The Mi'gmaq mark family every lane ignores for matching (the
 *  orthography survey: ' backtick ’ hyphen space). */
const MARKS = "'`’- ";

/** The phonological CLASSES the transliteration rules are written over
 *  (transliteration-findings.md Part 3: rules read as phonology, not
 *  letter accidents).  Skeleton/lane-neutral lowercase. */
export const VOWELS = 'aeiou';
export const SONORANTS = 'lnm';
export const OBSTRUENTS = 'ptkqjsg';

const PLAIN: OrthoNormalizer = {strip: MARKS};

/** Per-orthography skeleton rules.  The modern and Watson lanes share
 *  the survey rules (Watson's backtick schwa mark is in the strip set);
 *  the source orthographies are diacritic-heavy and fold to base
 *  letters (Rand's ā/ĕ/ŭ/ö family). */
export const MIKMAQ_NORMALIZERS: Record<string, OrthoNormalizer> = {
    'mm-li':     PLAIN,
    'mm-sf':     PLAIN,
    'watson-li': PLAIN,
    'watson-sf': PLAIN,
    'rand':      {strip: MARKS, foldDiacritics: true},
    'mm-mp':     {strip: MARKS, foldDiacritics: true},
    'mm-pm':     {strip: MARKS, foldDiacritics: true},
    // Clark 1902 = Rand's system lighter, but 'tc' where Rand prints
    // 'ch' (Wenootc/Wenooch) - mapped so the skeletons collide.
    'clark':     {replace: {'tc': 'ch'}, strip: MARKS, foldDiacritics: true},
};

/** The Mi'gmaq similarity morphology (language rules v2 - the version
 *  bumps whenever a list or threshold changes; reports carry it). */
export const MIKMAQ_RULES: LanguageRules = {
    version: 3,

    // Verb/paradigm FINALS in skeleton space: inflectional endings whose
    // removal exposes a comparable stem.  Longest-match wins; the stem
    // keeps >= minStem letters.  CONSERVATIVE ON PURPOSE - a missing
    // ending costs a referral, a wrong one costs a false root.
    verbFinals: [
        'ultijik', 'atijik', 'ijik', 'ajik',
        'eget', 'eket', 'iget', 'iket',
        'atoq', 'atl', 'asit', 'atas', 'ates', 'alsit',
        'aqan', 'igan',
        'et', 'it',
    ].toSorted((a, b) => b.length - a.length),

    // ji'j in skeleton space.
    diminutive: 'jij',

    // KNOWN ROOTS - the heart of the language-rules project: a shared
    // lexicon root INSIDE both words plus meaning overlap = a root
    // family.  Seeded from the first eval's misses; GROW ME (each entry
    // names the root's sense for the reviewer).
    rootLexicon: [
        {root: 'maw',  sense: 'gather/together'},
        {root: 'gim',  sense: 'count'},
        {root: 'nesp', sense: 'along with/simultaneously'},
    ],

    // Measured on the landed counterpart corpus (288 aligned single-sub
    // pairs): g<->q 27 (uvularity), l<->n 7 (sonorant), u<->w 5 (glide).
    // g<->t (8) EXCLUDED: word-final -g/-t is inflection (animacy), not
    // dialect.
    dialectSubs: ['gq', 'ln', 'uw'],

    minStem: 4,
    prefixStrong: 5,
    prefixWeak: 3,
    nearLen1: 8,
    rareDefDf: 3,
    synonymDefDf: 10,
};
