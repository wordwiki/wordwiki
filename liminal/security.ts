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
    args?: any[];                  // the route call's evaluated args (for route perms
                                   // that key off an arg, e.g. selfArg('volunteer_id'))
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

// --------------------------------------------------------------------------
// Route (request-level) security.  The SAME Permission vocabulary as fields and
// tables, applied to the methods/getters reachable as route expressions.
//
// Route perms are deliberately COARSE - public / authenticated / role - because
// per-record (isSelf/owner) and per-field redaction are already enforced down in
// the query/save layer; the route layer's job is "is this exposed, and to whom"
// (anonymous vs logged-in vs a role floor).  See route-security-migration notes.
// --------------------------------------------------------------------------

// The everyday floor: must be logged in.  (Open-books: any volunteer may reach
// most reads; the field layer still redacts the sensitive bits.)
export const authenticated: Permission = loggedIn;

// A role floor for host-only actions (the common one; redefined per-file today).
export const hostOrAdmin: Permission = or(hasRole('host'), hasRole('admin'));

// Owner check keyed off the route's ARGS rather than a loaded record - lets an
// arg-subject route (e.g. addTimesheet({volunteer_id}), checkOut(eid, vid))
// express "self" at the route layer, before the record is loaded.  `pick` is
// either a field name read from the first object arg, or an extractor over the
// positional arg array.
export function selfArg(pick: string | ((args: any[]) => number | undefined)): Permission {
    return a => {
        const args = a.args ?? [];
        const id = typeof pick === 'function'
            ? pick(args)
            : (args[0] && typeof args[0] === 'object' ? Number((args[0] as any)[pick]) : undefined);
        return id !== undefined && !Number.isNaN(id) && id === a.ctx.actorId;
    };
}

// Anonymous-reachable.  NOT a default: explicit, reason'd, and greppable so the
// public surface can be audited (and snapshotted) - e.g. login / password reset.
const PUBLIC_REASON: unique symbol = Symbol('publicRouteReason');
export function publicRoute(reason: string): Permission {
    const p: Permission = () => true;
    (p as any)[PUBLIC_REASON] = reason;
    return p;
}
export function publicRouteReason(p: Permission | undefined): string | undefined {
    return p ? (p as any)[PUBLIC_REASON] : undefined;
}

// Declare a method/getter as an exposed route carrying its authorization.
// Replaces @safe: it both exposes (the capability routeterp checks) AND records
// the Permission (enforced when routeterp runs in strict mode).  An undeclared
// member stays unreachable.  NB: stack ABOVE @path on getters - @path installs a
// wrapper, and @route must tag the installed function.
const ROUTE: unique symbol = Symbol('routePermission');
export function route(perm: Permission) {
    return (target: any, _ctx?: any) => {
        // Tag the function with its permission.  routeterp reads this (via
        // routePermissionOf) both to treat the member as exposed AND to enforce
        // the permission under its strict policy.
        if(typeof target === 'function') (target as any)[ROUTE] = perm;
        return undefined;              // keep the original (now-tagged) function
    };
}
// The route permission declared on obj.name (walks the prototype chain), or undefined.
export function routePermissionOf(obj: any, name: PropertyKey): Permission | undefined {
    for(let o = obj; o != null; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, name);
        if(d) {
            const fn = d.get ?? (typeof d.value === 'function' ? d.value : undefined);
            return fn ? (fn as any)[ROUTE] : undefined;
        }
    }
    return undefined;
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
