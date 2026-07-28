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
import { orthoMatch, type MatchGrade } from './transliterate-match.ts';
import type { Candidate, CandidateEvidence, KeyKind } from './similarity.ts';

export interface LanguageRules {
    version: number;               // the language package bumps on change
    /** Inflectional FINALS (skeleton space) whose removal exposes a
     *  comparable stem; longest-match, MIN_STEM guarded. */
    verbFinals: string[];
    /** The diminutive suffix (skeleton space), if the language has one. */
    diminutive?: string;
    /** Curated KNOWN ROOTS: a shared root INSIDE both words + meaning
     *  overlap = a root family.  The linguist's growing data. */
    rootLexicon: Array<{root: string, sense: string}>;
    minStem: number;
    prefixStrong: number;          // shared initial >= this = family evidence
    prefixWeak: number;            //   ... >= this counts only with meaning
    nearLen1: number;              // near-skeleton: dist<=1 up to this length
    rareDefDf: number;             // a def token this rare refers alone
    synonymDefDf: number;          // single-token possible-synonym band
}

/** Language-neutral: no morphology, thresholds only - the skeleton/def
 *  rules still work.  Language packages REGISTER their rules at the
 *  binary edge (mikmaq/register.ts); general code never imports them. */
export const EMPTY_RULES: LanguageRules = {
    version: 0, verbFinals: [], rootLexicon: [],
    minStem: 4, prefixStrong: 5, prefixWeak: 3,
    nearLen1: 8, rareDefDf: 3, synonymDefDf: 10,
};

let activeRules: LanguageRules = EMPTY_RULES;
export function registerLanguageRules(r: LanguageRules): void { activeRules = r; }
export function languageRules(): LanguageRules { return activeRules; }

// ---------------------------------------------------------------------------------
// --- Morphology helpers ---------------------------------------------------------------
// ---------------------------------------------------------------------------------

/** Strip ONE final (longest match, stem-length guarded); undefined = no
 *  final applies. */
export function stripFinal(skel: string, rules: LanguageRules = activeRules)
        : {stem: string, final: string}|undefined {
    for(const f of rules.verbFinals)
        if(skel.endsWith(f) && skel.length - f.length >= rules.minStem)
            return {stem: skel.slice(0, -f.length), final: f};
    return undefined;
}

