// deno-lint-ignore-file no-explicit-any
/**
 * A deliberately tiny, default-deny interpreter for *route expressions*.
 *
 * This is the security-restricted fork of jsterp.ts.  Where jsterp implements a
 * fairly complete JS expression language and tries to bolt safety on top,
 * routeterp implements ONLY the handful of constructs that route expressions
 * actually use, and exposes nothing else.  Safety comes from the smallness of
 * the grammar plus a positive (allowlist) model for every cross-trust-boundary
 * operation, rather than from a pile of negative conditionals.
 *
 * The supported grammar (everything else throws):
 *
 *   - Literal            "x", 7, true, null
 *   - Identifier         resolved ONLY against own-properties of the caller's
 *                        scope (no prototype walk -> no `constructor`/`toString`
 *                        leak); unbound -> throws.  This is how arg-list
 *                        identifiers bind from the passed-in scope.
 *   - ArrayExpression    [a, b, ...]            (no holes, no spread)
 *   - ObjectExpression   {a: x, "b": y}         (no spread, no computed keys,
 *                        no getters/methods; keys installed via defineProperty
 *                        so a `__proto__` key cannot poison the prototype)
 *   - MemberExpression   obj.name               (NON-computed only; gated: the
 *                        property must be marked @safe on obj's class/proto)
 *   - CallExpression     callee(args)           (callee must be an Identifier or
 *                        a (gated) MemberExpression - you cannot call the result
 *                        of an arbitrary sub-expression)
 *   - NewExpression      new Callee(args)       (same callee restriction)
 *
 * Notable things that are ABSENT by construction (not by a guard that could be
 * forgotten): operators (+ - * ! typeof ?: && ?? ...), template literals, arrow
 * functions, computed member access `obj[expr]`, computed object keys,
 * assignment, spread, optional chaining, sequence, regex.  Because there is no
 * computed access and no operators, the interpreter never implicitly invokes
 * `toString`/`valueOf` on a user value, so the coercion-leak caveat that applies
 * to jsterp does not apply here.
 *
 * THE TRUST MODEL.  Every member access and every call ultimately bottoms out in
 * one of two trusted things:
 *   1. a name the caller explicitly placed in `scope` (the route table, plus
 *      request bindings like bodyArgs / $argN), or
 *   2. a property/method the application author explicitly decorated `@safe`.
 * A blessed method is fully trusted once reached: it may do anything its own
 * code does.  The interpreter's job is only to ensure the expression cannot
 * reach anything that was not blessed.
 */
import * as acorn from "npm:acorn@8.11.3";
import {Node, Identifier, Literal, ArrayExpression, ObjectExpression,
        MemberExpression, CallExpression, NewExpression, Property,
        Expression, SpreadElement, PrivateIdentifier} from "npm:acorn@8.11.3";
import {routePermissionOf, routeIsMutation, current as currentCtx, type SecurityContext,
        route, routeMutation, authenticated, publicRoute, selfArg, run as runAs} from "./security.ts";

export type JsNode = Node;
export type Scope = Record<string, any>;

/**
 * Marker set by the @safe decorator on a method or getter *function*.  We check
 * it on the property *descriptor* (the accessor/method), never on the returned
 * value - so exposing a getter that returns a plain object does NOT expose that
 * object's own properties.
 */
const SAFE = Symbol('routeSafe');

/**
 * Mark a method or getter as reachable by route expressions.  Usage:
 *
 *     class VolunteerTable {
 *         @safe get volunteer() { ... }
 *         @safe saveForm(form) { ... }
 *     }
 *
 * Works for instance methods, getters, and static methods (TC39 / "ES" style
 * decorators, as already used elsewhere in this codebase).  The decorator simply
 * tags the underlying function object and leaves it otherwise untouched.
 */
export function safe(target: any, _context: any): any {
    // `target` is the method/getter function itself.  Tag it in place and keep
    // it (return undefined => original, now-tagged, function is installed).
    if(typeof target === 'function')
        target[SAFE] = true;
    return undefined;
}

export function parseRouteExpr(src: string): JsNode {
    return acorn.parseExpressionAt(src, 0, {ecmaVersion: 2023});
}

