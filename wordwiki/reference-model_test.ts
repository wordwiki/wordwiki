// deno-lint-ignore-file no-explicit-any
/**
 * Property test: the production VersionedDb vs the in-core reference oracle
 * (reference-model.ts). A seeded generator builds random operation sequences
 * biased toward the interesting states — edits/deletes/restores/moves on
 * EXISTING facts, and stale writes that must be rejected — applies each op to
 * BOTH models, and after every op asserts:
 *   (1) the two made the same accept/reject decision;
 *   (2) their serialized observable views agree (fullHistory + currentView);
 *   (3) the production store is structurally valid (assertVersionedDbValid);
 *   (4) the oracle's own structure is valid (the independent validator).
 *
 * On any failure the seed + op index + recent op log + first divergence are
 * reported — the minimal reproduction is (seed, op-count).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import * as model from "./model.ts";
import { dictSchemaJson } from "./entry-schema.ts";
import { Assertion, assertionPathToFields } from "./assertion.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { VersionedDb } from "./workspace.ts";
import { VersionedDbModel } from "./versioned-model.ts";
import { ReferenceModel } from "./reference-model.ts";
import { assertVersionedDbValid } from "./versioned-db-validate.ts";
import { validateFacts } from "./versioned-db-validate.ts";

const EOT = timestamp.END_OF_TIME;
const dictSchema = model.Schema.parseSchemaFromCompactJson("dict", dictSchemaJson);

// --- Schema introspection: tag -> valid child tags --------------------------------

function buildSchemaIndex(root: model.RelationField): Map<string, string[]> {
    const idx = new Map<string, string[]>();
    const visit = (rf: model.RelationField) => {
        if (idx.has(rf.tag)) return;
        idx.set(rf.tag, rf.relationFields.map((c) => c.tag));
        for (const c of rf.relationFields) visit(c);
    };
    visit(root);
    return idx;
}
const SCHEMA_INDEX = buildSchemaIndex(dictSchema);

// --- Assertion building -----------------------------------------------------------

function parsePath(s: string): [string, number][] {
    return s.split("/").map((seg) => {
        const [ty, id] = seg.split(":");
        return [ty, id === undefined ? 0 : Number(id)] as [string, number];
    });
}

function build(fullPath: [string, number][], assertionId: number, validFrom: number,
               validTo: number, replaces: number | undefined, orderKey: string,
               attrs: Record<string, any>): Assertion {
    const [ty, id] = fullPath[fullPath.length - 1];
    return {
        ...assertionPathToFields(fullPath),
        ty, id, assertion_id: assertionId,
        replaces_assertion_id: replaces,
        valid_from: validFrom, valid_to: validTo,
        order_key: orderKey,
        ...attrs,
    } as Assertion;
}

// --- Seeded PRNG ------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const randInt = (rng: () => number, n: number) => Math.floor(rng() * n);
const pick = <T>(rng: () => number, xs: T[]): T => xs[randInt(rng, xs.length)];

// --- The generator ----------------------------------------------------------------

interface Op { assertion: Assertion; expectReject: boolean; desc: string; }

function genOp(rng: () => number, oracle: ReferenceModel,
               nextClock: () => number, nextId: () => number): Op {
    const handles = oracle.handles();
    const live = handles.filter((h) => h.live);
    const dead = handles.filter((h) => !h.live);
    const parents = live.filter((h) => (SCHEMA_INDEX.get(h.ty)?.length ?? 0) > 0);

    const choices: string[] = ["addEntry"];
    if (parents.length) choices.push("addChild", "addChild");
    if (live.length) choices.push("edit", "edit", "del", "move", "stale");
    if (dead.length) choices.push("restore");
    const op = pick(rng, choices);

    const tok = () => "v" + Math.floor(rng() * 1e6).toString(36);
    const attrs = () => ({ attr1: tok(), ...(rng() < 0.3 ? { attr2: tok() } : {}) });
    const okey = () => "0." + Math.floor(rng() * 1e6).toString(36);

    switch (op) {
        case "addEntry": {
            const id = nextId();
            return { assertion: build([["dct", 0], ["ent", id]], nextId(), nextClock(), EOT, undefined, okey(), attrs()),
                     expectReject: false, desc: `addEntry ent:${id}` };
        }
        case "addChild": {
            const p = pick(rng, parents);
            const childTag = pick(rng, SCHEMA_INDEX.get(p.ty)!);
            const id = nextId();
            return { assertion: build([...parsePath(p.path), [childTag, id]], nextId(), nextClock(), EOT, undefined, okey(), attrs()),
                     expectReject: false, desc: `addChild ${childTag}:${id} under ${p.path}` };
        }
        case "edit": case "move": {
            const h = pick(rng, live);
            return { assertion: build(parsePath(h.path), nextId(), nextClock(), EOT, h.currentAssertionId, okey(), attrs()),
                     expectReject: false, desc: `${op} ${h.path}` };
        }
        case "del": {
            const h = pick(rng, live);
            const t = nextClock();
            return { assertion: build(parsePath(h.path), nextId(), t, t, h.currentAssertionId, okey(), {}),
                     expectReject: false, desc: `del ${h.path}` };
        }
        case "restore": {
            const h = pick(rng, dead);
            return { assertion: build(parsePath(h.path), nextId(), nextClock(), EOT, h.currentAssertionId, okey(), attrs()),
                     expectReject: false, desc: `restore ${h.path}` };
        }
        case "stale": default: {
            const h = pick(rng, live);
            // Wrong replaces_assertion_id: both models must reject (chain check).
            return { assertion: build(parsePath(h.path), nextId(), nextClock(), EOT, 999999999, okey(), attrs()),
                     expectReject: true, desc: `stale(wrong-replaces) ${h.path}` };
        }
    }
}

// --- Comparison -------------------------------------------------------------------

function firstDiff(label: string, a: { path: string }[], b: { path: string }[]): string | null {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const sa = JSON.stringify(a[i] ?? null), sb = JSON.stringify(b[i] ?? null);
        if (sa !== sb)
            return `${label} differ at #${i}:\n  oracle: ${sa}\n  prod:   ${sb}`;
    }
    return null;
}

function compare(oracle: ReferenceModel, prod: VersionedDbModel): string | null {
    return firstDiff("fullHistory", oracle.fullHistory(), prod.fullHistory())
        ?? firstDiff("currentView", oracle.currentView(), prod.currentView());
}

function didThrow(fn: () => void): boolean {
    try { fn(); return false; } catch { return true; }
}

// --- The property test ------------------------------------------------------------

test("property: production VersionedDb matches the reference oracle", () => {
    const SEEDS = 40;
    const OPS = 150;

    for (let seed = 1; seed <= SEEDS; seed++) {
        const rng = mulberry32(seed);
        const oracle = new ReferenceModel();
        const prod = new VersionedDbModel(new VersionedDb([dictSchema]));
        let clock = timestamp.BEGINNING_OF_TIME, ids = 1;
        const nextClock = () => ++clock;
        const nextId = () => ++ids;
        const log: string[] = [];

        const bail = (i: number, msg: string): never => {
            const recent = log.slice(-12).map((d, k) => `    ${log.length - 12 + k}: ${d}`).join("\n");
            throw new Error(
                `MISMATCH at seed ${seed}, op #${i} (${log[i]})\n${msg}\n  recent ops:\n${recent}`);
        };

        for (let i = 0; i < OPS; i++) {
            const op = genOp(rng, oracle, nextClock, nextId);
            log.push(op.desc);

            if (op.expectReject) {
                const oThrew = didThrow(() => oracle.apply(op.assertion));
                const pThrew = didThrow(() => prod.apply(op.assertion));
                if (oThrew !== pThrew)
                    bail(i, `reject parity: oracle threw=${oThrew}, prod threw=${pThrew}`);
            } else {
                try { oracle.apply(op.assertion); }
                catch (e) { bail(i, `oracle rejected a valid op: ${(e as Error).message}`); }
                try { prod.apply(op.assertion); }
                catch (e) { bail(i, `production rejected a valid op: ${(e as Error).message}`); }
            }

            const d = compare(oracle, prod);
            if (d) bail(i, d);

            // Both must stay structurally well-formed.
            try { assertVersionedDbValid(prod.vdb); }
            catch (e) { bail(i, `production became structurally invalid: ${(e as Error).message}`); }
            const op2 = validateFacts(oracle.factViews());
            if (op2.length) bail(i, `oracle became structurally invalid: ${op2[0].invariant} ${op2[0].path}`);
        }
    }
});

// --- A direct conformance check (oracle alone, hand-verified) ---------------------

test("oracle: a hand-checked scenario, and it matches production", () => {
    const oracle = new ReferenceModel();
    const prod = new VersionedDbModel(new VersionedDb([dictSchema]));
    const apply = (a: Assertion) => { oracle.apply(a); prod.apply(a); };
    const T = timestamp.BEGINNING_OF_TIME;

    // ent:10 with a spelling spl:11; edit the spelling; then delete the entry.
    apply(build([["dct", 0], ["ent", 10]], 100, T+1, EOT, undefined, "0.5", { attr1: "word" }));
    apply(build([["dct", 0], ["ent", 10], ["spl", 11]], 101, T+2, EOT, undefined, "0.5", { attr1: "cat" }));
    apply(build([["dct", 0], ["ent", 10], ["spl", 11]], 102, T+3, EOT, 101, "0.5", { attr1: "kat" }));

    // Before deletion: both facts visible, spelling shows the edited value.
    assertEquals(oracle.currentView(), [
        { path: "dct/ent:10", attrs: { ty: "ent", order_key: "0.5", attr1: "word" } },
        { path: "dct/ent:10/spl:11", attrs: { ty: "spl", order_key: "0.5", attr1: "kat" } },
    ]);
    assertEquals(compare(oracle, prod), null);

    // Delete the entry: BOTH facts vanish from the current view (the spelling's
    // ancestor is gone), but history is retained.
    apply(build([["dct", 0], ["ent", 10]], 103, T+4, T+4, 100, "0.5", {}));
    assertEquals(oracle.currentView(), []);
    assertEquals(oracle.fullHistory().length, 2);                 // both facts still in history
    assertEquals(oracle.fullHistory()[0].versions.length, 2);     // ent: live + tombstone
    assertEquals(compare(oracle, prod), null);
});

// --- A negative control: the comparator actually distinguishes states ------------

test("the comparator detects a divergence (negative control)", () => {
    const a = new ReferenceModel();
    const b = new VersionedDbModel(new VersionedDb([dictSchema]));
    a.apply(build([["dct", 0], ["ent", 10]], 100, timestamp.BEGINNING_OF_TIME+1, EOT, undefined, "0.5", { attr1: "x" }));
    // b is empty -> the views must differ.
    assert(compare(a, b) !== null);
});
