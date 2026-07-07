// deno-lint-ignore-file no-explicit-any
// Project templates + role-discriminated owned checklists: is_template
// definitions that deep-copy into owned (owner_table, owner_id, owner_role)
// projects, with additive resync and list exclusions.  See task.ts.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, asUser, asSystem, renderRoute } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import { hasText } from "../liminal/testing/markup-assert.ts";

function newEvent(): number {
    return getRabid().event.insert({
        event_kind: 'public', description: 'Repair Night', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-20 10:00:00', end_time: '2026-06-20 15:00:00',
        total_cash_collected: 0, notes: ''} as any);
}

// A cleanup template: 2 tasks; the first ('Sweep') has 2 subtasks.
function newCleanupTemplate(): {template_id: number, sweep: number, lockup: number, mainFloor: number} {
    const r = getRabid();
    const template_id = r.project.insert({
        is_template: 1, applies_to_table: 'event', owner_role: 'cleanup',
        name: 'Event Cleanup', deleted: 0} as any);
    const sweep = r.task.insert({project_id: template_id, title: 'Sweep', deleted: 0} as any);
    const mainFloor = r.subtask.insert({task_id: sweep, title: 'Main floor', done: 0} as any);
    r.subtask.insert({task_id: sweep, title: 'Bays', done: 0} as any);
    const lockup = r.task.insert({project_id: template_id, title: 'Lock up', deleted: 0} as any);
    return {template_id, sweep, lockup, mainFloor};
}

test("owner_role slots: an event holds its general list AND a cleanup checklist (each 1-1)", () =>
    withTestDb(() => asSystem(() => {
        const r = getRabid();
        const eid = newEvent();
        const general = r.project.forOwner('event', eid, null, /*create*/ true);
        const {template_id} = newCleanupTemplate();
        const cleanup = r.project.instantiateTemplate(template_id, 'event', eid);
        assert(general !== undefined && general !== cleanup, 'distinct projects per role');
        assertEquals(r.project.forOwner('event', eid, null), general);
        assertEquals(r.project.forOwner('event', eid, 'cleanup'), cleanup);
    })));

test("instantiateTemplate deep-copies tasks+subtasks with lineage; no due; idempotent", () =>
    withTestDb(({dave}) => asUser(dave, () => {
        const r = getRabid();
        const eid = asSystem(newEvent);
        const {template_id, sweep, mainFloor} = asSystem(newCleanupTemplate);
        const pid = r.project.instantiateTemplate(template_id, 'event', eid);
        const inst = r.project.getById(pid);
        assertEquals(inst.owner_role, 'cleanup');
        assertEquals(inst.from_template_id, template_id);
        assertEquals(inst.is_template, 0);
        const tasks = r.task.tasksForProject.all({project_id: pid});
        assertEquals(tasks.length, 2);
        const instSweep = tasks.find(t => t.title === 'Sweep')!;
        assertEquals(instSweep.from_template_task_id, sweep);
        assertEquals(instSweep.due ?? null, null);   // templates carry no due -> none copied
        const subs = r.subtask.forTask.all({task_id: instSweep.task_id});
        assertEquals(subs.length, 2);
        assert(subs.some(s => s.from_template_subtask_id === mainFloor), 'subtask lineage recorded');
        // Idempotent: re-instantiating returns the same project, no re-copy.
        assertEquals(r.project.instantiateTemplate(template_id, 'event', eid), pid);
        assertEquals(r.task.tasksForProject.all({project_id: pid}).length, 2);
    })));

test("resyncFromTemplate is additive: new items added; local/completed/deleted untouched; idempotent", () =>
    withTestDb(({dave}) => asUser(dave, () => {
        const r = getRabid();
        const eid = asSystem(newEvent);
        const {template_id, sweep} = asSystem(newCleanupTemplate);
        const pid = r.project.instantiateTemplate(template_id, 'event', eid);

        // Diverge the instance: complete a copied task, add a local one.
        const instSweep = r.task.tasksForProject.all({project_id: pid}).find(t => t.title === 'Sweep')!;
        r.task.toggleDone(instSweep.task_id);
        r.task.insert({project_id: pid, title: 'Local extra', status: 'open', deleted: 0} as any);

        // Grow the template: a new task, and a new subtask under the existing 'Sweep'.
        asSystem(() => {
            r.task.insert({project_id: template_id, title: 'Wipe benches', deleted: 0} as any);
            r.subtask.insert({task_id: sweep, title: 'Under benches', done: 0} as any);
        });

        r.project.resyncFromTemplate(pid);
        const after = r.task.tasksForProject.all({project_id: pid});
        assert(after.some(t => t.title === 'Wipe benches'), 'new template task copied in');
        assert(after.some(t => t.title === 'Local extra'), 'local task untouched');
        assertEquals(after.find(t => t.title === 'Sweep')!.status, 'done', 'completed task untouched');
        assertEquals(r.subtask.forTask.all({task_id: instSweep.task_id}).length, 3, 'new subtask copied under matched task');

        const count = after.length;
        r.project.resyncFromTemplate(pid);   // second resync is a no-op
        assertEquals(r.task.tasksForProject.all({project_id: pid}).length, count);
    })));