/**
 * Enforcement policy for the member-access gate (orthogonal to the grammar,
 * which is always restricted):
 *   - 'strict'      every member access must be declared (@safe today, @route
 *                   when the route-security migration lands); undeclared throws.
 *   - 'permissive'  undeclared members are ALLOWED but logged once (deduped) -
 *                   the migration bridge: it proves the restricted grammar can
 *                   evaluate the whole site before any annotations exist, and the
 *                   log becomes the annotation worklist.  Still strictly safer
 *                   than jsterp (no globals in scope; no operators / computed
 *                   access / calling a call-result -> the classic RCE shapes
 *                   stay blocked).
 */
export type RoutePolicy = 'permissive' | 'strict';

// Deduped record of undeclared (class.member) reached under 'permissive' - the
// route-annotation worklist.  Module-level so it accrues across requests.
const undeclaredSeen = new Set<string>();
export function undeclaredRouteMembers(): string[] { return [...undeclaredSeen].sort(); }
export function clearUndeclaredRouteMembers(): void { undeclaredSeen.clear(); }

function memberKey(obj: any, name: PropertyKey): string {
    const cls = (obj && obj.constructor && obj.constructor.name) || typeof obj;
    return `${cls}.${String(name)}`;
}

// httpMethod gates mutates routes (POST-only).  Defaults to 'POST' so non-HTTP
// callers (the server passes the real method; tests pass it explicitly) aren't
// surprised; the server passing 'GET' is what catches a GET to a mutation.
export function evalRouteExprSrc(scope: Scope, src: string, policy: RoutePolicy = 'strict',
                                 httpMethod: string = 'POST'): any {
    return new RouteEval(policy, httpMethod).eval(scope, parseRouteExpr(src));
}

// A declared route the actor isn't permitted to reach (strict policy).  Distinct
// from RouteUndeclaredError (the member isn't a route at all) so the dispatcher
// can map them differently later (deny -> login-or-403; undeclared -> 404).
export class RouteDeniedError extends Error {
    constructor(readonly member: string) {
        super(`routeterp: not permitted: '${member}'`);
        this.name = 'RouteDeniedError';
    }
}
export class RouteUndeclaredError extends Error {
    constructor(readonly member: string) {
        super(`routeterp: '${member}' is not an exposed route member`);
        this.name = 'RouteUndeclaredError';
    }
}
// A state-changing (mutates) route reached via GET - rejected to close GET-CSRF.
export class RouteMethodError extends Error {
    constructor(readonly member: string) {
        super(`routeterp: '${member}' is a mutation and must be POSTed`);
        this.name = 'RouteMethodError';
    }
}

const ANON: SecurityContext = {actorId: undefined, roles: new Set()};

/** Walk the prototype chain to find the descriptor that defines `name`. */
function findDescriptor(obj: any, name: PropertyKey): PropertyDescriptor|undefined {
    for(let o = obj; o != null; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, name);
        if(d) return d;
    }
    return undefined;
}

/** A member access is permitted iff the accessor (getter) or method value that
 *  defines it carries the @safe marker. */
function isSafeMember(obj: any, name: PropertyKey): boolean {
    const d = findDescriptor(obj, name);
    if(!d) return false;
    if(d.get) return (d.get as any)[SAFE] === true;
    return typeof d.value === 'function' && (d.value as any)[SAFE] === true;
}

export class RouteEval {
    ticksUsed = 0;

    constructor(readonly policy: RoutePolicy = 'strict',
                readonly httpMethod: string = 'POST',
                readonly maxTicks: number = 100_000) {}

    eval(s: Scope, e: JsNode): any {
        if(this.ticksUsed++ > this.maxTicks)
            throw new Error('routeterp: excess computation');
        switch(e.type) {
            case 'Literal':          return (e as Literal).value;
            case 'Identifier':       return this.evalIdentifier(s, e as Identifier);
            case 'ArrayExpression':  return this.evalArray(s, e as ArrayExpression);
            case 'ObjectExpression': return this.evalObject(s, e as ObjectExpression);
            case 'MemberExpression': return this.evalMember(s, e as MemberExpression);
            case 'CallExpression':   return this.evalCall(s, e as CallExpression);
            case 'NewExpression':    return this.evalNew(s, e as NewExpression);
            default:
                throw new Error(`routeterp: unsupported expression '${e.type}'`);
        }
    }

