/**
 * CROSS-ORTHOGRAPHY MATCHING (dz 2026-07-27): "does spelling a in lane A
 * plausibly denote the same form as spelling b in lane B?" - the
 * transliteration-pair registry's answer, GRADED, for pairing and the
 * editor dup-probe.
 *
 * Grades, strongest first:
 *   exact      the pair's rules alone produce b from a (or a from b)
 *   candidate  b is in a's AMBIGUITY set (a branch point went the other
 *              way - "g' sometimes g, sometimes gl"); rank = which branch
 *   skeleton   equal modulo marks (per-lane OrthoNormalizers) - either
 *              via the transliteration or raw cross-lane
 *   none
 *
 * Consumers should feed the GRADE into their evidence (ruleVerdict), not
 * collapse to bool early - a candidate-grade spelling match with disjoint
 * definitions is still ambiguous.  orthoMatches() is the bool wrapper for
 * callers that do want a threshold.  Direction is tried both ways
 * (registered forward and reverse pairs), so the relation is symmetric.
 * No transitive routing: only registered pairs are used - compositions
 * are registered explicitly when wanted (e.g. wsf-mmli), never inferred.
 */
import { transliterationPairFor, type TransliterationPairSpec } from './transliterate-pair.ts';
import { patternMatches, enumeratePattern } from './transliterate-pattern.ts';
import { skeleton } from './similarity.ts';

export type MatchGrade = 'none' | 'skeleton' | 'candidate' | 'exact';
const ORDER: MatchGrade[] = ['none', 'skeleton', 'candidate', 'exact'];

export interface OrthoMatchResult {
    grade: MatchGrade;
    /** The pair id that produced the grade (absent for same-lane and the
     *  raw cross-lane skeleton floor). */
    via?: string;
    /** For candidate matches: the matched branch's rank (0 = the rules'
     *  preferred branch; undefined = matched beyond the enumeration cap). */
    rank?: number;
}

function gradeVia(spec: TransliterationPairSpec, src: string, dst: string,
                  dstLane: string): OrthoMatchResult {
    const t = spec.transliterate(src);
    if(t === dst) return {grade: 'exact', via: spec.id, rank: 0};
    if(spec.candidatePattern) {
        const p = spec.candidatePattern(src);
        if(patternMatches(p, dst)) {
            const rank = enumeratePattern(p, 16).indexOf(dst);
            return {grade: 'candidate', via: spec.id,
                    rank: rank >= 0 ? rank : undefined};
        }
    } else if(spec.candidates) {
        const rank = spec.candidates(src, 8).indexOf(dst);
        if(rank >= 0) return {grade: 'candidate', via: spec.id, rank};
    }
    if(skeleton(t, dstLane) === skeleton(dst, dstLane))
        return {grade: 'skeleton', via: spec.id};
    return {grade: 'none'};
}

const better = (a: OrthoMatchResult, b: OrthoMatchResult): OrthoMatchResult =>
    ORDER.indexOf(b.grade) > ORDER.indexOf(a.grade)
        || (b.grade === a.grade && (b.rank ?? 99) < (a.rank ?? 99)) ? b : a;

export function orthoMatch(a: string, laneA: string|undefined,
                           b: string, laneB: string|undefined): OrthoMatchResult {
    if(laneA === laneB) {
        if(a === b) return {grade: 'exact'};
        return skeleton(a, laneA) === skeleton(b, laneA)
            ? {grade: 'skeleton'} : {grade: 'none'};
    }
    let best: OrthoMatchResult = {grade: 'none'};
    if(laneA !== undefined && laneB !== undefined) {
        const fwd = transliterationPairFor(laneA, laneB);
        const rev = transliterationPairFor(laneB, laneA);
        if(fwd) best = better(best, gradeVia(fwd, a, b, laneB));
        if(rev) best = better(best, gradeVia(rev, b, a, laneA));
    }
    // The raw cross-lane skeleton FLOOR (today's pairing behavior, e.g.
    // rand's diacritic fold): applies whether or not a pair is registered.
    if(best.grade === 'none' && skeleton(a, laneA) === skeleton(b, laneB))
        best = {grade: 'skeleton'};
    return best;
}

export function orthoMatches(a: string, laneA: string|undefined,
                             b: string, laneB: string|undefined,
                             min: MatchGrade = 'candidate'): boolean {
    return ORDER.indexOf(orthoMatch(a, laneA, b, laneB).grade) >= ORDER.indexOf(min);
}
