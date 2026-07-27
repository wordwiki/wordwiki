// deno-lint-ignore-file no-explicit-any
/**
 * PASS 1 of the similarity engine (similarity-design.md §2): the LLM
 * CLUSTER JUDGE.  One text-only call per entry-with-candidates: the probe
 * entry's presentation + each candidate's presentation + pass 0's
 * mechanical evidence; the model classifies every candidate as
 * same-word / related / unrelated with a confidence, a one-line reason,
 * and an optional QUALIFIER ('plural form', 'diminutive', ... - the §3b
 * link-payload commentary).
 *
 * Small contexts by construction (the binder's lesson): the model never
 * sees more than one probe and its handful of candidates.  Memoized per
 * CLUSTER on the extract substrate - the cluster's full content is the
 * cache key, so re-runs after corpus changes pay only for changed
 * clusters, and a prompt/model change re-extracts exactly what it
 * invalidates.  Tolerant output normalization from day one (models omit
 * empty fields), and a failed cluster reports and skips - never a dead
 * batch.
 *
 * NO LANDING here: this module produces JUDGED PAIRS; the per-purpose
 * machineSync landings ('~rand-mmo-pair', '~xref') are their own step.
 */
import * as model from './model.ts';
import * as schemaRoles from './schema-roles.ts';
import type { DictionaryStore } from './dictionary-store.ts';
import { extractTextStage, type ExtractConfig, type ExtractStage } from '../liminal/extract.ts';
import { type Candidate, type CandidateEvidence } from './similarity.ts';

export const PROMPT_VERSION_JUDGE = 1;
export const JUDGE_MODEL = 'claude-opus-4-8';

// ---------------------------------------------------------------------------------
// --- Entry presentation --------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface EntryPresentation {
    entry_id: number;
    headwords: Array<{text: string, lane?: string}>;
    definitions: string[];        // glosses + example_translation texts
    categories: string[];
}

function englishRelation(schema: model.Schema): model.RelationField|undefined {
    return schema.descendantAndSelfRelations.find(r => r.name === 'example_translation');
}

/** The judge-facing presentation of one entry: everything discriminating,
 *  nothing bulky. */
export function entryPresentation(store: DictionaryStore, entry_id: number)
        : EntryPresentation|undefined {
    const schema = store.dictSchema;
    const e = store.entriesById.get(entry_id);
    if(!e) return undefined;
    const definitions: string[] = [...schemaRoles.glossTexts(schema, e)];
    const eng = englishRelation(schema);
    if(eng)
        for(const tuple of schemaRoles.collectTuples(e, eng)) {
            const t = schemaRoles.tupleText(eng, tuple);
            if((t ?? '') !== '' && !definitions.includes(t)) definitions.push(t);
        }
    return {entry_id,
            headwords: schemaRoles.headwordsAllLanes(schema, e)
                .map(h => ({text: h.text, lane: h.variant})),
            definitions,
            categories: schemaRoles.categoryValues(schema, e)};
}

// ---------------------------------------------------------------------------------
// --- The judgment stage --------------------------------------------------------------
// ---------------------------------------------------------------------------------

export type Verdict = 'same-word' | 'related' | 'unrelated';

export interface Judgment {
    target_entry_id: number;
    verdict: Verdict;
    confidence: 'high' | 'medium' | 'low';
    reason?: string;
    /** The link-payload commentary ('plural form', 'diminutive', ...). */
    qualifier?: string;
}

export interface JudgedPair extends Judgment {
    entry_id: number;
    score: number;                // pass 0's mechanical score
    exactSkeleton: boolean;
    evidence: CandidateEvidence[];
}

export const JUDGE_SCHEMA = {
    type: 'object', required: ['judgments'],
    properties: {
        // 'string' tolerated: the model occasionally emits the array
        // JSON-STRINGIFIED (the binder saw the same quirk); the
        // normalizer below parses it.
        judgments: {type: ['array', 'string'], items: {type: 'object',
            required: ['target_entry_id', 'verdict'],
            properties: {
                target_entry_id: {type: 'integer'},
                verdict: {enum: ['same-word', 'related', 'unrelated']},
                confidence: {enum: ['high', 'medium', 'low']},
                reason: {type: 'string'},
                qualifier: {type: 'string'}}}},
    },
};

