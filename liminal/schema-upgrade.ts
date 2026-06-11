// deno-lint-ignore-file no-explicit-any
/**
 * Schema upgrade: the declarative Table model is the schema-of-record, and this
 * module compares a live database against it.  The contract is ADDITIVE OR
 * HANDS-OFF:
 *
 *   - a declared table missing from the db        -> created (its indexes too);
 *   - a declared column missing from its table    -> ALTER TABLE ... ADD COLUMN
 *     (using the field's own DML line - the same code path CREATE TABLE uses,
 *     so quoting/defaults cannot diverge);
 *   - a declared index (CREATE INDEX IF NOT EXISTS in extraDML) missing -> created;
 *   - EVERYTHING ELSE is reported and never touched.
 *
 * Manual interventions, out of scope BY DESIGN (SQLite needs a table rebuild
 * for most of them anyway): dropping/renaming columns or tables, type changes,
 * changing nullability/PK, data backfills, changing an index's definition
 * (give it a new name instead; the old one shows up as an "unknown index" note
 * and you drop it by hand).
 *
 * SQLite's ALTER TABLE ADD COLUMN rules become model rules, enforced by
 * refusal: a column added to an EXISTING table must be nullable or carry a
 * constant default (NOT NULL without default is reported as a blocker, never
 * improvised around).  Columns on NEW tables are unconstrained - they ride in
 * with CREATE TABLE.
 *
 * Severities: a 'blocker' means the db does NOT match the model and needs a
 * human (mismatched type/null/pk, un-addable column).  A 'note' is drift that
 * doesn't impede operation (extra columns/tables/indexes in the db - e.g.
 * wordwiki's legacy raw-DML tables - or a default-value difference, which only
 * affects rows inserted outside the model anyway).
 *
 * Used two ways:
 *   - `<app>.ts upgrade-db [--apply]` (upgradeDbCommand): prints the plan;
 *     applies it only with --apply, taking a VACUUM INTO backup first.
 *   - on every server startup (checkDbMatchesSchema, called from
 *     LiminalApp.startServer): refuses to start on any pending action or
 *     blocker unless --allow-schema-mismatch is passed.  Startup never applies
 *     DDL - upgrades are an explicit command only.
 */
import { db, defaultDbPath } from './db.ts';
import { Table, PrimaryKeyField } from './table.ts';

export interface UpgradeAction {
    kind: 'create-table' | 'add-column' | 'create-index';
    table: string;
    detail: string;     // one-line human description
    sql: string;        // possibly multi-statement (create-table includes its indexes)
}

export interface UpgradeIssue {
    severity: 'blocker' | 'note';
    table?: string;
    message: string;
}

export interface UpgradePlan {
    actions: UpgradeAction[];
    issues: UpgradeIssue[];
}

// "Matches" = nothing to create/add and no blockers.  Notes don't count: they
// are drift the model deliberately ignores.
export function schemaMatches(plan: UpgradePlan): boolean {
    return plan.actions.length === 0 && !plan.issues.some(i => i.severity === 'blocker');
}

// The house style for extraDML index statements; anything else in extraDML is
// reported as unverifiable (a note) and never auto-executed.
const INDEX_RE = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i;

interface ParsedExtraDML { name?: string; sql: string; }

function parseExtraDML(t: Table<any>): ParsedExtraDML[] {
    return t.extraDML.map(sql => {
        const m = sql.match(INDEX_RE);
        return m ? {name: m[1], sql} : {sql};
    });
}

// Loose equivalence between a declared default and PRAGMA's literal text.  Our
// own CREATE/ALTER DML writes defaults via JSON.stringify, so dbs we created
// compare exactly; the fallbacks tolerate hand-written DML ('x' vs "x", 0 vs
// "0").  Only ever feeds a NOTE - defaults don't affect existing rows.
function defaultsEquivalent(declared: any, dbDefault: string | null | undefined): boolean {
    if(declared === undefined) return dbDefault == null;
    if(dbDefault == null) return false;
    if(JSON.stringify(declared) === dbDefault) return true;
    const unquoted = dbDefault.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    if(typeof declared === 'string') return unquoted === declared;
    if(typeof declared === 'number') return Number(dbDefault) === declared;
    return false;
}

/**
 * Compare the live db (the ambient db()) against the declared tables and return
 * the plan: safe additive actions + report-only issues.  Pure read.
 */
