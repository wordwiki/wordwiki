// The group model (group.ts) through its first owner, committee: owned-group
// creation, membership actions gated via the owner backlink, the shared member
// editor, and the standard committee list/detail/page markup.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { find, byClass, tagOf, hasText, attr } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

function insertCommittee(name = 'Logistics Committee'): {committee_id: number, group_id: number} {
    return asSystem(() => {
        const committee_id = rabid.committee.insert({
            name, description: 'Moves the stuff', notes: '', deleted: 0});
        return {committee_id, group_id: rabid.committee.getById(committee_id).group_id};
    });
}

test("creating a committee creates its owned named group (backlink patched in)", async () => {
    await withTestDb(() => {
        const {committee_id, group_id} = insertCommittee();
        const g = asSystem(() => rabid.volunteer_group.getById(group_id));
        assertEquals(g.group_kind, 'named');
        assertEquals(g.owner_table, 'committee');
        assertEquals(g.owner_id, committee_id);
        // Owned groups go by their owner's name (own name stays '').
        assertEquals(g.name, '');
        assertEquals(asSystem(() => rabid.volunteer_group.displayName(g)), 'Logistics Committee');
        // "No members" is an EMPTY group, not NULL.
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id})).length, 0);
    });
});

test("membership: host adds/removes via the owner gate; regular volunteer is refused", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const {group_id} = insertCommittee();

        // bob (regular) may not touch the committee's members.
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.volunteer_group.addMember($arg0)",
                         {group_id: String(group_id), volunteer_id: String(bob)}),
            Error, "Not permitted to edit the members of Logistics Committee"));

        // alice (host) adds bob and carol; re-adding bob is a no-op (unique index).
        const res = await asUser(alice, () => invoke("rabid.volunteer_group.addMember($arg0)",
            {group_id: String(group_id), volunteer_id: String(bob)}));
        assertEquals(res.action, "reload");
        assertEquals(res.targets, [`.-volunteer_group-${group_id}-`]);
        await asUser(alice, () => invoke("rabid.volunteer_group.addMember($arg0)",
            {group_id: String(group_id), volunteer_id: String(carol)}));
        await asUser(alice, () => invoke("rabid.volunteer_group.addMember($arg0)",
            {group_id: String(group_id), volunteer_id: String(bob)}));
        const members = asSystem(() => rabid.volunteer_group.members.all({group_id}));
        assertEquals(members.map(m => m.volunteer_name), ["Bob Shares", "Carol Private"]);

        // Remove is gated the same way.
        await asUser(bob, () => assertRejects(
            () => invoke(`rabid.volunteer_group.removeMember($arg0,$arg1)`, group_id, carol),
            Error, "Not permitted"));
        await asUser(alice, () => invoke(`rabid.volunteer_group.removeMember($arg0,$arg1)`, group_id, carol));
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id})).length, 1);
    });
});

