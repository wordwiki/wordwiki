// deno-lint-ignore-file no-explicit-any
/**
 * Field-level security, evaluated at the data layer.
 *
 * A *permission* is a small predicate over an access (the current actor + the
 * record being touched).  Fields declare a `view` (and later `edit`) permission;
 * tables provide `ownerId(record)` so the `isSelf` predicate works.  The actor
 * is resolved once per request into a SecurityContext and carried ambiently via
 * AsyncLocalStorage, so deep render/query code can consult it without threading
 * a parameter through every call.
 *
 * Enforcement lives low: Table tags its prepared queries, and the query result
 * (.all/.first) throws a ReadPermissionError if a row carries a column the actor
 * can't view - so even a dispatchable query can't leak a protected field.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface SecurityContext {
    actorId: number | undefined;   // logged-in volunteer id (undefined if anonymous)
    roles: Set<string>;
    system?: boolean;              // trusted/system context - bypasses all guards
}

// What a permission is evaluated against.
export interface Access {
    ctx: SecurityContext;
    record?: any;                  // the row being accessed (for owner checks)
    ownerId?: number | undefined;  // owner of the record, precomputed by the caller
}

export type Permission = (a: Access) => boolean;

export const anyone:   Permission = () => true;
export const never:    Permission = () => false;
export const loggedIn: Permission = a => a.ctx.actorId !== undefined;
export const isSelf:   Permission = a => a.ownerId !== undefined && a.ownerId === a.ctx.actorId;
export function hasRole(role: string): Permission { return a => a.ctx.roles.has(role); }
// Visible when a boolean opt-in/opt-out flag on the record itself is set, e.g.
// recordFlag('phone_number_visible_to_all_volunteers') - lets a volunteer choose
// whether a field of theirs is exposed to other volunteers.
export function recordFlag(fieldName: string): Permission { return a => !!a.record?.[fieldName]; }
export function or(...ps: Permission[]):  Permission { return a => ps.some(p => p(a)); }
export function and(...ps: Permission[]): Permission { return a => ps.every(p => p(a)); }
export function not(p: Permission):       Permission { return a => !p(a); }

// For now roles are a comma-separated list in volunteer.permissions.
export function rolesFromPermissionsField(permissions: string | null | undefined): Set<string> {
    return new Set((permissions ?? '').split(',').map(s => s.trim()).filter(Boolean));
}

// A redactable field the actor may not view is replaced (in the query result)
// with this sentinel rather than throwing - so a row with mixed-visibility fields
// still comes back, just with the private bits hidden.  Renderers show it as a
// muted '***' (distinct from an empty value, which means "nothing on file").
export const REDACTED: unique symbol = Symbol('redacted');
export function isRedacted(v: any): boolean { return v === REDACTED; }

export class ReadPermissionError extends Error {
    constructor(public table: string, public field: string) {
        super(`Not permitted to read '${field}' on '${table}'`);
        this.name = 'ReadPermissionError';
    }
}

const storage = new AsyncLocalStorage<SecurityContext>();
const SYSTEM: SecurityContext = { actorId: undefined, roles: new Set(), system: true };

// Run fn with the given actor context active (ambiently visible to current()).
export function run<T>(ctx: SecurityContext, fn: () => T): T { return storage.run(ctx, fn); }
// Set the actor context for the rest of the current async execution (e.g. a
// request handler), without needing to wrap the remainder in a callback.
export function enterWith(ctx: SecurityContext): void { storage.enterWith(ctx); }
// Run fn as a trusted system operation (guards bypassed) - e.g. resolving the
// actor during login, before there is an actor.
export function runSystem<T>(fn: () => T): T { return storage.run(SYSTEM, fn); }
export function current(): SecurityContext | undefined { return storage.getStore(); }
