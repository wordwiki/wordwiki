// deno-lint-ignore-file no-explicit-any
/**
 * The TRANSLITERATION ORACLE HARNESS (dz): the fast rules-iteration loop,
 * generalized over registered TRANSLITERATION PAIRS (transliterate-pair.ts).
 *
 *   ./wordwiki.sh export-transliteration-pairs [path] [--pair=ID]  # refresh an oracle
 *   deno run --allow-all wordwiki/transliterate-harness.ts \
 *        [pairs.json] [--pair ID] [--candidate NAME] [--holdout] [--all] \
 *        [--write-baseline path] [--baseline path] [--clusters N] \
 *        [--roundtrip]     # A->B->A consistency audit (needs the inverse
 *                          # pair registered); no target column used
 *        [--calibrate]     # (li-sf only) regenerate transliterate-calibration.ts:
 *                          # per-risk-band MEASURED accuracy on the train
 *                          # folds, validated on the holdout
 *
 * A pair that declares a `composition` (transliterate-pair.ts) is scored
 * direct-vs-composed on the same oracle by default - the hub-vs-direct
 * measurement, formerly a hand-written candidate.
 *
 * The loop: edit the pair's rules → run the harness → read
 *   1. the SCORE (exact matches; near-misses = edit distance 1 shown too),
 *      on the TRAIN split by default — pass --holdout for the untouched 20%
 *      (a deterministic hash split): a rule that only helps the train split
 *      is memorization, not a rule;
 *   2. the ERROR CLUSTERS: failures grouped by their edit signature
 *      (insert/delete/replace what, in which character context), counts and
 *      examples — the top cluster IS the next rule candidate;
 *   3. the BASELINE DIFF (--baseline from a prior --write-baseline): exactly
 *      which pairs a change FIXED and which it REGRESSED — a rule that helps
 *      40 and silently breaks 25 gets caught here, not in review.
 *
 * The CLI entry is a BINARY EDGE (it imports mikmaq/register.ts), but the
 * core is the exported runHarness() over already-loaded JSON pairs — in a
 * SAAS future with no CLI it runs as a function on db query results
 * unchanged (dz 2026-07-27).
 */
import { type CorpusPair, normalizeCorpusPair,
         transliterationPair, transliterationPairIds, validateCompositions,
         composedTransliterator, roundTripTransliterator } from './transliterate-pair.ts';

// --- tiny edit-script diff (short strings; classic DP) -----------------------

type Op = { kind: 'insert' | 'delete' | 'replace', from: string, to: string,
            before: string, after: string };

function editOps(a: string, b: string): Op[] {
    const n = a.length, m = b.length;
    const d: number[][] = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
    for(let i = 0; i <= n; i++) d[i][0] = i;
    for(let j = 0; j <= m; j++) d[0][j] = j;
    for(let i = 1; i <= n; i++)
        for(let j = 1; j <= m; j++)
            d[i][j] = a[i-1] === b[j-1] ? d[i-1][j-1]
                : 1 + Math.min(d[i-1][j-1], d[i-1][j], d[i][j-1]);
    // Walk back, coalescing runs of the same kind.
    const raw: {kind: Op['kind'], ai: number, from: string, to: string}[] = [];
    let i = n, j = m;
    while(i > 0 || j > 0) {
        if(i > 0 && j > 0 && a[i-1] === b[j-1] && d[i][j] === d[i-1][j-1]) { i--; j--; }
        else if(i > 0 && j > 0 && d[i][j] === d[i-1][j-1] + 1) {
            raw.push({kind: 'replace', ai: i-1, from: a[i-1], to: b[j-1]}); i--; j--;
        } else if(i > 0 && d[i][j] === d[i-1][j] + 1) {
            raw.push({kind: 'delete', ai: i-1, from: a[i-1], to: ''}); i--;
        } else {
            raw.push({kind: 'insert', ai: i, from: '', to: b[j-1]}); j--;
        }
    }
    raw.reverse();
    const ops: Op[] = [];
    for(const r of raw) {
        const prev = ops[ops.length - 1] as any;
        if(prev && prev.kind === r.kind && prev._end === r.ai) {
            prev.from += r.from; prev.to += r.to;
            prev._end = r.ai + (r.kind === 'insert' ? 0 : 1);
            prev.after = a[prev._end] ?? '$';
            continue;
        }
        ops.push({kind: r.kind, from: r.from, to: r.to,
                  before: a[r.ai - 1] ?? '^', after: a[r.ai + (r.kind === 'insert' ? 0 : 1)] ?? '$',
                  ...( {_end: r.ai + (r.kind === 'insert' ? 0 : 1)} as any )});
    }
    return ops;
}

