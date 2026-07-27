/**
 * The AMBIGUITY PATTERN form (dz 2026-07-27): a compact single-string
 * spelling-set notation for transliteration branch points -
 *
 *     epa'q[oe]t        one char, two readings, 'o' preferred
 *     ta(s|ts|)ipow     group alternation; the empty branch = optional
 *
 * DELIBERATELY a strict syntactic SUBSET of regex - literals plus two
 * alternation forms, nothing else - so it stays finite and enumerable by
 * construction, and the regex transform is mechanical.  What regex cannot
 * carry is RANK: alternative ORDER here is preference order (first =
 * preferred), which is what powers top-k candidates, confidence, and the
 * display default.  patternToRegExp is therefore the (only) lossy
 * direction: it drops rank, keeps the set.
 *
 * The bracket form reads like phonemic variant notation - the review
 * audience is linguists, not programmers.
 */

/** One segment: a ranked list of alternative literal strings.  A plain
 *  literal is a one-alternative segment. */
export interface PatternSegment { alternatives: string[] }
export type Pattern = PatternSegment[];

// The only reserved characters.  Anything else (apostrophes, backticks,
// hyphens, diacritics) is an ordinary literal - no escaping, ever; a
// reserved character loose in data is a loud parse error, not a silent
// wildcard.
const RESERVED = '[]()|';

export function parsePattern(text: string): Pattern {
    const segs: Pattern = [];
    let lit = '';
    const flushLit = () => { if(lit !== '') { segs.push({alternatives: [lit]}); lit = ''; } };
    let i = 0;
    while(i < text.length) {
        const c = text[i];
        if(c === '[') {
            flushLit();
            const end = text.indexOf(']', i);
            if(end < 0) throw new Error(`pattern '${text}': unclosed '['`);
            const chars = text.slice(i + 1, end);
            if(chars.length < 2) throw new Error(
                `pattern '${text}': '[${chars}]' needs >= 2 characters`);
            for(const ch of chars) if(RESERVED.includes(ch)) throw new Error(
                `pattern '${text}': reserved '${ch}' inside [...]`);
            const alternatives = [...chars];
            if(new Set(alternatives).size !== alternatives.length) throw new Error(
                `pattern '${text}': duplicate alternative in '[${chars}]'`);
            segs.push({alternatives});
            i = end + 1;
        } else if(c === '(') {
            flushLit();
            const end = text.indexOf(')', i);
            if(end < 0) throw new Error(`pattern '${text}': unclosed '('`);
            const body = text.slice(i + 1, end);
            const alternatives = body.split('|');
            if(alternatives.length < 2) throw new Error(
                `pattern '${text}': '(${body})' needs a '|'`);
            for(const a of alternatives) for(const ch of a)
                if(RESERVED.includes(ch)) throw new Error(
                    `pattern '${text}': reserved '${ch}' inside (...)`);
            if(new Set(alternatives).size !== alternatives.length) throw new Error(
                `pattern '${text}': duplicate alternative in '(${body})'`);
            segs.push({alternatives});
            i = end + 1;
        } else if(RESERVED.includes(c)) {
            throw new Error(`pattern '${text}': unexpected '${c}' at ${i}`);
        } else {
            lit += c; i++;
        }
    }
    flushLit();
    return segs;
}

export function formatPattern(p: Pattern): string {
    return p.map(s =>
        s.alternatives.length === 1 ? s.alternatives[0]
        : s.alternatives.every(a => a.length === 1) ? `[${s.alternatives.join('')}]`
        : `(${s.alternatives.join('|')})`).join('');
}

/** The number of spellings the pattern denotes (product of alternation
 *  widths) - callers cap on this before enumerating. */
export function patternSize(p: Pattern): number {
    return p.reduce((n, s) => n * s.alternatives.length, 1);
}

/** Enumerate the denoted spellings in RANK order: cost = sum of chosen
 *  alternative indexes, ascending (all-preferred first), position-stable
 *  within a cost.  Capped at k. */
export function enumeratePattern(p: Pattern, k = 20): string[] {
    const out: string[] = [];
    const maxCost = p.reduce((n, s) => n + s.alternatives.length - 1, 0);
    for(let cost = 0; cost <= maxCost && out.length < k; cost++) {
        const walk = (seg: number, left: number, acc: string) => {
            if(out.length >= k) return;
            if(seg === p.length) { if(left === 0) out.push(acc); return; }
            const alts = p[seg].alternatives;
            for(let a = 0; a < alts.length && a <= left; a++)
                walk(seg + 1, left - a, acc + alts[a]);
        };
        walk(0, cost, '');
    }
    return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The lossy direction: the same set as an anchored RegExp, rank dropped. */
export function patternToRegExp(p: Pattern): RegExp {
    return new RegExp('^' + p.map(s =>
        s.alternatives.length === 1 ? escapeRe(s.alternatives[0])
        : `(?:${s.alternatives.map(escapeRe).join('|')})`).join('') + '$');
}

export function patternMatches(p: Pattern, word: string): boolean {
    return patternToRegExp(p).test(word);
}

/** Fold a ranked candidate LIST back into a pattern where the candidates
 *  differ at isolated points (the common case: same length, few branch
 *  sites; or a single insertion site).  Returns undefined when the shape
 *  is not pattern-like - callers fall back to the plain list. */
export function candidatesToPattern(candidates: string[]): Pattern|undefined {
    if(candidates.length === 0) return undefined;
    const uniq = candidates.filter((c, i) => candidates.indexOf(c) === i);
    if(uniq.length === 1) return [{alternatives: [uniq[0]]}];
    if(uniq.some(c => [...c].some(ch => RESERVED.includes(ch)))) return undefined;
    // Align on the shared prefix/suffix; the middles become one group.
    let pre = 0;
    while(uniq.every(c => pre < c.length && c[pre] === uniq[0][pre])) pre++;
    let suf = 0;
    while(uniq.every(c => suf < c.length - pre
                       && c[c.length - 1 - suf] === uniq[0][uniq[0].length - 1 - suf])) suf++;
    const middles = uniq.map(c => c.slice(pre, c.length - suf));
    if(new Set(middles).size !== middles.length) return undefined;  // suffix ambiguity
    const p: Pattern = [];
    if(pre > 0) p.push({alternatives: [uniq[0].slice(0, pre)]});
    p.push({alternatives: middles});
    if(suf > 0) p.push({alternatives: [uniq[0].slice(uniq[0].length - suf)]});
    return p;
}
