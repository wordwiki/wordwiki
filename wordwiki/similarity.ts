// deno-lint-ignore-file no-explicit-any
/**
 * PASS 0 of the similarity engine (similarity-design.md §2): the
 * mechanical substrate everything else stands on.
 *
 *   KEY EXTRACTION  - per entry, data-driven normalizers turn content
 *                     into comparison keys: spelling SKELETONS per
 *                     orthography lane, English definition TOKENS,
 *                     category values.
 *   THE INDEX       - keys persist in `similarity_key` (dictionary,
 *                     entry_id, kind, key), rebuilt per dictionary by
 *                     batch runs and (later) maintained incrementally on
 *                     entry edits - the live single-entry dup-probe reads
 *                     the same table with the same normalizers.
 *   BLOCKING        - candidate pairs join on shared keys, weighted by
 *                     INVERSE FREQUENCY: a key's evidence value is
 *                     proportional to its rarity, and keys above a
 *                     commonness threshold cannot FORM a candidate pair
 *                     (they only corroborate one formed by rarer
 *                     evidence) - the 'bear bite' vs 'time' rule, which
 *                     kills O(n^2) and the overwhelm at once.
 *
 * NO LLM anywhere in this module: pass 0 is free, deterministic, and
 * unit-testable.  Pass 1 (the cluster judge) consumes its candidate
 * sets; the tunables below are the knobs the third-pass feedback
 * document adjusts.
 */
import { db } from '../liminal/db.ts';
import { block } from '../liminal/strings.ts';
import * as model from './model.ts';
import * as schemaRoles from './schema-roles.ts';
import type { DictionaryStore } from './dictionary-store.ts';
import { allTransliterationPairs } from './transliterate-pair.ts';

// ---------------------------------------------------------------------------------
// --- Orthography normalizers (DATA - graduates to per-instance config when
// --- a tenant needs different rules; the slugs are orthography-table rows) --------
// ---------------------------------------------------------------------------------

export interface OrthoNormalizer {
    /** Applied first, longest-match-insensitive literal replacements. */
    replace?: Record<string, string>;
    /** Characters DELETED after replacement (the apostrophe family etc.). */
    strip?: string;
    /** NFD-decompose and drop combining marks (diacritic-heavy source
     *  orthographies - Rand's ā/ĕ/ŭ/ö family). */
    foldDiacritics?: boolean;
}

/** The generic mark family (apostrophe variants, hyphen, space) - the
 *  language-neutral default; LANGUAGE packages register per-orthography
 *  overrides (mikmaq/language.ts) at the binary edge - general code never
 *  imports the specific package (dz's packaging rule, 2026-07-27). */
const MARKS = "'`’- ";

export const DEFAULT_NORMALIZER: OrthoNormalizer = {strip: MARKS};

const orthoNormalizers: Record<string, OrthoNormalizer> = {};

/** Install per-orthography normalizers (a language package's boot-time
 *  registration; later per-instance DATA when a tenant needs it). */
export function registerOrthoNormalizers(m: Record<string, OrthoNormalizer>): void {
    Object.assign(orthoNormalizers, m);
}

/** The comparison skeleton of `text` under `orthography`'s rules.
 *  Skeletons from DIFFERENT lanes are comparable by construction - that
 *  is the point (watson-li and mm-li spellings of the same word should
 *  collide). */
export function skeleton(text: string, orthography: string|undefined): string {
    const n = orthoNormalizers[orthography ?? ''] ?? DEFAULT_NORMALIZER;
    let s = text.toLowerCase();
    for(const [from, to] of Object.entries(n.replace ?? {})) s = s.split(from).join(to);
    if(n.foldDiacritics)
        s = s.normalize('NFD').replace(/\p{Mark}/gu, '');
    for(const ch of n.strip ?? '') s = s.split(ch).join('');
    return s;
}

// ---------------------------------------------------------------------------------
// --- English definition tokens ------------------------------------------------------
// ---------------------------------------------------------------------------------

/** Function words that carry no matching signal.  (Tunable data - a
 *  third-pass feedback candidate.) */
export const STOPWORDS = new Set(('a an and are as at be but by for from he her his i in is it its ' +
    'my of on or she so that the their them they this to was we with you your one who whom it, ' +
    'do does did not no yes have has had will would can could shall should may might').split(/[ ,]+/));

