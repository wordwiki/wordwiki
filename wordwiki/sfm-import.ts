// deno-lint-ignore-file no-explicit-any
/**
 * SFM IMPORT, STEP 1 of the two-step pipeline (multi-dictionary-survey.md
 * phase 5): auto-import a shoebox database as a RAW dictionary - a literal
 * IMPORT MIRROR, no user decisions beyond encodings and the structure
 * mode.  Step 2 (the mapping transform to the rich dictionary) is
 * separate; nothing here reshapes.
 *
 * THE SCHEMA IS A PURE FUNCTION OF THE .TYP (stable per .typ - data can
 * change; the shape must not).  Two structure modes (dz 2026-07-25):
 *
 *  - 'tree': the derived relations NEST as the .typ's mkrOverThis tree -
 *    the right mode for STRUCTURAL typs, where downstream steps get the
 *    grouping for free.  Refused (with the offending markers listed) when
 *    the .typ is deeper than the assertion path capacity.
 *  - 'flat': every marker is a DIRECT child relation of the entry root,
 *    and the exact SFM field sequence is preserved in `seq` - the escape
 *    hatch for ENTRY-TEMPLATE typs like the Watson drop's, whose
 *    mkrOverThis chains markers in record order (a 14-level vine that is
 *    template artifact, not meaning).  Nothing is lost: order + the .typ
 *    (stashed in config as source_typ) let step 2 re-derive any grouping.
 *
 * Common shape: the record marker becomes the ENTRY ROOT (pk only, like
 * MMO's), with its content in ONE synthesized child relation carrying the
 * headword title role - so a raw dictionary browses immediately.  Every
 * derived relation is {pk, content(attr1), seq(attr2)}; storage tags are
 * the RAW marker names (readable-in-1000-years data); relation names go
 * through toJavascriptIdentifier (the digit-initial 1d family);
 * \nam -> $prompt.
 *
 * DETERMINISM: ids are CONTENT-KEYED (dz 2026-07-26) - a record's id is
 * a 53-bit hash of its canonical field text (+ an occurrence index for
 * Rand's genuinely duplicate records), field ids hang off the record id
 * by emission ordinal.  An identical re-import is byte-identical, and a
 * NEW DROP with an inserted record moves NOTHING ELSE: unchanged records
 * keep their ids, so downstream identity (transform-reused fact ids,
 * references, binder cache keys, cross-dictionary links) survives
 * re-imports; an EDITED record changes id, so human work attached to the
 * old id orphans VISIBLY (preserve-foreign skeletons + report), never
 * mis-attaches.  Import ids live in [2^44, 2^53) - disjoint from app
 * counter ids and the transform's derivedId wrapper space.  Timestamps
 * are a single import stamp, order keys derived from seq.  Mirrors are
 * stamped '~sfm-import'; re-import WIPES the
 * assertion table and refuses if any foreign (non-importer) assertion
 * exists - edits belong in the step-2 dictionary.
 */
import * as sfm from './sfm.ts';
import * as model from './model.ts';
import * as dictionaryConfig from './dictionary-config.ts';
import { toJavascriptIdentifier } from '../liminal/identifier.ts';
import { db } from '../liminal/db.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import { highestTimestamp, type Assertion, assertionPathToFields } from './assertion.ts';

export const SFM_IMPORT_USERNAME = '~sfm-import';

/** Path capacity: ty0 (the schema root) + ty1..ty5 = the entry root and
 *  four relation levels below it. */
const MAX_RELATION_DEPTH = 5;

export type SfmStructure = 'flat' | 'tree';

// --- .typ -> schema (a pure function; NOTHING here looks at data) -------------

/** A deterministic tag that avoids the marker namespace: `want`, else
 *  want0, want1, ... (stability: a fixed .typ always yields the same). */
function freeTag(want: string, taken: Set<string>): string {
    if(!taken.has(want)) return want;
    for(let i = 0; ; i++)
        if(!taken.has(`${want}${i}`)) return `${want}${i}`;
}

export interface DerivedSchema {
    schemaJson: any;
    entryTag: string;
    /** marker -> relation name (the record marker maps to its synthesized
     *  content relation). */
    relationNameByMarker: Map<string, string>;
    problems: string[];
}

