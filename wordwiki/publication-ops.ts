// deno-lint-ignore-file no-explicit-any
/**
 * The PRODUCTION publication operations — approve / revert / comment — over a
 * real VersionedDb (the workspace). They mirror the semantics of the reference
 * oracle (reference-model.ts), but drive the actual workspace machinery
 * (applyProposedAssertion: chain validation, the in-place valid_to close, the
 * tree) — which is exactly the complex, bug-prone code the property test pins
 * against the oracle (publication-model_test.ts).
 *
 * Like applyProposedAssertion (which mutates a predecessor's valid_to and
 * returns it for the caller to persist), these mutate a prior published
 * version's published_to in place and return the full set of assertions a
 * db-backed caller must persist: `applied` (the new version, INSERT) and
 * `updated` (predecessors whose valid_to/published_to changed, UPDATE).
 *
 * Timestamps and ids are passed in (the app allocates a server timestamp + a
 * fresh id; the property test a monotonic counter), keeping these pure over
 * the workspace.
 */
import { Assertion } from "./assertion.ts";
import { VersionedDb, VersionedTuple } from "./workspace.ts";
import * as timestamp from "../liminal/timestamp.ts";
import { isComment, COMMENT } from "./versioned-model.ts";

const EOT = timestamp.END_OF_TIME;

export interface OpResult {
    applied: Assertion[];   // new versions to INSERT
    updated: Assertion[];   // predecessors mutated in place to UPDATE
}

function tupleOf(vdb: VersionedDb, factId: number): VersionedTuple {
    const t = vdb.getTableByTag("dct").getTupleById(factId);
    if (!t) throw new Error(`no fact ${factId}`);
    return t;
}
const versionsOf = (t: VersionedTuple): Assertion[] => t.tupleVersions.map((tv) => tv.assertion);
const latest = (vs: Assertion[]): Assertion => vs[vs.length - 1];
const publishedCurrent = (vs: Assertion[]): Assertion | undefined =>
    vs.find((a) => a.published_to === EOT);
function latestContent(vs: Assertion[]): Assertion | undefined {
    for (let i = vs.length - 1; i >= 0; i--) if (!isComment(vs[i])) return vs[i];
    return undefined;
}

// A re-assertion: same path + content as `contentFrom`, chained onto `tip`,
// with the version/publication/change fields set explicitly. (Independent of
// the oracle's equivalent - the point of the conformance test.)
function buildReassertion(contentFrom: Assertion, tip: Assertion, f: {
    assertionId: number; validFrom: number; validTo: number;
    publishedFrom?: number; publishedTo?: number;
    changeAction: string; changeBy: string; changeNote?: string;
}): Assertion {
    return {
        ...structuredClone(contentFrom),
        assertion_id: f.assertionId,
        replaces_assertion_id: tip.assertion_id,
        valid_from: f.validFrom, valid_to: f.validTo,
        published_from: f.publishedFrom, published_to: f.publishedTo,
        change_action: f.changeAction, change_by_username: f.changeBy,
        change_note: f.changeNote, change_arg: undefined,
    };
}

/** Approve the fact's pending content: re-assert it as published, close the
 *  prior published version. The approver must differ from the change's author
 *  (the two-person rule) unless allowSelfApprove is set (the production layer
 *  grants this via a self-approve permission, and separately checks the
 *  approver holds approve-permission). */
export function approve(vdb: VersionedDb, factId: number, approver: string,
                        now: number, assertionId: number,
                        opts: { allowSelfApprove?: boolean } = {}): OpResult {
    const vs = versionsOf(tupleOf(vdb, factId));
    const content = latestContent(vs);
    if (!content) throw new Error(`fact ${factId} has no content to approve`);
    if (content.published_from != null) throw new Error(`fact ${factId} is not pending`);
    if (content.change_by_username === approver && !opts.allowSelfApprove)
        throw new Error(`approver must differ from the content's author (two-person rule)`);
    const tip = latest(vs);
    const prevPublished = publishedCurrent(vs);

    const newAssertion = content.valid_from === content.valid_to
        // Approving a DELETION: a tombstone, publishing nothing (I7).
        ? buildReassertion(tip, tip, {
            assertionId, validFrom: now, validTo: now, changeAction: "approved", changeBy: approver })
        : buildReassertion(content, tip, {
            assertionId, validFrom: now, validTo: EOT, publishedFrom: now, publishedTo: EOT,
            changeAction: "approved", changeBy: approver });

    return finish(vdb, newAssertion, now, prevPublished);
}

/** Revert to the last published value (decline a pending edit / roll back an
 *  approved one), published immediately under the carve-out; a never-published
 *  fact becomes a tombstone. Required note. */
export function revert(vdb: VersionedDb, factId: number, reverter: string, note: string,
                       now: number, assertionId: number): OpResult {
    const vs = versionsOf(tupleOf(vdb, factId));
    const tip = latest(vs);
    const prevPublished = publishedCurrent(vs);

    const newAssertion = prevPublished
        ? buildReassertion(prevPublished, tip, {
            assertionId, validFrom: now, validTo: EOT, publishedFrom: now, publishedTo: EOT,
            changeAction: "reverted", changeBy: reverter, changeNote: note })
        : buildReassertion(tip, tip, {
            assertionId, validFrom: now, validTo: now,
            changeAction: "reverted", changeBy: reverter, changeNote: note });

    return finish(vdb, newAssertion, now, prevPublished);
}

/** A discussion note: re-assert the current value, never published, never a
 *  content version. Required note. */
export function comment(vdb: VersionedDb, factId: number, commenter: string, note: string,
                        now: number, assertionId: number): OpResult {
    const vs = versionsOf(tupleOf(vdb, factId));
    const tip = latest(vs);
    const newAssertion = buildReassertion(tip, tip, {
        assertionId, validFrom: now, validTo: EOT,
        changeAction: COMMENT, changeBy: commenter, changeNote: note });
    return finish(vdb, newAssertion, now, undefined);
}

// Apply the new assertion (closing the tip's valid_to) and, if publishing,
// close the prior published version's published_to in place. Returns the
// persist set.
function finish(vdb: VersionedDb, newAssertion: Assertion, now: number,
                prevPublished: Assertion | undefined): OpResult {
    const updatedTip = vdb.applyProposedAssertion(newAssertion);
    const updated: Assertion[] = updatedTip ? [updatedTip] : [];
    // Close the prior published version whenever one was passed (the caller
    // passes it only for approve/revert). It is superseded by the new published
    // version, OR - for a deletion approval - the fact simply leaves the public
    // view (no successor). It may BE the valid-chain predecessor (reverting a
    // clean fact), so close it in place without duplicating it in the persist
    // set.
    if (prevPublished) {
        prevPublished.published_to = now;
        if (!updated.includes(prevPublished)) updated.push(prevPublished);
    }
    return { applied: [newAssertion], updated };
}
