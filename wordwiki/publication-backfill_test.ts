// deno-lint-ignore-file no-explicit-any
/**
 * The Phase 0 born-approved backfill (publication-backfill.ts): stamps
 * published_* onto the current live fact of EVERY chain - whatever the entry's
 * status (the cutover blesses the whole offline-approved accepted state) -
 * skipping tombstones and comments, mute-in-place and idempotently.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, type Fixture } from "./testing.ts";
import { backfillPublication } from "./publication-backfill.ts";
import { clearLegacyPublishedPlaceholder } from "./repair-assertions.ts";
import { db } from "../liminal/db.ts";
import * as timestamp from "../liminal/timestamp.ts";

const EOT = timestamp.END_OF_TIME;
const BOT = timestamp.BEGINNING_OF_TIME;
const T = 300_000_000_000_000; // a real-ish timestamp, well above BEGINNING_OF_TIME

function ins(f: Record<string, any>): void {
    db().insert("dict", { ty0: "dct", valid_from: T, valid_to: EOT, order_key: "0.5", ...f }, "assertion_id");
}
const pub = (a: number) =>
    db().required<{ pf: number | null; pt: number | null }, { a: number }>(
        "SELECT published_from AS pf, published_to AS pt FROM dict WHERE assertion_id = :a", { a });

test("backfill: born-approves every entry's live facts, skips tombstones, idempotent", () => {
    return withTestDb((_fx: Fixture) => {
        // Entry 100 — Completed: entry fact, status, a live spelling, a tombstone.
        ins({ assertion_id: 1, id: 100, ty: "ent", ty1: "ent", id1: 100, attr1: "water" });
        ins({ assertion_id: 2, id: 101, ty: "sta", ty1: "ent", id1: 100, ty2: "sta", id2: 101, attr1: "Completed" });
        ins({ assertion_id: 3, id: 102, ty: "spl", ty1: "ent", id1: 100, ty2: "spl", id2: 102, attr1: "samqwan" });
        ins({ assertion_id: 4, id: 103, ty: "spl", ty1: "ent", id1: 100, ty2: "spl", id2: 103, valid_to: T, attr1: "deleted" }); // tombstone
        // Entry 200 — InProgress: still blessed (offline-approved work, not public).
        ins({ assertion_id: 5, id: 200, ty: "ent", ty1: "ent", id1: 200, attr1: "pending" });
        ins({ assertion_id: 6, id: 201, ty: "sta", ty1: "ent", id1: 200, ty2: "sta", id2: 201, attr1: "InProgress" });
        ins({ assertion_id: 7, id: 202, ty: "spl", ty1: "ent", id1: 200, ty2: "spl", id2: 202, attr1: "foo" });
        // Entry 300 — Archived: also blessed.
        ins({ assertion_id: 8, id: 300, ty: "ent", ty1: "ent", id1: 300, attr1: "old" });
        ins({ assertion_id: 9, id: 301, ty: "sta", ty1: "ent", id1: 300, ty2: "sta", id2: 301, attr1: "Archived" });
        // A fact under entry 100 whose current version is a comment (never published).
        ins({ assertion_id: 10, id: 104, ty: "spl", ty1: "ent", id1: 100, ty2: "spl", id2: 104,
              attr1: "samqwan", change_action: "comment" });

        const stats = backfillPublication();
        // Every entry's live, non-comment facts: 100 (ent+sta+spl=3) + 200 (3) +
        // 300 (ent+sta=2) = 8.  Tombstone and comment skipped.
        assertEquals(stats.bornApproved, 8);

        // Completed entry 100: live facts stamped (published_from = valid_from = T).
        assertEquals(pub(1), { pf: T, pt: EOT });     // entry fact
        assertEquals(pub(3), { pf: T, pt: EOT });     // spelling
        assertEquals(pub(4), { pf: null, pt: null }); // tombstone NOT stamped
        assertEquals(pub(10), { pf: null, pt: null }); // comment NOT stamped
        // InProgress entry 200: now stamped too (approved-but-not-public).
        assertEquals(pub(5), { pf: T, pt: EOT });
        assertEquals(pub(7), { pf: T, pt: EOT });
        // Archived entry 300: stamped.
        assertEquals(pub(8), { pf: T, pt: EOT });

        // Idempotent: a re-run changes nothing.
        assertEquals(backfillPublication(), { bornApproved: 0 });
    });
});

test("clearLegacyPublishedPlaceholder: clears the 2020 placeholder, idempotent", () => {
    return withTestDb((_fx: Fixture) => {
        // A placeholder row (published forever from 2020) and a real published row.
        ins({ assertion_id: 1, id: 100, ty: "ent", ty1: "ent", id1: 100, attr1: "ph",
              published_from: BOT, published_to: EOT });
        ins({ assertion_id: 2, id: 200, ty: "ent", ty1: "ent", id1: 200, attr1: "real",
              published_from: T, published_to: EOT });
        assertEquals(clearLegacyPublishedPlaceholder(), 1);
        assertEquals(pub(1), { pf: null, pt: null }); // placeholder cleared
        assertEquals(pub(2), { pf: T, pt: EOT });      // real publication untouched
        assertEquals(clearLegacyPublishedPlaceholder(), 0); // idempotent
    });
});

test("clearLegacyPublishedPlaceholder: never clobbers a born-approved BOT fact", () => {
    return withTestDb((_fx: Fixture) => {
        // A born-approved fact whose valid_from IS BEGINNING_OF_TIME: published_from
        // = valid_from = BOT - byte-identical to a placeholder, but legitimate.
        // With no VIOLATING placeholder present, the clear must not touch it.
        ins({ assertion_id: 1, id: 100, ty: "ent", ty1: "ent", id1: 100, attr1: "old",
              valid_from: BOT, published_from: BOT, published_to: EOT });
        assertEquals(clearLegacyPublishedPlaceholder(), 0);
        assertEquals(pub(1), { pf: BOT, pt: EOT }); // untouched
    });
});

test("backfill: a fact already under publication management is never re-stamped", () => {
    return withTestDb((_fx: Fixture) => {
        // A fact whose OLD version is still published-current (a pending edit
        // awaiting review): stamping the new version would double-publish AND
        // silently approve the edit.
        ins({ assertion_id: 20, id: 400, ty: "spl", ty1: "ent", id1: 400,
              valid_to: T + 10, published_from: T, published_to: EOT, attr1: "old" });
        ins({ assertion_id: 21, id: 400, ty: "spl", ty1: "ent", id1: 400,
              replaces_assertion_id: 20, valid_from: T + 10, attr1: "edited-pending" });
        // A genuinely unblessed fact (no published version anywhere): stamped.
        ins({ assertion_id: 22, id: 401, ty: "spl", ty1: "ent", id1: 401, attr1: "fresh" });

        const stats = backfillPublication();
        assertEquals(stats.bornApproved, 1);
        assertEquals(pub(21), { pf: null, pt: null });        // pending edit untouched
        assertEquals(pub(20), { pf: T, pt: EOT });            // old truth still current
        assertEquals(pub(22), { pf: T, pt: EOT });            // fresh fact blessed
    });
});

test("backfill: the config marker makes a second run a hard no-op", () => {
    return withTestDb((_fx: Fixture) => {
        const store = new Map<string, string>();
        const config = { get: (k: string) => store.get(k), set: (k: string, v: string) => { store.set(k, v); } };

        ins({ assertion_id: 30, id: 500, ty: "spl", ty1: "ent", id1: 500, attr1: "one" });
        const first = backfillPublication({ config });
        assertEquals(first.bornApproved, 1);
        assertEquals(typeof store.get('publication-backfill-done'), 'string');

        // New (pending) work appears after Phase 0; a re-run must NOT bless it.
        ins({ assertion_id: 31, id: 501, ty: "spl", ty1: "ent", id1: 501, attr1: "pending-new" });
        const second = backfillPublication({ config });
        assertEquals(second.bornApproved, 0);
        assertEquals(second.skippedByMarker, true);
        assertEquals(pub(31), { pf: null, pt: null });
    });
});
