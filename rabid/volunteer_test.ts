// Field-level privacy + edit-permission behaviour, captured as render→act→render
// tests that run the system as a library (no HTTP, no browser).
//
//   fixture: alice=host(hides own phone)  bob=regular(shares)  carol=regular(private)  dave=admin
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asAnon, asSystem } from "./testing.ts";
import { rabid } from "./rabid.ts";
import { getByTestId, text, hasText, find, byClass, tagOf, attr } from "../liminal/testing/markup-assert.ts";

const detail = (id: number) => renderRoute(`rabid.volunteer.detailPage(${id})`);
const phoneText = (markup: any) => text(getByTestId(markup, "detail-phone")).trim();
const emailText = (markup: any) => text(getByTestId(markup, "detail-email")).trim();

test("a shared phone is shown, a private phone is redacted (regular viewer)", async () => {
    await withTestDb(async ({ bob, carol }) => {
        // Bob shares his phone -> Carol (a regular volunteer) sees the number.
        assertStringIncludes(phoneText(await asUser(carol, () => detail(bob))), "(555) 222-2222");
        // Carol hides hers -> Bob sees '***'.
        assertEquals(phoneText(await asUser(bob, () => detail(carol))), "***");
    });
});

test("a host sees a private phone that a regular volunteer cannot", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        assertStringIncludes(phoneText(await asUser(alice, () => detail(carol))), "(555) 333-3333"); // host
        assertEquals(phoneText(await asUser(bob, () => detail(carol))), "***");                       // regular
    });
});

test("you can always see your own private fields", async () => {
    await withTestDb(async ({ carol }) => {
        const own = await asUser(carol, () => detail(carol));
        assertStringIncludes(phoneText(own), "(555) 333-3333");
        assertStringIncludes(emailText(own), "carol@test.example");
    });
});

test("email is opt-out: shared by default, redacted when the owner hides it", async () => {
    await withTestDb(async ({ bob, carol }) => {
        // Bob shares email (default) -> a regular viewer sees it.
        assertStringIncludes(emailText(await asUser(carol, () => detail(bob))), "bob@test.example");
        // Carol opted her email out -> redacted to a regular viewer.
        assertEquals(emailText(await asUser(bob, () => detail(carol))), "***");
    });
});

test("emergency contact is host/self only", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const emergency = (m: any) => text(getByTestId(m, "detail-emergency")).trim();
        assertEquals(emergency(await asUser(bob, () => detail(carol))), "***");           // regular: hidden
        assertStringIncludes(emergency(await asUser(carol, () => detail(carol))), "Pat Okafor"); // self
        assertStringIncludes(emergency(await asUser(alice, () => detail(carol))), "Pat Okafor"); // host
    });
});

test("admin sees everything; the list redacts per-row for a regular viewer", async () => {
    await withTestDb(async ({ bob, carol, dave }) => {
        const adminList = await asUser(dave, () => renderRoute(`rabid.volunteer.renderVolunteerList("", false)`));
        assertStringIncludes(text(getByTestId(adminList, `volunteer-${carol}-email`)), "carol@test.example");

        const regularList = await asUser(bob, () => renderRoute(`rabid.volunteer.renderVolunteerList("", false)`));
        assertEquals(text(getByTestId(regularList, `volunteer-${carol}-email`)).trim(), "***"); // opted out
        assertStringIncludes(text(getByTestId(regularList, `volunteer-${bob}-email`)), "bob@test.example"); // default-shared
    });
});

test("the list view never shows phone numbers, even to an admin (detail-page-only)", async () => {
    await withTestDb(async ({ dave }) => {
        const adminList = await asUser(dave, () => renderRoute(`rabid.volunteer.renderVolunteerList("", false)`));
        assert(!text(adminList).includes("(555)")); // fixture phones are all (555) ...
    });
});

// --- Row-level edit security (recordEdit): which row species does each viewer
// --- get, and are renderForm/saveForm gated server-side to match?

const listFor = () => renderRoute(`rabid.volunteer.renderVolunteerList("", false)`);
const rowIn = (list: any, id: number) => getByTestId(list, `volunteer-row-${id}`);
const hasPencil = (list: any, id: number) => !!find(rowIn(list, id), byClass("lm-edit-pencil"));

test("the pencil (and tap-to-edit) renders only on rows the viewer may edit", async () => {
    await withTestDb(async ({ alice, bob, carol, dave }) => {
        const bobList = await asUser(bob, listFor);
        assert(hasPencil(bobList, bob));     // own row: editable surface
        assert(!hasPencil(bobList, carol));  // someone else's: not for a regular volunteer

        const aliceList = await asUser(alice, listFor);
        assert(hasPencil(aliceList, carol)); // host: edits anyone

        const daveList = await asUser(dave, listFor);
        assert(hasPencil(daveList, carol));  // admin: edits anyone
    });
});