    evalIdentifier(s: Scope, e: Identifier): any {
        // Own-property lookup ONLY: no prototype walk, so bare `constructor`,
        // `toString`, `__proto__`, etc. are never silently bound.  This is also
        // exactly the "unbound identifier binds from the passed-in scope"
        // behaviour: the scope IS the allowlist.
        if(!Object.hasOwn(s, e.name))
            throw new Error(`routeterp: unbound identifier '${e.name}'`);
        return s[e.name];
    }

    evalArray(s: Scope, e: ArrayExpression): any[] {
        const out: any[] = [];
        for(const el of e.elements) {
            if(el === null)
                throw new Error('routeterp: array holes are not supported');
            if(el.type === 'SpreadElement')
                throw new Error('routeterp: spread is not supported');
            out.push(this.eval(s, el));
        }
        return out;
    }

    evalObject(s: Scope, e: ObjectExpression): Record<string, any> {
        const out: Record<string, any> = {};
        for(const p of e.properties) {
            if(p.type !== 'Property')
                throw new Error('routeterp: object spread is not supported');
            const prop = p as Property;
            if(prop.computed)
                throw new Error('routeterp: computed object keys are not supported');
            if(prop.kind !== 'init')
                throw new Error('routeterp: getters/setters in object literals are not supported');
            let key: PropertyKey;
            if(prop.key.type === 'Identifier') key = (prop.key as Identifier).name;
            else if(prop.key.type === 'Literal') key = String((prop.key as Literal).value);
            else throw new Error(`routeterp: unsupported object key '${prop.key.type}'`);
            // defineProperty (not `out[key] =`) so a literal `__proto__` key
            // becomes an ordinary own property instead of mutating the prototype.
            Object.defineProperty(out, key, {
                value: this.eval(s, prop.value as Expression),
                writable: true, enumerable: true, configurable: true,
            });
        }
        return out;
    }

    // A member is "declared" if it carries a @route permission or the legacy
    // @safe marker.  Capability check + value resolution, NO permission run -
    // that is authorize()'s job (deferred to the call site so a route perm can
    // see the call args).
    resolveMember(obj: any, name: PropertyKey): any {
        const declared = routePermissionOf(obj, name) !== undefined || isSafeMember(obj, name);
        if(!declared) {
            if(this.policy === 'strict')
                throw new RouteUndeclaredError(memberKey(obj, name));
            // permissive: allow, but record the gap once (the annotation worklist).
            const key = memberKey(obj, name);
            if(!undeclaredSeen.has(key)) {
                undeclaredSeen.add(key);
                console.warn(`ROUTE-SECURITY undeclared member: ${key}`);
            }
        }
        const member = obj[name];
        return (member instanceof Function) ? member.bind(obj) : member;
    }

    // Run a member's @route permission (strict only).  `args` are the evaluated
    // call args when authorizing a call (undefined for plain navigation).  A
    // @safe-only member (no @route perm) is capability-gated but not authz'd.
    authorize(obj: any, name: PropertyKey, args: any[] | undefined): void {
        if(this.policy !== 'strict') return;
        // A state-changing route must be POSTed - reject a GET (closes GET-CSRF).
        // Checked before auth, and not bypassed by the system ctx (it's about the
        // HTTP method, not the actor; internal callers default to POST anyway).
        if(this.httpMethod === 'GET' && routeIsMutation(obj, name))
            throw new RouteMethodError(memberKey(obj, name));
        const perm = routePermissionOf(obj, name);
        if(!perm) return;
        const ctx = currentCtx() ?? ANON;
        if(ctx.system) return;
        if(!perm({ctx, args}))
            throw new RouteDeniedError(memberKey(obj, name));
    }

    evalMember(s: Scope, e: MemberExpression): any {
        const {obj, name} = this.evalMemberTarget(s, e);
        this.authorize(obj, name, undefined);   // navigation: ctx-only
        return this.resolveMember(obj, name);
    }

