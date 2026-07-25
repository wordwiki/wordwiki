// deno-lint-ignore-file no-explicit-any
/**
 * The DICTIONARY CONFIG table pair (multi-dictionary-survey.md §3.1,
 * converged with dz 2026-07-24): a dictionary is fully contained in TWO
 * tables - `<name>` (the assertions, base name NAKED) and
 * `<name>_dict_config` (name/value
 * pairs, one of which is the soft SCHEMA as compact JSON).  The schema
 * travels INSIDE the SQLite file (external schema files would have to move
 * in sync with the db - a recipe for sadness), and dictionaries are
 * SEPARABLE: dump/drop the pair and the dictionary moves with everything
 * it means.  There is deliberately NO registry table - DISCOVERY is by
 * convention (a `X_dict_config` table holding a `schema` row - the suffix
 * is deliberately distinctive: bare `_config` collides with SQLite's own
 * FTS shadow tables, dz 2026-07-24); per-dictionary
 * metadata (slug, display name, license/attribution, ...) is just more
 * pairs; instance-level concerns stay in the global `config` table.
 *
 * TRANSITIONAL (until MMO's literal retires): entry-schema.ts's
 * dictSchemaJson is still the schema's DEVELOPMENT SURFACE for MMO, so
 * ensureDictionaryConfig SYNCS literal -> config at every ensure
 * (write-if-changed of the canonical serialization).  An imported/second
 * dictionary has no literal: its config row IS the authority, written by
 * the load-schema gate (strict parse + data-at-rest validation).
 */
import { db } from '../liminal/db.ts';
import * as model from './model.ts';

export function configTableName(assertionTable: string): string {
    return `${assertionTable}_dict_config`;
}

