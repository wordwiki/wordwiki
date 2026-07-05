// Field-level privacy + edit-permission behaviour, captured as render→act→render
// tests that run the system as a library (no HTTP, no browser).
//
//   fixture: alice=host(hides own phone)  bob=regular(shares)  carol=regular(private)  dave=admin
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asAnon, asSystem } from "./testing.ts";
import { rabid } from "./rabid.ts";
import { getByTestId, text, hasText, find, byClass, tagOf, attr } from "../liminal/testing/markup-assert.ts";
import { shortName } from "./volunteer.ts";

test("shortName: curated short_name wins; else the first word; blank/whitespace falls back", () => {
    assertEquals(shortName({name: "Bob Shares"}), "Bob");                            // no short_name -> first word
    assertEquals(shortName({name: "Bob Shares", short_name: "Bobby Q"}), "Bobby Q"); // curated wins (not first word)
    assertEquals(shortName({name: "Cher", short_name: ""}), "Cher");                 // empty -> whole name
    assertEquals(shortName({name: "Ada Lovelace", short_name: "  "}), "Ada");        // whitespace-only -> first word
});

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

test("admin sees everything; the detail page redacts email per-viewer", async () => {
    await withTestDb(async ({ bob, carol, dave }) => {
        // Email is a detail-page field now (the list shows skills & interests).
        assertStringIncludes(text(getByTestId(await asUser(dave, () => detail(carol)), "detail-email")),
                             "carol@test.example");
        assertEquals(text(getByTestId(await asUser(bob, () => detail(carol)), "detail-email")).trim(),
                     "***");   // carol opted out; a regular viewer sees it redacted
        assertStringIncludes(text(getByTestId(await asUser(bob, () => detail(bob)), "detail-email")),
                             "bob@test.example");   // own record
    });
});

test("the list view shows no email or phone (both detail-page-only)", async () => {
    await withTestDb(async ({ bob, dave }) => {
        const adminList = await asUser(dave, () => renderRoute(`rabid.volunteer.renderVolunteerList("", false)`));
        assert(!text(adminList).includes("(555)"));                   // fixture phones are all (555) ...
        assert(!text(adminList).includes("bob@test.example"));        // emails are not in the list either
    });
});

// --- Row-level edit security (recordEdit): which row species does each viewer
// --- get, and are renderForm/saveForm gated server-side to match?

const listFor = () => renderRoute(`rabid.volunteer.renderVolunteerList("", false)`);
const rowIn = (list: any, id: number) => getByTestId(list, `volunteer-row-${id}`);
const hasPencil = (list: any, id: number) => !!find(rowIn(list, id), byClass("lm-edit-pencil"));

test("the list carries no edit affordance - not even for a host/admin (edit from the detail page)", async () => {
    await withTestDb(async ({ alice, bob, dave }) => {
        // No per-row pencil for anyone; whole-record fields are edited from the
        // volunteer's own detail page (design-language.md).
        assert(!hasPencil(await asUser(bob, listFor), bob));     // not even one's own row
        assert(!hasPencil(await asUser(alice, listFor), bob));   // host
        assert(!hasPencil(await asUser(dave, listFor), bob));    // admin
    });
});

test("'Add new volunteer' is host/admin-only: in the ☰ for them, and the dialog is server-gated", async () => {
    await withTestDb(async ({ bob, dave }) => {
        // The ☰ (on the page title) offers the create item to an admin, who can
        // open the dialog.
        const pageFor = () => renderRoute(`rabid.volunteer.search({})`);
        assert(hasText(await asUser(dave, pageFor), 'Add new volunteer'));
        await asUser(dave, () => renderRoute('rabid.volunteer.newDialog()'));   // no throw
        // A regular volunteer gets neither the item nor the dialog.
        assert(!hasText(await asUser(bob, pageFor), 'Add new volunteer'));
        await asUser(bob, () => assertRejects(() => renderRoute('rabid.volunteer.newDialog()'), Error));
    });
});