    // Shared by evalMember and evalCall: validate the member syntax and evaluate
    // the receiver object (without authorizing/resolving the property yet).
    private evalMemberTarget(s: Scope, e: MemberExpression): {obj: any, name: string} {
        if(e.computed)
            throw new Error('routeterp: computed member access obj[..] is not supported');
        if((e as any).optional)
            throw new Error('routeterp: optional chaining is not supported');
        if(e.property.type !== 'Identifier')
            throw new Error(`routeterp: unsupported member property '${e.property.type}'`);
        const name = (e.property as Identifier).name;
        const obj = this.eval(s, e.object);
        if(obj == null)
            throw new Error(`routeterp: cannot read '${name}' of ${obj}`);
        return {obj, name};
    }

    evalCall(s: Scope, e: CallExpression): any {
        this.assertCallable(e.callee);
        // Member call: authorize the final method WITH the evaluated args (so a
        // route perm like selfArg('volunteer_id') can read them).  The receiver
        // chain is authorized as navigation by the inner eval/evalMember.
        if(e.callee.type === 'MemberExpression') {
            const {obj, name} = this.evalMemberTarget(s, e.callee as MemberExpression);
            const args = this.evalArgs(s, e.arguments);
            this.authorize(obj, name, args);
            const fn = this.resolveMember(obj, name);
            if(!(fn instanceof Function))
                throw new Error(`routeterp: attempt to call a non-function (${typeof fn})`);
            return fn(...args);
        }
        // Identifier callee: a function placed in scope (the route table).
        const callee = this.eval(s, e.callee);
        const args = this.evalArgs(s, e.arguments);
        if(!(callee instanceof Function))
            throw new Error(`routeterp: attempt to call a non-function (${typeof callee})`);
        return callee(...args);
    }

    evalNew(s: Scope, e: NewExpression): any {
        this.assertCallable(e.callee);
        const callee = this.eval(s, e.callee);
        const args = this.evalArgs(s, e.arguments);
        if(!(callee instanceof Function))
            throw new Error(`routeterp: attempt to 'new' a non-constructor (${typeof callee})`);
        return new (callee as any)(...args);
    }

    /** A callee must be a trusted name (Identifier in scope) or a gated member
     *  access - never the result of an arbitrary sub-expression, so a blessed
     *  method that returns a raw function cannot have that function invoked. */
    assertCallable(callee: Node): void {
        if(callee.type !== 'Identifier' && callee.type !== 'MemberExpression')
            throw new Error(`routeterp: callee must be a name or @safe member, not '${callee.type}'`);
    }

    evalArgs(s: Scope, args: Array<Expression|SpreadElement>): any[] {
        const out: any[] = [];
        for(const a of args) {
            if(a.type === 'SpreadElement')
                throw new Error('routeterp: spread arguments are not supported');
            out.push(this.eval(s, a as Expression));
        }
        return out;
    }
}

// --------------------------------------------------------------------------
// Self-test.  Run with: deno run --allow-all liminal/routeterp.ts
// --------------------------------------------------------------------------

function expectOk(s: Scope, src: string, expectJSON: string) {
    let got: string;
    try { got = JSON.stringify(evalRouteExprSrc(s, src)); }
    catch(e) { console.info(`FAIL  ${src}\n  expected ${expectJSON}, THREW ${(e as Error).message}`); return; }
    if(got !== expectJSON) console.info(`FAIL  ${src}\n  expected ${expectJSON}, got ${got}`);
}

function expectThrow(s: Scope, src: string) {
    try { evalRouteExprSrc(s, src); }
    catch { return; }
    console.info(`FAIL  ${src}\n  expected a throw, but it succeeded`);
}

class Demo {
    name = 'Rover';
    @safe get pet() { return new Pet('Spot'); }
    @safe greet(who: string) { return `hi ${who}`; }
    secret() { return 'leak'; }            // NOT @safe
    @safe static make() { return new Demo(); }
    @route(publicRoute('demo')) openEcho(x: string) { return `open ${x}`; }
    @route(authenticated) authEcho(x: string) { return `auth ${x}`; }
    @route(selfArg('who')) selfEcho(arg: {who: number}) { return `self ${arg.who}`; }
}
class Pet {
    constructor(readonly petName: string) {}
    @safe speak() { return `${this.petName} barks`; }
}