test("member editor: edit affordances for the host only; dialog gated server-side", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const {group_id} = insertCommittee();
        await asUser(alice, () => invoke("rabid.volunteer_group.addMember($arg0)",
            {group_id: String(group_id), volunteer_id: String(bob)}));

        // Members render as a pure name phrase; ONE in-fragment ☰ carries the
        // verbs.  The host (not a member) gets Add me / Add member… / the
        // per-member removes; bob (a member but not an editor) gets no menu
        // at all - his one open verb, Add me, doesn't apply to a member.
        const hostView = await asUser(alice, () =>
            renderRoute(`rabid.volunteer_group.renderMemberEditor(${group_id})`));
        assert(hasText(hostView, "Bob"));
        assert(!!find(hostView, byClass("lm-member")));
        assert(!!find(hostView, byClass("lm-action-menu")));
        assert(hasText(hostView, "Add me"));
        assert(hasText(hostView, "Add member…"));
        assert(hasText(hostView, "Remove Bob"));

        const regularView = await asUser(bob, () =>
            renderRoute(`rabid.volunteer_group.renderMemberEditor(${group_id})`));
        assert(hasText(regularView, "Bob"));
        assert(!find(regularView, byClass("lm-action-menu")));

        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.volunteer_group.addMemberDialog(${group_id})`),
            Error, "Not permitted"));
    });
});

test("crafted group_member.saveForm writes are rejected (the actions are the write path)", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const {group_id} = insertCommittee();
        // Insert attempt (no record to gate on -> per-field delegate says no).
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.group_member.saveForm($arg0)", {
                group_id: String(group_id), "before-group_id": "",
                volunteer_id: String(bob), "before-volunteer_id": ""}),
            Error, "Not permitted"));
        // Update attempt against an existing membership row (row gate).
        const member_id = asSystem(() => rabid.group_member.insert({group_id, volunteer_id: alice}));
        await asUser(bob, () => assertRejects(
            () => invoke("rabid.group_member.saveForm($arg0)", {
                group_member_id: String(member_id),
                volunteer_id: String(bob), "before-volunteer_id": String(alice)}),
            Error, "Not permitted to edit this group_member"));
    });
});

test("committee rows: navigable document sections (no per-row pencil); New-committee behind the ☰ for hosts only", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const {committee_id} = insertCommittee();

        // A document section - no per-row pencil for anyone (editing committee
        // parameters is done from the detail page); the whole section navigates.
        const bobRow = await asUser(bob, () => renderRoute(`rabid.committee.renderCommitteeRowById(${committee_id})`));
        assertEquals(tagOf(bobRow as any), "section");
        assert(attr(bobRow as any, "onclick") === "lmNavigableClick(event)");
        assert(!!find(bobRow, byClass("lm-nav-link")));
        assert(!!find(bobRow, byClass("lm-nav-chevron")));
        assert(hasText(bobRow, "No members yet"));   // members are shown inline, not "N members"
        const aliceRow = await asUser(alice, () => renderRoute(`rabid.committee.renderCommitteeRowById(${committee_id})`));
        assert(!find(aliceRow, byClass("lm-edit-pencil")));   // even a host edits from the detail page

        const hostPage = await asUser(alice, () => renderRoute(`committees`));
        assert(hasText(hostPage, "Logistics Committee"));
        assert(hasText(hostPage, "New committee"));   // in the ☰ menu
        const regularPage = await asUser(bob, () => renderRoute(`committees`));
        assert(hasText(regularPage, "Logistics Committee"));
        assert(!hasText(regularPage, "New committee"));

        // The create dialog itself is server-gated.
        await asUser(bob, () => assertRejects(
            () => renderRoute(`rabid.committee.newDialog()`),
            Error, "not permitted"));   // route layer (@route hostOrAdmin) denies first
    });
});

test("dissolved committees are hidden by default; the ☰ 'Show dissolved' reveals them (page-state)", async () => {
    await withTestDb(async ({ alice }) => {
        const {committee_id} = insertCommittee('Old Guard Committee');
        asSystem(() => rabid.committee.update(committee_id, {deleted: 1}));   // dissolve it

        // Default view omits it; the page offers "Show dissolved".
        const active = await asUser(alice, () => renderRoute(`committees`));
        assert(!hasText(active, 'Old Guard Committee'));
        assert(hasText(active, 'Show dissolved'));

        // include_dissolved:true surfaces it, flagged "Dissolved" (navigate to
        // its detail page to un-dissolve), and now the menu offers "Hide".
        const all = await asUser(alice, () => renderRoute(`committees({include_dissolved:true})`));
        assert(hasText(all, 'Old Guard Committee'));
        assert(hasText(all, 'Dissolved'));
        assert(hasText(all, 'Hide dissolved'));
        // The dissolved-aware list query reload URL carries the flag.
        const list = await asUser(alice, () => renderRoute(`rabid.committee.renderCommitteeList(true)`));
        assert(hasText(list, 'Old Guard Committee'));
    });
});

test("committee detail embeds the member editor; insert via saveForm creates the group", async () => {
    await withTestDb(async ({ alice, bob }) => {
        // Create through the generic record form (no primary key -> insert),
        // exactly what the New-committee dialog submits.
        const res = await asUser(alice, () => invoke("rabid.committee.saveForm($arg0)", {
            name: "Outreach Committee", "before-name": ""}));
        assertEquals(res.action, "reload");
        const c = asSystem(() => rabid.committee.activeCommittees.all({}))
            .find(c => c.name === "Outreach Committee")!;
        assert(c.group_id > 0);
        assertEquals(asSystem(() => rabid.volunteer_group.getById(c.group_id)).owner_id, c.committee_id);

        await asUser(alice, () => invoke("rabid.volunteer_group.addMember($arg0)",
            {group_id: String(c.group_id), volunteer_id: String(bob)}));
        const detail = await asUser(bob, () => renderRoute(`rabid.committee.detailPage(${c.committee_id})`));
        assert(hasText(detail, "Outreach Committee"));
        assert(hasText(detail, "Members"));
        assert(hasText(detail, "Bob"));
    });
});
