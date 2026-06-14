// deno-lint-ignore-file no-explicit-any
/**
 * The REFERENCE ORACLE for the versioned model — a dead-simple, in-core
 * implementation whose only job is to be obviously correct by inspection, so
 * it can serve as the oracle for property-testing the production VersionedDb
 * (reference-model_test.ts).
 *
 * It is a flat list of assertions (a Map from fact id to its versions) plus
 * brute-force pure functions for the views. It deliberately shares NOTHING
 * with the production tree / query layer — that is the whole point: a bug in
 * the production machinery shows up as a divergence from this, and a bug
 * shared by both would have to be reinvented here independently.
 *
 * The apply semantics mirror VersionedDb.applyProposedAssertion +
 * VersionedTuple._applyProposedAssertion EXACTLY — same checks in the same
 * order, same accept/reject, same in-place close of a replaced predecessor's
 * valid_to — but over a flat Map instead of a tree. (This rule IS the model
 * definition; the independence that matters is the absence of the tree, the
 * id index, the incremental structures, and the query layer.)
 */
import { Assertion } from "./assertion.ts";
import * as timestamp from "../liminal/timestamp.ts";
import {
    type VersionedModel, type FactHistory, type VisibleFact,
    pathString, parentIdOf, extractAttrs, toSnapshot, byPath,
} from "./versioned-model.ts";

const EOT = timestamp.END_OF_TIME;
const BOT = timestamp.BEGINNING_OF_TIME;

export class ReferenceModel implements VersionedModel {
    // fact id -> its versions, oldest first (the assertions, as stored, with
    // valid_to closed in place when superseded - same as production persists).
    readonly #facts = new Map<number, Assertion[]>();
    readonly #seenAssertionIds = new Set<number>();
    #mostRecent = BOT;

    apply(input: Assertion): void {
        const a = structuredClone(input);

        // 1. Per-assertion sanity (mirrors VersionedDb._trackAssertion - note
        //    the assertion_id is recorded even if a later check rejects, so a
        //    rejected apply burns the id exactly as production does).
        if (!Number.isFinite(a.assertion_id))
            throw new Error(`assertion has no assertion_id`);
        if (this.#seenAssertionIds.has(a.assertion_id))
            throw new Error(`duplicate assertion_id ${a.assertion_id}`);
        if (a.valid_from > a.valid_to)
            throw new Error(`valid_from > valid_to`);
        this.#seenAssertionIds.add(a.assertion_id);

        // 2. Workspace-level checks (mirrors VersionedDb.applyProposedAssertion).
        if (a.valid_from <= this.#mostRecent)
            throw new Error(`Attempt to assert into the past`);
        if (a.valid_to !== a.valid_from && a.valid_to !== EOT)
            throw new Error(`new assertions must be live or a tombstone`);

        // 3. Per-fact chain checks (mirrors VersionedTuple._applyProposedAssertion).
        const versions = this.#facts.get(a.id);
        if (versions && versions.length > 0) {
            const prev = versions[versions.length - 1];
            if (a.replaces_assertion_id !== prev.assertion_id)
                throw new Error(`replaces_assertion_id chain broken`);
            if (!(a.valid_from > prev.valid_from))
                throw new Error(`Attempt to assert a tuple in the past`);
            if (prev.valid_to === EOT) {
                prev.valid_to = a.valid_from; // close the live predecessor
            } else if (prev.valid_to < a.valid_from) {
                // restore after a delete (gap): no predecessor update
            } else {
                throw new Error(`Attempt to assert a tuple in the past`);
            }
            versions.push(a);
        } else {
            this.#facts.set(a.id, [a]);
        }
        this.#mostRecent = a.valid_from;
    }

    // --- Views (brute force over the flat list) ---------------------------------

    fullHistory(): FactHistory[] {
        const out: FactHistory[] = [];
        for (const versions of this.#facts.values())
            out.push({ path: pathString(versions[0]), versions: versions.map(toSnapshot) });
        return out.sort(byPath);
    }

    currentView(): VisibleFact[] {
        // Most-recent version per fact = the last applied.
        const latest = new Map<number, Assertion>();
        for (const [id, versions] of this.#facts)
            latest.set(id, versions[versions.length - 1]);

        // Visible iff live (valid_to === EOT) and every ancestor is visible.
        const memo = new Map<number, boolean>();
        const isVisible = (id: number): boolean => {
            const cached = memo.get(id);
            if (cached !== undefined) return cached;
            const a = latest.get(id);
            let result: boolean;
            if (!a || a.valid_to !== EOT) {
                result = false;
            } else {
                const parent = parentIdOf(a);
                result = parent === 0 ? true : isVisible(parent);
            }
            memo.set(id, result);
            return result;
        };

        const out: VisibleFact[] = [];
        for (const [id, a] of latest)
            if (isVisible(id)) out.push({ path: pathString(a), attrs: extractAttrs(a) });
        return out.sort(byPath);
    }

    // --- For the generator + the cross-check validator --------------------------

    /** Per-fact handles the generator uses to pick targets and build valid
     *  follow-on assertions. */
    handles(): Array<{ id: number; path: string; ty: string; currentAssertionId: number; live: boolean }> {
        const hs = [];
        for (const versions of this.#facts.values()) {
            const last = versions[versions.length - 1];
            hs.push({
                id: last.id, path: pathString(versions[0]), ty: last.ty,
                currentAssertionId: last.assertion_id, live: last.valid_to === EOT,
            });
        }
        return hs;
    }

    /** The minimal FactView shape (versioned-db-validate.ts) so the oracle's
     *  own structural integrity can be cross-checked during the property
     *  test. */
    factViews() {
        return Array.from(this.#facts.values()).map((versions) => {
            const first = versions[0];
            const parentId = parentIdOf(first);
            const parentVersions = parentId === 0 ? undefined : this.#facts.get(parentId);
            return {
                path: pathString(first),
                ty: first.ty,
                id: first.id,
                versions: versions.map((a) => ({
                    assertion_id: a.assertion_id,
                    replaces_assertion_id: a.replaces_assertion_id,
                    valid_from: a.valid_from,
                    valid_to: a.valid_to,
                    published_from: a.published_from,
                    published_to: a.published_to,
                })),
                parentEarliestValidFrom: parentVersions ? parentVersions[0].valid_from : undefined,
            };
        });
    }
}
