// deno-lint-ignore-file no-explicit-any
/**
 * The OBSERVABLE interface of the versioned model, shared by the production
 * implementation and the in-core reference oracle (reference-model.ts).
 *
 * This is deliberately the *observable* contract — apply an assertion (with
 * the same accept/reject decisions) and read plain-data views — NOT the
 * internal tree. Both sides agree only here, by completely different routes:
 * production via the workspace tree + query layer (the code under test); the
 * oracle via brute force over a flat list. Comparing the serialized outputs of
 * the two is the property test (reference-model_test.ts).
 *
 * The views are plain data and schema-LIGHT: a fact's identity is its path
 * ("dct/ent:123/sub:456") and its content is the raw assertion attrs. We
 * compare by path-sorted value, so sibling order is captured by the order_key
 * *value* (in attrs), not by list position.
 */
import { Assertion, getAssertionPath } from "./assertion.ts";
import { VersionedDb, CurrentTupleQuery } from "./workspace.ts";

// --- The canonical, comparable observable shapes --------------------------------

export interface VersionSnapshot {
    assertion_id: number;
    replaces_assertion_id: number | null;
    valid_from: number;
    valid_to: number;
    // The publication dimension + change metadata (null while unset) — part of
    // the compared state, so the property test catches publication bugs too.
    published_from: number | null;
    published_to: number | null;
    change_action: string | null;
    change_by_username: string | null;
    change_note: string | null;
    attrs: Record<string, unknown>;
}

export interface FactHistory {
    path: string;
    versions: VersionSnapshot[]; // oldest first
}

export interface VisibleFact {
    path: string;
    attrs: Record<string, unknown>;
}

export interface VersionedModel {
    /** Apply one proposed assertion, with the SAME accept/reject decisions as
     *  production (throws on the same rejections). */
    apply(assertion: Assertion): void;
    /** Every version of every fact, oldest first, sorted by path — the total
     *  state. */
    fullHistory(): FactHistory[];
    /** The editor view: facts whose latest version is live (not a tombstone)
     *  AND all of whose ancestors are likewise live. Sorted by path. */
    currentView(): VisibleFact[];
}

// --- Shared pure helpers (data extraction only — no model logic) ----------------

/** "dct/ent:123/sub:456" from an assertion. */
export function pathString(a: Assertion): string {
    return getAssertionPath(a).map(([ty, id]) => (id === 0 ? ty : `${ty}:${id}`)).join("/");
}

/** The fact id of an assertion's parent (0 = the table root, i.e. top-level). */
export function parentIdOf(a: Assertion): number {
    const path = getAssertionPath(a);
    return path[path.length - 2][1];
}

const ATTR_FIELDS = [
    "ty", "order_key", "tags",
    ...Array.from({ length: 15 }, (_v, i) => `attr${i + 1}`),
];

/** The raw, comparable content of an assertion (path + version-interval are
 *  carried separately). Null/undefined fields are omitted so two assertions
 *  that differ only in unset columns still compare equal. */
export function extractAttrs(a: Assertion): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of ATTR_FIELDS) {
        const v = (a as any)[f];
        if (v !== null && v !== undefined) out[f] = v;
    }
    return out;
}

export function toSnapshot(a: Assertion): VersionSnapshot {
    return {
        assertion_id: a.assertion_id,
        replaces_assertion_id: a.replaces_assertion_id ?? null,
        valid_from: a.valid_from,
        valid_to: a.valid_to,
        published_from: a.published_from ?? null,
        published_to: a.published_to ?? null,
        change_action: a.change_action ?? null,
        change_by_username: a.change_by_username ?? null,
        change_note: a.change_note ?? null,
        attrs: extractAttrs(a),
    };
}

/** A comment re-asserts a value to carry discussion; it is never published and
 *  never counts as a content version (see publication-model.md §5). */
export const COMMENT = "comment";
export function isComment(a: { change_action?: string | null }): boolean {
    return a.change_action === COMMENT;
}

export function byPath<T extends { path: string }>(a: T, b: T): number {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// --- The production adapter: VersionedDb behind the shared interface ------------

/**
 * Wraps a real VersionedDb. `apply` is the live-edit path; `fullHistory`/
 * `currentView` are produced via the production tree and QUERY LAYER — i.e.
 * the code under test. (The oracle, by contrast, must never touch this.)
 */
export class VersionedDbModel implements VersionedModel {
    constructor(readonly vdb: VersionedDb, readonly rootTag: string = "dct") {}

    apply(assertion: Assertion): void {
        // Clone: the workspace takes ownership and mutates a predecessor's
        // valid_to in place; we keep the caller's object (and the oracle's
        // copy) untouched.
        this.vdb.applyProposedAssertion(structuredClone(assertion));
    }

    fullHistory(): FactHistory[] {
        const out: FactHistory[] = [];
        const root = this.vdb.getTableByTag(this.rootTag);
        const walk = (tuple: any, path: string) => {
            if (tuple.id !== 0)
                out.push({
                    path,
                    versions: tuple.tupleVersions.map((tv: any) => toSnapshot(tv.assertion)),
                });
            for (const rel of Object.values(tuple.childRelations) as any[])
                for (const child of rel.tuples.values())
                    walk(child, `${path}/${child.schema.tag}:${child.id}`);
        };
        walk(root, this.rootTag);
        return out.sort(byPath);
    }

    currentView(): VisibleFact[] {
        const out: VisibleFact[] = [];
        const root = this.vdb.getTableByTag(this.rootTag);
        // CurrentTupleQuery / CurrentRelationQuery filter to live tuples and
        // never recurse into deleted ones — so this walk yields exactly the
        // visible facts (the query layer's notion of "current").
        const walk = (q: CurrentTupleQuery, path: string) => {
            for (const rel of Object.values(q.childRelations) as any[])
                for (const childQ of rel.tuples) {
                    const a = childQ.mostRecentTupleVersion!.assertion;
                    const childPath = `${path}/${childQ.src.schema.tag}:${childQ.src.id}`;
                    out.push({ path: childPath, attrs: extractAttrs(a) });
                    walk(childQ, childPath);
                }
        };
        walk(new CurrentTupleQuery(root), this.rootTag);
        return out.sort(byPath);
    }
}