test("templates and owned projects are excluded from the Projects and Tasks lists", () =>
    withTestDb(() => asSystem(() => {
        const r = getRabid();
        const eid = newEvent();
        const {template_id} = newCleanupTemplate();
        const cleanup = r.project.instantiateTemplate(template_id, 'event', eid);

        const projList = r.project.projectsForList.all({include_done: 0}).map(p => p.project_id);
        assert(!projList.includes(template_id), 'template not in Projects list');
        assert(!projList.includes(cleanup), 'event-owned checklist not in Projects list (owned)');

        const openTasks = r.task.allOpenTasks.all({include_done: 0});
        assert(!openTasks.some(t => t.project_id === template_id), 'template tasks not in Tasks list');
        assert(openTasks.some(t => t.project_id === cleanup), 'the checklist IS real work (present)');
    })));

test("templates are host/admin-managed; instantiation requires event-edit", () =>
    withTestDb(({alice, bob}) => {
        const r = getRabid();
        const eid = asSystem(newEvent);
        const {template_id, sweep} = asSystem(newCleanupTemplate);
        // bob (regular) can't edit the event -> can't add its checklist.
        asUser(bob, () => assertThrows(
            () => r.project.instantiateTemplate(template_id, 'event', eid), Error, 'Not permitted'));
        // alice (host) can.
        const pid = asUser(alice, () => r.project.instantiateTemplate(template_id, 'event', eid));
        assert(pid !== undefined);
        // Template task editing is host/admin only (empty group -> canWorkTask host-only).
        assertEquals(asUser(bob, () => r.task.canEditRecord(r.task.getById(sweep))), false);
        assertEquals(asUser(alice, () => r.task.canEditRecord(r.task.getById(sweep))), true);
    }));

test("a template carries no people assignment: the line is hidden and assign routes reject it", () =>
    withTestDb(async ({alice}) => {
        const r = getRabid();
        const {template_id} = asSystem(newCleanupTemplate);
        const committee = asSystem(() => r.committee.insert({name: 'Ops', deleted: 0} as any));
        // The template's project page shows no assignment affordance.
        const page = await asUser(alice, () => renderRoute(`rabid.project.detailPage(${template_id})`));
        assert(!hasText(page, 'Assign'), 'no assignment affordance on a template');
        // The project-level assign routes reject a template (defence in depth).
        asUser(alice, () => assertThrows(
            () => r.project.assignCommittee({project_id: template_id, committee_id: committee}),
            Error, 'not assigned to people'));
        asUser(alice, () => assertThrows(
            () => r.project.customizeMembers(template_id), Error, 'not assigned to people'));
    }));

test("event page: the checklist section always shows (a '+ set up' before, the tasks + Resync after)", () =>
    withTestDb(async ({alice}) => {
        const r = getRabid();
        const eid = asSystem(newEvent);
        const {template_id} = asSystem(newCleanupTemplate);
        const before = await asUser(alice, () => renderRoute(`rabid.event.detailPage(${eid})`));
        // The section stands even before setup - heading + a "Not set up yet" +.
        assert(hasText(before, 'Cleanup Tasks'), 'the section heading always shows');
        assert(hasText(before, 'Not set up yet'), 'shown as a + to set up');
        assert(!hasText(before, 'Sweep'), 'no copied tasks before setup');
        asUser(alice, () => r.project.instantiateTemplate(template_id, 'event', eid));
        const after = await asUser(alice, () => renderRoute(`rabid.event.detailPage(${eid})`));
        assert(hasText(after, 'Cleanup Tasks'), 'role heading');
        assert(hasText(after, 'Sweep'), 'copied task shown');
        assert(hasText(after, 'Resync from template'), 'resync affordance');
        assert(!hasText(after, 'Not set up yet'), 'the placeholder is gone once set up');
    }));
