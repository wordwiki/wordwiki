import { db, Db } from "../liminal/db.ts";
import { Table, PrimaryKeyField, StringField } from "../liminal/table.ts";
import { path } from "../liminal/serializable.ts";
import { block } from "../liminal/strings.ts";

// TODO: move this to a config file.
export const awsCmdPath = '/usr/local/bin/aws';
export const lameEncPath = '/usr/bin/lame';

export const defaultTileWidth = 1024;
export const defaultTileHeight = 128;


export const googleTagId = "G-XSLP5DBR7L";

export const bootstrapCssLink =
    ['link',
     {href:"https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
      rel:"stylesheet",
      integrity:"sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH",
      crossorigin:"anonymous"}];

export const bootstrapScriptTag =
    ['script',
     {'src':"https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js",
      integrity:"sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz",
      crossorigin:"anonymous"}];

// --------------------------------------------------------------------------------
// --- Config: a general key/value settings table ---------------------------------
// --------------------------------------------------------------------------------
//
// Same model as rabid's config table: built through the framework like any other
// table.  Its first use is `db_purpose`, a marker that travels with the data and
// lets destructive operations (test setup, data rebuilds) refuse to clobber a
// production database.  Protection is opt-in by marking: a real database must be
// marked 'production' to be protected; an unmarked one is treated as wipeable
// (with a warning), so dev/legacy databases keep working.

export type DbPurpose = "production" | "dev" | "test";

export interface Config {
    config_id: number;
    key: string;
    value: string;
}

export class ConfigTable extends Table<Config> {
    constructor() {
        super('config', [
            new PrimaryKeyField('config_id', {}),
            new StringField('key', {indexed: true, unique: true}),
            new StringField('value', {default: ''}),
        ]);
    }

    @path
    get byKey() {
        return db().prepare<Config, {key: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM config
/**/          WHERE key = :key`);
    }

    get(key: string): string | undefined {
        return this.byKey.first({key})?.value;
    }

    set(key: string, value: string): void {
        const existing = this.byKey.first({key});
        if(existing)
            // deno-lint-ignore no-explicit-any
            this.updateNamedFields(existing.config_id, ['value'], {value} as any);
        else
            this.insert({key, value});
    }

    getDbPurpose(): DbPurpose | undefined { return this.get('db_purpose') as DbPurpose | undefined; }
    setDbPurpose(purpose: DbPurpose): void { this.set('db_purpose', purpose); }
}

// --- destructive-operation guard --------------------------------------------

// The wipe decision as a pure function (trivially testable).
export function checkWipeAllowed(purpose: DbPurpose | undefined): { allowed: boolean; reason?: string } {
    if(purpose === "production") return { allowed: false, reason: "it is marked db_purpose='production'" };
    if(purpose === undefined)    return { allowed: true,  reason: "it has no db_purpose marker (treating as wipeable)" };
    return { allowed: true };   // dev / test
}

function fileExists(dbPath: string): boolean {
    // deno-lint-ignore no-explicit-any
    try { (globalThis as any).Deno.statSync(dbPath); return true; } catch { return false; }
}

// Throw if wiping the database file at `dbPath` would destroy a production db.
// Reads the marker with a raw query on an uncached handle, since it inspects a
// possibly-old/foreign db (maybe without the config table) before destroying it.
export function assertSafeToWipe(dbPath: string): void {
    if(!fileExists(dbPath)) return;   // nothing there yet -> bootstrap
    const probe = Db.open(dbPath);
    let purpose: DbPurpose | undefined;
    try {
        const rows = probe.rawQuery("SELECT value FROM config WHERE key = 'db_purpose'");
        purpose = rows.length ? (rows[0][0] as DbPurpose) : undefined;
    } catch {
        purpose = undefined;          // no config table (legacy db) -> unmarked
    } finally {
        probe.close();
    }
    const { allowed, reason } = checkWipeAllowed(purpose);
    if(!allowed)
        throw new Error(`refusing to wipe '${dbPath}': ${reason}. ` +
                        `Change its db_purpose or delete it deliberately to proceed.`);
    if(reason)
        console.warn(`WARNING: wiping '${dbPath}': ${reason}. Mark real data with config.setDbPurpose('production').`);
}