test("a non-editable row is a navigable item: an <a> to the detail page, with a chevron", async () => {
    await withTestDb(async ({ bob, carol }) => {
        const row = rowIn(await asUser(bob, listFor), carol);
        assertEquals(tagOf(row), "a");
        assertStringIncludes(String(attr(row, "href")), `detailPage(${carol})`);
        assert(!!find(row, byClass("lm-nav-chevron")));
        // and the editable species is not an anchor
        const own = rowIn(await asUser(bob, listFor), bob);
        assertEquals(tagOf(own), "div");
    });
});

test("renderForm is row-gated: you cannot even generate a form for a record you may not edit", async () => {
    await withTestDb(async ({ bob, carol }) => {
        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.volunteer.renderForm(rabid.volunteer.getById(${carol}))`),
            Error, "Not permitted to edit this volunteer"));
        // but your own form renders fine
        await asUser(bob, () => renderRoute(`rabid.volunteer.renderForm(rabid.volunteer.getById(${bob}))`));
    });
});

test("saveForm is row-gated before the per-field check (host may, regular may not)", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.volunteer.saveForm($arg0)", {
                volunteer_id: String(carol), skills: "crafted", "before-skills": "",
            }),
            Error, "Not permitted to edit this volunteer"));

        // alice is a host: same edit goes through.
        const res = await asUser(alice, () => invoke("rabid.volunteer.saveForm($arg0)", {
            volunteer_id: String(carol), skills: "host-assigned", "before-skills": "",
        }));
        assertEquals(res.action, "reload");
    });
});

test("an anonymous viewer cannot read volunteer records (non-redactable field throws)", async () => {
    await withTestDb(async ({ bob }) => {
        await asAnon(() => assertRejects(() => detail(bob)));
    });
});

// --- The search page (rabid.volunteer.search({text, only_active})) ----------

test("search matches name-word/email prefixes case-insensitively, and filters by only_active", async () => {
    await withTestDb(async ({ alice, bob, carol, dave }) => {
        // Mark carol inactive so the only_active filter has something to filter.
        asSystem(() => rabid.volunteer.updateNamedFields(carol, ["inactive"], {inactive: 1}));

        // Case-insensitive prefix on a name word ('private' matches 'Carol Private'),
        // only_active:false includes the inactive carol...
        const all = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"private", only_active:false})`));
        assert(hasText(all, "Carol Private"));
        assert(hasText(all, "1 volunteer(s) matching"));

        // ...and the default (only_active absent -> true) excludes her.
        const active = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"private"})`));
        assert(!hasText(active, "Carol Private"));
        assert(hasText(active, "0 active volunteer(s) matching"));

        // Email prefix works too.
        const byEmail = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"BOB@"})`));
        assert(hasText(byEmail, "Bob Shares"));
    });
});

test("the search page's dialog pre-populates with the current search (refinement)", async () => {
    await withTestDb(async ({ dave }) => {
        const dialog = await asUser(dave, () =>
            renderRoute(`rabid.volunteer.searchDialog({text:"Dav", only_active:false})`));
        const textInput = find(dialog, n => tagOf(n) === "input" && attr(n, "name") === "text");
        assertEquals(attr(textInput!, "value"), "Dav");
        const checkbox = find(dialog, n => tagOf(n) === "input" && attr(n, "name") === "only_active");
        assertEquals(attr(checkbox!, "checked"), undefined); // only_active:false -> unchecked
        // and the page's own Search button carries the current search into the dialog url
        const page = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"Dav", only_active:false})`));
        const btn = find(page, n => tagOf(n) === "button" && String(attr(n, "hx-get") ?? "").includes("searchDialog"));
        assertStringIncludes(String(attr(btn!, "hx-get")), `{text:"Dav",only_active:false}`);
    });
});

test("a crafted edit of a field you may not edit is rejected at save", async () => {
    await withTestDb(async ({ alice, bob }) => {
        // The row gate passes (own record / host) - the FIELD gate must still
        // hold: `permissions` (role management) is admin-only to edit.
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.volunteer.saveForm($arg0)", {
                volunteer_id: String(bob), permissions: "admin", "before-permissions": "",
            }),
            Error, "Not permitted to edit",
        ));
        await asUser(alice, () => assertRejects(   // a host is not an admin either
            () => invoke("rabid.volunteer.saveForm($arg0)", {
                volunteer_id: String(bob), permissions: "admin", "before-permissions": "",
            }),
            Error, "Not permitted to edit",
        ));
    });
});

test("a volunteer can edit their own field (render → act → render)", async () => {
    await withTestDb(async ({ carol }) => {
        const before = await asUser(carol, () => detail(carol));
        assertEquals(text(getByTestId(before, "detail-skills")).trim(), "—"); // empty initially

        const res = await asUser(carol, () => invoke("rabid.volunteer.saveForm($arg0)", {
            volunteer_id: String(carol), skills: "welding", "before-skills": "",
        }));
        assertEquals(res.action, "reload");

        const after = await asUser(carol, () => detail(carol));
        assert(hasText(getByTestId(after, "detail-skills"), "welding"));
    });
});
