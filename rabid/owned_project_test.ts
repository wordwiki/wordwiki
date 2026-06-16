// An owner (event/volunteer/bike) owning a 1-1 project for its tasks:
//   - project.forOwner: lazy find-or-create, 1-1 per owner.
//   - the owned project's name is derived from its owner (recordLabel), suffixed,
//     and chains (group label -> project -> event).
//   - addOwnerTask materializes the project on the first task and inserts into it.
//   - owned-project tasks still flow into the global task list with a derived name.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, invoke, asUser, asSystem } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import { projectRowLabel } from "./task.ts";

function newEvent(): number {
    return getRabid().event.insert({
        event_kind: 'public', description: 'Saturday in the Park', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-20 10:00:00', end_time: '2026-06-20 15:00:00',
        total_cash_collected: 0, notes: '',
    });
}

test("project.forOwner: lazy create, then 1-1 reuse", () =>
    withTestDb(() => asSystem(() => {
        const r = getRabid();
        const eid = newEvent();
        assertEquals(r.project.forOwner('event', eid, false), undefined);   // not yet
        const pid = r.project.forOwner('event', eid, true);                 // create
        assert(pid !== undefined);
        assertEquals(r.project.forOwner('event', eid, true), pid);          // same one
        assertEquals(r.project.forOwner('event', eid, false), pid);
    })));

test("owned project's name derives from its owner (suffixed), and chains to its group", () =>
    withTestDb(() => asSystem(() => {
        const r = getRabid();
        const eid = newEvent();
        const pid = r.project.forOwner('event', eid, true)!;
        const p = r.project.getById(pid);
        assertEquals(p.name, '');                                  // stored name stays empty
        assertEquals(r.project.recordLabel(p), 'Saturday in the Park — tasks');
        // The project owns a group; its label chains through the project to the event.
        assertEquals(r.volunteer_group.displayName(r.volunteer_group.getById(p.group_id)),
                     'Saturday in the Park — tasks');
    })));

test("addOwnerTask: creates the project on first task; appears in global list with derived name", () =>
    withTestDb(async ({ dave }) => {
        const r = getRabid();
        const eid = asSystem(() => newEvent());
        // dave is admin -> may edit the event -> may add its tasks.
        await asUser(dave, () => invoke(`rabid.task.addOwnerTask($arg0)`,
            { owner_table: 'event', owner_id: eid, title: 'Book the truck' }));

        const pid = asSystem(() => r.project.forOwner('event', eid, false));
        assert(pid !== undefined, 'first task should have materialized the project');

        const all = asSystem(() => r.task.allOpenTasks.all({}));
        const row = all.find(t => t.title === 'Book the truck');
        assert(row, 'the owned-project task should appear in the global list');
        assertEquals(projectRowLabel(row!), 'Saturday in the Park — tasks');
    }));

test("addOwnerTask: denied for someone who can't edit the owner", () =>
    withTestDb(({ bob }) => {
        const r = getRabid();
        const eid = asSystem(() => newEvent());
        // bob is a regular volunteer (not host/admin) -> cannot edit the event.
        let threw = false;
        try { asUser(bob, () => r.task.addOwnerTask({owner_table: 'event', owner_id: eid, title: 'x'})); }
        catch { threw = true; }
        assert(threw, 'a non-owner-editor must not add owner tasks');
        assertEquals(asSystem(() => r.project.forOwner('event', eid, false)), undefined);
    }));

// --- Volunteer-owned projects: the owner-edit delegation is self-OR-host, so a
//     volunteer manages their OWN tasks (unlike an event, which is host-only). ---

test("volunteer-owned: a volunteer may add their OWN tasks; its name derives from them", () =>
    withTestDb(({ bob }) => {
        const r = getRabid();
        asUser(bob, () => r.task.addOwnerTask({owner_table: 'volunteer', owner_id: bob, title: 'Renew first-aid cert'}));
        const pid = asSystem(() => r.project.forOwner('volunteer', bob, false));
        assert(pid !== undefined, 'a volunteer adding their own task materializes their project');
        assertEquals(asSystem(() => r.project.recordLabel(r.project.getById(pid!))), 'Bob Shares — tasks');
    }));

test("volunteer-owned: another regular volunteer may NOT add to someone else's", () =>
    withTestDb(({ bob, carol }) => {
        const r = getRabid();
        // carol (regular) cannot edit bob -> cannot add bob's tasks; bob's stays uncreated.
        let threw = false;
        try { asUser(carol, () => r.task.addOwnerTask({owner_table: 'volunteer', owner_id: bob, title: 'x'})); }
        catch { threw = true; }
        assert(threw, "a peer must not add another volunteer's tasks");
        assertEquals(asSystem(() => r.project.forOwner('volunteer', bob, false)), undefined);
    }));

test("volunteer-owned: a host may add tasks for any volunteer", () =>
    withTestDb(({ alice, bob }) => {
        const r = getRabid();
        // alice is a host -> may edit bob -> may add bob's tasks.
        asUser(alice, () => r.task.addOwnerTask({owner_table: 'volunteer', owner_id: bob, title: 'Onboarding chat'}));
        assert(asSystem(() => r.project.forOwner('volunteer', bob, false)) !== undefined);
    }));

// --- Committee-owned projects + the committee's assigned-projects list ---------

test("committee-owned: a host may add committee tasks; the name derives from the committee", () =>
    withTestDb(({ alice }) => {
        const r = getRabid();
        const cid = asSystem(() => r.committee.insert(
            {name: 'Logistics', description: '', notes: '', deleted: 0} as any));
        asUser(alice, () => r.task.addOwnerTask({owner_table: 'committee', owner_id: cid, title: 'Order parts'}));
        const pid = asSystem(() => r.project.forOwner('committee', cid, false));
        assert(pid !== undefined, 'first committee task materializes its project');
        assertEquals(asSystem(() => r.project.recordLabel(r.project.getById(pid!))), 'Logistics — tasks');
    }));

test("committee page lists ASSIGNED projects, not the committee's own task-list project", () =>
    withTestDb(({ alice }) => {
        const r = getRabid();
        const cid = asSystem(() => r.committee.insert(
            {name: 'Logistics', description: '', notes: '', deleted: 0} as any));
        const g = asSystem(() => r.committee.getById(cid).group_id);
        // A standalone project assigned to the committee (group_id = its group).
        const assigned = asSystem(() => r.project.insert(
            {name: 'Spring Bike Drive', group_id: g, deleted: 0} as any));
        // The committee's OWN owned project (direct task list).
        asUser(alice, () => r.task.addOwnerTask({owner_table: 'committee', owner_id: cid, title: 'Order parts'}));
        const owned = asSystem(() => r.project.forOwner('committee', cid, false))!;

        const listed = asSystem(() =>
            r.project.projectsForCommittee.all({committee_id: cid}).map(p => p.project_id));
        assertEquals(listed, [assigned]);              // the assigned project shows
        assert(!listed.includes(owned), 'the owned task-list project is excluded');
    }));