export function planUpgrade(tables: Table<any>[]): UpgradePlan {
    const actions: UpgradeAction[] = [];
    const issues: UpgradeIssue[] = [];

    const dbTables = new Set(db().all<{name: string}, {}>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .map(r => r.name));
    const declaredTables = new Set(tables.map(t => t.name));
    const declaredIndexNames = new Set<string>();

    for(const t of tables) {
        const extra = parseExtraDML(t);
        for(const e of extra)
            if(e.name) declaredIndexNames.add(e.name);

        // --- missing table: create it whole (columns + its extraDML indexes).
        if(!dbTables.has(t.name)) {
            actions.push({kind: 'create-table', table: t.name,
                          detail: `create table ${t.name} (with its indexes)`,
                          sql: t.createDMLString()});
            continue;
        }

        // --- existing table: per-column comparison.
        const cols = db().all<{name: string, type: string, nn: number, dflt_value: string|null, pk: number},
                              {tbl: string}>(
            `SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info(:tbl)`,
            {tbl: t.name});
        const colByName = new Map(cols.map(c => [c.name, c]));

        for(const field of t.fields) {
            const col = colByName.get(field.name);
            if(!col) {
                // Missing column: addable only within SQLite's ADD COLUMN rules.
                if(field instanceof PrimaryKeyField) {
                    issues.push({severity: 'blocker', table: t.name,
                        message: `${t.name}.${field.name}: a PRIMARY KEY column cannot be added to an existing table - migrate manually`});
                } else if(field.createDML().length !== 1) {
                    issues.push({severity: 'blocker', table: t.name,
                        message: `${t.name}.${field.name}: field emits table-level DML - cannot ALTER in; migrate manually`});
                } else if(!field.options.nullable && field.options.default === undefined) {
                    issues.push({severity: 'blocker', table: t.name,
                        message: `${t.name}.${field.name}: NOT NULL without a default cannot be added to an existing table - ` +
                                 `give it a default, make it nullable, or migrate manually`});
                } else {
                    actions.push({kind: 'add-column', table: t.name,
                                  detail: `add column ${t.name}.${field.name}`,
                                  sql: `ALTER TABLE ${t.name} ADD COLUMN ${field.createDML()[0]};`});
                }
                continue;
            }

            // Present in both: report (never act on) shape differences.
            const declaredPk = field instanceof PrimaryKeyField;
            if(declaredPk !== (col.pk > 0))
                issues.push({severity: 'blocker', table: t.name,
                    message: `${t.name}.${field.name}: primary-key mismatch (model: ${declaredPk}, db: ${col.pk > 0}) - migrate manually`});
            if(field.dmlType().toUpperCase() !== (col.type ?? '').toUpperCase())
                issues.push({severity: 'blocker', table: t.name,
                    message: `${t.name}.${field.name}: type mismatch (model: ${field.dmlType()}, db: ${col.type || '(none)'}) - migrate manually`});
            const declaredNotNull = !field.options.nullable;
            if(declaredNotNull !== !!col.nn)
                issues.push({severity: 'blocker', table: t.name,
                    message: `${t.name}.${field.name}: nullability mismatch (model: ${declaredNotNull ? 'NOT NULL' : 'nullable'}, ` +
                             `db: ${col.nn ? 'NOT NULL' : 'nullable'}) - migrate manually`});
            if(!defaultsEquivalent(field.options.default, col.dflt_value))
                issues.push({severity: 'note', table: t.name,
                    message: `${t.name}.${field.name}: default differs (model: ${JSON.stringify(field.options.default)}, ` +
                             `db: ${col.dflt_value ?? 'none'}) - affects only rows inserted outside the model; align manually if desired`});
        }

        // Columns in the db the model doesn't declare: ignored, by contract.
        const declaredCols = new Set(t.fieldNames);
        for(const col of cols)
            if(!declaredCols.has(col.name))
                issues.push({severity: 'note', table: t.name,
                    message: `${t.name}.${col.name}: column exists in db but not in the model (ignored; drop manually if obsolete)`});

        // Declared indexes (and any unverifiable extraDML) for an EXISTING table.
        for(const e of extra) {
            if(!e.name) {
                issues.push({severity: 'note', table: t.name,
                    message: `${t.name}: extraDML statement is not 'CREATE INDEX IF NOT EXISTS' - not verified or auto-applied: ${e.sql.trim().slice(0, 80)}`});
                continue;
            }
            const exists = db().first<{name: string}, {name: string}>(
                `SELECT name FROM sqlite_master WHERE type='index' AND name = :name`, {name: e.name});
            if(!exists)
                actions.push({kind: 'create-index', table: t.name,
                              detail: `create index ${e.name} on ${t.name}`, sql: e.sql});
        }
    }

    // Drift visibility (notes only): db tables not in the model (e.g. legacy
    // raw-DML tables), and indexes on DECLARED tables the model doesn't name.
    for(const name of dbTables)
        if(!declaredTables.has(name))
            issues.push({severity: 'note',
                message: `table '${name}' exists in db but not in the model (ignored)`});
    const dbIndexes = db().all<{name: string, tbl_name: string}, {}>(
        `SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'`);
    for(const ix of dbIndexes)
        if(declaredTables.has(ix.tbl_name) && !declaredIndexNames.has(ix.name))
            issues.push({severity: 'note', table: ix.tbl_name,
                message: `index '${ix.name}' on ${ix.tbl_name} exists in db but not in the model (ignored; drop manually if obsolete)`});

    return {actions, issues};
}

