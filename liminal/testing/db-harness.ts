/**
 * Generic test-database harness: a fresh in-memory SQLite the ambient db() points
 * at, built from a set of tables' DML.  No app/test-framework coupling - rabid
 * wiring lives in rabid/testing.ts.
 *
 * One in-memory db per process (created lazily): the data layer memoizes prepared
 * queries per-Db, so we keep a single Db for the whole run and reset its *data*
 * between tests rather than swapping the Db out from under those caches.
 */
import { Db, setDefaultDb, db } from "../db.ts";

export interface SchemaTable {
    name: string;
    createDMLString(): string;
}

let active: Db | undefined;

// Ensure the process-wide in-memory test db exists, is the ambient default, and
// has the given tables' schema.  Idempotent.
export function openTestDb(tables: SchemaTable[]): Db {
    if(active) return active;
    active = Db.openMemory();
    setDefaultDb(active);
    active.execute("PRAGMA foreign_keys = OFF");   // tests build partial graphs
    for(const t of tables)
        active.executeStatements(t.createDMLString());
    return active;
}

// Delete all rows from the given tables (FK checks are off above).
export function clearAllData(tables: SchemaTable[]): void {
    const d = db();
    for(const t of tables)
        d.execute(`DELETE FROM ${t.name}`);
}

// Close and forget the test db (e.g. between independent suites).
export function closeTestDb(): void {
    if(active) {
        active.close();
        active = undefined;
        setDefaultDb(undefined);
    }
}
