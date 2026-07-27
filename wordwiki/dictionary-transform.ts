// deno-lint-ignore-file no-explicit-any
/**
 * THE DICTIONARY TRANSFORM - step 2 of the import pipeline
 * (multi-dictionary-survey.md phase 5, design converged 2026-07-25):
 * rebuild a RICH dictionary from a RAW import mirror, driven by a MAPPING
 * DOCUMENT.  Re-runnable: iterate on the mapping until it is right.
 *
 * THE MAPPING'S AUTHORITY IS THE TARGET'S OWN CONFIG PAIR (key
 * 'transform') - "fully recreate the target" means the ASSERTION TABLE
 * ONLY; the config pair is the dictionary's durable identity (slug,
 * license, schema, recipe), which is what makes this pipeline available
 * in the SAAS (data-only customization).  The FILE is an editing surface:
 * dump-mapping / load-mapping [--apply], gated like dump-schema.
 *
 * DETERMINISTIC TARGET IDS: a rule's tuple REUSES its source tuple's id;
 * auto-created intermediate wrappers derive theirs by hashing (source id,
 * wrapper depth).  Full recreates therefore look like in-place updates to
 * everything outside - copied-from links and cherry-picks survive
 * iteration, and a future history-merge stays tractable.
 *
 * The mapping document:
 *   {
 *     formatVersion: 1,
 *     sources: [{table: 'randraw', schemaHash?: '...'}],   // v1 uses [0]
 *     targetSchema: { ...a full wordwiki schema... },
 *     rules: [{
 *       from: 'ps/ge',                // source TAG path under the entry root
 *       to: 'subentry/gloss',         // target relation NAME path (may be
 *                                     //   DEEPER: wrappers auto-create per
 *                                     //   source tuple)
 *       intoParentField: 'name',      // OR: set a FIELD on the parent's
 *                                     //   target tuple instead of creating one
 *       set: {field: VALUE, ...},     // field assignments (tuple rules)
 *       value: VALUE,                 // the assignment (intoParentField rules)
 *       parser: 'randCitation',       // rule-level parser feeding {parsed:...}
 *       skipEmpty: false,             // default TRUE: empty content emits
 *                                     //   nothing (shoebox template noise)
 *     }],
 *   }
 *   VALUE := {const: s} | {content: true} | {field: 'name'}
 *            + optional {recode: {...}, recodeMiss: 'keep'|'drop'}
 *            | {parsed: 'key'}        // a field of the rule parser's result
 *
 * Source relations with NO rule are UNMAPPED: their subtrees are skipped
 * and counted per tag - the run report is the completeness accounting the
 * iterate-until-right loop converges on.  Edits on the target (any
 * assertion not authored by '~dict-transform') BLOCK re-runs - unless
 * `preserveForeign`, which rebuilds ONLY machine-owned facts: a fact any
 * of whose rows has a foreign author survives whole (history + chains),
 * computed rows never displace it, nothing is re-created under a
 * human-tombstoned ancestor, and open preserved facts whose ancestors
 * vanished are REPORTED as orphans (rand-references-design.md §4; the
 * fact-granular ownership predicate of machine-contributors-design.md).
 */
import * as model from './model.ts';
import { parseShoeboxDate } from './creation-dates.ts';
import * as schemaRoles from './schema-roles.ts';
import * as dictionaryConfig from './dictionary-config.ts';
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import { highestTimestamp, type Assertion, assertionPathToFields } from './assertion.ts';
import type { DictionaryStore } from './dictionary-store.ts';

export const DICT_TRANSFORM_USERNAME = '~dict-transform';

// --- Parsers (rule-level; a tiny registry - bespoke ops stay data-named) ------