export interface JudgeClusterInput {
    probe: EntryPresentation;
    probeDictionary: string;
    targetDictionary: string;
    candidates: Array<{presentation: EntryPresentation,
                       evidence: CandidateEvidence[],
                       exactSkeleton: boolean}>;
}

export function judgePrompt(input: JudgeClusterInput): string {
    const pres = (p: EntryPresentation) => JSON.stringify({
        entry_id: p.entry_id,
        headwords: p.headwords.map(h => h.lane ? `${h.text} [${h.lane}]` : h.text),
        definitions: p.definitions,
        categories: p.categories});
    const cands = input.candidates.map(c => JSON.stringify({
        ...JSON.parse(pres(c.presentation)),
        mechanical_evidence: c.evidence.slice(0, 6)
            .map(ev => `${ev.kind}:${ev.key}(df ${ev.df})`),
        exact_skeleton: c.exactSkeleton})).join('\n');
    return `You are judging CANDIDATE MATCHES between two Mi'gmaq dictionaries.

THE PROBE ENTRY (from dictionary '${input.probeDictionary}'):
${pres(input.probe)}

CANDIDATES (from dictionary '${input.targetDictionary}'), each with the
mechanical evidence that formed it - spelling-skeleton collisions
('skel', lane-normalized so different orthographies' marks are already
ignored) and shared rare definition tokens ('def'; df = how many entries
carry that token, smaller = rarer):
${cands}

For EACH candidate, judge its relationship to the probe:
- "same-word": the same lexeme - these are essentially the same entry in
  two dictionaries (spelling variance across orthographies/eras is
  expected; the definitions should agree in substance).
- "related": a meaningfully related but distinct word - same root or
  stem, a derived form (plural, diminutive, verb form, reciprocal...), a
  close compound.  Put WHAT the relation is in "qualifier" (e.g.
  "plural form", "same root", "diminutive").
- "unrelated": the evidence is coincidence (a shared common English word,
  an accidental skeleton collision).

Rules:
- Judge on the WORDS and their MEANINGS together: an exact skeleton with
  compatible definitions is near-certain same-word; an exact skeleton
  with clearly different meanings can still be homography - judge it
  "unrelated" (confidence per your certainty).
- Shared English tokens alone (no plausible morphological relationship
  between the Mi'gmaq forms) is usually "related" only when the meanings
  genuinely connect - otherwise "unrelated".
- confidence: "high" = certain; "medium" = probable; "low" = a guess.
- One short "reason" per judgment.

Return JSON for the schema; judge every candidate exactly once.`;
}

/** Judge ONE cluster (memoized; the input IS the cache key). */
export async function judgeCluster(cfg: ExtractConfig, input: JudgeClusterInput,
                                   model_: string = JUDGE_MODEL): Promise<Judgment[]> {
    const stage: ExtractStage = {
        name: 'similarity-judge', model: model_, promptVersion: PROMPT_VERSION_JUDGE,
        imageBox: 0, schema: JUDGE_SCHEMA,
        prompt: (i: unknown) => judgePrompt(i as JudgeClusterInput),
    };
    const raw = await extractTextStage(cfg, stage, input) as {judgments?: any};
    let js = raw.judgments ?? [];
    if(typeof js === 'string') { try { js = JSON.parse(js); } catch { js = []; } }
    if(!Array.isArray(js)) js = [];
    return (js as any[]).filter(j => Number.isSafeInteger(j?.target_entry_id)).map(j => ({
        target_entry_id: j.target_entry_id,
        verdict: (j.verdict ?? 'unrelated') as Verdict,
        confidence: j.confidence ?? 'low',
        reason: j.reason,
        qualifier: j.qualifier}));
}

// ---------------------------------------------------------------------------------
// --- The driver ----------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface JudgeRunOptions {
    model?: string;
    /** Judge only the first N clusters (the eval flow). */
    sampleClusters?: number;
    /** Injectable judge (tests). */
    judge?: (input: JudgeClusterInput) => Promise<Judgment[]>;
    log?: (m: string) => void;
}

export interface JudgeRunResult {
    pairs: JudgedPair[];
    clusters: number;
    failedClusters: Array<{entry_id: number, error: string}>;
}

/** Judge every candidate cluster between two stores.  Failures isolate
 *  per cluster (nothing caches on failure; a re-run retries exactly the
 *  failed clusters). */
