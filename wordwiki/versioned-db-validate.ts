// deno-lint-ignore-file no-explicit-any
/**
 * Structural validation of the versioned assertion model — a literate
 * statement of the invariants the persisted data must satisfy.
 *
 * Two design choices make this useful beyond a one-off check:
 *
 *  1. It runs over a MINIMAL abstract view of the data — per fact, its
 *     ordered version records plus its parent's earliest time — NOT over the
 *     VersionedDb tree directly. So the same checker validates the live
 *     workspace (via `factViewsFromVersionedDb`), and later the in-core
 *     reference model and even a raw archived export, all by adapting them to
 *     `FactView`. One invariant, one implementation, every representation.
 *
 *  2. It is INDEPENDENT of the apply paths. The workspace already enforces
 *     chain continuity and interval non-overlap incrementally as it loads
 *     (workspace.ts); this re-states those invariants from scratch over the
 *     finished structure, and adds the global/tail ones the incremental walk
 *     cannot see (orphans, the last-version shape, temporal containment,
 *     assertion-id uniqueness). Two independent encodings of the same truth —
 *     a bug has to fool both.
 *
 * Checks are READ-ONLY and never throw on a finding; they accumulate
 * `ValidationProblem`s so a full report is possible. `assertVersionedDbValid`
 * is the throw-on-any wrapper for load-time / test use.
 *
 * The publication-dimension invariants (published_from/published_to, I1–I8 in
 * publication-model.md) are deliberately NOT checked here yet: that model is
 * not built, and the columns currently hold legacy placeholder data (a single
 * constant 2020 epoch-ms stamp on ~151k rows, in a different time-space than
 * valid_from). Those checks return with the publication model, once Phase-0
 * backfill has cleared the placeholder.
 */
import * as timestamp from "../liminal/timestamp.ts";
import { VersionedDb, VersionedTuple } from "./workspace.ts";

const END_OF_TIME = timestamp.END_OF_TIME;

/** One version of a fact, reduced to the fields the invariants constrain. */
export interface VersionRecord {
    assertion_id: number;
    replaces_assertion_id?: number;
    valid_from: number;
    valid_to: number;
    published_from?: number;
    published_to?: number;
}

/** One fact, as the validator needs to see it (any representation adapts to
 *  this — the live tree, the reference model, an export file). */
export interface FactView {
    /** Human-readable address for error messages, e.g. "dct/ent:123/sub:456". */
    path: string;
    ty: string;
    id: number;
    /** Every version, OLDEST FIRST. */
    versions: VersionRecord[];
    /** The earliest valid_from of this fact's parent fact, or undefined for a
     *  top-level fact (whose parent is the versionless table root). */
    parentEarliestValidFrom?: number;
}

export interface ValidationProblem {
    path: string;
    invariant: string;
    detail: string;
}

/**
 * Validate a collection of facts. Returns every problem found (empty = valid).
 */