export const createConfigDml = (assertionTable: string): string => `
CREATE TABLE IF NOT EXISTS ${configTableName(assertionTable)}(
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/** The canonical stored form of a schema: parse (strict validation) then
 *  re-emit, pretty-printed - so what lands in the config row is exactly
 *  what the parser will yield back (the round-trip fixed point), and diffs
 *  read well. */
export function canonicalSchemaJsonText(locus: string, schemaJson: any): string {
    const schema = model.Schema.parseSchemaFromCompactJson(locus, schemaJson);
    return JSON.stringify(schema.schemaToCompactJson(), null, 2);
}

export function readConfigValue(assertionTable: string, name: string): string|undefined {
    try {
        return db().first<{value: string}>(
            `SELECT value FROM ${configTableName(assertionTable)} WHERE name = :name`,
            {name})?.value;
    } catch(_e) { return undefined; }   // pre-migration db: no config table yet
}

export function writeConfigValue(assertionTable: string, name: string, value: string): void {
    db().execute(
        `INSERT INTO ${configTableName(assertionTable)}(name, value) VALUES (:name, :value)
         ON CONFLICT(name) DO UPDATE SET value = :value`,
        {name, value});
}

/** Create the config table and sync/seed its rows.  Idempotent, called at
 *  every ensure (a fully synced db sees one read, no writes). */
export function ensureDictionaryConfig(assertionTable: string, literalSchemaJson: any,
                                       seeds: Record<string, string> = {}): void {
    // One-day-old-name courtesy rename (the pair briefly shipped as
    // `X_config` before the suffix was made distinctive; only dev dbs
    // ever saw it).
    try {
        const oldName = `${assertionTable}_config`;
        const hasOld = db().first<{name: string}>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = :n`, {n: oldName});
        const hasNew = db().first<{name: string}>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = :n`,
            {n: configTableName(assertionTable)});
        if(hasOld && !hasNew)
            db().executeStatements(`ALTER TABLE ${oldName} RENAME TO ${configTableName(assertionTable)};`);
    } catch(_e) { /* fresh db */ }
    db().executeStatements(createConfigDml(assertionTable));
    // The schema row: TRANSITIONAL literal->config sync (see module note).
    const canonical = canonicalSchemaJsonText(assertionTable, literalSchemaJson);
    if(readConfigValue(assertionTable, 'schema') !== canonical)
        writeConfigValue(assertionTable, 'schema', canonical);
    // Metadata pairs: seed-if-absent only (edits in the db are the
    // authority; the seed never overwrites).
    for(const [name, value] of Object.entries(seeds))
        if(readConfigValue(assertionTable, name) === undefined)
            writeConfigValue(assertionTable, name, value);
}

/** The dictionary's schema as stored in its config row (strictly parsed),
 *  or undefined when the pair isn't set up yet (pre-migration db, minimal
 *  test db). */
export function readStoredDictionarySchema(assertionTable: string): model.Schema|undefined {
    const text = readConfigValue(assertionTable, 'schema');
    if(text === undefined) return undefined;
    return model.Schema.parseSchemaFromCompactJson(
        `${configTableName(assertionTable)}.schema`, JSON.parse(text));
}

// --- The SCHEMA-EDIT LOAD GATE ------------------------------------------------
//
// dz's rule (survey §3.1): edit the schema JSON; if the validator decides
// the change is COMPATIBLE WITH THE DATA AT REST (adding a field/relation
// is), the edit loads into the config row - otherwise error.  Two checks:
//  1. attr-usage scan: for every relation, the assertion columns actually
//     CARRYING DATA must all be bound by the proposed schema (a field
//     removal with data at rest fails, with counts); assertions whose ty
//     has no relation in the proposed schema fail wholesale.
//  2. a full workspace load under the proposed schema (structure/paths) +
//     the store validator - a moved relation (changed parentage) fails.

export interface SchemaGateResult {
    schema: model.Schema|undefined;   // parsed proposal (undefined = parse failed)
    problems: string[];               // empty = compatible
}

const ATTR_COLUMNS = Array.from({length: 15}, (_v, i) => `attr${i+1}`);

export function checkProposedSchema(assertionTable: string, proposedJson: any,
                                    deps: {
                                        loadWorkspace: (schema: model.Schema) => void,
                                    }): SchemaGateResult {
    // 1. Strict parse (styles, $view, roles, variant rules...).
    let schema: model.Schema;
    try {
        schema = model.Schema.parseSchemaFromCompactJson(
            `proposed schema for '${assertionTable}'`, proposedJson);
    } catch(e) {
        return {schema: undefined, problems: [String(e instanceof Error ? e.message : e)]};
    }
    const problems: string[] = [];

    // 2. Attr usage vs the proposed binds, one aggregate pass per db.
    const sums = ATTR_COLUMNS.map(c => `SUM(${c} IS NOT NULL) AS ${c}`).join(', ');
    const usage = db().all<any, {}>(
        `SELECT ty, COUNT(*) AS n, ${sums} FROM ${assertionTable} GROUP BY ty`, {});
    for(const row of usage) {
        const rel = schema.relationsByTag[row.ty];
        if(!rel) {
            problems.push(`${row.n} assertion(s) with ty '${row.ty}' have no relation in the proposed schema`);
            continue;
        }
        const bound = new Set(rel.scalarFields.map(f => f.bind));
        for(const c of ATTR_COLUMNS)
            if(row[c] > 0 && !bound.has(c))
                problems.push(`relation '${rel.name}' (ty '${row.ty}'): ${row[c]} assertion(s) carry data in ${c}, which the proposed schema does not bind`);
    }

    // 3. Structure: the full load + store validation under the proposal.
    if(problems.length === 0) {
        try { deps.loadWorkspace(schema); }
        catch(e) { problems.push(`workspace load under the proposed schema failed: ${String(e instanceof Error ? e.message : e)}`); }
    }
    return {schema, problems};
}

/** DISCOVERY BY CONVENTION: every assertion table in this db that has a
 *  config peer holding a schema row.  (The phase-3 store map builds from
 *  this - drop a table pair into the db file and the dictionary appears.) */
export function discoverDictionaries(): string[] {
    try {
        const configTables = db().all<{name: string}, {}>(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name LIKE '%\\_dict\\_config' ESCAPE '\\'`, {})
            .map(r => r.name);
        return configTables
            .filter(t => {
                try {
                    return db().first<{value: string}>(
                        `SELECT value FROM ${t} WHERE name = 'schema'`, {}) !== undefined;
                } catch(_e) { return false; }
            })
            .map(t => t.slice(0, -'_dict_config'.length));
    } catch(_e) { return []; }
}