export async function judgeCandidates(cfg: ExtractConfig,
                                      storeA: DictionaryStore, storeB: DictionaryStore,
                                      candidates: Candidate[],
                                      opts: JudgeRunOptions = {}): Promise<JudgeRunResult> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const judge = opts.judge
        ?? ((input: JudgeClusterInput) => judgeCluster(cfg, input, opts.model));
    const byEntry = new Map<number, Candidate[]>();
    for(const c of candidates) {
        let l = byEntry.get(c.entry_id);
        if(!l) byEntry.set(c.entry_id, l = []);
        l.push(c);
    }
    const result: JudgeRunResult = {pairs: [], clusters: 0, failedClusters: []};
    let clustersDone = 0;
    for(const [entry_id, cands] of byEntry) {
        if(opts.sampleClusters !== undefined && result.clusters >= opts.sampleClusters) break;
        const probe = entryPresentation(storeA, entry_id);
        if(!probe) continue;
        const input: JudgeClusterInput = {
            probe, probeDictionary: storeA.assertionTable,
            targetDictionary: storeB.assertionTable,
            candidates: cands.flatMap(c => {
                const p = entryPresentation(storeB, c.target_entry_id);
                return p ? [{presentation: p, evidence: c.evidence,
                             exactSkeleton: c.exactSkeleton}] : [];
            }),
        };
        if(input.candidates.length === 0) continue;
        result.clusters++;
        let judgments: Judgment[];
        try {
            judgments = await judge(input);
        } catch(e) {
            result.failedClusters.push({entry_id,
                error: e instanceof Error ? e.message : String(e)});
            log(`cluster ${entry_id}: JUDGE FAILED - ${result.failedClusters.at(-1)!.error}`);
            continue;
        }
        const byTarget = new Map(judgments.map(j => [j.target_entry_id, j]));
        for(const c of cands) {
            const j = byTarget.get(c.target_entry_id);
            result.pairs.push({
                entry_id, target_entry_id: c.target_entry_id,
                verdict: j?.verdict ?? 'unrelated',
                confidence: j?.confidence ?? 'low',
                reason: j?.reason ?? (j === undefined ? 'not judged by the model' : undefined),
                qualifier: j?.qualifier,
                score: c.score, exactSkeleton: c.exactSkeleton, evidence: c.evidence});
        }
        if(++clustersDone % 200 === 0) log(`${clustersDone} clusters judged...`);
    }
    return result;
}

// ---------------------------------------------------------------------------------
// --- Report --------------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export function judgeReportMarkdown(dictA: string, dictB: string, r: JudgeRunResult,
                                    headwordOf: (dict: string, id: number) => string,
                                    opts: {sample?: number} = {}): string {
    const by = (v: Verdict) => r.pairs.filter(p => p.verdict === v);
    const conf = (ps: JudgedPair[]) => {
        const c = {high: 0, medium: 0, low: 0} as Record<string, number>;
        for(const p of ps) c[p.confidence] = (c[p.confidence] ?? 0) + 1;
        return `high ${c.high} / medium ${c.medium} / low ${c.low}`;
    };
    const lines = [
        `# Similarity pass 1: '${dictA}' -> '${dictB}' judged pairs`,
        ``,
        `- clusters judged: ${r.clusters}; failed (retryable): ${r.failedClusters.length}`,
        `- same-word: ${by('same-word').length} (${conf(by('same-word'))})`,
        `- related: ${by('related').length} (${conf(by('related'))})`,
        `- unrelated: ${by('unrelated').length}`,
        ``,
    ];
    const section = (title: string, ps: JudgedPair[]) => {
        lines.push(`## ${title}`);
        for(const p of ps.slice(0, opts.sample ?? 40))
            lines.push(`- **${headwordOf(dictA, p.entry_id)}** -> ` +
                `**${headwordOf(dictB, p.target_entry_id)}** ` +
                `[${p.confidence}${p.qualifier ? `; ${p.qualifier}` : ''}] ` +
                `${p.reason ?? ''}`);
        lines.push('');
    };
    section('same-word', by('same-word').toSorted((a, b) => b.score - a.score));
    section('related', by('related').toSorted((a, b) => b.score - a.score));
    section('unrelated (sample - the rejected evidence)',
            by('unrelated').toSorted((a, b) => b.score - a.score));
    for(const f of r.failedClusters.slice(0, 20))
        lines.push(`- FAILED cluster ${f.entry_id}: ${f.error}`);
    return lines.join('\n') + '\n';
}
