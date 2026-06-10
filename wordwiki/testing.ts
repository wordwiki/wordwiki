// deno-lint-ignore-file no-explicit-any
/**
 * Wordwiki-specific test glue, on the same model as rabid/testing.ts: run the
 * app AS A LIBRARY - no HTTP, no browser.  A fresh in-memory SQLite carries
 * both the new-style tables (config/user/sessions) and the legacy raw-DML
 * schema (scanned documents, bounding boxes, and - crucially - the `dict`
 * assertion table), so the assertion model can be exercised end-to-end:
 * workspace -> applyTransaction -> SQLite -> reload.
 *
 *   await withTestDb(async (ww) => {
 *     ww.applyTransaction([...]);
 *     const markup = await renderRoute(ww, `wordwiki.lexeme.renderEntry(1000)`);
 *     ...
 *   });
 *
 * Each withTestDb call hands you a FRESH WordWiki instance over the cleared
 * db, so the workspace/entries caches can never leak between tests.
 */
import { WordWiki } from './wordwiki.ts';
import * as schema from './schema.ts';
import { Assertion, getAssertionPath, assertionPathToFields } from './schema.ts';
import * as user from './user.ts';
import * as security from '../liminal/security.ts';
import * as templates from './templates.ts';
import * as timestamp from '../liminal/timestamp.ts';
import type { Markup } from '../liminal/markup.ts';
import { db } from '../liminal/db.ts';
import { openTestDb, clearAllData } from '../liminal/testing/db-harness.ts';

// The legacy raw-DML tables (created by schema.createAllTables, cleared here
// by name - they are not liminal Tables).
const LEGACY_TABLES = ['scanned_document', 'scanned_page', 'layer',
                       'bounding_group', 'bounding_box', 'change_log', 'dict'];

let legacySchemaCreated = false;

export interface Fixture {
    ww: WordWiki;
    // The seeded users' ids by username (djz has admin,publish,testing).
    userIds: Record<string, number>;
}

// Ensure the in-memory test db + schema exist (once per process), reset its
// data, seed the users, and run `fn` with a fresh WordWiki over it.
export async function withTestDb(fn: (fx: Fixture) => any | Promise<any>): Promise<void> {
    const ww = new WordWiki();
    openTestDb(ww.tables);
    if(!legacySchemaCreated) {
        security.runSystem(() => schema.createAllTables());
        legacySchemaCreated = true;
    }
    const fx = security.runSystem(() => {
        clearAllData(ww.tables);
        for(const t of LEGACY_TABLES)
            db().execute(`DELETE FROM ${t}`, {});
        user.seedUsersFromEntrySchema(ww.users);
        const userIds: Record<string, number> = {};
        for(const u of ww.users.allUsersByName.all({}))
            userIds[u.username] = u.user_id;
        // djz gets a known password so the login flow is testable.
        ww.passwordHash.setPassword(userIds['djz'], 'test-password');
        return {ww, userIds};
    });
    await fn(fx);
}

// --- Acting as an actor (sets the ambient security context) -----------------

export type ActorSpec =
    | "anon"
    | "system"
    | { actorId?: number; roles: Iterable<string> };

export function as<T>(fx: Fixture, spec: ActorSpec | string, fn: () => T): T {
    if(spec === "system") return security.runSystem(fn);
    if(spec === "anon") return security.run({actorId: undefined, roles: new Set()}, fn);
    if(typeof spec === 'string') {
        // a username: roles read from the seeded record
        const actorId = fx.userIds[spec] ?? (() => { throw new Error(`no test user '${spec}'`); })();
        const u = security.runSystem(() => fx.ww.users.getById(actorId));
        return security.run({actorId, roles: security.rolesFromPermissionsField(u.permissions)}, fn);
    }
    return security.run({actorId: spec.actorId, roles: new Set(spec.roles)}, fn);
}

// --- Dispatching routes as the current actor --------------------------------

// Render a route and return its markup (a page() is unwrapped to its body).
export async function renderRoute(ww: WordWiki, path: string,
                                  opts: { queryArgs?: Record<string, any> } = {}): Promise<Markup> {
    const result = await ww.dispatch(path, { queryArgs: opts.queryArgs });
    return templates.isPage(result) ? result.body : result;
}

// Invoke an action route with positional args (mirrors the client rpc/tx call),
// returning the raw result (e.g. {action:'reload', targets}).  Throws on a
// server-side error, so tests can assertRejects.
export async function invoke(ww: WordWiki, path: string, ...args: any[]): Promise<any> {
    const bodyArgs: Record<string, any> = {};
    args.forEach((a, i) => bodyArgs[`$arg${i}`] = a);
    return await ww.dispatch(path, { bodyArgs });
}

// --- Assertion builders ------------------------------------------------------
//
// Tests build assertions with EXPLICIT ids (deterministic, readable failures)
// and strictly increasing timestamps from a TestTimeline.

export class TestTimeline {
    private t = timestamp.BEGINNING_OF_TIME;
    next(): number { return this.t = timestamp.nextTime(this.t); }
}

// A new top-level entry fact.
export function mkEntry(id: number, t: number, fields: Partial<Assertion> = {}): Assertion {
    return {
        assertion_id: id, id, ty: 'ent',
        ty0: 'dct', ty1: 'ent', id1: id,
        valid_from: t, valid_to: timestamp.END_OF_TIME,
        order_key: '0.5',
        ...fields,
    } as Assertion;
}

// A new child fact under `parent` (any depth - the path is derived).
export function mkChild(parent: Assertion, ty: string, id: number, t: number,
                        fields: Partial<Assertion> = {}): Assertion {
    return {
        ...assertionPathToFields([...getAssertionPath(parent), [ty, id]]),
        assertion_id: id, id, ty,
        valid_from: t, valid_to: timestamp.END_OF_TIME,
        order_key: '0.5',
        ...fields,
    } as Assertion;
}

// A new version of an existing fact (an edit / move / restore).
export function mkEdit(prev: Assertion, newAssertionId: number, t: number,
                       fields: Partial<Assertion> = {}): Assertion {
    return {
        ...prev,
        assertion_id: newAssertionId,
        replaces_assertion_id: prev.assertion_id,
        valid_from: t, valid_to: timestamp.END_OF_TIME,
        ...fields,
    };
}

// A deletion tombstone for an existing fact (empty valid period).
export function mkTombstone(prev: Assertion, newAssertionId: number, t: number): Assertion {
    return {
        ...prev,
        assertion_id: newAssertionId,
        replaces_assertion_id: prev.assertion_id,
        valid_from: t, valid_to: t,
    };
}
