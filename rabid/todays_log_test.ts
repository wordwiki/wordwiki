// "Today's Ad-hoc" entry point: materialises the day's Ad-hoc catch-all on demand
// (host/admin only) and renders it; the nav link is host/admin-gated.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem } from "./testing.ts";
import { hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";
import { navBar } from "./templates.ts";
import * as date from "../liminal/date.ts";

test("todaysLog materialises today's catch-all and renders it (host)", async () => {
    await withTestDb(async ({ alice }) => {
        // Nothing there yet.
        assertEquals(asSystem(() => rabid.event.catchAllForToday(false)), undefined);

        const page = await asUser(alice, () => renderRoute(`todaysLog`));
        assert(hasText(page, 'Ad-hoc'));       // titled by its day
        assert(hasText(page, 'Activity'));      // the log section

        // The catch-all now exists, for today's org day.
        const today = date.temporalToSqliteDate(date.orgToday());
        const id = asSystem(() => rabid.event.catchAllForToday(false));
        assert(id !== undefined);
        assertEquals(asSystem(() => rabid.event.getById(id!).catch_all_date), today);
    });
});

test("todaysLog reuses the same catch-all on repeat visits (1-1 per day)", async () => {
    await withTestDb(async ({ alice }) => {
        await asUser(alice, () => renderRoute(`todaysLog`));
        const first = asSystem(() => rabid.event.catchAllForToday(false));
        await asUser(alice, () => renderRoute(`todaysLog`));
        const second = asSystem(() => rabid.event.catchAllForToday(false));
        assertEquals(first, second);
    });
});

test("a regular volunteer may not open Today's Ad-hoc (and none is created)", async () => {
    await withTestDb(async ({ bob }) => {
        await asUser(bob, () => assertRejects(() => renderRoute(`todaysLog`)));
        assertEquals(asSystem(() => rabid.event.catchAllForToday(false)), undefined);
    });
});

test("the nav link shows for host/admin, not for a regular volunteer", () => {
    assert(hasText(navBar(false, false, /*isHostOrAdmin*/ true), "Today's Ad-hoc"));
    assert(!hasText(navBar(false, false, /*isHostOrAdmin*/ false), "Today's Ad-hoc"));
});
