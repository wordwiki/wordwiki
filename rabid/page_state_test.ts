// deno-lint-ignore-file no-explicit-any
// The page-state pattern in rabid (liminal/page-state.md): view state rides in
// the route expression as a `{}` argument decoded by a FieldSet.  Covers the
// volunteer.search filter (navigation) and the Time-view section
// (hx-replace-url depth toggle), plus the strict date route-literal codecs.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, invoke } from "./testing.ts";
import { rabid } from "./rabid.ts";
import { volunteerQuery, type VolunteerQuery } from "./volunteer.ts";
import { timeViewQuery } from "./volunteer_time.ts";
import { DateField, DateTimeField } from "../liminal/table.ts";
import { find, attr, tagOf } from "../liminal/testing/markup-assert.ts";

// --- volunteerQuery: the codec ------------------------------------------------

test("volunteerQuery.literal omits defaults; equal views get equal (shortest) URLs", () => {
    const norm = (q: any) => volunteerQuery.normalize(q) as VolunteerQuery;
    // The common view (no term, current roster) canonicalizes to '{}'.
    assertEquals(volunteerQuery.literal(norm({})), '{}');
    assertEquals(volunteerQuery.literal(norm({text: '', include_archived: false})), '{}');
    // Non-defaults ride, defaults drop (include_archived:false is never emitted).
    assertEquals(volunteerQuery.literal(norm({text: 'Dav'})), '{text:"Dav"}');
    assertEquals(volunteerQuery.literal(norm({include_archived: true})),
                 '{include_archived:true}');
    assertEquals(volunteerQuery.literal(norm({text: 'Dav', include_archived: true})),
                 '{text:"Dav",include_archived:true}');
    // Round-trip: normalize ∘ literal-shaped input is identity in value.
    assertEquals(norm({text: 'x', include_archived: true}),
                 {text: 'x', include_archived: true});
});

test("volunteerQuery.normalize rejects unknown keys and mistyped values", () => {
    assertThrows(() => volunteerQuery.normalize({nope: 1}), Error, 'unknown fields');
    assertThrows(() => volunteerQuery.normalize({text: 5}), Error, 'expected a string');
    assertThrows(() => volunteerQuery.normalize({include_archived: 'yes'}),
                 Error, 'expected true or false');
});

// --- volunteer.search / applySearch: the navigation loop ----------------------

test("applySearch turns the filter form into a canonical navigate URL", async () => {
    await withTestDb(async ({ dave }) => {
        // A checked box + a term -> canonical URL with the term and the flag.
        const withFlag = await asUser(dave, () =>
            invoke(`rabid.volunteer.applySearch($arg0)`, {text: 'Haz', include_archived: 'on'}));
        assertEquals(withFlag, {action: 'navigate',
                                url: '/rabid.volunteer.search({text:"Haz",include_archived:true})'});
        // Empty form -> the shortest canonical URL (defaults omitted).
        const empty = await asUser(dave, () => invoke(`rabid.volunteer.applySearch($arg0)`, {}));
        assertEquals(empty, {action: 'navigate', url: '/rabid.volunteer.search({})'});
    });
});

test("the search dialog is built from volunteerQuery.fields and dispatches applySearch", async () => {
    await withTestDb(async ({ dave }) => {
        const dialog = await asUser(dave, () =>
            renderRoute(`rabid.volunteer.searchDialog({text:"Dav", include_archived:true})`));
        // Prefilled from the current search (checkbox checked, text input value).
        const checkbox = find(dialog, n => tagOf(n) === 'input' && attr(n, 'name') === 'include_archived');
        assertEquals(attr(checkbox!, 'checked'), '');
        const textInput = find(dialog, n => tagOf(n) === 'input' && attr(n, 'name') === 'text');
        assertEquals(attr(textInput!, 'value'), 'Dav');
        // Server-side dispatch, not the retired client lmNavigateFormRoute.
        const form = find(dialog, n => tagOf(n) === 'form');
        assertStringIncludes(String(attr(form!, 'onsubmit')), 'rabid.volunteer.applySearch');
    });
});

// --- timeViewQuery + the detail page depth toggles ----------------------------

test("timeViewQuery canonicalizes both flags; the collapsed view is '{}'", () => {
    const norm = (q: any) => timeViewQuery.normalize(q);
    assertEquals(timeViewQuery.literal(norm({})), '{}');
    assertEquals(timeViewQuery.literal(norm({all_weeks: true})), '{all_weeks:true}');
    assertEquals(timeViewQuery.literal(norm({orphan_tasks: true, all_weeks: true})),
                 '{orphan_tasks:true,all_weeks:true}');
});

test("Time-view toggles swap the fragment AND replace the page URL with the flipped view", async () => {
    await withTestDb(async ({ bob }) => {
        const frag = await asUser(bob, () =>
            renderRoute(`rabid.volunteer_time.renderForVolunteer(${bob},{orphan_tasks:true})`));
        // The orphans toggle (currently ON) offers to turn it OFF: its hx-get
        // re-renders the fragment without the flag, and hx-replace-url points
        // the browser at the detail PAGE with the flipped view.
        const offBtn = find(frag, n => tagOf(n) === 'button'
            && String(attr(n, 'hx-get') ?? '').includes('renderForVolunteer')
            && String(attr(n, 'hx-replace-url') ?? '').includes('detailPage'));
        assert(!!offBtn, 'a toggle carries both hx-get and hx-replace-url');
        // Turning orphans off -> the flag drops from BOTH URLs (canonical).
        assertStringIncludes(String(attr(offBtn!, 'hx-get')),
                             `renderForVolunteer(${bob},{})`);
        assertStringIncludes(String(attr(offBtn!, 'hx-replace-url')),
                             `/rabid.volunteer.detailPage(${bob},{})`);
    });
});

test("detailPage threads the Time-view arg into the embedded fragment (bookmark reproduces it)", async () => {
    await withTestDb(async ({ bob }) => {
        const page = await asUser(bob, () =>
            renderRoute(`rabid.volunteer.detailPage(${bob},{all_weeks:true})`));
        // The detail fragment's own reload URL carries the view, so a
        // record-edit reload preserves the expanded Time view.
        const detail = find(page, n => typeof attr(n, 'hx-get') === 'string'
            && String(attr(n, 'hx-get')).includes('renderDetail'));
        assertStringIncludes(String(attr(detail!, 'hx-get')),
                             `renderDetail(${bob},{all_weeks:true})`);
    });
});

// --- strict date route literals (liminal/table.ts) ----------------------------

test("DateField/DateTimeField.fromLiteral accept valid values and reject junk", () => {
    // Validation is STRUCTURAL (matches parseSimpleInput, so a URL date and a
    // form date agree) - it guards shape, not calendar validity.
    const d = new DateField('d');
    assertEquals(d.fromLiteral('2026-02-19'), '2026-02-19');
    for(const bad of ['DROP TABLE', '2026-2-9', '2026/02/19', '20260219', 12345, true])
        assertThrows(() => d.fromLiteral(bad as any), Error);

    const dt = new DateTimeField('dt');
    assertEquals(dt.fromLiteral('2026-02-19 09:32:00'), '2026-02-19 09:32:00');
    assertEquals(dt.fromLiteral('2026-02-19T09:32'), '2026-02-19 09:32:00');  // 'T' + no seconds
    for(const bad of ['2026-02-19', 'nope', '2026-02-19 9:32', 99])
        assertThrows(() => dt.fromLiteral(bad as any), Error);
});
