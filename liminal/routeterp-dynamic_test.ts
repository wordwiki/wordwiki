// deno-lint-ignore-file no-explicit-any
/**
 * DYNAMIC route members (routeterp dynamicRouteMember): a namespace whose
 * member NAMES are runtime data (wordwiki's dictionaries) opts in via the
 * well-known symbol, returning {value, perm, mutates?} per identifier.
 * The trust model must hold exactly as for static declarations: default
 * deny, the same Permission enforcement, GET-mutation rejection, and
 * static @route declarations taking precedence.
 */
import { test } from "./testing/test.ts";
import { assertEquals, assertThrows } from "./testing/assert.ts";
import { evalRouteExprSrc, dynamicRouteMember, type DynamicRouteResolution,
         RouteUndeclaredError, RouteDeniedError, RouteMethodError } from "./routeterp.ts";
import * as security from "./security.ts";

class Words {
    @security.route(security.authenticated)
    hello(): string { return 'hi'; }
}

class Dicts {
    @security.route(security.publicRoute('test fixture'))
    get stat(): string { return 'static-wins'; }

    [dynamicRouteMember](name: string): DynamicRouteResolution|undefined {
        if(name === 'toy')
            return {value: new Words(), perm: security.authenticated};
        if(name === 'boom')
            return {value: new Words(), perm: security.authenticated, mutates: true};
        if(name === 'stat')   // tries to shadow the static member - must lose
            return {value: 'dynamic-shadow', perm: security.publicRoute('shadow')};
        return undefined;
    }
}

const scope = () => ({dicts: new Dicts()});
const asUser = <T>(fn: () => T): T =>
    security.run({actorId: 7, roles: new Set<string>()}, fn);
const asAnon = <T>(fn: () => T): T =>
    security.run({actorId: undefined, roles: new Set<string>()}, fn);

test("dynamic member resolves, gated by its returned permission", () => {
    assertEquals(asUser(() => evalRouteExprSrc(scope(), 'dicts.toy.hello()')), 'hi');
    assertThrows(() => asAnon(() => evalRouteExprSrc(scope(), 'dicts.toy.hello()')),
                 RouteDeniedError);
});

test("an unclaimed dynamic name is undeclared (default deny)", () => {
    assertThrows(() => asUser(() => evalRouteExprSrc(scope(), 'dicts.nope.hello()')),
                 RouteUndeclaredError);
});

test("a mutating dynamic member rejects GET", () => {
    assertThrows(() => asUser(() => evalRouteExprSrc(scope(), 'dicts.boom.hello()',
                                                     'strict', 'GET')),
                 RouteMethodError);
    // POST (the default) passes.
    assertEquals(asUser(() => evalRouteExprSrc(scope(), 'dicts.boom.hello()')), 'hi');
});

test("a static @route declaration beats a dynamic claim of the same name", () => {
    assertEquals(asAnon(() => evalRouteExprSrc(scope(), 'dicts.stat')), 'static-wins');
});