export const PARSERS: Record<string, (content: string) => Record<string, any>|undefined> = {
    /** "Rand 1888, p 282" and Watson's hand-typed variants: punctuation
     *  soup around the marker ("Rand,1888,pg151", "Rand 1888.p.149",
     *  "pp"), page LISTS ("p 269, 270" - page = the FIRST; the raw line
     *  is kept in the source field), trailing junk ("p 201)"), roman
     *  intro pages ("p v intro." - book without page).  ->
     *  {book, page, pages}; non-citations (informant names, dates) ->
     *  undefined (counted, fields null).  Book-name typos (RRand 1888)
     *  are the mapping recode table's business, not the parser's. */
    randCitation: (content: string) => {
        const c = content.trim().replace(/\s+/g, ' ');
        const m = c.match(/^(.*?)[\s.,]+p[pg]?\.?(?=[\s.,]|\d|$)[\s.,]*(.*)$/i);
        if(!m) return undefined;
        const book = m[1].replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim() || undefined;
        const pages = m[2].match(/\d+/g) ?? [];
        if(pages.length === 0 && !/\d/.test(m[1])) return undefined;
        return {book, page: pages.length > 0 ? Number(pages[0]) : undefined,
                pages: pages.length > 0 ? pages.join(', ') : undefined};
    },
};

// --- The mapping document -------------------------------------------------------

export interface TransformValue {
    const?: string;
    content?: boolean;
    field?: string;
    parsed?: string;
    recode?: Record<string, string>;
    recodeMiss?: 'keep'|'drop';
    // Literal substring substitutions, applied to string values after
    // recode (the shoebox '_'-for-space convention in glosses - dz).
    replaceAll?: Record<string, string>;
}
export interface TransformRule {
    from: string;
    to?: string;
    intoParentField?: string;
    set?: Record<string, TransformValue>;
    value?: TransformValue;
    parser?: string;
    skipEmpty?: boolean;
}
export interface TransformMapping {
    formatVersion: number;
    sources: Array<{table: string, schemaHash?: string}>;
    targetSchema: any;
    // The target dictionary's DISPLAY NAME (config 'name') - part of the
    // recipe so a fresh migration reproduces it (the navbar/pages read it).
    targetName?: string;
    // The ENTRY ROOT's valid_from from a source field (dz: the ent
    // assertion never changes - its valid_from IS the entry's creation
    // date; MMO's migration uses the shoebox date the same way).  The
    // parser maps field content -> timestamp; unparseable/pre-epoch
    // dates fall back to the transform stamp (counted in the report).
    entryValidFrom?: {from: string, parser: string};
    rules: TransformRule[];
}

/** entryValidFrom parsers: field content -> assertion timestamp. */
export const ENTRY_TIMESTAMP_PARSERS: Record<string, (content: string) => number|undefined> = {
    /** dd/Mon/yyyy or ISO yyyy-mm-dd (parseShoeboxDate) -> a local-epoch
     *  timestamp at UTC noon; undefined below the 2020 epoch. */
    shoeboxDate: (content: string) => {
        const iso = parseShoeboxDate(content);
        if(iso === undefined) return undefined;
        const seconds = Math.floor((Date.parse(`${iso}T12:00:00Z`) - timestamp.LOCAL_EPOCH_START) / 1000);
        return seconds >= 0 ? timestamp.makeTimestamp(seconds, 0) : undefined;
    },
};

/** Advisory content hash (djb2 hex) of a source's canonical schema text -
 *  a mapping declares what it was written against; a mismatch WARNS. */