export function validateFacts(facts: Iterable<FactView>): ValidationProblem[] {
    const problems: ValidationProblem[] = [];
    const add = (path: string, invariant: string, detail: string) =>
        problems.push({ path, invariant, detail });

    // Global: an assertion_id identifies one version across the whole store.
    const seenAssertionIds = new Map<number, string>();

    for (const fact of facts) {
        const vs = fact.versions;

        // --- A registered fact must have at least one version. A zero-version
        //     fact is an orphan: a path segment that some descendant referenced
        //     but that was never itself asserted (a child under a missing
        //     parent).
        if (vs.length === 0) {
            add(fact.path, "fact-has-no-versions",
                `fact ${fact.ty}:${fact.id} exists in the tree but was never asserted ` +
                `(a descendant referenced a parent that does not exist)`);
            continue;
        }

        for (let i = 0; i < vs.length; i++) {
            const v = vs[i];

            // --- assertion_id is globally unique.
            const prevHome = seenAssertionIds.get(v.assertion_id);
            if (prevHome !== undefined)
                add(fact.path, "duplicate-assertion-id",
                    `assertion_id ${v.assertion_id} appears on both ${prevHome} and ${fact.path}`);
            else
                seenAssertionIds.set(v.assertion_id, fact.path);

            // --- A version cannot end before it begins.
            if (v.valid_from > v.valid_to)
                add(fact.path, "valid-interval-reversed",
                    `version ${v.assertion_id} has valid_from ${v.valid_from} > valid_to ${v.valid_to}`);

            // (Publication-interval invariants come with the publication
            //  model — see the module comment.)

            if (i === 0) {
                // --- The first version replaces nothing.
                if (v.replaces_assertion_id != null)
                    add(fact.path, "first-version-replaces",
                        `oldest version ${v.assertion_id} has replaces_assertion_id ${v.replaces_assertion_id}`);
            } else {
                const prev = vs[i - 1];
                // --- The chain is unbroken: each version replaces the prior.
                if (v.replaces_assertion_id !== prev.assertion_id)
                    add(fact.path, "broken-replaces-chain",
                        `version ${v.assertion_id} replaces ${v.replaces_assertion_id}, ` +
                        `but the prior version is ${prev.assertion_id}`);
                // --- Valid intervals do not overlap; a successor begins no
                //     earlier than its predecessor ended (a LATER start is a
                //     gap — a restore after a delete — and is allowed).
                if (v.valid_from < prev.valid_to)
                    add(fact.path, "overlapping-valid-intervals",
                        `version ${v.assertion_id} starts at ${v.valid_from}, ` +
                        `before the prior version ended at ${prev.valid_to}`);
            }
        }

        // --- The last version is either currently live (open to END_OF_TIME)
        //     or a deletion tombstone (empty interval). A tail that is closed
        //     at some finite time without being a tombstone is a fact that
        //     "stopped" with neither a successor nor a deletion — corruption.
        const last = vs[vs.length - 1];
        const lastIsOpen = last.valid_to === END_OF_TIME;
        const lastIsTombstone = last.valid_from === last.valid_to;
        if (!lastIsOpen && !lastIsTombstone)
            add(fact.path, "dangling-closed-tail",
                `newest version ${last.assertion_id} is closed at ${last.valid_to} ` +
                `but is neither live (END_OF_TIME) nor a tombstone`);

        // --- A fact cannot predate its parent (it could not have been
        //     asserted before the parent it hangs off existed).
        if (fact.parentEarliestValidFrom != null &&
            vs[0].valid_from < fact.parentEarliestValidFrom)
            add(fact.path, "fact-predates-parent",
                `oldest version begins at ${vs[0].valid_from}, before its parent's ` +
                `earliest version at ${fact.parentEarliestValidFrom}`);
    }

    return problems;
}

// --------------------------------------------------------------------------------
// --- Adapter: the live workspace tree -> FactViews ------------------------------
// --------------------------------------------------------------------------------

export function factViewsFromVersionedDb(vdb: VersionedDb): FactView[] {
    const out: FactView[] = [];
    for (const table of vdb.tables.values())
        walk(table, table.schema.tag, undefined, out);
    return out;
}

function walk(tuple: VersionedTuple, path: string,
              parentEarliestValidFrom: number|undefined, out: FactView[]): void {
    // The table root (id 0) is a versionless placeholder, not a fact.
    const isRoot = tuple.id === 0;
    let earliest = parentEarliestValidFrom;

    if (!isRoot) {
        const versions: VersionRecord[] = tuple.tupleVersions.map(tv => {
            const a = tv.assertion;
            return {
                assertion_id: a.assertion_id,
                replaces_assertion_id: a.replaces_assertion_id,
                valid_from: a.valid_from,
                valid_to: a.valid_to,
                published_from: a.published_from,
                published_to: a.published_to,
            };
        });
        earliest = versions[0]?.valid_from ?? parentEarliestValidFrom;
        out.push({ path, ty: tuple.schema.tag, id: tuple.id, versions, parentEarliestValidFrom });
    }

    for (const rel of Object.values(tuple.childRelations))
        for (const child of rel.tuples.values())
            walk(child, `${path}/${child.schema.tag}:${child.id}`, earliest, out);
}

// --------------------------------------------------------------------------------
// --- Throwing wrapper -----------------------------------------------------------
// --------------------------------------------------------------------------------

export function validateVersionedDb(vdb: VersionedDb): ValidationProblem[] {
    return validateFacts(factViewsFromVersionedDb(vdb));
}

/** Throw if the workspace violates any structural invariant. For load-time
 *  and tests — the "know right away" path. */
export function assertVersionedDbValid(vdb: VersionedDb): void {
    const problems = validateVersionedDb(vdb);
    if (problems.length === 0) return;
    const shown = problems.slice(0, 20)
        .map(p => `  [${p.invariant}] ${p.path}: ${p.detail}`).join("\n");
    const more = problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : "";
    throw new Error(
        `VersionedDb failed structural validation (${problems.length} problem(s)):\n${shown}${more}`);
}
