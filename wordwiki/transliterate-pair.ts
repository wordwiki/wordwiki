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
    /** Declares this pair as a COMPOSITION of other registered pairs,
     *  applied left-to-right (e.g. ['wsf-wli','wli-mmli'] for 'wsf-mmli').
     *  The harness then runs the direct rules and the composed chain
     *  side-by-side on one oracle, and (when the inverse pairs exist) an
     *  A->B->A round-trip audit.  The chain's endpoints must equal this
     *  pair's own sourceLane/targetLane; intermediate lanes must abut.
     *  Validated lazily (composedTransliterator throws on a gap) so a
     *  mis-declared composition fails loudly at first use. */
    composition?: string[];
    /** Extract this pair's training corpus from the live db (the
     *  export-transliteration-pairs --pair=<id> path). */
    extractCorpus?(ww: WordWiki): {pairs: CorpusPair[], notes?: string[]};
    /** Where the harness reads this pair's oracle JSON when no path is
     *  given.  Defaults to `transliteration-pairs-<id>.json`; li-sf keeps
     *  its historical bare `transliteration-pairs.json`.  Data, not an
     *  `id==='li-sf'` branch in the harness. */
    corpusPath?: string;
    /** Optional per-pair calibration (`--calibrate`): regenerate whatever
     *  risk/branch tables the pair's engine reads, MEASURED on the oracle.
     *  Only li-sf has one today (its markers/branches live in
     *  transliterate.ts); the harness just calls the hook or errors if a
     *  pair has none - no engine-specific code in the harness. */
    calibrate?(pairs: CorpusPair[]): void;
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

/** Chain registered pairs left-to-right into one transliterator.  The
 *  intermediate lanes must abut (each step's targetLane === the next
 *  step's sourceLane); a gap throws so a mis-declared composition surfaces
 *  at first use, not as silently-wrong output.  `pos` is a source-lane
 *  property, so it is passed to the FIRST step only. */
export function composedTransliterator(pairIds: string[])
        : (word: string, opts?: {pos?: string}) => string {
    if(pairIds.length === 0) throw new Error('empty composition');
    const specs = pairIds.map(id => {
        const s = pairs.get(id);
        if(!s) throw new Error(
            `composition references unknown pair '${id}' `+
            `(registered: ${transliterationPairIds().join(', ')})`);
        return s;
    });
    for(let i = 0; i + 1 < specs.length; i++)
        if(specs[i].targetLane !== specs[i+1].sourceLane)
            throw new Error(`composition lane gap: '${specs[i].id}' ends in `+
                `lane '${specs[i].targetLane}' but '${specs[i+1].id}' starts `+
                `in lane '${specs[i+1].sourceLane}'`);
    return (word, opts) =>
        specs.reduce((w, s, i) => s.transliterate(w, i === 0 ? opts : undefined), word);
}

/** A -> B -> A through the two registered directional pairs, when both
 *  are registered (looks up the inverse by lane).  A pure CONSISTENCY
 *  signal needing no gold: how much survives the round trip unchanged
 *  measures how lossy the pair is.  Returns undefined if either direction
 *  is missing. */
export function roundTripTransliterator(pairId: string)
        : ((word: string, opts?: {pos?: string}) => string) | undefined {
    const fwd = pairs.get(pairId);
    if(!fwd) return undefined;
    const back = transliterationPairFor(fwd.targetLane, fwd.sourceLane);
    if(!back) return undefined;
    return (word, opts) => back.transliterate(fwd.transliterate(word, opts));
}

/** Eagerly validate every declared composition (endpoints match the
 *  pair's own lanes; intermediate lanes abut).  A binary edge can call
 *  this after all pairs register to fail fast on a bad declaration. */
export function validateCompositions(): void {
    for(const spec of pairs.values()) {
        if(!spec.composition) continue;
        composedTransliterator(spec.composition);   // throws on lane gap / unknown id
        const chain = spec.composition.map(id => pairs.get(id)!);
        const first = chain[0], last = chain[chain.length - 1];
        if(first.sourceLane !== spec.sourceLane || last.targetLane !== spec.targetLane)
            throw new Error(`composition endpoints for '${spec.id}' `+
                `(${first.sourceLane}->${last.targetLane}) do not match its `+
                `own lanes (${spec.sourceLane}->${spec.targetLane})`);
    }
}
