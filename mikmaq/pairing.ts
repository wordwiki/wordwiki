// deno-lint-ignore-file no-explicit-any
/**
 * THE rand<->MMO PAIRING ('~rand-mmo-pair') - the first machineSync
 * consumer (similarity-design.md §3 / machine-contributors-design.md).
 * MMO-project SPECIALIZATION of the general similarity + sync machinery
 * (dz's packaging rule: the algorithms live in wordwiki/, this wiring
 * lives here).
 *
 * Pipeline: pass-0 candidates -> pass-1a rule verdicts -> the SAME-WORD
 * pairs -> counterpart facts on BOTH sides (rand.mmo_counterpart /
 * dict.rand_counterpart - each entry renders its pair without joins),
 * landed via machineSync: born-approved WITH CONFIDENCE, no approval
 * flow, sever/pin/annotate are the human verbs, and re-runs after rule
 * iterations are free and respect every human touch.
 *
 * 1:1 discipline: each rand entry lands AT MOST ONE counterpart (the
 * top-scoring same-word verdict; the rest are the multi-pair WORKLIST).
 * The MMO side legitimately receives several rand counterparts (Rand's
 * duplicate records), ranked by score.
 */
import * as similarity from '../wordwiki/similarity.ts';
import * as schemaRoles from '../wordwiki/schema-roles.ts';
import * as rules from '../wordwiki/similarity-rules.ts';
import { machineSync, machineSyncReportLines,
         type ComputedFact, type MachineSyncResult } from '../wordwiki/machine-sync.ts';
import { contentKeyId } from '../wordwiki/sfm-import.ts';
import * as orderkey from '../liminal/orderkey.ts';
import type { WordWiki } from '../wordwiki/wordwiki.ts';

export const PAIR_AUTHOR = '~rand-mmo-pair';
export const RAND_TABLE = 'rand';
export const MMO_TABLE = 'dict';
const RAND_REL = {tag: 'mcp'};      // rand.mmo_counterpart
const MMO_REL = {tag: 'rcp'};       // dict.rand_counterpart

export interface PairPlan {
    pairs: Array<{rand_entry: number, mmo_entry: number,
                  confidence: string, rule: string, score: number}>;
    multiPairWorklist: Array<{rand_entry: number, kept: number, dropped: number[]}>;
    randFacts: ComputedFact[];
    dictFacts: ComputedFact[];
}

/** Same-word rule verdicts -> the pair plan (pure given the verdicts). */
export function planPairs(ruled: rules.RuledPair[],
                          schemaTags: {randRoot: string, randEntry: string,
                                       mmoRoot: string, mmoEntry: string}): PairPlan {
    const byRand = new Map<number, rules.RuledPair[]>();
    for(const p of ruled) {
        if(p.verdict !== 'same-word') continue;
        let l = byRand.get(p.entry_id);
        if(!l) byRand.set(p.entry_id, l = []);
        l.push(p);
    }
    const plan: PairPlan = {pairs: [], multiPairWorklist: [], randFacts: [], dictFacts: []};
    for(const [rand_entry, l] of byRand) {
        l.sort((a, b) => b.score - a.score);
        const top = l[0];
        if(l.length > 1)
            plan.multiPairWorklist.push({rand_entry, kept: top.target_entry_id,
                                         dropped: l.slice(1).map(p => p.target_entry_id)});
        plan.pairs.push({rand_entry, mmo_entry: top.target_entry_id,
                         confidence: top.confidence, rule: top.rule, score: top.score});
    }
    // rand side: one fact per rand entry.
    for(const p of plan.pairs) {
        const id = contentKeyId(['pair', RAND_TABLE, p.rand_entry, MMO_TABLE, p.mmo_entry]);
        plan.randFacts.push({
            id, ty: RAND_REL.tag,
            path: [[schemaTags.randRoot, 0], [schemaTags.randEntry, p.rand_entry],
                   [RAND_REL.tag, id]],
            fields: {attr1: p.mmo_entry, attr2: p.confidence, attr3: p.rule}});
    }
    // MMO side: possibly several per entry (Rand's duplicates), score-ranked
    // deterministic order keys.
    const byMmo = new Map<number, typeof plan.pairs>();
    for(const p of plan.pairs) {
        let l = byMmo.get(p.mmo_entry);
        if(!l) byMmo.set(p.mmo_entry, l = []);
        l.push(p);
    }
    for(const [mmo_entry, l] of byMmo) {
        l.sort((a, b) => b.score - a.score || a.rand_entry - b.rand_entry);
        let prev: string|undefined = undefined;
        for(const p of l) {
            const id = contentKeyId(['pair', MMO_TABLE, mmo_entry, RAND_TABLE, p.rand_entry]);
            prev = orderkey.between(prev, undefined);
            plan.dictFacts.push({
                id, ty: MMO_REL.tag,
                path: [[schemaTags.mmoRoot, 0], [schemaTags.mmoEntry, mmo_entry],
                       [MMO_REL.tag, id]],
                fields: {attr1: p.rand_entry, attr2: p.confidence, attr3: p.rule},
                order_key: prev});
        }
    }
    return plan;
}