function routePlay() {
    const demo = new Demo();
    const scope: Scope = {demo, Demo, who: 'world'};

    // --- allowed grammar ---
    expectOk(scope, `"hello"`, `"hello"`);
    expectOk(scope, `[1, {a: 2, b: [3, 4]}]`, `[1,{"a":2,"b":[3,4]}]`);
    expectOk(scope, `demo.greet("you")`, `"hi you"`);
    expectOk(scope, `demo.greet(who)`, `"hi world"`);          // identifier arg binds from scope
    expectOk(scope, `demo.pet.speak()`, `"Spot barks"`);        // chained @safe member + method
    expectOk(scope, `Demo.make().greet("x")`, `"hi x"`);        // static @safe + call result then @safe member

    // --- denied: unsafe / escape attempts ---
    expectThrow(scope, `demo.secret()`);                        // method not @safe
    expectThrow(scope, `demo.name`);                            // plain field not @safe
    expectThrow(scope, `demo.constructor`);                     // proto escape hatch
    expectThrow(scope, `demo.pet.petName`);                     // plain field on returned object
    expectThrow({}, `constructor`);                             // no prototype-walk identifier leak
    expectThrow(scope, `constructor.constructor("return 1")()`);// classic RCE shape
    expectThrow(scope, `demo["greet"]("x")`);                   // computed access banned
    expectThrow(scope, `1 + 1`);                                // operators absent
    expectThrow(scope, `demo.greet.call(demo, "x")`);           // .call not @safe
    expectThrow(scope, `(()=>1)()`);                            // arrow absent
    expectThrow(scope, `demo.greet("x")("y")`);                 // cannot call a call-result

    // --- __proto__ key must not poison the prototype ---
    const poisoned: any = evalRouteExprSrc(scope, `{"__proto__": 7}`);
    if(Object.getPrototypeOf(poisoned) !== Object.prototype)
        console.info('FAIL  __proto__ key poisoned the prototype');

    // --- policy dial: strict throws on undeclared, permissive allows + logs ---
    expectThrow(scope, `demo.secret()`);                            // strict (default)
    clearUndeclaredRouteMembers();
    const leaked = new RouteEval('permissive').eval(scope, parseRouteExpr(`demo.secret()`));
    if(leaked !== 'leak')
        console.info('FAIL  permissive should allow an undeclared member');
    if(!undeclaredRouteMembers().includes('Demo.secret'))
        console.info('FAIL  permissive should record the undeclared member');
    // permissive still blocks the RCE shapes (no globals; cannot call a call-result)
    expectThrow({}, `constructor`);
    try {
        new RouteEval('permissive').eval(scope, parseRouteExpr(`demo.greet("x")("y")`));
        console.info('FAIL  permissive should still block calling a call-result');
    } catch { /* expected */ }

    // --- @route enforcement (strict policy) ---
    const strict = (src: string, ctx?: SecurityContext) => {
        const run = () => new RouteEval('strict').eval(scope, parseRouteExpr(src));
        return ctx ? runAs(ctx, run) : run();
    };
    const denies = (src: string, ctx?: SecurityContext) => {
        try { strict(src, ctx); return false; } catch(e) { return e instanceof RouteDeniedError; }
    };
    const actor = (id: number, roles: string[] = []): SecurityContext => ({actorId: id, roles: new Set(roles)});

    if(strict(`demo.openEcho("hi")`) !== 'open hi')
        console.info('FAIL  public @route should be allowed anonymously');
    if(!denies(`demo.authEcho("x")`))
        console.info('FAIL  authenticated @route should deny an anonymous actor');
    if(strict(`demo.authEcho("x")`, actor(5)) !== 'auth x')
        console.info('FAIL  authenticated @route should allow a logged-in actor');
    if(strict(`demo.selfEcho({who: 5})`, actor(5)) !== 'self 5')
        console.info('FAIL  selfArg @route should allow the owner (arg matches actor)');
    if(!denies(`demo.selfEcho({who: 5})`, actor(9)))
        console.info('FAIL  selfArg @route should deny a non-owner');

    console.info('routePlay done');
}

if(import.meta.main)
    routePlay();
