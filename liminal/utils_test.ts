// Base utility grab-bag (see utils.ts) - everything imports this, so the
// type-probe functions must be TOTAL (no input crashes them: they get called
// on request bodies and inside error-message construction), the error
// helpers must never themselves explode, and the collection helpers must
// honor their documented ordering/dedup contracts.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import * as u from "./utils.ts";

test("typeof_extended: stock typeof plus 'null' and 'array'", () => {
    assertEquals(u.typeof_extended(undefined), "undefined");
    assertEquals(u.typeof_extended(true), "boolean");
    assertEquals(u.typeof_extended(7), "number");
    assertEquals(u.typeof_extended(7n), "bigint");
    assertEquals(u.typeof_extended("s"), "string");
    assertEquals(u.typeof_extended(Symbol("x")), "symbol");
    assertEquals(u.typeof_extended(() => 1), "function");
    assertEquals(u.typeof_extended({}), "object");
    assertEquals(u.typeof_extended(null), "null");
    assertEquals(u.typeof_extended([1, 2]), "array");
});

test("type probes are total: no input crashes them (regression: null threw)", () => {
    // every probe over a nasty-input gauntlet
    const gauntlet = [null, undefined, 0, "", false, NaN, [], {}, () => 1,
                      new Date(), Object.create(null), Promise.resolve(1), Symbol("s"), 7n];
    for (const v of gauntlet) {
        u.isPromise(v); u.isObjectLiteral(v); u.className(v); u.isClassInstance(v);
        u.isAssignableFrom(Object, v);
    }
    // and the interesting answers:
    assertEquals(u.isPromise(null), false);                    // threw pre-fix
    assertEquals(u.isPromise(Promise.resolve(1)), true);
    assertEquals(u.isPromise({ then: () => {} }), true);       // thenable
    assertEquals(u.isObjectLiteral(null), false);              // threw pre-fix (request.body!)
    assertEquals(u.isObjectLiteral({}), true);
    assertEquals(u.isObjectLiteral(new Date()), false);
    assertEquals(u.isObjectLiteral([]), false);
    assertEquals(u.className(null), "null");                   // threw pre-fix (markup error path!)
    assertEquals(u.className(undefined), "undefined");
    assertEquals(u.className(new Date()), "Date");
    assertEquals(u.className(Object.create(null)), "(no class)");
    assertEquals(u.className(7), "Number");
});

test("isAssignableFrom / isClassInstance", () => {
    class A {}
    class B extends A {}
    assert(u.isAssignableFrom(A, A) && u.isAssignableFrom(A, B));
    assert(!u.isAssignableFrom(B, A));
    assert(!u.isAssignableFrom(A, null) && !u.isAssignableFrom(A, undefined));  // threw pre-fix
    assert(u.isClassInstance(new A()) && u.isClassInstance(new Date()));
    assert(!u.isClassInstance({}) && !u.isClassInstance([]) && !u.isClassInstance(null) && !u.isClassInstance("s"));
});

test("panic / unwrap / unwrapWithDetail / assert / assertNever", () => {
    assertThrows(() => u.panic("boom"), Error, "Panic: boom");
    assertThrows(() => u.panic("boom", { id: 7 }), Error, '{"id":7}');
    // Regression: a circular detail made panic throw a JSON TypeError,
    // eating the actual panic message.
    const circular: any = {}; circular.self = circular;
    assertThrows(() => u.panic("the real message", circular), Error, "the real message");
    assertThrows(() => u.unwrapWithDetail(null, "msg", circular), Error, "msg");

    assertEquals(u.unwrap(7), 7);
    assertEquals(u.unwrap(0), 0);          // falsy non-null passes through
    assertEquals(u.unwrap(""), "");
    assertThrows(() => u.unwrap(null, "ctx"), Error, "ctx");
    assertThrows(() => u.unwrap(undefined), Error, "null or undefined");
    assertEquals(u.unwrapWithDetail(5, "m", {}), 5);

    u.assert(true);
    assertThrows(() => u.assert(false, "why"), Error, "why");
    assertThrows(() => u.assert(0), Error, "assertion failed");
    assertThrows(() => u.assertNever("oops" as never), Error, "oops");
});

