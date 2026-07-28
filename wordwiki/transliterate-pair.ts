// deno-lint-ignore-file no-explicit-any
/**
 * The GENERAL transliteration-pair mechanism (dz 2026-07-27): the li->sf
 * engine (transliterate.ts) grew a proven shape - corpus-derived rules,
 * ranked AMBIGUITY candidates, risk/calibration, the standalone oracle
 * harness - and the new corpora (watson-sf<->watson-li, watson-li<->mm-li,
 * the re-derived mm-li->mm-sf) each want the same machinery.  This module
 * is the pair INTERFACE + registry; the per-pair rules and corpus
 * extractors are language-package residents (mikmaq/transliterate-pairs.ts)
 * registered at the binary edges.  General code never imports them.
 */
import type { WordWiki } from './wordwiki.ts';
import type { Pattern } from './transliterate-pattern.ts';

/** One oracle pair.  (The legacy li-sf corpus files use {li, sf} field
 *  names; loaders normalize - see normalizeCorpusPair.) */
export interface CorpusPair { source: string; target: string; tag: string; pos?: string; }

export function normalizeCorpusPair(p: any): CorpusPair {
    return {source: p.source ?? p.li, target: p.target ?? p.sf,
            tag: p.tag ?? '', pos: p.pos};
}

export interface TransliterationPairSpec {
    /** Stable id ('li-sf', 'wsf-wli', ...) - CLI/harness selection key. */
    id: string;
    sourceLane: string;              // orthography slugs
    targetLane: string;
    /** Stamped into change_arg by proposing features; bump on rule change. */
    version: string;
    /** The current rules: word -> best transliteration. */
    transliterate(word: string, opts?: {pos?: string}): string;
    /** Ranked candidates (the AMBIGUITY surface - dz: an ambiguous answer
     *  beats a guess or a refusal, users can correct it, and matching can
     *  use the whole set).  Always >= 1. */
    candidates?(word: string, k?: number): string[];
    /** The same ambiguity as a PATTERN (transliterate-pattern.ts) - lets
     *  orthoMatch test set membership in O(1) via the regex transform
     *  instead of enumerating.  Prefer providing this over candidates()
     *  when the branch structure is explicit. */
    candidatePattern?(word: string): Pattern;
    /** Rule-set variants for the harness --candidate/--all comparison
     *  (e.g. a direct mapping vs a composition through another pair). */
    candidateTransliterators?: Array<{name: string,
        fn: (word: string, opts?: {pos?: string}) => string}>;
    /** Extract this pair's training corpus from the live db (the
     *  export-transliteration-pairs --pair=<id> path). */
    extractCorpus?(ww: WordWiki): {pairs: CorpusPair[], notes?: string[]};
}

const pairs = new Map<string, TransliterationPairSpec>();

export function registerTransliterationPair(spec: TransliterationPairSpec): void {
    pairs.set(spec.id, spec);
}
export function transliterationPairIds(): string[] { return [...pairs.keys()]; }
export function allTransliterationPairs(): TransliterationPairSpec[] {
    return [...pairs.values()];
}
export function transliterationPair(id: string): TransliterationPairSpec|undefined {
    return pairs.get(id);
}
/** Lane-based lookup (the editor/report/similarity consumers). */
export function transliterationPairFor(sourceLane: string, targetLane: string)
        : TransliterationPairSpec|undefined {
    return [...pairs.values()].find(p =>
        p.sourceLane === sourceLane && p.targetLane === targetLane);
}
