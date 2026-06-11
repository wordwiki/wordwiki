// @lazy getter-caching decorator (see lazy.ts).  The contract tested here:
// compute at most once per instance per property (falsy results included),
// retry after a throw, never share between instances or properties, and
// fail loudly at class-definition time when applied to a non-getter.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import { lazy } from "./lazy.ts";

test("computes once per instance; later reads are cache hits", () => {
    let calls = 0;
    class C {
        constructor(public base: number) {}
        @lazy get expensive(): number { calls++; return this.base * 2; }
    }
    const c = new C(21);
    assertEquals(c.expensive, 42);
    assertEquals(c.expensive, 42);
    assertEquals(c.expensive, 42);
    assertEquals(calls, 1);
});

test("falsy values are cached too (undefined, null, false, 0, '')", () => {
    const calls = { u: 0, n: 0, f: 0, z: 0, e: 0 };
    class C {
        @lazy get u(): undefined { calls.u++; return undefined; }
        @lazy get n(): null { calls.n++; return null; }
        @lazy get f(): boolean { calls.f++; return false; }
        @lazy get z(): number { calls.z++; return 0; }
        @lazy get e(): string { calls.e++; return ''; }
    }
    const c = new C();
    assertEquals([c.u, c.u], [undefined, undefined]);
    assertEquals([c.n, c.n], [null, null]);
    assertEquals([c.f, c.f], [false, false]);
    assertEquals([c.z, c.z], [0, 0]);
    assertEquals([c.e, c.e], ['', '']);
    assertEquals(calls, { u: 1, n: 1, f: 1, z: 1, e: 1 });
});

test("caches are per-instance, and per-property within an instance", () => {
    let aCalls = 0, bCalls = 0;
    class C {
        constructor(public tag: string) {}
        @lazy get a(): string { aCalls++; return this.tag + ':a'; }
        @lazy get b(): string { bCalls++; return this.tag + ':b'; }
    }
    const one = new C('one'), two = new C('two');
    assertEquals(one.a, 'one:a');
    assertEquals(one.b, 'one:b');   // distinct property: distinct cache slot
    assertEquals(two.a, 'two:a');   // distinct instance: computed for itself
    assertEquals(one.a, 'one:a');
    assertEquals([aCalls, bCalls], [2, 1]);  // a computed for each instance; b only for `one` so far
    assertEquals(two.b, 'two:b');
    assertEquals([aCalls, bCalls], [2, 2]);
});

test("identity: the same object comes back on every read", () => {
    class C { @lazy get obj(): { x: number } { return { x: 1 }; } }
    const c = new C();
    assert(c.obj === c.obj, "cache must return the identical object");
});

test("a throwing getter caches nothing and retries on the next read", () => {
    let attempts = 0;
    class C {
        @lazy get flaky(): string {
            if (++attempts === 1) throw new Error('first read fails');
            return 'recovered';
        }
    }
    const c = new C();
    assertThrows(() => c.flaky, Error, 'first read fails');
    assertEquals(c.flaky, 'recovered');
    assertEquals(c.flaky, 'recovered');  // success IS cached
    assertEquals(attempts, 2);
});

test("inherited lazy getters cache per concrete instance", () => {
    let calls = 0;
    class Base { @lazy get v(): number { calls++; return 7; } }
    class Sub extends Base {}
    const base = new Base(), sub = new Sub();
    assertEquals([base.v, sub.v, base.v, sub.v], [7, 7, 7, 7]);
    assertEquals(calls, 2);
});

test("static and symbol-named getters work", () => {
    let calls = 0;
    const sym = Symbol('symGetter');
    class C {
        @lazy static get stat(): number { calls++; return 11; }
        @lazy get [sym](): number { calls++; return 22; }
    }
    assertEquals([C.stat, C.stat], [11, 11]);
    const c = new C();
    assertEquals([c[sym], c[sym]], [22, 22]);
    assertEquals(calls, 2);
});

test("applying @lazy to a non-getter throws at class definition time", () => {
    // Pre-guard, this silently misbehaved: the wrapper called the method
    // body with no arguments and cached the first result (NaN) forever.
    assertThrows(() => {
        // deno-lint-ignore no-explicit-any
        class C { @(lazy as any) add(n: number) { return n + 1; } }
        new C();
    }, Error, 'can only decorate getters');
});
