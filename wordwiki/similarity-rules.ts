// deno-lint-ignore-file no-explicit-any
/**
 * PASS 1a of the similarity engine: the ALGORITHMIC judge (dz 2026-07-27:
 * "much of what we are filtering here could be done by a normal algorithm
 * authored by an LLM" - so it was; these rules are the LLM's development-
 * time output, committed as reviewable code).
 *
 * Issues a verdict for every pass-0 candidate pair using Mi'gmaq-aware
 * string morphology + definition overlap - free, deterministic, and
 * ITERABLE AT ZERO MARGINAL COST, which matters because the
 * transliteration/rules project will keep changing the normalizers and a
 * paid judge would re-bill every iteration.  Pairs the rules cannot call
 * confidently get verdict 'ambiguous' - the RESIDUAL BAND that may be
 * referred to the LLM judge (similarity-judge.ts), whose spend then
 * scales with genuine ambiguity, not corpus size.
 *
 * EVERY LIST AND THRESHOLD BELOW IS LANGUAGE DATA FOR REVIEW - dz can
 * correct the endings, prefixes and limits directly (which no prompt ever
 * offered).  The rules operate in SKELETON space (marks stripped,
 * lowercase - similarity.ts), so orthography variance is already handled
 * before morphology looks at anything.
 */
import { levenshteinDistance } from '../liminal/levenshtein-distance.ts';
import { db } from '../liminal/db.ts';
import type { Candidate, CandidateEvidence, KeyKind } from './similarity.ts';

export const RULES_VERSION = 2;   // bump when rules change (reports carry it)

// ---------------------------------------------------------------------------------
// --- Mi'gmaq morphology data (REVIEW ME) ---------------------------------------------
// ---------------------------------------------------------------------------------

/** Verb/paradigm FINALS in skeleton space: inflectional endings whose
 *  removal exposes a comparable stem.  Longest-match wins; the remaining
 *  stem must keep MIN_STEM letters.  Sources: the ps-code paradigm
 *  structure + endings observed across the corpora.  CONSERVATIVE ON
 *  PURPOSE - a missing ending costs a referral, a wrong one costs a
 *  false root. */
export const VERB_FINALS: string[] = [
    'ultijik', 'atijik', 'ijik', 'ajik',
    'eget', 'eket', 'iget', 'iket',
    'atoq', 'atl', 'asit', 'atas', 'ates', 'alsit',
    'aqan', 'igan',
    'et', 'it', 'it',
].toSorted((a, b) => b.length - a.length);

/** The diminutive suffix (skeleton space: ji'j -> jij). */
export const DIMINUTIVE = 'jij';

/** KNOWN ROOTS (skeleton space) - the curated root lexicon, the heart of
 *  the language-rules project: a shared lexicon root INSIDE both words
 *  (not just at the start) plus meaning overlap = a root family.  Seeded
 *  from the first eval's misses; GROW ME (each entry names the root and
 *  its sense for the reviewer). */
export const ROOT_LEXICON: Array<{root: string, sense: string}> = [
    {root: 'maw',  sense: 'gather/together'},
    {root: 'gim',  sense: 'count'},
    {root: 'nesp', sense: 'along with/simultaneously'},
];

/** A single shared def token in this df band (rarer than common, not
 *  rare enough to refer) with NO formal link = a possible synonym pair -
 *  related, low (the related role WANTS synonyms; 'collect' at df 21
 *  stays a coincidence). */
export const SYNONYM_DEF_DF = 10;

/** Minimum stem length left after stripping a final. */
export const MIN_STEM = 4;

/** Shared-initial thresholds for root-family membership (maw-, nesp-...):
 *  a shared prefix of >= STRONG letters is family evidence on its own;
 *  >= WEAK letters counts only alongside meaning overlap. */
export const PREFIX_STRONG = 5;
export const PREFIX_WEAK = 3;

/** Near-skeleton: edit distance <= 1 for words up to NEAR_LEN_1, <= 2
 *  above (length-scaled typo/orthography tolerance). */
export const NEAR_LEN_1 = 8;

/** A def token this rare (df <=) is meaningful evidence even alone. */
export const RARE_DEF_DF = 3;

// ---------------------------------------------------------------------------------
// --- Morphology helpers ---------------------------------------------------------------
// ---------------------------------------------------------------------------------

/** Strip ONE final (longest match, stem-length guarded); undefined = no
 *  final applies. */
export function stripFinal(skel: string): {stem: string, final: string}|undefined {
    for(const f of VERB_FINALS)
        if(skel.endsWith(f) && skel.length - f.length >= MIN_STEM)
            return {stem: skel.slice(0, -f.length), final: f};
    return undefined;
}