export function schemaHash(text: string): string {
    let h = 5381;
    for(let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(16);
}

export interface MappingGateResult {
    mapping: TransformMapping|undefined;
    targetSchema: model.Schema|undefined;
    problems: string[];
    warnings: string[];
}

/** The LOAD GATE (the dump-schema pattern): strict-parse the target
 *  schema, resolve every rule's source tag path and target name path /
 *  fields, check parser names.  Problems refuse; unmapped source
 *  relations are the REPORT's business, not the gate's. */
export function checkMapping(json: any, sourceSchema: model.Schema,
                             sourceSchemaText: string): MappingGateResult {
    const problems: string[] = [];
    const warnings: string[] = [];
    if(typeof json !== 'object' || json === null)
        return {mapping: undefined, targetSchema: undefined,
                problems: ['the mapping must be a JSON object'], warnings};
    const mapping = json as TransformMapping;
    if(mapping.formatVersion !== 1)
        problems.push(`unsupported mapping formatVersion '${mapping.formatVersion}'`);
    if(!Array.isArray(mapping.sources) || mapping.sources.length < 1)
        problems.push('the mapping needs at least one source');
    const declaredHash = mapping.sources?.[0]?.schemaHash;
    if(declaredHash !== undefined && declaredHash !== schemaHash(sourceSchemaText))
        warnings.push(`the source schema has changed since the mapping was written ` +
                      `(hash ${schemaHash(sourceSchemaText)} != declared ${declaredHash})`);

    let targetSchema: model.Schema|undefined;
    try {
        targetSchema = model.Schema.parseSchemaFromCompactJson('mapping.targetSchema',
                                                               mapping.targetSchema);
    } catch(e) {
        problems.push(`targetSchema: ${e instanceof Error ? e.message : e}`);
        return {mapping, targetSchema: undefined, problems, warnings};
    }

    const srcRoot = sourceSchema.relationFields[0];
    const tgtRoot = targetSchema.relationFields[0];
    const srcByPath = new Map<string, model.RelationField>();
    const walkSrc = (rel: model.RelationField, path: string) => {
        for(const c of rel.relationFields) {
            const p = path === '' ? c.tag : `${path}/${c.tag}`;
            srcByPath.set(p, c);
            walkSrc(c, p);
        }
    };
    walkSrc(srcRoot, '');
    const tgtByPath = new Map<string, model.RelationField>();
    const walkTgt = (rel: model.RelationField, path: string) => {
        for(const c of rel.relationFields) {
            const p = path === '' ? c.name : `${path}/${c.name}`;
            tgtByPath.set(p, c);
            walkTgt(c, p);
        }
    };
    walkTgt(tgtRoot, '');

    if(mapping.entryValidFrom !== undefined) {
        if(!srcByPath.has(mapping.entryValidFrom.from))
            problems.push(`entryValidFrom: no source relation at tag path ` +
                          `'${mapping.entryValidFrom.from}'`);
        if(ENTRY_TIMESTAMP_PARSERS[mapping.entryValidFrom.parser] === undefined)
            problems.push(`entryValidFrom: unknown parser '${mapping.entryValidFrom.parser}'`);
    }
    for(const [i, rule] of (mapping.rules ?? []).entries()) {
        const at = `rule ${i} (from '${rule.from}')`;
        if(!srcByPath.has(rule.from))
            problems.push(`${at}: no source relation at tag path '${rule.from}'`);
        if(rule.parser !== undefined && PARSERS[rule.parser] === undefined)
            problems.push(`${at}: unknown parser '${rule.parser}'`);
        if(rule.intoParentField !== undefined) {
            if(rule.to !== undefined)
                problems.push(`${at}: 'to' and 'intoParentField' are exclusive`);
            if(rule.value === undefined)
                problems.push(`${at}: intoParentField needs a 'value'`);
            // The parent field resolves at RUN time against the parent's
            // target relation (the parent's own rule decides where it maps).
            continue;
        }
        if(rule.to === undefined) { problems.push(`${at}: needs 'to' or 'intoParentField'`); continue; }
        const target = tgtByPath.get(rule.to);
        if(target === undefined) { problems.push(`${at}: no target relation at name path '${rule.to}'`); continue; }
        for(const f of Object.keys(rule.set ?? {}))
            if(!(target.fieldsByName[f] instanceof model.ScalarField))
                problems.push(`${at}: target '${rule.to}' has no scalar field '${f}'`);
    }
    return {mapping, targetSchema, problems, warnings};
}

// --- The engine -------------------------------------------------------------------

export interface TransformResult {
    entries: number;
    assertions: number;
    mappedPerTag: Map<string, number>;
    unmappedPerTag: Map<string, number>;    // source tuples skipped (no rule)
    skippedEmpty: number;
    parseMisses: number;
    recodeMisses: number;
    entryDatesFromSource: number;    // entry roots stamped from entryValidFrom
    generation: number;
    // preserve-foreign accounting (all zero/empty on a from-scratch run)
    preservedFacts: number;                 // foreign-owned facts kept intact
    preservedByAuthor: Map<string, number>; // ... per latest foreign author
    computedSkippedPreserved: number;       // computed rows not written (the
                                            //   preserved human version wins)
    resurrectionsSkipped: number;           // computed rows under a human-
                                            //   tombstoned ancestor (never
                                            //   reassert a human retraction)
    orphans: Array<{id: number, ty: string, entry_id: number,
                    missingAncestor: number}>;  // OPEN preserved facts whose
                                            //   ancestor no longer exists
}

/** Deterministic wrapper/fan-out id: hash of (source id, salt), folded
 *  into the positive 53-bit space away from small counter ids. */
function derivedId(sourceId: number, salt: string): number {
    let h = 5381;
    const s = `${sourceId}/${salt}`;
    for(let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 0x100000000 + h * 2048 + (sourceId % 2048);
}

export function runTransform(targetTable: string, sourceStore: DictionaryStore,
                             opts: {stopAfterCount?: number,
                                    preserveForeign?: boolean} = {}): TransformResult {
    const mappingText = dictionaryConfig.readConfigValue(targetTable, 'transform');
    if(mappingText === undefined)
        throw new Error(`dictionary '${targetTable}' has no 'transform' config - load-mapping first`);
    const sourceSchemaText = dictionaryConfig.readConfigValue(
        sourceStore.assertionTable, 'schema') ?? '';
    const gate = checkMapping(JSON.parse(mappingText), sourceStore.dictSchema, sourceSchemaText);
    if(gate.problems.length > 0 || !gate.mapping || !gate.targetSchema)
        throw new Error(`the stored mapping fails its gate: ${gate.problems.join('; ')}`);
    const mapping = gate.mapping;
    const targetSchema = gate.targetSchema;

    // OWNERSHIP is FACT-granular (the machine-contributors predicate): a
    // fact id is FOREIGN-OWNED iff ANY of its rows has a non-transformer
    // author - a human edit is a superseding row on the same id, a human
    // delete is a tombstone row on the same id, so both mark the whole
    // fact (including its machine-authored history, which must survive so
    // replaces_assertion_id chains stay intact).
    const foreignSql =
        `SELECT DISTINCT id FROM ${targetTable} WHERE change_by_username IS NULL ` +
        `OR change_by_username <> :u`;
    const foreignCount = (() => {
        try {
            return db().first<{n: number}>(
                `SELECT COUNT(*) AS n FROM (${foreignSql})`, {u: DICT_TRANSFORM_USERNAME})?.n ?? 0;
        } catch(_e) { return 0; }
    })();
    if(foreignCount > 0 && !opts.preserveForeign)
        throw new Error(`target '${targetTable}' has ${foreignCount} edited fact(s) - ` +
                        `the transform fully recreates the target; resolve the edits ` +
                        `or re-run with --preserve-foreign`);

    // Recreate = the ASSERTION TABLE ONLY (the config pair is identity).
    // Under preserve-foreign, delete only MACHINE-OWNED facts' rows;
    // foreign-owned facts survive whole.
    if(foreignCount > 0)
        db().execute(`DELETE FROM ${targetTable} WHERE id NOT IN (${foreignSql})`,
                     {u: DICT_TRANSFORM_USERNAME});
    else
        db().execute(`DELETE FROM ${targetTable}`, {});

    // The preserved facts: open/dead partition drives emission (a computed
    // row never displaces a preserved fact; nothing is emitted under a
    // human-tombstoned ancestor), and the latest foreign author is the
    // report's attribution.
    interface PreservedRow { assertion_id: number; id: number; ty: string;
        valid_from: number; valid_to: number;
        ty0: string|null; ty1: string|null; ty2: string|null;
        ty3: string|null; ty4: string|null; ty5: string|null;
        id1: number|null; id2: number|null; id3: number|null;
        id4: number|null; id5: number|null; change_by_username: string|null; }
    const preservedRows: PreservedRow[] = foreignCount === 0 ? [] :
        db().all<PreservedRow, Record<string, never>>(
            `SELECT assertion_id, id, ty, valid_from, valid_to, ` +
            `ty0, ty1, ty2, ty3, ty4, ty5, id1, id2, id3, id4, id5, ` +
            `change_by_username FROM ${targetTable}`, {});
    const preservedIds = new Set(preservedRows.map(r => r.id));
    const openPreserved = new Set(
        preservedRows.filter(r => r.valid_to === timestamp.END_OF_TIME).map(r => r.id));
    const deadPreserved = new Set([...preservedIds].filter(id => !openPreserved.has(id)));
    dictionaryConfig.writeConfigValue(targetTable, 'schema',
        dictionaryConfig.canonicalSchemaJsonText(targetTable, mapping.targetSchema));

    const rulesByFrom = new Map<string, TransformRule>();
    for(const r of mapping.rules) rulesByFrom.set(r.from, r);
    const tgtRoot = targetSchema.relationFields[0];
    const tgtByPath = new Map<string, model.RelationField>();
    const walkTgt = (rel: model.RelationField, path: string) => {
        for(const c of rel.relationFields) {
            const p = path === '' ? c.name : `${path}/${c.name}`;
            tgtByPath.set(p, c);
            walkTgt(c, p);
        }
    };
    walkTgt(tgtRoot, '');

    // Preserve runs REUSE the original stamp: rebuilt rows keep the valid_from
    // they were born with, so preserved human versions (always later) still
    // postdate their rebuilt parents, and a preserve re-run is byte-stable.
    // (A from-scratch run keeps the fresh-stamp behavior.)
    const storedStamp = dictionaryConfig.readConfigValue(targetTable, 'transform_stamp');
    const t = opts.preserveForeign && storedStamp !== undefined
        ? Number(storedStamp)
        : timestamp.nextTime(highestTimestamp(targetTable));
    const rows: Assertion[] = [];
    const rowById = new Map<number, Assertion>();
    const result: TransformResult = {
        entries: 0, assertions: 0,
        mappedPerTag: new Map(), unmappedPerTag: new Map(),
        skippedEmpty: 0, parseMisses: 0, recodeMisses: 0,
        entryDatesFromSource: 0,
        generation: Number(dictionaryConfig.readConfigValue(targetTable, 'transform_generation') ?? '0') + 1,
        preservedFacts: preservedIds.size, preservedByAuthor: new Map(),
        computedSkippedPreserved: 0, resurrectionsSkipped: 0, orphans: [],
    };
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

    const srcSchema = sourceStore.dictSchema;
    const srcRoot = srcSchema.relationFields[0];
    const srcPk = srcRoot.primaryKeyField.name;
    const lastKey = new Map<string, string>();
    const keyFor = (parentId: number, tag: string): string => {
        const k = `${parentId}/${tag}`;
        const next = orderkey.between(lastKey.get(k), undefined);
        lastKey.set(k, next);
        return next;
    };

    const evalValue = (v: TransformValue, tuple: any, parsed: Record<string, any>|undefined,
                       contentField: string): any => {
        let out: any;
        if(v.const !== undefined) out = v.const;
        else if(v.parsed !== undefined) out = parsed?.[v.parsed] ?? null;
        else out = tuple[v.field ?? (v.content ? contentField : contentField)];
        if(v.recode !== undefined && out != null) {
            const hit = v.recode[String(out)];
            if(hit !== undefined) out = hit;
            else { result.recodeMisses++; if(v.recodeMiss === 'drop') out = null; }
        }
        if(v.replaceAll !== undefined && typeof out === 'string')
            for(const [from, to] of Object.entries(v.replaceAll))
                out = (out as string).split(from).join(to);
        return out;
    };

    // The entryValidFrom source relation, resolved by TAG PATH (top-level
    // segments walked by tag; the gate has already vetted the path).
    const entryDateRel = (() => {
        if(mapping.entryValidFrom === undefined) return undefined;
        let rel: model.RelationField|undefined;
        let at: model.RelationField = srcRoot;
        for(const seg of mapping.entryValidFrom.from.split('/')) {
            rel = at.relationFields.find(r => r.tag === seg);
            if(rel === undefined) return undefined;
            at = rel;
        }
        return rel;
    })();
    const entryDateParser = mapping.entryValidFrom !== undefined
        ? ENTRY_TIMESTAMP_PARSERS[mapping.entryValidFrom.parser] : undefined;

    const entries = (sourceStore.entries as any[]).slice(0, opts.stopAfterCount ?? Infinity);
    for(const e of entries) {
        const entryId = e[srcPk] as number;
        result.entries++;
        // The ent assertion never changes - its valid_from IS the entry's
        // creation date (dz): stamp it from the source date field where
        // one parses; children keep the transform stamp (always later,
        // so the parent-before-child validator invariant holds).
        let entryValidFrom = t;
        if(entryDateRel !== undefined && entryDateParser !== undefined) {
            const dateTuple = schemaRoles.collectTuples(e, entryDateRel)
                .find(d => (d.content ?? '') !== '');
            const ts = dateTuple !== undefined
                ? entryDateParser(String(dateTuple.content)) : undefined;
            if(ts !== undefined && ts <= t) {
                entryValidFrom = ts;
                result.entryDatesFromSource++;
            }
        }
        const entryRow = {
            ...assertionPathToFields([[targetSchema.tag, 0], [tgtRoot.tag, entryId]]),
            assertion_id: entryId, id: entryId, ty: tgtRoot.tag,
            valid_from: entryValidFrom, valid_to: timestamp.END_OF_TIME,
            order_key: orderkey.new_range_start_string,
            change_by_username: DICT_TRANSFORM_USERNAME,
        } as Assertion;
        rows.push(entryRow); rowById.set(entryId, entryRow);
        result.assertions++;

        // Per-entry: target path -> the tuple id owning that path level,
        // seeded with the entry root; each mapped source tuple registers
        // the wrappers+leaf it created so DESCENDANT rules can attach.
        interface Ctx { byTargetPath: Map<string, {id: number, path: [string, number][]}>;
                        srcRel: model.RelationField; }
        const entryCtx: Ctx = {
            byTargetPath: new Map([['', {id: entryId,
                path: [[targetSchema.tag, 0], [tgtRoot.tag, entryId]] as [string, number][]}]]),
            srcRel: srcRoot};

        const walk = (srcTuple: any, srcRel: model.RelationField, srcPath: string,
                      ancestors: Ctx[]) => {
            const rule = rulesByFrom.get(srcPath);
            const contentField = 'content';
            const content = srcTuple[contentField];
            const skipEmpty = rule?.skipEmpty ?? true;
            const ctx: Ctx = {byTargetPath: new Map(), srcRel};

            if(rule === undefined) {
                bump(result.unmappedPerTag, srcRel.tag);
                return;   // unmapped subtree: skipped (the report's business)
            }
            const parsed = rule.parser !== undefined && content != null
                ? PARSERS[rule.parser](String(content)) : undefined;
            if(rule.parser !== undefined && content != null && parsed === undefined)
                result.parseMisses++;

            if(rule.intoParentField !== undefined) {
                if(skipEmpty && (content == null || content === '')) { result.skippedEmpty++; return; }
                // Set the field on the nearest ancestor's DEEPEST target
                // tuple (its leaf - the tuple that ancestor's rule created).
                outer:
                for(let i = ancestors.length - 1; i >= 0; i--) {
                    let bestPath: string|undefined;
                    for(const pth of ancestors[i].byTargetPath.keys())
                        if(bestPath === undefined || pth.length > bestPath.length)
                            bestPath = pth;
                    if(bestPath === undefined) continue;
                    const own = ancestors[i].byTargetPath.get(bestPath)!;
                    const rel = bestPath === '' ? tgtRoot : tgtByPath.get(bestPath)!;
                    const f = rel.fieldsByName[rule.intoParentField!] as model.ScalarField|undefined;
                    const parentRow = rowById.get(own.id);
                    if(parentRow !== undefined && f !== undefined)
                        (parentRow as any)[f.bind] =
                            evalValue(rule.value!, srcTuple, parsed, contentField);
                    break outer;
                }
                bump(result.mappedPerTag, srcRel.tag);
                return;
            }

            // skipEmpty is DEEP: a tuple with no content of its own AND no
            // content anywhere below it emits nothing (the shoebox template
            // noise - e.g. an all-empty first sense vanishes entirely).
            const hasContentDeep = (tuple: any, rel: model.RelationField): boolean => {
                if(tuple.content != null && tuple.content !== '') return true;
                return rel.relationFields.some(c =>
                    (tuple[c.name] ?? []).some((ct: any) => hasContentDeep(ct, c)));
            };
            if(skipEmpty && !hasContentDeep(srcTuple, srcRel)) {
                result.skippedEmpty++;
                return;
            }

            // Resolve the target parent: the LONGEST proper prefix of
            // rule.to registered by an ancestor (the entry root registers '').
            const toParts = rule.to!.split('/');
            let parent: {id: number, path: [string, number][]}|undefined;
            let parentDepth = -1;
            for(const a of [entryCtx, ...ancestors]) {
                for(const [p, reg] of a.byTargetPath) {
                    const depth = p === '' ? 0 : p.split('/').length;
                    if(depth > parentDepth && depth < toParts.length
                        && (p === '' || rule.to!.startsWith(p + '/')))
                        { parent = reg; parentDepth = depth; }
                }
            }
            if(parent === undefined) { bump(result.unmappedPerTag, srcRel.tag); return; }

            // Auto-create intermediate WRAPPERS (one per source tuple), then
            // the leaf tuple (which REUSES the source id).
            let at = parent;
            for(let d = parentDepth; d < toParts.length; d++) {
                const targetPath = toParts.slice(0, d + 1).join('/');
                const rel = tgtByPath.get(targetPath)!;
                const leaf = d === toParts.length - 1;
                const id = leaf ? (srcTuple[srcRel.primaryKeyField.name] as number)
                                : derivedId(srcTuple[srcRel.primaryKeyField.name] as number,
                                            targetPath);
                const path: [string, number][] = [...at.path, [rel.tag, id]];
                const row = {
                    ...assertionPathToFields(path),
                    assertion_id: id, id, ty: rel.tag,
                    valid_from: t, valid_to: timestamp.END_OF_TIME,
                    order_key: keyFor(at.id, rel.tag),
                    change_by_username: DICT_TRANSFORM_USERNAME,
                } as Assertion;
                if(leaf)
                    for(const [fname, v] of Object.entries(rule.set ?? {})) {
                        const f = rel.fieldsByName[fname] as model.ScalarField;
                        (row as any)[f.bind] = evalValue(v, srcTuple, parsed, contentField);
                    }
                rows.push(row); rowById.set(id, row);
                result.assertions++;
                ctx.byTargetPath.set(targetPath, {id, path});
                at = {id, path};
            }
            bump(result.mappedPerTag, srcRel.tag);

            for(const child of srcRel.relationFields)
                for(const childTuple of (srcTuple[child.name] ?? []))
                    walk(childTuple, child, `${srcPath}/${child.tag}`, [...ancestors, ctx]);
        };

        for(const child of srcRoot.relationFields)
            for(const tuple of (e[child.name] ?? []))
                walk(tuple, child, child.tag, [entryCtx]);
    }

    // Preserve-foreign emission filter: a computed row whose fact id is
    // preserved is SKIPPED (the human version - open, edited, or
    // tombstoned - wins); a computed row under a human-tombstoned
    // ancestor is skipped too (re-creating a deleted sense's children
    // would resurrect what the human removed).  Deterministic ids make
    // both checks a set lookup.
    const ancestorIds = (a: Assertion): number[] =>
        [a.id1, a.id2, a.id3, a.id4, a.id5]
            .filter((x): x is number => x != null && x !== a.id);
    const inserted: Assertion[] = preservedIds.size === 0 ? rows : rows.filter(a => {
        if(preservedIds.has(a.id)) { result.computedSkippedPreserved++; return false; }
        if(ancestorIds(a).some(x => deadPreserved.has(x))) {
            result.resurrectionsSkipped++; return false; }
        return true;
    });

    // The preserved-facts accounting: latest-foreign-author attribution, and
    // ORPHANS - open preserved facts whose ancestor chain no longer has an
    // open fact (typically: the source record vanished in a re-import, so
    // the rebuilt table lacks the entry).  Human work is never deleted, and
    // dangling rows would fail the store's structural validation - so each
    // missing ancestor is re-asserted as a machine SKELETON stub: the
    // orphaned facts stay visible and editable in-band, the report is the
    // worklist, and (being machine-owned) the stubs re-derive or vanish on
    // the next run as the orphans are resolved.
    if(preservedRows.length > 0) {
        const latestByFact = new Map<number, PreservedRow>();
        for(const r of preservedRows) {
            const cur = latestByFact.get(r.id);
            if(!cur || r.valid_from > cur.valid_from ||
               (r.valid_from === cur.valid_from && r.assertion_id > cur.assertion_id))
                latestByFact.set(r.id, r);
        }
        for(const r of latestByFact.values()) {
            const author = r.change_by_username !== DICT_TRANSFORM_USERNAME
                ? (r.change_by_username ?? '(unknown)') : '(machine history)';
            bump(result.preservedByAuthor, author);
        }
        const openIds = new Set<number>(openPreserved);
        for(const a of inserted) openIds.add(a.id);
        for(const id of openPreserved) {
            const r = latestByFact.get(id)!;
            const levels: Array<[string|null, number|null]> = [
                [r.ty1, r.id1], [r.ty2, r.id2], [r.ty3, r.id3],
                [r.ty4, r.id4], [r.ty5, r.id5]];
            const missing = levels
                .filter((l): l is [string, number] => l[1] != null && l[1] !== id)
                .filter(([_ty, aid]) => !openIds.has(aid));
            if(missing.length === 0) continue;
            result.orphans.push({id, ty: r.ty, entry_id: r.id1 ?? 0,
                                 missingAncestor: missing[0][1]});
            // Skeleton stubs, outermost first, deduped via openIds.
            for(let k = 0; k < levels.length; k++) {
                const [ty, aid] = levels[k];
                if(ty == null || aid == null || aid === id || openIds.has(aid)) continue;
                const prefix: [string, number][] = [[r.ty0 ?? targetSchema.tag, 0]];
                for(let j = 0; j <= k; j++)
                    prefix.push([levels[j][0]!, levels[j][1]!]);
                inserted.push({
                    ...assertionPathToFields(prefix),
                    assertion_id: aid, id: aid, ty,
                    valid_from: t, valid_to: timestamp.END_OF_TIME,
                    order_key: orderkey.new_range_start_string,
                    change_by_username: DICT_TRANSFORM_USERNAME,
                    change_note: 'skeleton for orphaned edits (see the transform report)',
                } as Assertion);
                openIds.add(aid);
            }
        }
    }
    result.assertions = inserted.length;

    db().transaction(() => {
        for(const a of inserted)
            db().insert<Assertion, 'assertion_id'>(targetTable, a, 'assertion_id');
    });
    dictionaryConfig.writeConfigValue(targetTable, 'transform_generation',
                                      String(result.generation));
    dictionaryConfig.writeConfigValue(targetTable, 'transform_stamp', String(t));
    dictionaryConfig.writeConfigValue(targetTable, 'transform_source',
                                      sourceStore.assertionTable);
    return result;
}

export function transformReportMarkdown(table: string, r: TransformResult): string {
    const fmt = (m: Map<string, number>) =>
        [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- \\${k}: ${n}`);
    return [
        `# Transform: ${table} (generation ${r.generation})`,
        ``,
        `- entries: ${r.entries}`,
        `- assertions: ${r.assertions}`,
        `- skipped empty: ${r.skippedEmpty}`,
        `- parse misses: ${r.parseMisses}`,
        `- recode misses: ${r.recodeMisses}`,
        `- entry dates from source (entryValidFrom): ${r.entryDatesFromSource}`,
        ``,
        ...(r.preservedFacts === 0 ? [] : [
            ``,
            `## Preserved foreign-owned facts: ${r.preservedFacts}`,
            ...fmt(r.preservedByAuthor),
            `- computed rows skipped (preserved version wins): ${r.computedSkippedPreserved}`,
            `- resurrections skipped (under a human-tombstoned ancestor): ${r.resurrectionsSkipped}`,
            ``,
            `## ORPHANED preserved facts (ancestor gone; now under skeleton stubs - the human worklist)`,
            ...(r.orphans.length === 0 ? ['- (none)'] :
                r.orphans.slice(0, 40).map(o =>
                    `- fact ${o.id} (\\${o.ty}) in entry ${o.entry_id}: ` +
                    `ancestor ${o.missingAncestor} no longer exists`)),
            ...(r.orphans.length > 40 ? [`- ... and ${r.orphans.length - 40} more`] : []),
        ]),
        ``,
        `## Mapped source tuples per tag`, ...fmt(r.mappedPerTag),
        ``,
        `## UNMAPPED source tuples per tag (the iteration worklist)`,
        ...(r.unmappedPerTag.size === 0 ? ['- (none)'] : fmt(r.unmappedPerTag)),
    ].join('\n') + '\n';
}
