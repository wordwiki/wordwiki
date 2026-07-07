// Service/Sales are no longer top-level nav pages (activity is logged through
// events); their cross-event lists live under the Reports menu, with a home entry.
import { test } from "../liminal/testing/test.ts";
import { assert } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser } from "./testing.ts";
import { findAll, attr, hasText } from "../liminal/testing/markup-assert.ts";
import { navBar } from "./templates.ts";

const anchors = (nav: any, cls: string): string[] =>
    findAll(nav, (m: any) => Array.isArray(m) && m[0] === 'a'
             && String(m[1]?.class ?? '').split(/\s+/).includes(cls))
        .map((a: any) => String(attr(a, 'href')));

test("Service/Sales are not top-level nav links, but ARE Reports dropdown items", () => {
    const nav = navBar(false, false, /*isHostOrAdmin*/ true);
    const topLevel = anchors(nav, 'nav-link');
    assert(!topLevel.includes('/service'), 'no top-level Service link');
    assert(!topLevel.includes('/sales'), 'no top-level Sales link');

    const reports = anchors(nav, 'dropdown-item');
    assert(reports.includes('/service'), 'Services under Reports');
    assert(reports.includes('/sales'), 'Sales under Reports');
    assert(reports.includes('/activityReport'), 'Volunteer Activity Report under Reports');
});

test("the home page carries a Reports entry point", async () => {
    await withTestDb(async ({ bob }) => {
        const page = await asUser(bob, () => renderRoute(`home`));
        assert(hasText(page, 'Reports'));
        const links = anchors(page, 'nav-link').concat(
            findAll(page, (m: any) => Array.isArray(m) && m[0] === 'a')
                .map((a: any) => String(attr(a, 'href'))));
        assert(links.includes('/service'), 'home links to the Services report');
        assert(links.includes('/sales'), 'home links to the Sales report');
        assert(links.includes('/activityReport'), 'home links to the activity report');
    });
});
