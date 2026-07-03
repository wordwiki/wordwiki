// deno-lint-ignore-file no-explicit-any
/**
 * Rabid-specific test glue, built on the generic harness + the dispatch seam:
 *
 *   await withTestDb(async (fx) => {
 *     const page = await asUser(fx.bob, () => renderRoute(`rabid.volunteer.detailPage(${fx.carol})`));
 *     assertEquals(text(getByTestId(page, 'detail-phone')).trim(), '***');
 *   });
 *
 * The render→act→render shape: set an actor, render a route to markup, fire an
 * action via invoke(), render again - all in-process, no HTTP, no browser.
 */
import { getRabid } from "./rabid.ts";
import * as security from "../liminal/security.ts";
import * as dirty from "../liminal/dirty.ts";
import * as templates from "./templates.ts";
import type { Markup } from "../liminal/markup.ts";
import { openTestDb, clearAllData } from "../liminal/testing/db-harness.ts";
import { buildFixture, type Fixture } from "./test-fixtures.ts";
import { setRoutePolicy } from "../liminal/liminal.ts";

// Pin the suite to strict so it exercises full @route enforcement regardless of
// any LIMINAL_ROUTE_POLICY in the environment.  (routeterp is the only router now.)
setRoutePolicy('strict');

// Ensure the in-memory test db + schema exist (once per process), reset its data,
// seed the deterministic fixture, and run `fn` with the fixture handles.
export async function withTestDb(fn: (fx: Fixture) => any | Promise<any>): Promise<void> {
    const rabid = getRabid();
    openTestDb(rabid.tables);
    clearAllData(rabid.tables);
    const fx = security.runSystem(() => buildFixture(rabid));
    await fn(fx);
}

// --- Acting as an actor (sets the ambient security context) -----------------

export type ActorSpec =
    | number                                        // a volunteer id (roles read from their record)
    | "anon"
    | "system"
    | { actorId?: number; roles: Iterable<string> }; // explicit context

function contextFor(spec: Exclude<ActorSpec, "system">): security.SecurityContext {
    if(spec === "anon") return { actorId: undefined, roles: new Set() };
    if(typeof spec === "number") {
        const v = security.runSystem(() => getRabid().volunteer.getById(spec));
        return { actorId: spec, roles: security.rolesFromPermissionsField((v as any)?.permissions) };
    }
    return { actorId: spec.actorId, roles: new Set(spec.roles) };
}

export function as<T>(spec: ActorSpec, fn: () => T): T {
    if(spec === "system") return security.runSystem(fn);
    return security.run(contextFor(spec), fn);
}
export const asUser = <T>(id: number, fn: () => T): T => as(id, fn);
export const asAnon = <T>(fn: () => T): T => as("anon", fn);
export const asSystem = <T>(fn: () => T): T => as("system", fn);

// --- Dispatching routes as the current actor --------------------------------

// Render a route and return its markup (a page() is unwrapped to its body).
export async function renderRoute(
    path: string,
    opts: { queryArgs?: Record<string, any> } = {},
): Promise<Markup> {
    // Renders are reads -> GET (so a mutates route rendered this way is rejected).
    const result = await getRabid().dispatch(path, { queryArgs: opts.queryArgs, httpMethod: 'GET' });
    return templates.isPage(result) ? result.body : result;
}

// Invoke an action route with positional args (mirrors the client rpc/tx call),
// returning the raw result (e.g. {action:'reload', targets}).  Throws on a
// server-side error (e.g. a permission rejection), so tests can assertRejects.
// Runs under a dirty-key collector and merges the emitted keys into the
// response targets, exactly as rpcHandler does - tests see the same target
// sets production produces.  (A DIRECT table-method call has no collector, so
// its result carries only hand-written targets - use invoke, or wrap in
// withDirtyTargets, when asserting on targets.)
export async function invoke(path: string, ...args: any[]): Promise<any> {
    const bodyArgs: Record<string, any> = {};
    args.forEach((a, i) => bodyArgs[`$arg${i}`] = a);
    // Actions are mutations -> POST.
    const {result, keys} = await dirty.collectTargets(() =>
        getRabid().dispatch(path, { bodyArgs, httpMethod: 'POST' }));
    if(result !== null && typeof result === 'object'
       && (result.action === 'reload' || result.action === 'open'))
        return {...result, targets: dirty.mergeTargets(result.targets, keys)};
    return result;
}

// Run a direct (non-route) mutation under a dirty-key collector, returning the
// call's result plus the production-shape merged targets.
export async function withDirtyTargets<T>(fn: () => T | Promise<T>):
        Promise<{result: T, targets: string[]}> {
    const {result, keys} = await dirty.collectTargets(fn);
    const hand = (result !== null && typeof result === 'object')
        ? (result as any).targets : undefined;
    return {result, targets: dirty.mergeTargets(hand, keys)};
}