export function sharedPrefixLen(a: string, b: string): number {
    let i = 0;
    while(i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

function nearSkeleton(a: string, b: string, rules: LanguageRules): boolean {
    if(a === b) return false;                       // 'near' means not exact
    const max = Math.max(a.length, b.length) <= rules.nearLen1 ? 1 : 2;
    return Math.abs(a.length - b.length) <= max
        && levenshteinDistance(a, b) <= max;
}

// ---------------------------------------------------------------------------------
// --- Per-entry keys from the persistent index ---------------------------------------
// ---------------------------------------------------------------------------------

export interface EntrySimKeys { skels: string[]; defs: string[]; cskels?: string[]; }

export function entrySimKeys(dictionary: string, entry_id: number): EntrySimKeys {
    const rows = db().all<{kind: KeyKind, key: string}, {d: string, e: number}>(
        `SELECT kind, key FROM similarity_key WHERE dictionary = :d AND entry_id = :e`,
        {d: dictionary, e: entry_id});
    return {skels: rows.filter(r => r.kind === 'skel').map(r => r.key),
            defs: rows.filter(r => r.kind === 'def').map(r => r.key),
            cskels: rows.filter(r => r.kind === 'cskel').map(r => r.key)};
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
                            evidence: CandidateEvidence[],
                            rules: LanguageRules = activeRules,
                            spellGrade?: MatchGrade): RuleResult {
    const defOverlap = probe.defs.filter(t => target.defs.includes(t));
    const bothHaveDefs = probe.defs.length > 0 && target.defs.length > 0;
    const sharedDefEvidence = evidence.filter(ev => ev.kind === 'def');
    const rareShared = sharedDefEvidence.filter(ev => ev.df <= rules.rareDefDf);

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

    // --- 1b. TRANSLITERATION-GRADE spelling match --------------------------------
    // orthoMatch (transliterate-match.ts): 'exact' = a registered pair's
    // rules produce one spelling from the other; 'candidate' = they differ
    // by a MEASURED ambiguity branch (epenthesis, -ey/-ei, the schwa
    // mark).  A branch is a known coin flip, not an edit-distance guess -
    // so this outranks the near-skeleton rules below, and letter-level
    // branches are exactly the pairs the skeleton tests above cannot see.
    if(spellGrade === 'exact' || spellGrade === 'candidate') {
        if(defOverlap.length > 0)
            return {verdict: 'same-word', confidence: 'high',
                    rule: `xlit-${spellGrade}+def-overlap`};
        if(!bothHaveDefs)
            return {verdict: 'same-word', confidence: 'medium',
                    rule: `xlit-${spellGrade}+missing-defs`};
        return {verdict: 'ambiguous', confidence: 'low',
                rule: `xlit-${spellGrade}+disjoint-defs`};
    }

    // --- 2. NEAR skeleton -------------------------------------------------------
    const near = probe.skels.some(ps => target.skels.some(ts => nearSkeleton(ps, ts, rules)));
    if(near) {
        if(defOverlap.length > 0)
            return {verdict: 'same-word', confidence: 'medium',
                    rule: 'near-skel+def-overlap'};
        return {verdict: 'ambiguous', confidence: 'low', rule: 'near-skel-only'};
    }

    // --- 2b. CONSONANT skeleton ---------------------------------------------------
    // Same consonants in order (syncope-proof: g's'talg = gisatalg) plus
    // meaning agreement -> same word; consonants alone prove little, so
    // without defs it only refers, and with DISJOINT defs it falls
    // through to the weaker rules.
    if((probe.cskels ?? []).some(c => (target.cskels ?? []).includes(c))) {
        if(defOverlap.length > 0)
            return {verdict: 'same-word', confidence: 'medium',
                    rule: 'cskel+def-overlap'};
        if(!bothHaveDefs)
            return {verdict: 'ambiguous', confidence: 'low',
                    rule: 'cskel+missing-defs'};
    }

    // --- 3. Morphology: diminutive / same stem ----------------------------------
    for(const ps of probe.skels) for(const ts of target.skels) {
        if(rules.diminutive !== undefined
           && (ts === ps + rules.diminutive || ps === ts + rules.diminutive))
            return {verdict: 'related', confidence: 'high',
                    rule: 'diminutive', qualifier: 'diminutive'};
        const pf = stripFinal(ps, rules), tf = stripFinal(ts, rules);
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
        for(const {root, sense} of rules.rootLexicon)
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
    if(bestPrefix >= rules.prefixStrong && defOverlap.length > 0)
        return {verdict: 'related', confidence: 'medium',
                rule: 'root-family', qualifier: 'shared root'};
    if(bestPrefix >= rules.prefixWeak && defOverlap.length > 0)
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
    if(sharedDefEvidence.some(ev => ev.df <= rules.synonymDefDf))
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
    spellGrade?: MatchGrade;
}

/** A headword spelling with its orthography lane (the shape
 *  schemaRoles.headwordsAllLanes returns). */
export interface SpellingLane { text: string; variant: string|undefined; }

export function ruleVerdicts(dictA: string, dictB: string, candidates: Candidate[],
        opts: {spellingsOf?: (dict: string, id: number) => SpellingLane[]} = {}): RuledPair[] {
    const keyCache = new Map<string, EntrySimKeys>();
    const keysOf = (dict: string, id: number): EntrySimKeys => {
        const k = `${dict}/${id}`;
        let v = keyCache.get(k);
        if(!v) keyCache.set(k, v = entrySimKeys(dict, id));
        return v;
    };
    const spellCache = new Map<string, SpellingLane[]>();
    const spellsOf = (dict: string, id: number): SpellingLane[] => {
        const k = `${dict}/${id}`;
        let v = spellCache.get(k);
        if(!v) spellCache.set(k, v = opts.spellingsOf!(dict, id));
        return v;
    };
    const GRADE_ORDER: MatchGrade[] = ['none', 'skeleton', 'candidate', 'exact'];
    const gradeOf = (aId: number, bId: number): MatchGrade|undefined => {
        if(!opts.spellingsOf) return undefined;
        let best: MatchGrade = 'none';
        for(const sa of spellsOf(dictA, aId))
            for(const sb of spellsOf(dictB, bId)) {
                const g = orthoMatch(sa.text, sa.variant, sb.text, sb.variant).grade;
                if(GRADE_ORDER.indexOf(g) > GRADE_ORDER.indexOf(best)) best = g;
            }
        return best;
    };
    return candidates.map(c => {
        const spellGrade = gradeOf(c.entry_id, c.target_entry_id);
        return {
            ...ruleVerdict(keysOf(dictA, c.entry_id), keysOf(dictB, c.target_entry_id),
                           c.evidence, activeRules, spellGrade),
            entry_id: c.entry_id, target_entry_id: c.target_entry_id,
            score: c.score, exactSkeleton: c.exactSkeleton, evidence: c.evidence,
            spellGrade};
    });
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
        `# Similarity pass 1a (language rules v${activeRules.version}): '${dictA}' -> '${dictB}'`,
        ``,
        `- pairs: ${pairs.length}`,
        ...['same-word', 'related', 'unrelated', 'ambiguous'].map(v =>
            `- ${v}: ${(by.get(v) ?? []).length} ` +
            `(${(100 * (by.get(v) ?? []).length / n).toFixed(1)}%)`),
        `- REFERRAL BAND (ambiguous -> the LLM judge, if funded): ` +
            `${(by.get('ambiguous') ?? []).length} pairs`,
        ...(pairs.some(p => p.spellGrade !== undefined) ? [
            `- spelling grades (orthoMatch): ` +
            (['exact', 'candidate', 'skeleton', 'none'] as const).map(g =>
                `${g} ${pairs.filter(p => p.spellGrade === g).length}`).join(' / ')]
            : []),
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
