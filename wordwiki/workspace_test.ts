// deno-lint-ignore-file no-explicit-any
/**
 * Assertion-model core tests: the pure in-memory versioned workspace
 * (datawiki/workspace.ts) plus the path/ordering/timestamp machinery it sits
 * on.  No database - these exercise the model invariants directly.
 *
 * The db-backed end of the model (applyTransaction, persistence round-trips,
 * the editor flows) is covered in wordwiki/assertion_model_test.ts.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertExists, assertThrows, assertNotEquals } from "../liminal/testing/assert.ts";
import * as model from './model.ts';
import { VersionedDb, CurrentTupleQuery, CurrentRelationQuery,
         currentTuplesForVersionedRelation,
         generateAtEndOrderKey, generateBeforeOrderKey, generateAfterOrderKey } from './workspace.ts';
import { Assertion, getAssertionPath, assertionPathToFields, parentAssertionPath,
         getAssertionTypeN, getAssertionIdN, compareAssertionsByOrderKey } from './assertion.ts';
import { dictSchemaJson } from './entry-schema.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as orderkey from '../liminal/orderkey.ts';
import { TestTimeline, mkEntry, mkChild, mkEdit, mkTombstone } from './testing.ts';

const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);

function newWorkspace(): VersionedDb {
    return new VersionedDb([dictSchema]);
}

// Apply a sequence of assertions as proposed assertions (the live-edit path).
function apply(ws: VersionedDb, ...assertions: Assertion[]) {
    for(const a of assertions)
        ws.applyProposedAssertion(structuredClone(a));
}

// Load a sequence of assertions (the from-db path).
function load(ws: VersionedDb, ...assertions: Assertion[]) {
    for(const a of assertions)
        ws.untrackedApplyAssertion(structuredClone(a));
}

function currentEntryJSON(ws: VersionedDb, entry_id: number): any {
    const tuple = ws.getTableByTag('dct').childRelations['ent'].tuples.get(entry_id);
    assertExists(tuple, `entry ${entry_id} not in workspace`);
    return new CurrentTupleQuery(tuple!).toJSON();
}

// ---------------------------------------------------------------------------
// --- Path encoding -----------------------------------------------------------
// ---------------------------------------------------------------------------

test("path: encode/decode round-trips at every depth", () => {
    const tl = new TestTimeline();
    const entry = mkEntry(10, tl.next());
    const sub = mkChild(entry, 'sub', 11, tl.next());
    const example = mkChild(sub, 'exa', 12, tl.next());
    const exampleText = mkChild(example, 'etx', 13, tl.next(), {attr1: 'hello'});

    for(const a of [entry, sub, example, exampleText]) {
        const path = getAssertionPath(a);
        const fields = assertionPathToFields(path);
        for(const [k, v] of Object.entries(fields))
            assertEquals((a as any)[k], v, `field ${k} of ${a.ty}`);
    }

    // Depth-by-depth shape of the deepest one: dct/ent/sub/exa/etx.
    const p = getAssertionPath(exampleText);
    assertEquals(p, [['dct', 0], ['ent', 10], ['sub', 11], ['exa', 12], ['etx', 13]]);
    assertEquals(parentAssertionPath(p), [['dct', 0], ['ent', 10], ['sub', 11], ['exa', 12]]);

    // The tyN/idN accessors agree with the path.
    p.forEach(([ty, id], n) => {
        assertEquals(getAssertionTypeN(exampleText, n), ty);
        assertEquals(getAssertionIdN(exampleText, n), id);
    });
});

test("path: an assertion missing ty0 is rejected", () => {
    const bad = {ty: 'ent', id: 1} as unknown as Assertion;
    assertThrows(() => getAssertionPath(bad), Error, 'missing ty0');
});

// ---------------------------------------------------------------------------
// --- Timestamps ---------------------------------------------------------------
// ---------------------------------------------------------------------------

test("timestamp: nextTime is strictly monotonic, even faster than the clock", () => {
    let t = timestamp.BEGINNING_OF_TIME;
    for(let i = 0; i < 1000; i++) {
        const n = timestamp.nextTime(t);
        assert(n > t, `nextTime must increase (${n} after ${t})`);
        t = n;
    }
});

test("timestamp: the TIME component round-trips; ordering survives counter rollover", () => {
    const t = timestamp.makeTimestamp(123456, 789);
    assertEquals(timestamp.extractTimeFromTimestamp(t), 123456);

    // KNOWN QUIRK (display-only): makeTimestamp multiplies by COUNTER_MASK
    // while extractCounterFromTimestamp uses a bitwise AND - these are not
    // inverses, so the COUNTER does not round-trip in general.  The counter is
    // only used in formatted timestamps; ordering never depends on extracting
    // it.  This assertion documents the quirk so a fix is a conscious change.
    assertNotEquals(timestamp.extractCounterFromTimestamp(t), 789);

    // What actually matters: timestamps order correctly across a counter
    // rollover into the next second.
    const lastOfSecond = timestamp.makeTimestamp(123456, 0xFFFFE);
    const firstOfNext = timestamp.makeTimestamp(123457, 0);
    assert(lastOfSecond < firstOfNext);
});

test("timestamp: nextTime from a future timestamp counts within it", () => {
    // A timestamp far in the future (e.g. from a machine with a wrong clock):
    // nextTime can only go forward - it must not go back to current time.
    const future = timestamp.makeTimestamp(timestamp.currentSystemTimeInLocalEpoch() + 10_000, 5);
    const n = timestamp.nextTime(future);
    assertEquals(n, future + 1);
});

// ---------------------------------------------------------------------------
// --- Order keys ---------------------------------------------------------------
// ---------------------------------------------------------------------------

test("orderkey: between() lands strictly between its bounds", () => {
    const a = orderkey.begin_string, b = orderkey.end_string;
    const mid = orderkey.between(a, b);
    assert(orderkey.compareOrderKeys(a, mid) < 0);
    assert(orderkey.compareOrderKeys(mid, b) < 0);

    // Repeated insertion before the same key keeps producing distinct,
    // correctly-ordered keys (no precision wall within sane depths).
    let upper = mid;
    for(let i = 0; i < 50; i++) {
        const k = orderkey.between(a, upper);
        assert(orderkey.compareOrderKeys(a, k) < 0 && orderkey.compareOrderKeys(k, upper) < 0,
               `iteration ${i}: ${k} not between ${a} and ${upper}`);
        upper = k;
    }
});

test("orderkey: compareAssertionsByOrderKey is a stable total order on ties", () => {
    const tl = new TestTimeline();
    const a = mkEntry(1, tl.next(), {order_key: '0.5'});
    const b = mkEntry(2, tl.next(), {order_key: '0.5'});
    // Same key: falls back to fact id.
    assert(compareAssertionsByOrderKey(a, b) < 0);
    assert(compareAssertionsByOrderKey(b, a) > 0);
    assertEquals(compareAssertionsByOrderKey(a, a), 0);
});

// ---------------------------------------------------------------------------
// --- applyProposedAssertion (the live-edit path) ------------------------------
// ---------------------------------------------------------------------------

test("apply: insert then edit chains versions and stamps the predecessor", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat', variant: 'mm-li'});
    apply(ws, entry, spelling);

    const editTime = tl.next();
    const edit = mkEdit(spelling, 102, editTime, {attr1: 'caat'});
    const updatedPrev = ws.applyProposedAssertion(edit);

    // The replaced version's valid_to is stamped with the edit time and
    // handed back (so the caller can persist the update).
    assertExists(updatedPrev);
    assertEquals(updatedPrev!.assertion_id, 101);
    assertEquals(updatedPrev!.valid_to, editTime);

    // Both versions exist; current is the edit.
    const tuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(101);
    assertEquals(tuple.tupleVersions.length, 2);
    assertEquals(tuple.currentAssertion?.assertion_id, 102);
    assertEquals(tuple.currentAssertion?.attr1, 'caat');

    // And the current query sees exactly the new value.
    assertEquals(currentEntryJSON(ws, 100).spelling.map((s: any) => s.text), ['caat']);
});

test("apply: a broken replaces chain is rejected", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    apply(ws, entry, spelling);

    const bad = mkEdit(spelling, 102, tl.next());
    bad.replaces_assertion_id = 999;  // not the current version
    assertThrows(() => ws.applyProposedAssertion(bad), Error, 'replaces_assertion_id chain broken');
});

test("apply: asserting into the past is rejected", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const t1 = tl.next(), t2 = tl.next();
    apply(ws, mkEntry(100, t2));
    assertThrows(() => ws.applyProposedAssertion(mkEntry(200, t1)),
                 Error, 'assert into the past');
});

test("apply: a second assertion at the SAME timestamp is rejected (known model limitation)", () => {
    // applyTransaction sidesteps this by allocating distinct timestamps per tx
    // group; this test documents the current workspace-level behaviour so a
    // change to it is a conscious one.
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const t = tl.next();
    apply(ws, mkEntry(100, t));
    assertThrows(() => ws.applyProposedAssertion(mkEntry(200, t)),
                 Error, 'assert into the past');
});

test("apply: valid_to must be END_OF_TIME or a tombstone", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const a = mkEntry(100, tl.next());
    a.valid_to = a.valid_from + 10;  // neither current nor tombstone
    assertThrows(() => ws.applyProposedAssertion(a), Error);
});

test("apply: delete via tombstone removes the tuple from the current view", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    apply(ws, entry, spelling);
    assertEquals(currentEntryJSON(ws, 100).spelling.length, 1);

    apply(ws, mkTombstone(spelling, 102, tl.next()));
    assertEquals(currentEntryJSON(ws, 100).spelling.length, 0);

    // The tuple itself still exists with its full history.
    const tuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(101);
    assertEquals(tuple.tupleVersions.length, 2);
    assertEquals(tuple.mostRecentTuple?.isCurrent, false);
});

test("apply: restore after delete starts a new valid period (undo of a delete)", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    apply(ws, entry, spelling);
    const tombstone = mkTombstone(spelling, 102, tl.next());
    apply(ws, tombstone);

    // Re-assert the old values over the tombstone.
    const restore = mkEdit(tombstone, 103, tl.next(), {attr1: 'cat'});
    restore.valid_to = timestamp.END_OF_TIME;
    const updatedPrev = ws.applyProposedAssertion(restore);

    // The tombstone is already closed: no predecessor update is needed.
    assertEquals(updatedPrev, undefined);
    assertEquals(currentEntryJSON(ws, 100).spelling.map((s: any) => s.text), ['cat']);
});

test("apply: restore must still chain through the tombstone", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    apply(ws, entry, spelling);
    apply(ws, mkTombstone(spelling, 102, tl.next()));

    // Chaining to the pre-delete version (not the tombstone) is refused -
    // nothing ever bypasses the chain.
    const bad = mkEdit(spelling, 103, tl.next());
    assertThrows(() => ws.applyProposedAssertion(bad), Error, 'replaces_assertion_id chain broken');
});

// ---------------------------------------------------------------------------
// --- untrackedApplyAssertion (the load-from-db path) ---------------------------
// ---------------------------------------------------------------------------

test("load: a contiguous edit chain loads", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    const editTime = tl.next();
    const edit = mkEdit(spelling, 102, editTime, {attr1: 'caat'});
    const closedSpelling = {...spelling, valid_to: editTime};   // as persisted

    load(ws, entry, closedSpelling, edit);
    assertEquals(currentEntryJSON(ws, 100).spelling.map((s: any) => s.text), ['caat']);
});

test("load: a valid-time GAP (a deletion period) loads", () => {
    // delete-then-restore persists as: v1 closed at t3, tombstone(t3..t3),
    // restore starting at t4 > t3.  The gap t3..t4 is the deleted period.
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    const t3 = tl.next();
    const tombstone = mkTombstone(spelling, 102, t3);
    const restore = mkEdit(tombstone, 103, tl.next(), {attr1: 'cat'});

    load(ws, entry, {...spelling, valid_to: t3}, tombstone, restore);
    assertEquals(currentEntryJSON(ws, 100).spelling.map((s: any) => s.text), ['cat']);
});

test("load: an OVERLAP (successor starting before predecessor ends) is rejected", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    const t3 = tl.next(), t4 = tl.next();
    const edit = mkEdit(spelling, 102, t3);

    load(ws, entry, {...spelling, valid_to: t4});  // closed AFTER the edit starts
    assertThrows(() => ws.untrackedApplyAssertion(edit), Error, 'valid_from chain broken');
});

test("load: a broken replaces chain is rejected", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    const editTime = tl.next();
    const edit = mkEdit(spelling, 102, editTime);
    edit.replaces_assertion_id = 999;

    load(ws, entry, {...spelling, valid_to: editTime});
    assertThrows(() => ws.untrackedApplyAssertion(edit), Error, 'replaces_assertion_id chain broken');
});

// ---------------------------------------------------------------------------
// --- The current view (queries) -----------------------------------------------
// ---------------------------------------------------------------------------

test("query: entry JSON has schema-mapped field names and nested relations", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat', variant: 'mm-li'});
    const sub = mkChild(entry, 'sub', 102, tl.next(), {attr1: 'n'});
    const gloss = mkChild(sub, 'gls', 103, tl.next(), {attr1: 'a cat'});
    apply(ws, entry, spelling, sub, gloss);

    // JSON round-trip drops undefined-valued fields (e.g. an unset variant),
    // matching what a client/export would actually see.
    const e = JSON.parse(JSON.stringify(currentEntryJSON(ws, 100)));
    assertEquals(e.entry_id, 100);
    assertEquals(e.spelling, [{spelling_id: 101, text: 'cat', variant: 'mm-li'}]);
    assertEquals(e.subentry.length, 1);
    assertEquals(e.subentry[0].part_of_speech, 'n');
    assertEquals(e.subentry[0].gloss, [{gloss_id: 103, gloss: 'a cat'}]);
});

test("query: relations sort by order_key regardless of insertion order", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const s1 = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'third', order_key: '0.7'});
    const s2 = mkChild(entry, 'spl', 102, tl.next(), {attr1: 'first', order_key: '0.2'});
    const s3 = mkChild(entry, 'spl', 103, tl.next(), {attr1: 'second', order_key: '0.5'});
    apply(ws, entry, s1, s2, s3);

    assertEquals(currentEntryJSON(ws, 100).spelling.map((s: any) => s.text),
                 ['first', 'second', 'third']);
});

test("query: a move (re-assert with new order_key) reorders the current view", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const s1 = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'a', order_key: '0.2'});
    const s2 = mkChild(entry, 'spl', 102, tl.next(), {attr1: 'b', order_key: '0.5'});
    apply(ws, entry, s1, s2);

    // Move 'a' after 'b'.
    apply(ws, mkEdit(s1, 103, tl.next(), {order_key: '0.7'}));
    assertEquals(currentEntryJSON(ws, 100).spelling.map((s: any) => s.text), ['b', 'a']);
});

test("query: toJSON(includeHistory) carries the prior versions", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    apply(ws, entry, spelling);
    apply(ws, mkEdit(spelling, 102, tl.next(), {attr1: 'caat'}));

    const tuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(101);
    const json = new CurrentTupleQuery(tuple).toJSON(true);
    assertEquals(json.text, 'caat');
    // History is the PRIOR versions; the current one is the record body.
    assertEquals(json.history.map((h: any) => h.text), ['cat']);
});

test("query: findNonDeletedChildTuples sees through to live descendants only", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const sub = mkChild(entry, 'sub', 101, tl.next());
    const gloss = mkChild(sub, 'gls', 102, tl.next(), {attr1: 'g'});
    apply(ws, entry, sub, gloss);

    const subTuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(101);
    assertEquals(subTuple.findNonDeletedChildTuples().length, 1);

    apply(ws, mkTombstone(gloss, 103, tl.next()));
    assertEquals(subTuple.findNonDeletedChildTuples().length, 0);
});

// ---------------------------------------------------------------------------
// --- Order-key generation over a live relation --------------------------------
// ---------------------------------------------------------------------------

test("orderkey generation: at-end, before and after land in the right slots", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    apply(ws, entry);
    const entryTuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(100);
    const relation = entryTuple.childRelations['spl'];

    // Empty relation: the standard fresh-range start.
    assertEquals(generateAtEndOrderKey(relation), orderkey.new_range_start_string);

    const s1 = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'a', order_key: generateAtEndOrderKey(relation)});
    apply(ws, s1);
    const endKey = generateAtEndOrderKey(relation);
    assert(orderkey.compareOrderKeys(s1.order_key, endKey) < 0, 'end key after existing');

    const s2 = mkChild(entry, 'spl', 102, tl.next(), {attr1: 'b', order_key: endKey});
    apply(ws, s2);

    const beforeS2 = generateBeforeOrderKey(relation, 102);
    assert(orderkey.compareOrderKeys(s1.order_key, beforeS2) < 0);
    assert(orderkey.compareOrderKeys(beforeS2, s2.order_key) < 0);

    const afterS1 = generateAfterOrderKey(relation, 101);
    assert(orderkey.compareOrderKeys(s1.order_key, afterS1) < 0);
    assert(orderkey.compareOrderKeys(afterS1, s2.order_key) < 0);
});

// ---------------------------------------------------------------------------
// --- Variant data survives the trip --------------------------------------------
// ---------------------------------------------------------------------------

test("variants: per-dialect facts live side by side on one relation", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const li = mkChild(entry, 'spl', 101, tl.next(), {attr1: "agase'wa'latl", variant: 'mm-li', order_key: '0.2'});
    const sf = mkChild(entry, 'spl', 102, tl.next(), {attr1: "akase'wa'latl", variant: 'mm-sf', order_key: '0.5'});
    apply(ws, entry, li, sf);

    const e = currentEntryJSON(ws, 100);
    assertEquals(e.spelling.map((s: any) => [s.text, s.variant]),
                 [["agase'wa'latl", 'mm-li'], ["akase'wa'latl", 'mm-sf']]);
});

// ---------------------------------------------------------------------------
// --- Audit pins (workspace-audit.md) -----------------------------------------
// ---------------------------------------------------------------------------
//
// These tests PIN behaviours called out by the audit - including current bugs
// and unenforced invariants - so the planned cleanup changes them consciously
// (the test updates in the same commit as the fix) rather than silently.

test("AUDIT 2.2 FIXED: path lookups never create; the apply path's variant does", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    apply(ws, mkEntry(100, tl.next()));
    const entryTuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(100);
    assertEquals(entryTuple.childRelations['sub'].tuples.size, 0);

    // A pure LOOKUP of a nonexistent path throws and plants nothing.
    assertThrows(() => ws.getVersionedTupleByPath([['dct', 0], ['ent', 100], ['sub', 999]]),
                 Error, 'no fact sub:999');
    assertEquals(entryTuple.childRelations['sub'].tuples.size, 0);
    assertEquals(entryTuple.findVersionedTupleById(999), undefined);

    // The apply-path variant creates (and registers the id).
    const created = ws.getOrCreateVersionedTupleByPath([['dct', 0], ['ent', 100], ['sub', 999]]);
    assertEquals(created.tupleVersions.length, 0);
    assertEquals(entryTuple.childRelations['sub'].tuples.size, 1);
    assertExists(ws.getTableByTag('dct').getTupleById(999));
});

test("AUDIT 2.1 FIXED: a duplicate fact id is rejected at apply time", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    apply(ws, entry);
    apply(ws, mkChild(entry, 'spl', 555, tl.next(), {attr1: 'cat'}));

    // Same fact id under a DIFFERENT relation: refused (ids are unique per
    // table - the editor's (entry_id, fact_id) addressing depends on it).
    assertThrows(() => ws.applyProposedAssertion(mkChild(entry, 'sub', 555, tl.next())),
                 Error, 'duplicate fact id 555');

    // Subsequent VERSIONS of the existing fact are of course still fine.
    const spelling = ws.getTableByTag('dct').findRequiredVersionedTupleById(555);
    apply(ws, mkEdit(spelling.currentAssertion!, 556, tl.next(), {attr1: 'caat'}));
    assertEquals(spelling.currentAssertion?.attr1, 'caat');

    // And id-based addressing stays unambiguous.
    assertEquals(ws.getTableByTag('dct').getTupleById(555), spelling);
});

test("AUDIT 1.2 FIXED: toJSON honours includeHistory regardless of call order", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    apply(ws, entry, spelling);
    apply(ws, mkEdit(spelling, 102, tl.next(), {attr1: 'caat'}));

    const tuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(101);
    const q = new CurrentTupleQuery(tuple);
    assertEquals(q.toJSON(false).history, undefined);
    // The same query object now honours the flag (and history is the PRIOR
    // versions only - the current one is the record body itself).
    assertEquals(q.toJSON(true).history.map((h: any) => h.text), ['cat']);
    assertEquals(q.toJSON(false).history, undefined);
});

test("lookup: missing ids are distinguishable from present ones", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    apply(ws, mkEntry(100, tl.next()));
    const entryTuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(100);
    assertEquals(entryTuple.findVersionedTupleById(9999), undefined);
    assertThrows(() => entryTuple.findRequiredVersionedTupleById(9999), Error,
                 'failed to find required versioned tuple');
});

test("query: order-key TIES at the relation level sort stably by fact id", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    // Deliberately inserted in reverse-id order, all with the same key.
    apply(ws, entry,
          mkChild(entry, 'spl', 103, tl.next(), {attr1: 'c', order_key: '0.5'}),
          mkChild(entry, 'spl', 101, tl.next(), {attr1: 'a', order_key: '0.5'}),
          mkChild(entry, 'spl', 102, tl.next(), {attr1: 'b', order_key: '0.5'}));
    assertEquals(currentEntryJSON(ws, 100).spelling.map((s: any) => s.text), ['a', 'b', 'c']);
});

test("deep tree: findNonDeletedChildTuples sees GRANDdescendants", () => {
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const sub = mkChild(entry, 'sub', 101, tl.next());
    const exa = mkChild(sub, 'exa', 102, tl.next());
    const etx = mkChild(exa, 'etx', 103, tl.next(), {attr1: 'deep text'});
    apply(ws, entry, sub, exa, etx);

    const subTuple = ws.getTableByTag('dct').findRequiredVersionedTupleById(101);
    // Both the child (exa) and the grandchild (etx) count as live descendants.
    assertEquals(subTuple.findNonDeletedChildTuples().length, 2);

    // Deleting the LEAF leaves the child still counted...
    apply(ws, mkTombstone(etx, 104, tl.next()));
    assertEquals(subTuple.findNonDeletedChildTuples().length, 1);
    // ...and the deep value is out of the current JSON.
    assertEquals(currentEntryJSON(ws, 100).subentry[0].example[0].example_text.length, 0);
});

test("ownership: the workspace returns the SAME prev-assertion object it stamped", () => {
    // AUDIT 2.4: closing the predecessor mutates the caller-visible object;
    // applyTransaction depends on receiving that same instance to persist its
    // valid_to.  Pin the aliasing so a clone-on-ingest change is conscious.
    const ws = newWorkspace();
    const tl = new TestTimeline();
    const entry = mkEntry(100, tl.next());
    const spelling = mkChild(entry, 'spl', 101, tl.next(), {attr1: 'cat'});
    ws.applyProposedAssertion(entry);
    ws.applyProposedAssertion(spelling);   // NOT cloned: we check aliasing

    const editTime = tl.next();
    const updatedPrev = ws.applyProposedAssertion(mkEdit(spelling, 102, editTime));
    assert(updatedPrev === spelling, 'stamped predecessor is the ingested object itself');
    assertEquals(spelling.valid_to, editTime);
});
