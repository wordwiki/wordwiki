// Field-level privacy + edit-permission behaviour, captured as render→act→render
// tests that run the system as a library (no HTTP, no browser).
//
//   fixture: alice=host(hides own phone)  bob=regular(shares)  carol=regular(private)  dave=admin
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asAnon } from "./testing.ts";
import { getByTestId, text, hasText } from "../liminal/testing/markup-assert.ts";

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
        const adminList = await asUser(dave, () => renderRoute(`rabid.volunteer.renderVolunteerList("", "all")`));
        assertStringIncludes(text(getByTestId(adminList, `volunteer-${carol}-phone`)), "(555) 333-3333");

        const regularList = await asUser(bob, () => renderRoute(`rabid.volunteer.renderVolunteerList("", "all")`));
        assertEquals(text(getByTestId(regularList, `volunteer-${carol}-phone`)).trim(), "***"); // private
        assertStringIncludes(text(getByTestId(regularList, `volunteer-${bob}-phone`)), "(555) 222-2222"); // shared
    });
});

test("an anonymous viewer cannot read volunteer records (non-redactable field throws)", async () => {
    await withTestDb(async ({ bob }) => {
        await asAnon(() => assertRejects(() => detail(bob)));
    });
});

test("a crafted edit of a field you may not edit is rejected at save", async () => {
    await withTestDb(async ({ bob, carol }) => {
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.volunteer.saveForm($arg0)", {
                volunteer_id: String(carol), name: "Hacked", "before-name": "Carol Private",
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
