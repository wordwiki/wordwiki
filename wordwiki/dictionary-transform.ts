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
 * assertion not authored by '~dict-transform') BLOCK re-runs.
 */
import * as model from './model.ts';
import * as dictionaryConfig from './dictionary-config.ts';
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import { highestTimestamp, type Assertion, assertionPathToFields } from './assertion.ts';
import type { DictionaryStore } from './dictionary-store.ts';

export const DICT_TRANSFORM_USERNAME = '~dict-transform';

// --- Parsers (rule-level; a tiny registry - bespoke ops stay data-named) ------

export const PARSERS: Record<string, (content: string) => Record<string, any>|undefined> = {
    /** "Rand 1888, p 282" (also "Clark 1902, p 100", "p." variants) ->
     *  {book, page}; anything else -> undefined (counted, fields null). */
    randCitation: (content: string) => {
        const m = content.trim().match(/^(.*?),?\s+p\.?\s*(\d+)$/);
        return m ? {book: m[1].trim(), page: Number(m[2])} : undefined;
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
    rules: TransformRule[];
}

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
    generation: number;
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
                             opts: {stopAfterCount?: number} = {}): TransformResult {
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

    // Refuse to destroy human work: any non-transformer assertion blocks.
    const foreign = (() => {
        try {
            return db().first<{n: number}>(
                `SELECT COUNT(*) AS n FROM ${targetTable} WHERE change_by_username IS NULL ` +
                `OR change_by_username <> :u`, {u: DICT_TRANSFORM_USERNAME})?.n ?? 0;
        } catch(_e) { return 0; }
    })();
    if(foreign > 0)
        throw new Error(`target '${targetTable}' has ${foreign} edited assertion(s) - ` +
                        `the transform fully recreates the target; resolve the edits first`);

    // Recreate = the ASSERTION TABLE ONLY (the config pair is identity).
    db().execute(`DELETE FROM ${targetTable}`, {});
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

    const t = timestamp.nextTime(highestTimestamp(targetTable));
    const rows: Assertion[] = [];
    const rowById = new Map<number, Assertion>();
    const result: TransformResult = {
        entries: 0, assertions: 0,
        mappedPerTag: new Map(), unmappedPerTag: new Map(),
        skippedEmpty: 0, parseMisses: 0, recodeMisses: 0,
        generation: Number(dictionaryConfig.readConfigValue(targetTable, 'transform_generation') ?? '0') + 1,
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
        return out;
    };

    const entries = (sourceStore.entries as any[]).slice(0, opts.stopAfterCount ?? Infinity);
    for(const e of entries) {
        const entryId = e[srcPk] as number;
        result.entries++;
        const entryRow = {
            ...assertionPathToFields([[targetSchema.tag, 0], [tgtRoot.tag, entryId]]),
            assertion_id: entryId, id: entryId, ty: tgtRoot.tag,
            valid_from: t, valid_to: timestamp.END_OF_TIME,
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

    db().transaction(() => {
        for(const a of rows)
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
        ``,
        `## Mapped source tuples per tag`, ...fmt(r.mappedPerTag),
        ``,
        `## UNMAPPED source tuples per tag (the iteration worklist)`,
        ...(r.unmappedPerTag.size === 0 ? ['- (none)'] : fmt(r.unmappedPerTag)),
    ].join('\n') + '\n';
}