export interface PairRunResult {
    plan: PairPlan;
    randSync?: MachineSyncResult;
    dictSync?: MachineSyncResult;
}

/** Compute + (optionally) land the pairing.  Dry by default. */
export function pairRandMmo(ww: WordWiki, opts: {apply?: boolean} = {}): PairRunResult {
    const randStore = ww.storeFor(RAND_TABLE);
    const mmoStore = ww.storeFor(MMO_TABLE);
    const cands = similarity.candidatePairs(RAND_TABLE, MMO_TABLE);
    // orthoMatch grades (via the registered watson pairs) feed the
    // verdict rules: a measured branch difference outranks a raw
    // near-skeleton edit.
    const spellingsOf = (dict: string, id: number) => {
        const store = ww.storeFor(dict);
        const e = store.entriesById.get(id);
        return e ? [...schemaRoles.headwordsAllLanes(store.dictSchema, e),
                                    ...schemaRoles.sourceOrthographyTexts(store.dictSchema, e)] : [];
    };
    const ruled = rules.ruleVerdicts(RAND_TABLE, MMO_TABLE, cands, {spellingsOf});
    const plan = planPairs(ruled, {
        randRoot: randStore.dictSchema.tag,
        randEntry: randStore.dictSchema.relationFields[0].tag,
        mmoRoot: mmoStore.dictSchema.tag,
        mmoEntry: mmoStore.dictSchema.relationFields[0].tag});
    const result: PairRunResult = {plan};
    if(opts.apply) {
        result.randSync = machineSync(randStore, PAIR_AUTHOR, [RAND_REL.tag], plan.randFacts);
        result.dictSync = machineSync(mmoStore, PAIR_AUTHOR, [MMO_REL.tag], plan.dictFacts);
    }
    return result;
}

export function pairReportMarkdown(r: PairRunResult,
                                   headwordOf: (dict: string, id: number) => string,
                                   opts: {sample?: number} = {}): string {
    const conf = new Map<string, number>();
    for(const p of r.plan.pairs) conf.set(p.confidence, (conf.get(p.confidence) ?? 0) + 1);
    const lines = [
        `# rand<->MMO pairing ('${PAIR_AUTHOR}', language rules v${rules.languageRules().version})` +
            (r.randSync ? '' : ' - DRY RUN'),
        ``,
        `- pairs: ${r.plan.pairs.length} (` +
            [...conf.entries()].map(([c, n]) => `${c} ${n}`).join(' / ') + ')',
        `- multi-pair worklist (rand entries with >1 same-word candidate; ` +
            `top kept): ${r.plan.multiPairWorklist.length}`,
        ...(r.randSync ? [
            `- rand side: ${machineSyncReportLines(r.randSync).join('; ')}`,
            `- MMO side: ${machineSyncReportLines(r.dictSync!).join('; ')}`] : []),
        ``,
        `## Sample pairs (highest score first)`,
        ...r.plan.pairs.toSorted((a, b) => b.score - a.score)
            .slice(0, opts.sample ?? 40)
            .map(p => `- **${headwordOf(RAND_TABLE, p.rand_entry)}** <-> ` +
                      `**${headwordOf(MMO_TABLE, p.mmo_entry)}** ` +
                      `[${p.confidence}; ${p.rule}]`),
        ``,
        `## Multi-pair worklist (sample)`,
        ...r.plan.multiPairWorklist.slice(0, 20).map(w =>
            `- **${headwordOf(RAND_TABLE, w.rand_entry)}**: kept ` +
            `${headwordOf(MMO_TABLE, w.kept)}, also matched ` +
            w.dropped.map(d => headwordOf(MMO_TABLE, d)).join(', ')),
    ];
    return lines.join('\n') + '\n';
}