test("every row is the same navigable species: tap drills in, regardless of edit permission", async () => {
    await withTestDb(async ({ bob, carol }) => {
        const list = await asUser(bob, listFor);
        for (const id of [bob, carol]) {        // own (editable) and someone else's (not)
            const row = rowIn(list, id);
            assertEquals(tagOf(row), "tr");   // a data-table row (uniform records scan better)
            assertEquals(attr(row, "onclick"), "lmNavigableClick(event)"); // whole surface navigates
            const link = find(row, byClass("lm-nav-link"));               // the delegation target
            assert(link);
            assertStringIncludes(String(attr(link, "href")), `detailPage(${id})`);
        }
        // tapping a row never opens the edit dialog - the old tap-to-edit
        // species (lm-editable) is gone from this list
        assert(!find(list, byClass("lm-editable")));
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
                volunteer_id: String(carol), skills_and_interests: "crafted", "before-skills_and_interests": "",
            }),
            Error, "Not permitted to edit this volunteer"));

        // alice is a host: same edit goes through.
        const res = await asUser(alice, () => invoke("rabid.volunteer.saveForm($arg0)", {
            volunteer_id: String(carol), skills_and_interests: "host-assigned", "before-skills_and_interests": "",
        }));
        assertEquals(res.action, "reload");
    });
});

test("an anonymous viewer cannot read volunteer records (non-redactable field throws)", async () => {
    await withTestDb(async ({ bob }) => {
        await asAnon(() => assertRejects(() => detail(bob)));
    });
});

// --- The search page (rabid.volunteer.search({text, include_archived})) -----

test("search matches name-word/email prefixes case-insensitively, and filters by include_archived", async () => {
    await withTestDb(async ({ alice, bob, carol, dave }) => {
        // Archive carol so the include_archived filter has something to filter.
        asSystem(() => rabid.volunteer.updateNamedFields(carol, ["archived"], {archived: 1}));

        // Case-insensitive prefix on a name word ('private' matches 'Carol Private'),
        // include_archived:true includes the archived carol...
        const all = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"private", include_archived:true})`));
        assert(hasText(all, "Carol Private"));
        assert(hasText(all, "1 volunteer matching"));   // proper singular, no machine "(s)"

        // ...and the default (include_archived absent -> false) excludes her.
        const current = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"private"})`));
        assert(!hasText(current, "Carol Private"));
        assert(hasText(current, "0 current volunteers matching"));   // 0 is plural in English

        // Email prefix works too.
        const byEmail = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"BOB@"})`));
        assert(hasText(byEmail, "Bob Shares"));
    });
});

test("the search page's dialog pre-populates with the current search (refinement)", async () => {
    await withTestDb(async ({ dave }) => {
        const dialog = await asUser(dave, () =>
            renderRoute(`rabid.volunteer.searchDialog({text:"Dav", include_archived:true})`));
        const textInput = find(dialog, n => tagOf(n) === "input" && attr(n, "name") === "text");
        assertEquals(attr(textInput!, "value"), "Dav");
        const checkbox = find(dialog, n => tagOf(n) === "input" && attr(n, "name") === "include_archived");
        assertEquals(attr(checkbox!, "checked"), ""); // include_archived:true -> checked
        // and the page's own search menu carries the current search into the dialog url
        const page = await asUser(dave, () => renderRoute(`rabid.volunteer.search({text:"Dav", include_archived:true})`));
        const btn = find(page, n => tagOf(n) === "button" && String(attr(n, "hx-get") ?? "").includes("searchDialog"));
        assertStringIncludes(String(attr(btn!, "hx-get")), `{text:"Dav",include_archived:true}`);
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
        // Empty fields are ELIDED on the detail card (no "Label: —" row), so the
        // field is simply absent until it has a value.
        assert(!find(before, n => attr(n, "data-testid") === "detail-skills_and_interests"),
               "an empty field is elided, not shown as —");

        const res = await asUser(carol, () => invoke("rabid.volunteer.saveForm($arg0)", {
            volunteer_id: String(carol), skills_and_interests: "welding", "before-skills_and_interests": "",
        }));
        assertEquals(res.action, "reload");

        const after = await asUser(carol, () => detail(carol));
        assert(hasText(getByTestId(after, "detail-skills_and_interests"), "welding"));
    });
});