export function sharedPrefixLen(a: string, b: string): number {
    let i = 0;
    while(i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

function nearSkeleton(a: string, b: string): boolean {
    if(a === b) return false;                       // 'near' means not exact
    const max = Math.max(a.length, b.length) <= NEAR_LEN_1 ? 1 : 2;
    return Math.abs(a.length - b.length) <= max
        && levenshteinDistance(a, b) <= max;
}

// ---------------------------------------------------------------------------------
// --- Per-entry keys from the persistent index ---------------------------------------
// ---------------------------------------------------------------------------------

export interface EntrySimKeys { skels: string[]; defs: string[]; }

export function entrySimKeys(dictionary: string, entry_id: number): EntrySimKeys {
    const rows = db().all<{kind: KeyKind, key: string}, {d: string, e: number}>(
        `SELECT kind, key FROM similarity_key WHERE dictionary = :d AND entry_id = :e`,
        {d: dictionary, e: entry_id});
    return {skels: rows.filter(r => r.kind === 'skel').map(r => r.key),
            defs: rows.filter(r => r.kind === 'def').map(r => r.key)};
}

// ---------------------------------------------------------------------------------
// --- The verdict rules ----------------------------------------------------------------
// ---------------------------------------------------------------------------------

export type RuleVerdict = 'same-word' | 'related' | 'unrelated' | 'ambiguous';

export interface RuleResult {
    verdict: RuleVerdict;
    confidence: 'high' | 'medium' | 'low';
    rule: string;                  // which rule fired (the report's evidence)
    qualifier?: string;
}

/** Judge one candidate pair from its two key sets + the pass-0 evidence.
 *  The rules are ORDERED - first match wins. */
export function ruleVerdict(probe: EntrySimKeys, target: EntrySimKeys,
                            evidence: CandidateEvidence[]): RuleResult {
    const defOverlap = probe.defs.filter(t => target.defs.includes(t));
    const bothHaveDefs = probe.defs.length > 0 && target.defs.length > 0;
    const sharedDefEvidence = evidence.filter(ev => ev.kind === 'def');
    const rareShared = sharedDefEvidence.filter(ev => ev.df <= RARE_DEF_DF);

    // --- 1. EXACT skeleton ------------------------------------------------------
    const exact = probe.skels.some(s => target.skels.includes(s));
    if(exact) {
        if(defOverlap.length > 0)
            return {verdict: 'same-word', confidence: 'high',
                    rule: 'exact-skel+def-overlap'};
        if(!bothHaveDefs)
            return {verdict: 'same-word', confidence: 'medium',
                    rule: 'exact-skel+missing-defs'};
        // Same form, both defined, ZERO shared tokens: could be different
        // glossing vocabulary ('zephyr' vs 'breezy') or true homography -
        // exactly the judgment call the rules cannot make.
        return {verdict: 'ambiguous', confidence: 'low',
                rule: 'exact-skel+disjoint-defs'};
    }

    // --- 2. NEAR skeleton -------------------------------------------------------
    const near = probe.skels.some(ps => target.skels.some(ts => nearSkeleton(ps, ts)));
    if(near) {
        if(defOverlap.length > 0)
            return {verdict: 'same-word', confidence: 'medium',
                    rule: 'near-skel+def-overlap'};
        return {verdict: 'ambiguous', confidence: 'low', rule: 'near-skel-only'};
    }

    // --- 3. Morphology: diminutive / same stem ----------------------------------
    for(const ps of probe.skels) for(const ts of target.skels) {
        if(ts === ps + DIMINUTIVE || ps === ts + DIMINUTIVE)
            return {verdict: 'related', confidence: 'high',
                    rule: 'diminutive', qualifier: 'diminutive'};
        const pf = stripFinal(ps), tf = stripFinal(ts);
        const pStem = pf?.stem ?? ps, tStem = tf?.stem ?? ts;
        if((pf !== undefined || tf !== undefined) && pStem === tStem)
            return {verdict: 'related', confidence: 'high',
                    rule: 'same-stem', qualifier: 'same stem, different form'};
    }

    // --- 4. Root family: shared initial + meaning --------------------------------
    // Lexicon roots: a KNOWN root inside both words + meaning overlap.
    // (v2 - the -gim- counting-root case: internal roots are invisible to
    // prefix logic; the lexicon is the linguist's growing data.)
    if(defOverlap.length > 0)
        for(const {root, sense} of ROOT_LEXICON)
            if(probe.skels.some(ps => ps.includes(root))
               && target.skels.some(ts => ts.includes(root)))
                return {verdict: 'related', confidence: 'medium',
                        rule: 'lexicon-root', qualifier: `shared root ${root} (${sense})`};

    const bestPrefix = Math.max(0, ...probe.skels.flatMap(ps =>
        target.skels.map(ts => {
            const l = sharedPrefixLen(ps, ts);
            // Guard against trivial prefixes on very long words - but
            // Mi'gmaq roots are SHORT and words are LONG, so the guard is
            // mild (v2: 0.4 killed the maw- family on 8+ letter words).
            return l >= Math.min(ps.length, ts.length) * 0.25 ? l : 0;
        })));
    if(bestPrefix >= PREFIX_STRONG && defOverlap.length > 0)
        return {verdict: 'related', confidence: 'medium',
                rule: 'root-family', qualifier: 'shared root'};
    if(bestPrefix >= PREFIX_WEAK && defOverlap.length > 0)
        return {verdict: 'related', confidence: 'low',
                rule: 'weak-root-family', qualifier: 'possibly shared root'};

    // --- 5. Meaning only ----------------------------------------------------------
    if(rareShared.length > 0)
        // A very rare shared definition token with no formal relationship:
        // could be a real synonym pair - the judgment call again.
        return {verdict: 'ambiguous', confidence: 'low', rule: 'rare-def-only'};
    if(sharedDefEvidence.length >= 2)
        return {verdict: 'related', confidence: 'low',
                rule: 'multi-def-overlap', qualifier: 'shared meaning'};
    // v2: a single moderately-uncommon shared token = a possible synonym
    // (the related role wants synonyms; the etawet/mesugtaqanat 'crave'
    // case) - common tokens still fall through to the coincidence rule.
    if(sharedDefEvidence.some(ev => ev.df <= SYNONYM_DEF_DF))
        return {verdict: 'related', confidence: 'low',
                rule: 'possible-synonym', qualifier: 'possible synonym'};

    // --- 6. The coincidence default ----------------------------------------------
    return {verdict: 'unrelated', confidence: 'high', rule: 'single-common-token'};
}

// ---------------------------------------------------------------------------------
// --- Driver + report -------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface RuledPair extends RuleResult {
    entry_id: number;
    target_entry_id: number;
    score: number;
    exactSkeleton: boolean;
    evidence: CandidateEvidence[];
}

export function ruleVerdicts(dictA: string, dictB: string,
                             candidates: Candidate[]): RuledPair[] {
    const keyCache = new Map<string, EntrySimKeys>();
    const keysOf = (dict: string, id: number): EntrySimKeys => {
        const k = `${dict}/${id}`;
        let v = keyCache.get(k);
        if(!v) keyCache.set(k, v = entrySimKeys(dict, id));
        return v;
    };
    return candidates.map(c => ({
        ...ruleVerdict(keysOf(dictA, c.entry_id), keysOf(dictB, c.target_entry_id),
                       c.evidence),
        entry_id: c.entry_id, target_entry_id: c.target_entry_id,
        score: c.score, exactSkeleton: c.exactSkeleton, evidence: c.evidence}));
}

export function ruleReportMarkdown(dictA: string, dictB: string, pairs: RuledPair[],
                                   headwordOf: (dict: string, id: number) => string,
                                   opts: {sample?: number} = {}): string {
    const by = new Map<string, RuledPair[]>();
    for(const p of pairs) {
        let l = by.get(p.verdict); if(!l) by.set(p.verdict, l = []); l.push(p);
    }
    const n = pairs.length || 1;
    const ruleCounts = new Map<string, number>();
    for(const p of pairs) ruleCounts.set(p.rule, (ruleCounts.get(p.rule) ?? 0) + 1);
    const lines = [
        `# Similarity pass 1a (rules v${RULES_VERSION}): '${dictA}' -> '${dictB}'`,
        ``,
        `- pairs: ${pairs.length}`,
        ...['same-word', 'related', 'unrelated', 'ambiguous'].map(v =>
            `- ${v}: ${(by.get(v) ?? []).length} ` +
            `(${(100 * (by.get(v) ?? []).length / n).toFixed(1)}%)`),
        `- REFERRAL BAND (ambiguous -> the LLM judge, if funded): ` +
            `${(by.get('ambiguous') ?? []).length} pairs`,
        ``,
        `## Rule firings`,
        ...[...ruleCounts.entries()].toSorted((a, b) => b[1] - a[1])
            .map(([r, c]) => `- ${r}: ${c}`),
        ``,
    ];
    for(const v of ['same-word', 'related', 'ambiguous'] as const) {
        lines.push(`## ${v} (sample)`);
        for(const p of (by.get(v) ?? []).toSorted((a, b) => b.score - a.score)
                .slice(0, opts.sample ?? 25))
            lines.push(`- **${headwordOf(dictA, p.entry_id)}** -> ` +
                       `**${headwordOf(dictB, p.target_entry_id)}** ` +
                       `[${p.confidence}; ${p.rule}` +
                       `${p.qualifier ? `; ${p.qualifier}` : ''}]`);
        lines.push('');
    }
    return lines.join('\n') + '\n';
}