export function typToSchemaJson(typ: sfm.SfmSchema,
                                opts: {name: string, structure: SfmStructure}): DerivedSchema {
    const problems: string[] = [];
    const markers = [...typ.nodes.keys()];
    const taken = new Set(markers);
    const rootTag = freeTag(opts.name, taken);
    taken.add(rootTag);
    const entryTag = freeTag('rec', taken);
    taken.add(entryTag);

    const relationNameByMarker = new Map<string, string>();
    const usedNames = new Set(['entry']);
    const nameFor = (marker: string): string => {
        // toJavascriptIdentifier is INJECTIVE, so distinct markers cannot
        // collide with each other - only with our synthesized 'entry'.
        let name = toJavascriptIdentifier(marker);
        while(usedNames.has(name)) name = name + '_';
        usedNames.add(name);
        relationNameByMarker.set(marker, name);
        return name;
    };

    const relationJson = (marker: string, node: sfm.SfmSchemaNode|undefined,
                          extra: Record<string, any> = {}): any => {
        const name = nameFor(marker);
        const json: any = {
            $type: 'relation', $tag: marker,
            [`${name}_id`]: {$type: 'primary_key'},
            content: {$type: 'string', $bind: 'attr1', $optional: true,
                      $style: {$view: {label: 'inline'}}},
            /** The field's position in the ORIGINAL record - the exact SFM
             *  interleave order, always recoverable. */
            seq: {$type: 'integer', $bind: 'attr2', $optional: true,
                  $style: {$view: {hidden: true}}},
            $style: {$view: {label: 'inline', empty: 'elide'}},
            ...extra,
        };
        if(node?.name) json.$prompt = node.name;    // \nam
        return {name, json};
    };

    const entryJson: any = {
        $type: 'relation', $tag: entryTag, $prompt: 'Record',
        $style: {$shape: 'containerRelation'},
        entry_id: {$type: 'primary_key'},
    };
    // The record marker's own content: ONE synthesized child relation
    // carrying the headword title role (titles live on descendants).
    const recNode = typ.root;
    {
        const {name, json} = relationJson(typ.recordMarker, recNode, {
            $style: {$view: {label: 'inline', titleRole: 'headword'}},
        });
        entryJson[name] = json;
    }

    const nonRecord = markers.filter(m => m !== typ.recordMarker);
    if(opts.structure === 'flat') {
        for(const marker of nonRecord) {
            const {name, json} = relationJson(marker, typ.nodes.get(marker));
            entryJson[name] = json;
        }
    } else {
        // 'tree': nest as the .typ does; DEPTH is checked against the path
        // capacity first, and the whole derivation refuses on overflow
        // (use --structure=flat for entry-template vines).
        const depthOf = (n: sfm.SfmSchemaNode): number => {
            let d = 0;
            for(let p: sfm.SfmSchemaNode|undefined = n; p?.parent; p = p.parent) d++;
            return d;
        };
        const tooDeep = nonRecord.filter(m => {
            const n = typ.nodes.get(m)!;
            // marker at .typ depth d sits at relation depth d+1 (under the
            // entry root); capacity is MAX_RELATION_DEPTH.
            return depthOf(n) + 1 > MAX_RELATION_DEPTH;
        });
        if(tooDeep.length > 0) {
            problems.push(`structure 'tree' refused: markers deeper than the assertion ` +
                `path capacity (${MAX_RELATION_DEPTH} levels): ${tooDeep.join(' ')} - ` +
                `use --structure=flat (the .typ chains markers in record-template order)`);
            return {schemaJson: undefined, entryTag, relationNameByMarker, problems};
        }
        const build = (node: sfm.SfmSchemaNode, into: any) => {
            for(const child of node.children) {
                const {name, json} = relationJson(child.tagName, child);
                into[name] = json;
                build(child, json);
            }
        };
        if(recNode) build(recNode, entryJson);
    }

    const schemaJson = {
        $type: 'schema', $name: opts.name, $tag: rootTag,
        entry: entryJson,
    };
    return {schemaJson, entryTag, relationNameByMarker, problems};
}

// --- The import itself ----------------------------------------------------------

export interface SfmImportOpts {
    table: string;                    // the dictionary pair's table name
    slug?: string;
    structure?: SfmStructure;
    stopAfterCount?: number;          // sampling (tests)
    sourceName?: string;              // provenance label (the file name)
}