const editDistance = (a: string, b: string): number =>
    editOps(a, b).reduce((s, o) => s + Math.max(o.from.length, o.to.length), 0);

// --- the deterministic split ---------------------------------------------------

function hashFold(s: string, folds = 5): number {
    let h = 2166136261;
    for(const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return Math.abs(h) % folds;
}

export function splitPairs(allPairs: CorpusPair[], split: 'train'|'holdout'|'all')
        : {pairs: CorpusPair[], splitName: string} {
    const pairs = split === 'all' ? allPairs
        : allPairs.filter(p => (hashFold(p.source) === 0) === (split === 'holdout'));
    const splitName = split === 'all' ? 'ALL'
        : split === 'holdout' ? 'HOLDOUT (fold 0)' : 'TRAIN (folds 1-4)';
    return {pairs, splitName};
}

// --- the callable core ---------------------------------------------------------

export interface HarnessCandidate {
    name: string;
    fn: (word: string, opts?: {pos?: string}) => string;
}

export interface HarnessRun {
    name: string;
    splitName: string;
    n: number;
    exact: number;
    near: number;                      // 1 edit away
    perTag: {tag: string, n: number, ok: number}[];
    clusters: {sig: string, n: number, topCtx: string, examples: string[]}[];
    /** '<source> <tag>' -> exact?  (the baseline format) */
    results: Record<string, boolean>;
    fixed?: string[];
    regressed?: {source: string, want: string, got: string}[];
    /** The printable report, exactly what the CLI shows. */
    lines: string[];
}

/** Score candidate transliterators against an oracle: the whole harness
 *  minus file/flag IO, callable on JSON straight from a db query. */
export function runHarness(rawPairs: unknown[], candidates: HarnessCandidate[],
        opts: {split?: 'train'|'holdout'|'all', clusterN?: number,
               baseline?: Record<string, boolean>} = {}): HarnessRun[] {
    const clusterN = opts.clusterN ?? 20;
    const {pairs, splitName} = splitPairs(rawPairs.map(normalizeCorpusPair),
                                          opts.split ?? 'train');
    const runs: HarnessRun[] = [];
    for(const cand of candidates) {
        const lines: string[] = [];
        const fails: {p: CorpusPair, got: string}[] = [];
        let exact = 0, near = 0;
        const perTag = new Map<string, {n: number, ok: number}>();
        const results: Record<string, boolean> = {};
        for(const p of pairs) {
            const t = perTag.get(p.tag) ?? {n: 0, ok: 0};
            t.n++;
            const got = cand.fn(p.source, {pos: p.pos});
            const ok = got === p.target;
            results[p.source + ' ' + p.tag] = ok;
            if(ok) { exact++; t.ok++; }
            else {
                fails.push({p, got});
                if(editDistance(got, p.target) === 1) near++;
            }
            perTag.set(p.tag, t);
        }
        lines.push(`\n=== ${cand.name} on ${splitName}: ` +
                   `${exact}/${pairs.length} exact (${(exact*100/pairs.length).toFixed(1)}%), ` +
                   `${near} near-misses (1 edit away)`);
        for(const [tag, t] of perTag)
            lines.push(`    ${tag}: ${t.ok}/${t.n} (${(t.ok*100/t.n).toFixed(0)}%)`);

        // Error clusters: got -> want edit signatures, with source context.
        const clusterMap = new Map<string, {n: number, ctx: Map<string, number>, ex: string[]}>();
        for(const {p, got} of fails) {
            for(const op of editOps(got, p.target)) {
                const sig = `${op.kind} '${op.from}' -> '${op.to}'`;
                const c = clusterMap.get(sig) ?? {n: 0, ctx: new Map<string, number>(), ex: [] as string[]};
                c.n++;
                const ctx = `${op.before}_${op.after}`;
                c.ctx.set(ctx, (c.ctx.get(ctx) ?? 0) + 1);
                if(c.ex.length < 3) c.ex.push(`${p.source} → want ${p.target}, got ${got}`);
                clusterMap.set(sig, c);
            }
        }
        const clusters = [...clusterMap.entries()]
            .sort((a, b) => b[1].n - a[1].n)
            .map(([sig, c]) => ({sig, n: c.n,
                topCtx: [...c.ctx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
                    .map(([k, n]) => `${k}×${n}`).join(' '),
                examples: c.ex}));
        lines.push(`\n  top error clusters (the next rule lives here):`);
        for(const c of clusters.slice(0, clusterN)) {
            lines.push(`    ×${String(c.n).padStart(4)}  ${c.sig}   [ctx ${c.topCtx}]`);
            for(const e of c.examples) lines.push(`           ${e}`);
        }

        const run: HarnessRun = {name: cand.name, splitName, n: pairs.length,
            exact, near,
            perTag: [...perTag.entries()].map(([tag, t]) => ({tag, ...t})),
            clusters, results, lines};

        // Baseline diff.
        if(opts.baseline) {
            const fixed: string[] = [], regressed: HarnessRun['regressed'] = [];
            for(const [k, ok] of Object.entries(results)) {
                if(opts.baseline[k] === undefined) continue;
                const source = k.split(' ')[0];
                if(ok && !opts.baseline[k]) fixed.push(source);
                if(!ok && opts.baseline[k]) {
                    const f = fails.find(x => x.p.source === source)!;
                    regressed.push({source, want: f.p.target, got: f.got});
                }
            }
            run.fixed = fixed; run.regressed = regressed;
            lines.push(`\n  vs baseline: +${fixed.length} fixed, -${regressed.length} regressed`);
            for(const r of regressed.slice(0, 15))
                lines.push(`    REGRESSED: ${r.source} → want ${r.want}, got ${r.got}`);
        }
        runs.push(run);
    }
    return runs;
}

// --- round-trip consistency audit (A -> B -> A; no gold needed) -----------------

export interface RoundTripAudit {
    n: number;
    stable: number;                    // returned unchanged by A->B->A
    examples: {word: string, got: string}[];   // the lossy ones
    lines: string[];
}

/** How much of an oracle's SOURCE side survives A->B->A unchanged.  A
 *  consistency signal that needs no target column: a low stable rate means
 *  the pair (or its inverse) is lossy at those sites - the mismatches are
 *  a worklist that costs nothing to produce. */
export function roundTripAudit(sources: string[],
        rt: (word: string) => string): RoundTripAudit {
    const seen = new Set<string>();
    let stable = 0, n = 0;
    const examples: {word: string, got: string}[] = [];
    for(const w of sources) {
        if(seen.has(w)) continue;
        seen.add(w); n++;
        const got = rt(w);
        if(got === w) stable++;
        else if(examples.length < 20) examples.push({word: w, got});
    }
    const lines = [`\n=== round-trip A->B->A: ${stable}/${n} stable ` +
                   `(${n ? (stable*100/n).toFixed(1) : '0'}%)`,
                   `  lossy examples (source → round-tripped):`];
    for(const e of examples) lines.push(`    ${e.word} → ${e.got}`);
    return {n, stable, examples, lines};
}

// --- main -----------------------------------------------------------------------

async function main() {
    // The BINARY EDGE: pull in the language package's pair registrations.
    await import('../mikmaq/register.ts');
    validateCompositions();   // fail fast on a mis-declared composition

    const args = [...Deno.args];
    const flag = (name: string): boolean => {
        const i = args.indexOf(name); if(i < 0) return false; args.splice(i, 1); return true;
    };
    const opt = (name: string): string | undefined => {
        const i = args.indexOf(name); if(i < 0) return undefined;
        const v = args[i + 1]; args.splice(i, 2); return v;
    };
    const holdout = flag('--holdout');
    const all = flag('--all');
    const roundtripFlag = flag('--roundtrip');
    const pairId = opt('--pair') ?? 'li-sf';
    const candidateName = opt('--candidate');
    const writeBaseline = opt('--write-baseline');
    const baselinePath = opt('--baseline');
    const clusterN = Number(opt('--clusters') ?? 20);
    const calibrateFlag = flag('--calibrate');
    const spec = transliterationPair(pairId);
    if(!spec) throw new Error(
        `unknown pair '${pairId}' (registered: ${transliterationPairIds().join(', ')})`);

    // Default oracle path is spec-owned data, not an id branch.
    const pairsPath = args[0] ?? spec.corpusPath ?? `transliteration-pairs-${pairId}.json`;
    const allPairs = (JSON.parse(Deno.readTextFileSync(pairsPath)) as unknown[])
        .map(normalizeCorpusPair);

    if(calibrateFlag) {
        if(!spec.calibrate) throw new Error(
            `--calibrate: pair '${pairId}' has no calibration hook ` +
            `(only pairs whose engine reads a measured table define one)`);
        spec.calibrate(allPairs);
        return;
    }

    // Round-trip audit (A->B->A): a consistency check needing no target
    // column, so it runs on the pair's own source side.
    if(roundtripFlag) {
        const rt = roundTripTransliterator(pairId);
        if(!rt) throw new Error(`no round trip for '${pairId}': the inverse `+
            `pair (${spec.targetLane}->${spec.sourceLane}) is not registered`);
        const {pairs: split} = splitPairs(allPairs, all ? 'all' : holdout ? 'holdout' : 'train');
        for(const line of roundTripAudit(split.map(p => p.source), rt).lines)
            console.log(line);
        return;
    }

    const available: HarnessCandidate[] = spec.candidateTransliterators
        ?? [{name: `${spec.id} ${spec.version}`, fn: (w, o) => spec.transliterate(w, o)}];
    // A composition pair auto-compares its direct rules against the composed
    // chain on the SAME oracle (the hub-vs-direct measurement, was by hand).
    const composed: HarnessCandidate | undefined = spec.composition
        ? {name: `composed: ${spec.composition.join(' -> ')}`,
           fn: composedTransliterator(spec.composition)}
        : undefined;
    const candidates = candidateName
        ? [...available, ...(composed ? [composed] : [])].filter(c => c.name.includes(candidateName))
        : composed ? [available[0], composed] : [available[0]];
    if(candidates.length === 0) throw new Error(`no candidate matches '${candidateName}'`);

    const baseline = baselinePath
        ? JSON.parse(Deno.readTextFileSync(baselinePath)) as Record<string, boolean>
        : undefined;
    const runs = runHarness(allPairs, candidates,
        {split: all ? 'all' : holdout ? 'holdout' : 'train', clusterN, baseline});
    for(const run of runs) {
        for(const line of run.lines) console.log(line);
        if(writeBaseline) {
            Deno.writeTextFileSync(writeBaseline, JSON.stringify(run.results));
            console.log(`\n  baseline written to ${writeBaseline}`);
        }
    }
}

if(import.meta.main) main();