/** Execute the plan's actions (creates/adds only - that is all a plan contains). */
export function applyUpgrade(plan: UpgradePlan): void {
    for(const a of plan.actions) {
        console.info(`applying: ${a.detail}`);
        db().executeStatements(a.sql);
    }
}

export function formatPlan(plan: UpgradePlan): string {
    const blockers = plan.issues.filter(i => i.severity === 'blocker');
    const notes = plan.issues.filter(i => i.severity === 'note');
    const lines: string[] = [];
    lines.push(`--- schema plan: ${plan.actions.length} change(s), ${blockers.length} blocker(s), ${notes.length} note(s)`);
    for(const a of plan.actions) lines.push(`  + ${a.detail}`);
    for(const i of blockers)     lines.push(`  ! MANUAL: ${i.message}`);
    for(const i of notes)        lines.push(`  ~ note: ${i.message}`);
    return lines.join('\n');
}

/**
 * The startup gate (called from LiminalApp.startServer): refuse to serve a db
 * that doesn't match the declared model.  Notes alone are fine (one summary
 * line); any pending action or blocker prints the plan and throws - unless the
 * override flag was passed, in which case it warns and continues.
 */
export function checkDbMatchesSchema(tables: Table<any>[], appName: string,
                                     allowMismatch: boolean): void {
    const plan = planUpgrade(tables);
    if(schemaMatches(plan)) {
        console.info(`schema check: ok` +
            (plan.issues.length ? ` (${plan.issues.length} note(s) - run '${appName} upgrade-db' to list)` : ''));
        return;
    }
    console.error(formatPlan(plan));
    if(allowMismatch) {
        console.warn('schema check: MISMATCH - continuing because --allow-schema-mismatch was passed');
        return;
    }
    throw new Error(`database schema does not match the declared model (see plan above) - ` +
                    `run '${appName} upgrade-db' (then --apply), or start with --allow-schema-mismatch to serve anyway`);
}

// A consistent single-file snapshot regardless of WAL state; trivially
// restorable by copying back over the db.
function backupDb(dbPath: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = `${dbPath}.backup-${stamp}`;
    console.info(`backing up ${dbPath} -> ${target} (VACUUM INTO)`);
    db().execute<{path: string}>('VACUUM INTO :path', {path: target});
    return target;
}

/**
 * The `upgrade-db [--apply]` command body, shared by the app mains (rabid,
 * wordwiki).  Plan-only by default; --apply takes a backup, applies, and
 * re-plans to verify.  Returns a process exit code: 0 = db matches the model
 * (after apply, if given); 1 = pending changes (plan mode) or blockers remain.
 */
export function upgradeDbCommand(tables: Table<any>[], args: string[],
                                 opts: {dbPath?: string} = {}): number {
    const apply = args.includes('--apply');
    const plan = planUpgrade(tables);
    console.info(formatPlan(plan));

    const hasBlockers = plan.issues.some(i => i.severity === 'blocker');
    if(!apply) {
        if(plan.actions.length)
            console.info(`\nplan only - re-run with --apply to apply the ${plan.actions.length} change(s) above ` +
                         `(stop the server first; a backup is taken automatically).`);
        else if(!hasBlockers)
            console.info('\ndb matches the declared model - nothing to do.');
        return (plan.actions.length || hasBlockers) ? 1 : 0;
    }

    if(plan.actions.length) {
        backupDb(opts.dbPath ?? defaultDbPath);
        applyUpgrade(plan);
        const after = planUpgrade(tables);
        if(schemaMatches(after)) {
            console.info(`\napplied ${plan.actions.length} change(s) - db now matches the declared model.`);
        } else {
            console.error('\nafter applying, the db STILL does not match:');
            console.error(formatPlan(after));
            return 1;
        }
    } else if(!hasBlockers) {
        console.info('\ndb matches the declared model - nothing to do.');
    }
    return hasBlockers ? 1 : 0;
}