test("parseIntOrError: whole-string base-10 integers only (regression: lax parseInt)", () => {
    assertEquals(u.parseIntOrError("123"), 123);
    assertEquals(u.parseIntOrError("-7"), -7);
    assertEquals(u.parseIntOrError("+7"), 7);
    assertEquals(u.parseIntOrError("0"), 0);
    // Pre-fix these silently returned 12, 12, 16, 1:
    for (const bad of ["12abc", "12.9", "0x10", "1e3", "", " 12", "abc"])
        assertThrows(() => u.parseIntOrError(bad), Error, "Failed to parse");
});

test("groupToMap / multi_partition_by: per-partition order preserved, keyfn dups removed", () => {
    const items = [{ k: "a", n: 1 }, { k: "b", n: 2 }, { k: "a", n: 3 }];
    const grouped = u.groupToMap(items, i => i.k);
    assertEquals([...grouped.keys()], ["a", "b"]);
    assertEquals(grouped.get("a")!.map(i => i.n), [1, 3]);
    assertEquals(grouped.get("b")!.map(i => i.n), [2]);
    assertEquals(u.groupToMap([], (i: number) => i).size, 0);

    const multi = u.multi_partition_by(items, i => [i.k, "all", i.k]);  // dup key in keyfn output
    assertEquals(multi.get("all")!.map(i => i.n), [1, 2, 3]);
    assertEquals(multi.get("a")!.map(i => i.n), [1, 3]);                // not [1,1,3,3]
});

test("getOrCreate: creates once, then returns the stored value (even a stored undefined)", () => {
    const m = new Map<string, number[]>();
    const a = u.getOrCreate(m, "k", () => []);
    a.push(1);
    assertEquals(u.getOrCreate(m, "k", () => u.panic("must not re-create")), [1]);

    let factoryCalls = 0;
    const mu = new Map<string, undefined>();
    u.getOrCreate(mu, "k", () => { factoryCalls++; return undefined; });
    u.getOrCreate(mu, "k", () => { factoryCalls++; return undefined; });
    assertEquals(factoryCalls, 1);  // has()-based, so a stored undefined still counts
});

test("set operations match their definitions (seeded random)", () => {
    assertEquals([...u.union(new Set([1, 2]), new Set([2, 3]))].toSorted(), [1, 2, 3]);
    assertEquals([...u.intersection(new Set([1, 2]), new Set([2, 3]))], [2]);
    assertEquals([...u.difference(new Set([1, 2]), new Set([2, 3]))], [1]);

    let state = 13579;
    const rand = (n: number) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
    for (let i = 0; i < 200; i++) {
        const a = new Set(Array.from({ length: rand(20) }, () => rand(15)));
        const b = new Set(Array.from({ length: rand(20) }, () => rand(15)));
        for (const e of u.range(0, 15)) {
            assertEquals(u.union(a, b).has(e), a.has(e) || b.has(e));
            assertEquals(u.intersection(a, b).has(e), a.has(e) && b.has(e));
            assertEquals(u.difference(a, b).has(e), a.has(e) && !b.has(e));
        }
    }
});

test("duplicateItems", () => {
    assertEquals([...u.duplicateItems([1, 2, 1, 3, 2, 1])].toSorted(), [1, 2]);
    assertEquals(u.duplicateItems([1, 2, 3]).size, 0);
    assertEquals(u.duplicateItems([]).size, 0);
});

test("getAllPropertyNames: enumerable string keys incl inherited (for-in semantics)", () => {
    class Base { x = 1; }
    class Sub extends Base { y = 2; }
    assertEquals(u.getAllPropertyNames(new Sub()).toSorted(), ["x", "y"]);
    const proto = { a: 1 };
    assertEquals(u.getAllPropertyNames(Object.assign(Object.create(proto), { b: 2 })).toSorted(), ["a", "b"]);
});

test("range / repeat", () => {
    assertEquals(u.range(0, 4), [0, 1, 2, 3]);
    assertEquals(u.range(2, 2), []);
    assertEquals(u.range(5, 2), []);       // empty, not reversed
    assertEquals(u.range(-2, 1), [-2, -1, 0]);
    let n = 0;
    assertEquals(u.repeat(() => n++, 3), [0, 1, 2]);
    assertEquals(u.repeat(() => 1, 0), []);
});

test("isEqualsUint8Array", () => {
    assert(u.isEqualsUint8Array(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
    assert(u.isEqualsUint8Array(new Uint8Array(0), new Uint8Array(0)));
    assert(!u.isEqualsUint8Array(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])));
    assert(!u.isEqualsUint8Array(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])));
});
