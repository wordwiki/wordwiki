// deno-lint-ignore-file no-explicit-any
/**
 * The publication / approval model as an EXECUTABLE SPEC — the reference model
 * (reference-model.ts) exercised directly, with hand-verified expectations,
 * pinning down the decisions from publication-model.md:
 *   - approval gates PUBLICATION, not editing (the editor view runs ahead);
 *   - approval re-asserts the value and needs a second senior (two-person);
 *   - revert restores the last published value on one signature (the carve-out);
 *   - a comment never publishes and never makes a fact "pending";
 *   - deletion approval removes the fact from the public view.
 *
 * Production will be built against this and property-tested to match it; here
 * we just verify the spec itself behaves as designed.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows, assertStringIncludes } from "../liminal/testing/assert.ts";
import { ReferenceModel } from "./reference-model.ts";
import { validateFacts } from "./versioned-db-validate.ts";
import { Assertion, assertionPathToFields } from "./assertion.ts";
import * as timestamp from "../liminal/timestamp.ts";

const EOT = timestamp.END_OF_TIME;
const T0 = timestamp.BEGINNING_OF_TIME;

// A monotonic clock + id source, mirroring how production allocates them.
function mk() {
    let clock = T0, id = 1;
    return { now: () => ++clock, id: () => ++id };
}

// Assert a brand-new top-level entry fact (the pending content, by `author`).
function assertEntry(m: ReferenceModel, factId: number, author: string,
                     now: number, assertionId: number, attr1: string): void {
    m.apply({
        ...assertionPathToFields([["dct", 0], ["ent", factId]]),
        ty: "ent", id: factId, assertion_id: assertionId,
        valid_from: now, valid_to: EOT, order_key: "0.5",
        change_by_username: author, attr1,
    } as Assertion);
}
function editEntry(m: ReferenceModel, factId: number, replaces: number, author: string,
                   now: number, assertionId: number, attr1: string): void {
    m.apply({
        ...assertionPathToFields([["dct", 0], ["ent", factId]]),
        ty: "ent", id: factId, assertion_id: assertionId, replaces_assertion_id: replaces,
        valid_from: now, valid_to: EOT, order_key: "0.5",
        change_by_username: author, attr1,
    } as Assertion);
}
function deleteEntry(m: ReferenceModel, factId: number, replaces: number, author: string,
                     now: number, assertionId: number): void {
    m.apply({
        ...assertionPathToFields([["dct", 0], ["ent", factId]]),
        ty: "ent", id: factId, assertion_id: assertionId, replaces_assertion_id: replaces,
        valid_from: now, valid_to: now, order_key: "0.5", change_by_username: author,
    } as Assertion);
}

const paths = (xs: { path: string }[]) => xs.map((x) => x.path);
const val = (xs: { path: string; attrs: any }[], path: string) =>
    xs.find((x) => x.path === path)?.attrs.attr1;
const valid = (m: ReferenceModel) => validateFacts(m.factViews());

test("approval gates publication, not editing; pending tracks the content", () => {
    const m = new ReferenceModel(); const c = mk();

    // ana proposes "water" (entry fact 10, assertion 100).
    assertEntry(m, 10, "ana", c.now(), 100, "water");
    assertEquals(paths(m.currentView()), ["dct/ent:10"]);   // editors see it
    assertEquals(m.publishedView(), []);                     // public does not
    assertEquals(m.pending(), ["dct/ent:10"]);               // it's in the queue

    // A second senior, bob, approves it.
    m.approve(10, "bob", c.now(), c.id());
    assertEquals(val(m.publishedView(), "dct/ent:10"), "water"); // now public
    assertEquals(m.pending(), []);                                // queue clear

    // ana edits to "liquid": editors see it, the public still sees "water".
    const tip = m.factViews()[0].versions.at(-1)!.assertion_id;
    editEntry(m, 10, tip, "ana", c.now(), c.id(), "liquid");
    assertEquals(val(m.currentView(), "dct/ent:10"), "liquid");
    assertEquals(val(m.publishedView(), "dct/ent:10"), "water");
    assertEquals(m.pending(), ["dct/ent:10"]);
    assertEquals(valid(m), []);
});

test("the two-person rule, and the self-approve workaround", () => {
    const m = new ReferenceModel(); const c = mk();
    assertEntry(m, 10, "ana", c.now(), 100, "water");
    // ana cannot approve her own content...
    const e = assertThrows(() => m.approve(10, "ana", c.now(), c.id()), Error);
    assertStringIncludes((e as Error).message, "two-person");
    // ...unless the self-approve workaround is granted (a sole approver). The
    // self-approval is self-documenting: approver === content author.
    m.approve(10, "ana", c.now(), c.id(), { allowSelfApprove: true });
    assertEquals(val(m.publishedView(), "dct/ent:10"), "water");
    const pub = m.factViews()[0].versions.at(-1)!;
    assertEquals(pub.change_action, "approved");
    assertEquals(valid(m), []);
});

test("revert restores the last published value on one signature (carve-out)", () => {
    const m = new ReferenceModel(); const c = mk();
    assertEntry(m, 10, "ana", c.now(), 100, "water");
    m.approve(10, "bob", c.now(), c.id());
    const tip = m.factViews()[0].versions.at(-1)!.assertion_id;
    editEntry(m, 10, tip, "ana", c.now(), c.id(), "liquid");        // pending bad edit

    // bob reverts (one signature — restoring a previously-published value).
    m.revert(10, "bob", "wrong sense", c.now(), c.id());
    assertEquals(val(m.currentView(), "dct/ent:10"), "water");      // workspace re-converges
    assertEquals(val(m.publishedView(), "dct/ent:10"), "water");
    assertEquals(m.pending(), []);
    // History retains the rejected "liquid".
    const attrs = m.factViews()[0].versions.map((v: any) => v); // versions present
    assertEquals(attrs.length >= 4, true);
    assertEquals(valid(m), []);
});

test("reverting a never-published fact deletes it (tombstone, no publish)", () => {
    const m = new ReferenceModel(); const c = mk();
    assertEntry(m, 10, "ana", c.now(), 100, "junk");
    m.revert(10, "bob", "spam", c.now(), c.id());
    assertEquals(m.currentView(), []);   // gone from the editor view (deleted)
    assertEquals(m.publishedView(), []); // never was public
    assertEquals(m.pending(), []);
    // The tombstone carries no published interval.
    const last = m.factViews()[0].versions.at(-1)!;
    assertEquals(last.valid_from === last.valid_to, true);
    assertEquals(last.published_from ?? null, null);
    assertEquals(valid(m), []);
});

test("a comment never publishes and never makes a fact pending", () => {
    const m = new ReferenceModel(); const c = mk();
    assertEntry(m, 10, "ana", c.now(), 100, "water");
    m.approve(10, "bob", c.now(), c.id());

    m.comment(10, "cy", "should we add the SF spelling?", c.now(), c.id());
    assertEquals(val(m.publishedView(), "dct/ent:10"), "water"); // public unchanged
    assertEquals(m.pending(), []);                                // NOT pending
    assertEquals(val(m.currentView(), "dct/ent:10"), "water");    // value carried
    // The comment is on the chain, unpublished, change_action='comment'.
    const last = m.factViews()[0].versions.at(-1)!;
    assertEquals(last.change_action, "comment");
    assertEquals(last.published_from ?? null, null);
    assertEquals(valid(m), []);
});

test("approving a deletion removes the fact from the public view", () => {
    const m = new ReferenceModel(); const c = mk();
    assertEntry(m, 10, "ana", c.now(), 100, "water");
    m.approve(10, "bob", c.now(), c.id());
    assertEquals(val(m.publishedView(), "dct/ent:10"), "water");

    // ana deletes (pending); public still sees "water" until approved.
    const tip = m.factViews()[0].versions.at(-1)!.assertion_id;
    deleteEntry(m, 10, tip, "ana", c.now(), c.id());
    assertEquals(m.currentView(), []);                            // editor: gone
    assertEquals(val(m.publishedView(), "dct/ent:10"), "water");  // public: still there
    assertEquals(m.pending(), ["dct/ent:10"]);                    // deletion awaits approval

    m.approve(10, "bob", c.now(), c.id());
    assertEquals(m.publishedView(), []);   // now gone from the public view
    assertEquals(m.pending(), []);
    assertEquals(valid(m), []);
});