/** Normalization + LIGHT stemming: lowercase, alpha runs, drop
 *  stopwords, fold plurals, then -ing/-ed/-ly, a final silent e, and a
 *  doubled final consonant - so finish/finished and
 *  encourage/encouraging share a key.  (The unpaired-word audit showed
 *  English inflection alone hiding real pairs.)  Tokens are MATCHING
 *  KEYS, never display text - 'prepare' keying as 'prepar' is fine
 *  because both sides fold identically. */
export function definitionTokens(text: string): string[] {
    const out: string[] = [];
    for(let t of (text.toLowerCase().match(/[a-z]+/g) ?? [])) {
        if(STOPWORDS.has(t) || t.length < 3) continue;
        if(t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
        else if(t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
        if(t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
        else if(t.length > 4 && (t.endsWith('ed') || t.endsWith('ly'))) t = t.slice(0, -2);
        if(t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
        if(t.length > 3 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1);
        if(!out.includes(t)) out.push(t);
    }
    return out;
}

// ---------------------------------------------------------------------------------
// --- Key extraction ------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export type KeyKind = 'skel' | 'cskel' | 'cskel1' | 'def' | 'cat';

/** The CONSONANT skeleton: vowels stripped from a skeleton.  Modern
 *  Listuguj syncope (g's'talg vs Watson's gisatalg) leaves consonants
 *  intact while defeating both skeleton equality and the def-token
 *  bridge - the unpaired-word audit's biggest miss class.  Short ones
 *  are too collidey to index (entryKeys requires length >= 3). */
export function consonantSkeleton(skel: string): string {
    return skel.replace(/[aeiouɨ]/g, '');
}

/** The SYMMETRIC-DELETE neighborhood of a consonant skeleton: the cskel
 *  itself plus every single-consonant deletion.  Two entries whose
 *  cskels differ by ONE consonant edit (substitution, insertion, or
 *  deletion - wissugwalatl vs wisgugwalatl) share a neighborhood key, so
 *  BLOCKING meets them without betting on a substitution table; the
 *  verdict rules then decide.  Guarded to length >= 5 (deletions >= 4)
 *  - shorter neighborhoods are all collision. */
export function cskelNeighborhood(cskel: string): string[] {
    if(cskel.length < 5) return [];
    const out = [cskel];
    for(let i = 0; i < cskel.length; i++) {
        const d = cskel.slice(0, i) + cskel.slice(i + 1);
        if(!out.includes(d)) out.push(d);
    }
    return out;
}

/** The relation whose name is `example_translation` (the imported books'
 *  English phrase - MMO-aligned naming, same probe as the binder). */
function englishRelation(schema: model.Schema): model.RelationField|undefined {
    return schema.descendantAndSelfRelations.find(r => r.name === 'example_translation');
}

/** Every (kind, key) for one entry.  Deterministic; deduped. */
/** The RULE-TRANSLITERATED skeletons of a spelling: for every registered
 *  transliteration pair out of this lane, the skeleton (in the TARGET
 *  lane) of what the rules produce.  Indexed alongside the plain skeleton
 *  so cross-orthography BLOCKING catches rule-reachable matches (wsf
 *  'keknasimkewey' finds modern 'gegnasimgewei') - the pairwise grading
 *  is orthoMatch (transliterate-match.ts). */
export function transliteratedSkeletons(text: string, variant: string|undefined): string[] {
    if(variant === undefined) return [];
    const out: string[] = [];
    for(const p of allTransliterationPairs())
        if(p.sourceLane === variant)
            out.push(skeleton(p.transliterate(text), p.targetLane));
    return out;
}

export function entryKeys(schema: model.Schema, e: any): Array<{kind: KeyKind, key: string}> {
    const out = new Map<string, {kind: KeyKind, key: string}>();
    const add = (kind: KeyKind, key: string) => {
        if(key.length >= 2) out.set(`${kind} ${key}`, {kind, key});
    };
    // Headword-role spellings PLUS source-orthography texts (rand's
    // example_text lane): both are spellings of the entry, and the
    // source lane is the only one another source-era book (Clark) can
    // collide with - without it, rand entries are invisible to Clark.
    for(const h of [...schemaRoles.headwordsAllLanes(schema, e),
                    ...schemaRoles.sourceOrthographyTexts(schema, e)]) {
        const sk = skeleton(h.text, h.variant);
        const all = [sk, ...transliteratedSkeletons(h.text, h.variant)];
        for(const x of all) add('skel', x);
        for(const x of all) {
            const c = consonantSkeleton(x);
            if(c.length >= 3) add('cskel', c);
            for(const n of cskelNeighborhood(c)) add('cskel1', n);
        }
    }
    for(const g of schemaRoles.glossTexts(schema, e))
        for(const t of definitionTokens(g)) add('def', t);
    const eng = englishRelation(schema);
    if(eng)
        for(const tuple of schemaRoles.collectTuples(e, eng))
            for(const t of definitionTokens(schemaRoles.tupleText(eng, tuple) ?? ''))
                add('def', t);
    for(const c of schemaRoles.categoryValues(schema, e)) add('cat', c);
    return [...out.values()];
}

// ---------------------------------------------------------------------------------
// --- The persistent index ------------------------------------------------------------
// ---------------------------------------------------------------------------------

const SIMILARITY_DDL = block`
/**/   CREATE TABLE IF NOT EXISTS similarity_key(
/**/       dictionary TEXT NOT NULL,
/**/       entry_id INTEGER NOT NULL,
/**/       kind TEXT NOT NULL,
/**/       key TEXT NOT NULL);
/**/
/**/   CREATE INDEX IF NOT EXISTS similarity_key_by_key ON similarity_key(kind, key);
/**/   CREATE INDEX IF NOT EXISTS similarity_key_by_entry ON similarity_key(dictionary, entry_id);
/**/   `;

export function ensureSimilarityTables(): void {
    db().executeStatements(SIMILARITY_DDL);
}

/** Rebuild one dictionary's slice of the index from its current entries.
 *  (Batch semantics; the live path will maintain single entries
 *  incrementally through the same entryKeys.) */
export function rebuildSimilarityIndex(store: DictionaryStore): {entries: number, keys: number} {
    ensureSimilarityTables();
    const dictionary = store.assertionTable;
    const schema = store.dictSchema;
    let keys = 0, entries = 0;
    const pk = schema.relationFields[0].primaryKeyField.name;
    db().transaction(() => {
        db().execute(`DELETE FROM similarity_key WHERE dictionary = :dictionary`, {dictionary});
        for(const e of store.entries as any[]) {
            entries++;
            for(const {kind, key} of entryKeys(schema, e)) {
                db().insert('similarity_key',
                            {dictionary, entry_id: e[pk], kind, key}, 'rowid');
                keys++;
            }
        }
    });
    return {entries, keys};
}

// ---------------------------------------------------------------------------------
// --- Blocking: IDF-weighted candidate pairs ------------------------------------------
// ---------------------------------------------------------------------------------

/** The commonness knobs (the 'bear bite' vs 'time' rule) - per key kind:
 *  FORM = may create a candidate pair; CORROBORATE = counted for evidence
 *  on a pair someone else formed.  Above corroborate, the key is ignored
 *  entirely (and excluded in SQL - a 500-entry token would otherwise
 *  explode the join).  Tunable data; third-pass feedback candidates. */
export const KEY_LIMITS: Record<KeyKind, {form: number, corroborate: number}> = {
    skel: {form: 40,  corroborate: 100},
    cskel: {form: 20, corroborate: 80},    // consonant collisions are
                                           // commoner than full-skeleton
                                           // ones - tighter form gate
    cskel1: {form: 12, corroborate: 40},   // delete-1 neighborhoods
                                           // collide hard - tightest gate
    def:  {form: 25,  corroborate: 120},
    cat:  {form: 0,   corroborate: 400},   // categories NEVER form (that
                                           // grouping is the category
                                           // mechanism's own job)
};

export interface CandidateEvidence { kind: KeyKind; key: string; df: number; weight: number; }
export interface Candidate {
    entry_id: number;                      // in dictA
    target_entry_id: number;               // in dictB
    score: number;                         // sum of evidence weights
    exactSkeleton: boolean;
    evidence: CandidateEvidence[];
}

export interface CandidateOptions {
    /** Keep the top N candidates per entry (exact-skeleton matches are
     *  always kept).  Land generously; DISPLAY caps are the UI's. */
    topPerEntry?: number;
    /** Override the commonness knobs (tests; the third-pass feedback
     *  document). */
    limits?: Partial<Record<KeyKind, {form: number, corroborate: number}>>;
}

/** All candidate pairs between two dictionaries (A may equal B for the
 *  A<->A related case - self-pairs are excluded).  Pure SQL join over the
 *  index + JS aggregation; no content access. */
export function candidatePairs(dictA: string, dictB: string,
                               opts: CandidateOptions = {}): Candidate[] {
    ensureSimilarityTables();
    const topPerEntry = opts.topPerEntry ?? 12;
    const limits = {...KEY_LIMITS, ...(opts.limits ?? {})};
    const maxCorroborate = Math.max(...Object.values(limits).map(l => l.corroborate));
    const total = db().first<{n: number}, {a: string, b: string}>(
        `SELECT COUNT(DISTINCT dictionary || '/' || entry_id) AS n FROM similarity_key ` +
        `WHERE dictionary IN (:a, :b)`, {a: dictA, b: dictB})?.n ?? 1;
    const rows = db().all<{ae: number, be: number, kind: KeyKind, key: string, df: number},
                          {a: string, b: string, mx: number}>(
        block`
/**/     WITH df AS (
/**/         SELECT kind, key, COUNT(DISTINCT dictionary || '/' || entry_id) AS n
/**/           FROM similarity_key WHERE dictionary IN (:a, :b)
/**/           GROUP BY kind, key)
/**/     SELECT ka.entry_id AS ae, kb.entry_id AS be,
/**/            ka.kind AS kind, ka.key AS key, df.n AS df
/**/       FROM similarity_key AS ka
/**/         JOIN df ON df.kind = ka.kind AND df.key = ka.key
/**/         JOIN similarity_key AS kb ON kb.kind = ka.kind AND kb.key = ka.key
/**/       WHERE ka.dictionary = :a AND kb.dictionary = :b AND df.n <= :mx`,
        {a: dictA, b: dictB, mx: maxCorroborate});

    interface Acc { score: number; exactSkeleton: boolean; formed: boolean;
                    evidence: CandidateEvidence[]; }
    const byPair = new Map<string, Acc>();
    for(const r of rows) {
        if(dictA === dictB && r.ae === r.be) continue;      // self
        const kindLimits = limits[r.kind];
        if(r.df > kindLimits.corroborate) continue;
        const k = `${r.ae}/${r.be}`;
        let acc = byPair.get(k);
        if(!acc) byPair.set(k, acc = {score: 0, exactSkeleton: false, formed: false, evidence: []});
        if(acc.evidence.some(ev => ev.kind === r.kind && ev.key === r.key)) continue;
        const weight = Math.log(total / r.df);
        acc.evidence.push({kind: r.kind, key: r.key, df: r.df, weight});
        acc.score += weight;
        if(r.df <= kindLimits.form) acc.formed = true;
        if(r.kind === 'skel') acc.exactSkeleton = true;
    }

    const byEntry = new Map<number, Candidate[]>();
    for(const [k, acc] of byPair) {
        if(!acc.formed) continue;                           // corroboration alone never forms
        const [ae, be] = k.split('/').map(Number);
        let l = byEntry.get(ae);
        if(!l) byEntry.set(ae, l = []);
        l.push({entry_id: ae, target_entry_id: be, score: acc.score,
                exactSkeleton: acc.exactSkeleton,
                evidence: acc.evidence.toSorted((x, y) => y.weight - x.weight)});
    }
    const out: Candidate[] = [];
    for(const l of byEntry.values()) {
        l.sort((x, y) => y.score - x.score);
        out.push(...l.filter((c, i) => i < topPerEntry || c.exactSkeleton));
    }
    return out;
}

// ---------------------------------------------------------------------------------
// --- Report ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export function candidateReportMarkdown(dictA: string, dictB: string,
                                        cands: Candidate[],
                                        headwordOf: (dict: string, id: number) => string,
                                        opts: {sample?: number} = {}): string {
    const entries = new Set(cands.map(c => c.entry_id)).size;
    const exact = cands.filter(c => c.exactSkeleton);
    const lines = [
        `# Similarity pass 0: '${dictA}' -> '${dictB}' candidates`,
        ``,
        `- candidate pairs: ${cands.length} across ${entries} '${dictA}' entries`,
        `- exact-skeleton pairs: ${exact.length} ` +
            `(${new Set(exact.map(c => c.entry_id)).size} entries)`,
        `- mean candidates per entry (where any): ${(cands.length / Math.max(1, entries)).toFixed(1)}`,
        ``,
        `## Sample (highest-scoring first)`,
    ];
    for(const c of cands.toSorted((x, y) => y.score - x.score).slice(0, opts.sample ?? 40))
        lines.push(`- **${headwordOf(dictA, c.entry_id)}** -> ` +
                   `**${headwordOf(dictB, c.target_entry_id)}** ` +
                   `(score ${c.score.toFixed(1)}${c.exactSkeleton ? ', exact-skel' : ''}): ` +
                   c.evidence.slice(0, 4).map(ev => `${ev.kind}:${ev.key}(${ev.df})`).join(' '));
    return lines.join('\n') + '\n';
}