// --- Content-keyed ids --------------------------------------------------------
// Import ids live in [2^44, 2^53): DISJOINT from the app's counter ids and
// from dictionary-transform's derivedId wrapper space, so the id families
// can never collide inside a transformed table.  53 bits (not 64): JS
// numbers round-trip integers only to Number.MAX_SAFE_INTEGER, and these
// ids ride JSON, routes and attr columns.
const ID_FLOOR = 2 ** 44;
const ID_SPAN = 2 ** 53 - ID_FLOOR;
function fnv64(s: string): bigint {
    let h = 0xcbf29ce484222325n;
    for(let i = 0; i < s.length; i++) {
        h ^= BigInt(s.charCodeAt(i));
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h;
}
/** A stable 53-bit id from content parts (FNV-1a 64 folded into the
 *  import id space). */
export function contentKeyId(parts: Array<string|number>): number {
    return ID_FLOOR + Number(fnv64(parts.join('\u0000')) % BigInt(ID_SPAN));
}

export interface SfmImportResult {
    records: number;
    assertions: number;
    perMarker: Map<string, number>;
    droppedFields: number;            // fields whose marker has no relation
    idCollisions: number;             // content-hash collisions (deterministically re-salted)
    problems: sfm.SfmProblem[];       // tree-recovery problems (lenient)
    schemaProblems: string[];
    generation: number;
}

/** Any assertion not authored by the importer = the mirror has been
 *  edited; re-import refuses (edits belong in the step-2 dictionary). */
export function foreignAssertionCount(table: string): number {
    try {
        return db().first<{n: number}>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE change_by_username IS NULL ` +
            `OR change_by_username <> :u`, {u: SFM_IMPORT_USERNAME})?.n ?? 0;
    } catch(_e) { return 0; }   // no table yet
}

export function importSfm(typText: string, dataText: string,
                          opts: SfmImportOpts): SfmImportResult {
    const structure = opts.structure ?? 'tree';
    const typ = sfm.parseTyp(typText);
    const derived = typToSchemaJson(typ, {name: opts.table, structure});
    if(derived.schemaJson === undefined)
        throw new Error(derived.problems.join('; '));

    // --- The dictionary pair: create fresh, or WIPE an unedited mirror.
    const exists = db().first<{name: string}>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = :n`,
        {n: opts.table}) !== undefined;
    if(exists) {
        if(dictionaryConfig.readConfigValue(opts.table, 'import_mirror') !== 'true')
            throw new Error(`dictionary '${opts.table}' exists and is not an import mirror - refusing`);
        const foreign = foreignAssertionCount(opts.table);
        if(foreign > 0)
            throw new Error(`import mirror '${opts.table}' has ${foreign} edited assertion(s) - ` +
                            `re-import would destroy them; edits belong in the transformed dictionary`);
        db().execute(`DELETE FROM ${opts.table}`, {});
        dictionaryConfig.writeConfigValue(opts.table, 'schema',
            dictionaryConfig.canonicalSchemaJsonText(opts.table, derived.schemaJson));
    } else {
        dictionaryConfig.createDictionary(opts.table, derived.schemaJson,
                                          {slug: opts.slug ?? opts.table});
    }
    const generation =
        Number(dictionaryConfig.readConfigValue(opts.table, 'import_generation') ?? '0') + 1;
    dictionaryConfig.writeConfigValue(opts.table, 'import_mirror', 'true');
    dictionaryConfig.writeConfigValue(opts.table, 'import_structure', structure);
    dictionaryConfig.writeConfigValue(opts.table, 'import_generation', String(generation));
    dictionaryConfig.writeConfigValue(opts.table, 'import_source', opts.sourceName ?? '(text)');
    dictionaryConfig.writeConfigValue(opts.table, 'source_typ', typText);

    // --- Parse + recover trees (lenient: problems are part of the report).
    const database = sfm.readDatabase(dataText, typ.recordMarker,
                                      {stopAfterCount: opts.stopAfterCount});
    const problems = sfm.applySchema(database, typ, {lenient: true});

    // --- Records -> assertions.  DETERMINISTIC + CONTENT-KEYED ids (see
    //     the module doc), one import stamp, order keys from seq.
    const schema = model.Schema.parseSchemaFromCompactJson(opts.table, derived.schemaJson);
    const entryRel = schema.relationFields[0];
    const relByTag = entryRel.descendantAndSelfRelationsByTag;
    const t = timestamp.nextTime(highestTimestamp(opts.table));
    const usedIds = new Set<number>();
    // Cross-content hash collisions are ~1e-5 at this corpus size; resolve
    // deterministically (same file -> same result) and count them.
    let idCollisions = 0;
    const claimId = (id: number): number => {
        while(usedIds.has(id)) { idCollisions++; id = contentKeyId(['bump', id]); }
        usedIds.add(id);
        return id;
    };
    const recordOccurrence = new Map<string, number>();
    const rows: Assertion[] = [];
    const perMarker = new Map<string, number>();
    let droppedFields = 0;

    for(const record of database.records) {
        const canonical = record.fields
            .map(f => `${f.name}\u0001${f.content ?? ''}`).join('\u0002');
        const occ = recordOccurrence.get(canonical) ?? 0;
        recordOccurrence.set(canonical, occ + 1);
        const entryId = claimId(contentKeyId(['rec', canonical, occ]));
        let fieldOrdinal = 0;
        rows.push({
            ...assertionPathToFields([[schema.tag, 0], [entryTagOf(schema), entryId]]),
            assertion_id: entryId, id: entryId, ty: entryTagOf(schema),
            valid_from: t, valid_to: timestamp.END_OF_TIME,
            order_key: orderkey.new_range_start_string,
            change_by_username: SFM_IMPORT_USERNAME,
        } as Assertion);
        const entryPath: [string, number][] = [[schema.tag, 0], [entryTagOf(schema), entryId]];

        // Sibling order books: one per (parent id, relation tag).
        const lastKey = new Map<string, string>();
        const keyFor = (parentId: number, tag: string): string => {
            const k = `${parentId}/${tag}`;
            const next = orderkey.between(lastKey.get(k), undefined);
            lastKey.set(k, next);
            return next;
        };

        const emit = (marker: string, content: string|null|undefined, seq: number,
                      parentPath: [string, number][], parentId: number): number|undefined => {
            const rel = relByTag[marker];
            if(rel === undefined) { droppedFields++; return undefined; }
            const id = claimId(contentKeyId(['fld', entryId, fieldOrdinal++]));
            perMarker.set(marker, (perMarker.get(marker) ?? 0) + 1);
            rows.push({
                ...assertionPathToFields([...parentPath, [marker, id]]),
                assertion_id: id, id, ty: marker,
                valid_from: t, valid_to: timestamp.END_OF_TIME,
                order_key: keyFor(parentId, marker),
                attr1: content, attr2: seq,
                change_by_username: SFM_IMPORT_USERNAME,
            } as Assertion);
            return id;
        };

        if(structure === 'flat') {
            // Field 0 is the record marker's own content; the rest land in
            // FILE ORDER as direct children (seq = position).
            record.fields.forEach((f, seq) => {
                emit(f.name, f.content, seq, entryPath, entryId);
            });
        } else {
            // Walk the recovered tree; seq still records file position
            // (synthesized levels get the position of the field that
            // forced them, content null).
            let seq = 0;
            const seqOf = new Map<sfm.SfmField, number>();
            for(const f of record.fields) seqOf.set(f, seq++);
            const walk = (field: sfm.SfmField, parentPath: [string, number][],
                          parentId: number) => {
                const id = emit(field.name,
                                seqOf.has(field) ? field.content : null,
                                seqOf.get(field) ?? -1, parentPath, parentId);
                if(id === undefined) return;
                const path: [string, number][] = [...parentPath, [field.name, id]];
                for(const child of field.children) walk(child, path, id);
            };
            const root = record.root;
            if(root !== undefined) {
                // The record marker's content tuple, then the tree below it.
                emit(root.name, root.content, 0, entryPath, entryId);
                for(const child of root.children) walk(child, entryPath, entryId);
            }
        }
    }

    db().transaction(() => {
        for(const a of rows)
            db().insert<Assertion, 'assertion_id'>(opts.table, a, 'assertion_id');
    });
    dictionaryConfig.writeConfigValue(opts.table, 'import_stamp', String(t));

    return {records: database.records.length, assertions: rows.length, perMarker,
            droppedFields, idCollisions, problems,
            schemaProblems: derived.problems, generation};
}

const entryTagOf = (schema: model.Schema): string => schema.relationFields[0].tag;

/** The run report as markdown (the completeness accounting - no silent
 *  truncation; iterate-until-right needs something to converge on). */
export function importReportMarkdown(table: string, r: SfmImportResult): string {
    const lines = [
        `# SFM import: ${table} (generation ${r.generation})`,
        ``,
        `- records: ${r.records}`,
        `- assertions: ${r.assertions}`,
        `- dropped fields (marker without a relation): ${r.droppedFields}`,
        `- id-hash collisions (re-salted deterministically): ${r.idCollisions}`,
        `- tree-recovery problems: ${r.problems.length}`,
        ...r.schemaProblems.map(p => `- SCHEMA: ${p}`),
        ``,
        `## Fields per marker`,
        ...[...r.perMarker.entries()].sort((a, b) => b[1] - a[1])
            .map(([m, n]) => `- \\${m}: ${n}`),
    ];
    if(r.problems.length > 0) {
        lines.push('', '## Problems (first 100)');
        for(const p of r.problems.slice(0, 100))
            lines.push(`- record ${p.recordIndex} ('${p.recordMarkerContent}'): ${p.detail}`);
    }
    return lines.join('\n') + '\n';
}
