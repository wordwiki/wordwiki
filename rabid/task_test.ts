// deno-lint-ignore-file no-explicit-any
// The project/task/subtask model (task.ts): host-gated project/task creation,
// the owned adhoc assignee group + assignee edit rights, the prefilled new-task
// dialog (empty before-snapshots on insert), the thin subtask checklist with
// its task-stamp touching, and the standard list/detail markup.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem, as } from "./testing.ts";
import { find, byClass, tagOf, attr, hasText, getByTestId } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";
import { db } from "../liminal/db.ts";

// A project + one task, inserted as system.  The task gets an (empty)
// EXCLUSIVE assignment override, so tests can assign people to the task
// itself; group_id is that override group.  (Inheritance - the no-override
// rule - has its own tests below.)
function seedTask(): {project_id: number, task_id: number, group_id: number} {
    return asSystem(() => {
        const project_id = rabid.project.insert({name: 'Bike Drive', deleted: 0});
        const task_id = rabid.task.insert({project_id, title: 'Book truck', deleted: 0});
        rabid.task.overrideAssignees(task_id);
        return {project_id, task_id, group_id: rabid.task.getById(task_id).group_id!};
    });
}

const addToGroup = (group_id: number, volunteer_id: number) =>
    asSystem(() => rabid.group_member.insert({group_id, volunteer_id}));

test("projects: host-gated create via saveForm insert; managed defaults applied", async () => {
    await withTestDb(({ alice, bob }) => {
        // Host: the no-pk saveForm path inserts.
        const result = asUser(alice, () =>
            rabid.project.saveForm({name: 'Bike Drive', 'before-name': ''})) as any;
        assertEquals(result, {action: 'reload', targets: ['.-project-']});
        const p = asSystem(() => rabid.project.activeProjects.all({})).find(p => p.name === 'Bike Drive');
        assert(p);
        assertEquals(p!.description, '');

        // Regular volunteer: both the form and a crafted POST are refused.
        assertThrows(() => asUser(bob, () => rabid.project.renderForm({} as any)),
                     Error, 'Not permitted');
        assertThrows(() => asUser(bob, () => rabid.project.saveForm({name: 'Nope', 'before-name': ''})),
                     Error, 'Not permitted');
    });
});

test("projects own the assignment group; a new task INHERITS (NULL group); override creates its own", async () => {
    await withTestDb(() => {
        const {project_id, task_id, group_id} = seedTask();   // seedTask overrides
        // The project's assignment group, created with the project.
        const p = asSystem(() => rabid.project.getById(project_id));
        const pg = asSystem(() => rabid.volunteer_group.getById(p.group_id));
        assertEquals(pg.group_kind, 'adhoc');
        assertEquals(pg.owner_table, 'project');
        assertEquals(pg.owner_id, project_id);
        // A task inserted WITHOUT an override has no group of its own - the
        // RULE is inheritance.
        const bare = asSystem(() => rabid.task.insert({project_id, title: 'Inherits', deleted: 0}));
        assertEquals(asSystem(() => rabid.task.getById(bare)).group_id ?? null, null);
        // seedTask's override: a task-owned adhoc group, backlink patched in;
        // display name falls through to the task's title.
        const g = asSystem(() => rabid.volunteer_group.getById(group_id));
        assertEquals(g.group_kind, 'adhoc');
        assertEquals(g.owner_table, 'task');
        assertEquals(g.owner_id, task_id);
        assertEquals(asSystem(() => rabid.volunteer_group.displayName(g)), 'Book truck');
        // Managed fields were stamped at insert.
        const t = asSystem(() => rabid.task.getById(task_id));
        assert(t.order_key.startsWith('0.'));
        assert(t.last_change_time > '2020');
    });
});

test("assignees may edit the task (and its assignee list); other volunteers may not", async () => {
    await withTestDb(({ bob, carol }) => {
        const {task_id, group_id} = seedTask();
        addToGroup(group_id, bob);

        // A non-assignee volunteer can neither edit the record nor its members.
        assertThrows(() => asUser(carol, () => rabid.task.saveForm({
            task_id: String(task_id), status: 'done', 'before-status': 'open'})),
            Error, 'Not permitted');
        assertThrows(() => asUser(carol, () => rabid.volunteer_group.addMember(
            {group_id, volunteer_id: carol})), Error, 'Not permitted');

        // The assignee can update the task (saveForm = the pencil-edit path).
        const result = asUser(bob, () => rabid.task.saveForm({
            task_id: String(task_id), status: 'in-progress', 'before-status': 'open'})) as any;
        assertEquals(result.targets, [`.-task-${task_id}-`]);
        assertEquals(asSystem(() => rabid.task.getById(task_id)).status, 'in-progress');

        // ...and being an assignee delegates membership editing through the
        // owner backlink: bob can add carol to the task.
        asUser(bob, () => rabid.volunteer_group.addMember({group_id, volunteer_id: carol}));
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id})).length, 2);
    });
});

test("new-task dialog: project preset survives an untouched picker (empty before-snapshots)", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const {project_id} = seedTask();

        // The dialog renders the FK picker pre-selected, with an EMPTY
        // before-snapshot - so an unchanged preset still reaches the insert.
        const form = await asUser(alice, () => renderRoute(`rabid.task.newDialog(${project_id})`));
        const selected = find(form, n => tagOf(n) === 'option' && attr(n, 'selected') !== undefined);
        assertEquals(String(attr(selected!, 'value')), String(project_id));
        const beforeProject = find(form, n =>
            tagOf(n) === 'input' && attr(n, 'name') === 'before-project_id');
        assertEquals(attr(beforeProject!, 'value') ?? '', '');

        // Submitting with the preset untouched (value == preset, before == '')
        // inserts into the right project.
        const result = asUser(alice, () => rabid.task.saveForm({
            title: 'Posters', 'before-title': '',
            project_id: String(project_id), 'before-project_id': ''})) as any;
        assertEquals(result, {action: 'reload', targets: ['.-task-']});
        const tasks = asSystem(() => rabid.task.tasksForProject.all({project_id}));
        assert(tasks.some(t => t.title === 'Posters'));
        // New tasks append at the end of the project's order.
        assertEquals(tasks.filter(t => t.status !== 'done').at(-1)!.title, 'Posters');

        // Task creation is host/admin (an assignee can work tasks, not mint them).
        await assertRejects(() => asUser(bob, () =>
            renderRoute(`rabid.task.newDialog(${project_id})`)) as Promise<any>,
            Error, 'Not permitted');
    });
});

test("subtask checklist: add/toggle/remove gated by the task; every mutation stamps the task", async () => {
    await withTestDb(({ bob, carol }) => {
        const {task_id, group_id} = seedTask();
        addToGroup(group_id, bob);

        // Non-assignee: every checklist mutation is refused.
        assertThrows(() => asUser(carol, () => rabid.subtask.addItem({task_id, title: 'nope'})),
                     Error, 'Not permitted');

        // Assignee adds two items; they land in order.
        asUser(bob, () => rabid.subtask.addItem({task_id, title: 'Get quotes'}));
        asUser(bob, () => rabid.subtask.addItem({task_id, title: 'Confirm driver'}));
        const items = asSystem(() => rabid.subtask.forTask.all({task_id}));
        assertEquals(items.map(s => s.title), ['Get quotes', 'Confirm driver']);

        // Backdate the task stamp (direct SQL: rabid.task.update would re-stamp),
        // toggle, and observe the touch.
        const OLD = '2020-01-01 00:00:00';
        asSystem(() => db().execute<{task_id: number}>(
            `UPDATE task SET last_change_time = '${OLD}' WHERE task_id = :task_id`, {task_id}));
        const toggled = asUser(bob, () => rabid.subtask.toggle(items[0].subtask_id)) as any;
        assertEquals(toggled.targets, [`.-subtask-${task_id}-`]);
        assertEquals(asSystem(() => rabid.subtask.getById(items[0].subtask_id)).done, 1);
        assert(asSystem(() => rabid.task.getById(task_id)).last_change_time > OLD);

        // Non-assignee can't toggle either.
        assertThrows(() => asUser(carol, () => rabid.subtask.toggle(items[1].subtask_id)),
                     Error, 'Not permitted');

        // Remove deletes the row (subtasks are thin: no soft-delete; the task
        // stamp records the change).
        asUser(bob, () => rabid.subtask.remove(items[0].subtask_id));
        assertEquals(asSystem(() => rabid.subtask.forTask.all({task_id})).length, 1);

        // The crafted-POST backstop: generic saveForm insert on subtask has no
        // record to delegate through, so it is refused.
        assertThrows(() => asUser(carol, () => rabid.subtask.saveForm({
            task_id: String(task_id), 'before-task_id': '',
            title: 'crafted', 'before-title': ''})), Error, 'Not permitted');
    });
});

// A committee with the given members, inserted as system.
function seedCommittee(name: string, members: number[]): {committee_id: number, group_id: number} {
    return asSystem(() => {
        const committee_id = rabid.committee.insert({name, description: '', notes: '', deleted: 0});
        const group_id = rabid.committee.getById(committee_id).group_id;
        for(const volunteer_id of members)
            rabid.group_member.insert({group_id, volunteer_id});
        return {committee_id, group_id};
    });
}

test("assign committee: task aliases the named group (live); orphaned adhoc group dropped", async () => {
    await withTestDb(({ alice, bob, carol }) => {
        const {task_id, group_id: ownGroup} = seedTask();
        const c1 = seedCommittee('Logistics Committee', [bob]);
        const c2 = seedCommittee('Outreach Committee', []);

        // Only task editors may assign; carol (not host, not assignee) can't.
        assertThrows(() => asUser(carol, () => rabid.task.assignCommittee(
            {task_id, committee_id: c1.committee_id})), Error, 'Not permitted');

        // Host assigns: the task now points at the committee's NAMED group...
        const result = asUser(alice, () => rabid.task.assignCommittee(
            {task_id, committee_id: c1.committee_id})) as any;
        assertEquals(result.targets, [`.-task-${task_id}-`]);
        assertEquals(asSystem(() => rabid.task.getById(task_id)).group_id, c1.group_id);
        // ...and the task's old owned adhoc group is gone (hard-deleted garbage).
        assertThrows(() => asSystem(() => rabid.volunteer_group.getById(ownGroup)));

        // LIVE semantics: committee members are task assignees - bob can work
        // the task, and committee membership changes propagate (carol added to
        // the committee becomes a task editor with no task write at all).
        asUser(bob, () => rabid.task.saveForm({
            task_id: String(task_id), status: 'in-progress', 'before-status': 'open'}));
        asSystem(() => rabid.group_member.insert({group_id: c1.group_id, volunteer_id: carol}));
        asUser(carol, () => rabid.subtask.addItem({task_id, title: 'now allowed'}));

        // Reassigning to another committee NEVER touches the first committee's
        // group (it fails the task-ownership test).
        asUser(alice, () => rabid.task.assignCommittee({task_id, committee_id: c2.committee_id}));
        assertEquals(asSystem(() => rabid.task.getById(task_id)).group_id, c2.group_id);
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id: c1.group_id})).length, 2);
    });
});

test("customize members: explicit snapshot detaches from the committee (derived_from provenance)", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const {task_id} = seedTask();
        const c1 = seedCommittee('Logistics Committee', [bob]);
        asUser(alice, () => rabid.task.assignCommittee({task_id, committee_id: c1.committee_id}));

        // Committee-assigned: the detail page shows the committee READ-ONLY -
        // no Add member even for a host (member edits must not silently hit
        // the committee) - plus the two explicit affordances.
        const before = await asUser(alice, () => renderRoute(`rabid.task.detailPage(${task_id})`));
        assert(hasText(before, 'Logistics Committee'));
        assert(hasText(before, 'Membership follows the committee'));
        assert(!hasText(before, 'Add member'));
        assert(hasText(before, 'Customize members'));
        assert(hasText(before, 'Change committee'));

        // The snapshot: a fresh task-owned adhoc group, members copied,
        // provenance stamped; the committee's group is untouched.
        asUser(bob, () => rabid.task.customizeMembers(task_id));
        const t = asSystem(() => rabid.task.getById(task_id));
        assert(t.group_id !== c1.group_id);
        const g = asSystem(() => rabid.volunteer_group.getById(t.group_id!));
        assertEquals(g.group_kind, 'adhoc');
        assertEquals(g.owner_table, 'task');
        assertEquals(g.owner_id, task_id);
        assertEquals(g.derived_from, 'Logistics Committee');
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id: t.group_id!}))
            .map(m => m.volunteer_id), [bob]);

        // Edits now hit only the task's own group.
        asUser(bob, () => rabid.volunteer_group.addMember({group_id: t.group_id, volunteer_id: carol}));
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id: t.group_id!})).length, 2);
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id: c1.group_id})).length, 1);

        // The detail page is back to the editable member editor, with the
        // provenance label.
        const after = await asUser(alice, () => renderRoute(`rabid.task.detailPage(${task_id})`));
        assert(hasText(after, 'Customized from Logistics Committee'));
        assert(hasText(after, 'Add member'));
        assert(hasText(after, 'Assign committee'));
        assert(!hasText(after, 'Membership follows the committee'));
    });
});

test("tasks page: 'My tasks' for the actor's assignments; all-open grouped by project; done/deleted excluded", async () => {
    await withTestDb(async ({ bob, carol }) => {
        const {project_id, task_id, group_id} = seedTask();
        addToGroup(group_id, bob);
        asSystem(() => {
            // A second project so the grouping has something to group.
            const p2 = rabid.project.insert({name: 'Shop Fixes', deleted: 0});
            rabid.task.insert({project_id: p2, title: 'Fix stand', deleted: 0});
            // Done and deleted tasks stay out of the open views.
            rabid.task.insert({project_id, title: 'Old done thing', status: 'done', deleted: 0});
            rabid.task.insert({project_id, title: 'Deleted thing', deleted: 1});
        });

        // The assignee sees a My-tasks section with their task (and the row
        // carries its project name - the cross-project context).
        const bobPage = await asUser(bob, () => renderRoute('rabid.task.renderTasksPage()'));
        const mine = getByTestId(bobPage, 'my-tasks');
        assert(hasText(mine, 'Book truck'));
        assert(hasText(mine, 'Bike Drive'));

        // A volunteer with no assignments gets no My-tasks section, but the
        // grouped all-open view (both project headings, open tasks only).
        const carolPage = await asUser(carol, () => renderRoute('rabid.task.renderTasksPage()'));
        assert(!hasText(carolPage, 'My tasks'));
        assert(hasText(carolPage, 'All open tasks'));
        assert(hasText(carolPage, 'Bike Drive'));
        assert(hasText(carolPage, 'Shop Fixes'));
        assert(hasText(carolPage, 'Fix stand'));
        assert(!hasText(carolPage, 'Old done thing'));
        assert(!hasText(carolPage, 'Deleted thing'));

        // The page is anchored on the navbar route.
        const viaRoute = await asUser(bob, () => renderRoute('tasks'));
        assert(hasText(viaRoute, 'All open tasks'));
    });
});

test("completion provenance: done_time/done_by stamped on the done transition, cleared on reopen", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const {project_id, task_id, group_id} = seedTask();
        addToGroup(group_id, bob);

        // Subtask: bob checks it off -> stamped with bob + now; unchecking clears.
        asUser(bob, () => rabid.subtask.addItem({task_id, title: 'step'}));
        const sid = asSystem(() => rabid.subtask.forTask.all({task_id}))[0].subtask_id;
        asUser(bob, () => rabid.subtask.toggle(sid));
        let s = asSystem(() => rabid.subtask.getById(sid));
        assertEquals(s.done_by, bob);
        assert(s.done_time! > '2020');
        // The checklist row shows the provenance quietly.
        const checklist = await asUser(bob, () => renderRoute(`rabid.subtask.renderChecklist(${task_id})`));
        assert(hasText(checklist, 'Bob Shares,'));
        asUser(bob, () => rabid.subtask.toggle(sid));
        s = asSystem(() => rabid.subtask.getById(sid));
        assertEquals(s.done_time ?? null, null);
        assertEquals(s.done_by ?? null, null);

        // Task: the generic edit path stamps the done transition...
        asUser(bob, () => rabid.task.saveForm({
            task_id: String(task_id), status: 'done', 'before-status': 'open'}));
        let t = asSystem(() => rabid.task.getById(task_id));
        assertEquals(t.done_by, bob);
        assert(t.done_time! > '2020');
        // ...the detail page says who...
        const detail = await asUser(bob, () => renderRoute(`rabid.task.detailPage(${task_id})`));
        assert(hasText(detail, 'by Bob Shares'));
        // ...an unrelated edit leaves the stamp alone...
        asUser(bob, () => rabid.task.saveForm({
            task_id: String(task_id), details: 'note', 'before-details': ''}));
        assertEquals(asSystem(() => rabid.task.getById(task_id)).done_by, bob);
        // ...and reopening clears it.
        asUser(bob, () => rabid.task.saveForm({
            task_id: String(task_id), status: 'open', 'before-status': 'done'}));
        t = asSystem(() => rabid.task.getById(task_id));
        assertEquals(t.done_time ?? null, null);
        assertEquals(t.done_by ?? null, null);

        // Born-done rows (seeds, imports) get a time; no actor -> no by.
        const t2 = asSystem(() => rabid.task.insert({
            project_id, title: 'born done', status: 'done', deleted: 0}));
        assert(asSystem(() => rabid.task.getById(t2)).done_time);
        assertEquals(asSystem(() => rabid.task.getById(t2)).done_by ?? null, null);

        // Project: archiving stamps archived_time/archived_by; unarchiving clears.
        asUser(alice, () => rabid.project.saveForm({
            project_id: String(project_id), deleted: '1', 'before-deleted': '0'}));
        let p = asSystem(() => rabid.project.getById(project_id));
        assertEquals(p.archived_by, alice);
        assert(p.archived_time);
        asUser(alice, () => rabid.project.saveForm({
            project_id: String(project_id), deleted: '0', 'before-deleted': '1'}));
        p = asSystem(() => rabid.project.getById(project_id));
        assertEquals(p.archived_time ?? null, null);
        assertEquals(p.archived_by ?? null, null);
    });
});

test("pages: one navigable row species, pencil follows recordEdit; task detail embeds the member editor and checklist", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const {project_id, task_id, group_id} = seedTask();
        addToGroup(group_id, bob);
        asUser(bob, () => rabid.subtask.addItem({task_id, title: 'Get quotes'}));

        // Projects page: host sees the New-project affordance, regulars don't.
        const hostPage = await asUser(alice, () => renderRoute('rabid.project.renderProjectsPage()'));
        assert(hasText(hostPage, 'New project'));
        const volPage = await asUser(carol, () => renderRoute('rabid.project.renderProjectsPage()'));
        assert(!hasText(volPage, 'New project'));
        // Every viewer gets the same navigable row (tap drills in); only the
        // pencil follows recordEdit.
        const hostRow = getByTestId(hostPage, `project-row-${project_id}`);
        const volRow = getByTestId(volPage, `project-row-${project_id}`);
        for (const row of [hostRow, volRow]) {
            assertEquals(tagOf(row), 'div');
            assertEquals(attr(row, 'onclick'), 'lmNavigableClick(event)');
            assert(!!find(row, byClass('lm-nav-link')));
            assert(!!find(row, byClass('lm-nav-chevron')));
        }
        assert(!!find(hostRow, byClass('lm-edit-pencil')));  // host: edits anyone's project
        assert(!find(volRow, byClass('lm-edit-pencil')));    // regular volunteer: no pencil

        // The merged project view: each task is a BLOCK (checkbox + title +
        // inline checklist).  The pencil/checkbox follow recordEdit (assignee
        // yes, others read-only); the subtask is right there on the page; the
        // task's exclusive override shows as the → marker.
        const bobTasks = await asUser(bob, () => renderRoute(`rabid.task.renderProjectTasks(${project_id})`));
        const bobBlock = getByTestId(bobTasks, `task-block-${task_id}`);
        assert(!!find(bobBlock, byClass('lm-edit-pencil')));
        assert(!!find(bobBlock, n => tagOf(n) === 'input' && attr(n, 'type') === 'checkbox'
                                     && attr(n, 'disabled') === undefined));
        assert(hasText(bobBlock, 'Get quotes'));                  // checklist inline
        assert(hasText(getByTestId(bobTasks, `task-${task_id}-override`), 'Bob Shares'));
        const carolTasks = await asUser(carol, () => renderRoute(`rabid.task.renderProjectTasks(${project_id})`));
        const carolBlock = getByTestId(carolTasks, `task-block-${task_id}`);
        assert(!find(carolBlock, byClass('lm-edit-pencil')));

        // Task detail: assignee list + checklist render; the assignee gets the
        // add/remove affordances, the non-assignee gets read-only fragments.
        const detail = await asUser(bob, () => renderRoute(`rabid.task.detailPage(${task_id})`));
        assert(hasText(detail, 'Assigned to'));
        assert(hasText(detail, 'Checklist'));
        assert(hasText(detail, 'Add member'));
        assert(hasText(detail, 'Add item'));
        const carolDetail = await asUser(carol, () => renderRoute(`rabid.task.detailPage(${task_id})`));
        assert(!hasText(carolDetail, 'Add member'));
        assert(!hasText(carolDetail, 'Add item'));
        // The checklist checkbox is disabled for the non-editor.
        const box = find(carolDetail, n => tagOf(n) === 'input' && attr(n, 'type') === 'checkbox');
        assert(attr(box!, 'disabled') !== undefined);
    });
});

test("Mark project done / Reopen: confirmed buttons over the terminal flag, host-gated", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const {project_id} = seedTask();

        // The host page offers the button; a regular volunteer's doesn't.
        const hostPage = await asUser(alice, () => renderRoute(`rabid.project.detailPage(${project_id})`));
        assert(hasText(hostPage, 'Mark project done'));
        const volPage = await asUser(carol, () => renderRoute(`rabid.project.detailPage(${project_id})`));
        assert(!hasText(volPage, 'Mark project done'));

        // The action is gated server-side too.
        assertThrows(() => asUser(carol, () => rabid.project.markDone(project_id)),
                     Error, "Not permitted to edit this project");

        // Host marks done: flag + provenance stamped; the page flips to Done/Reopen.
        const res = asUser(alice, () => rabid.project.markDone(project_id)) as any;
        assertEquals(res.action, 'reload');
        const p = asSystem(() => rabid.project.getById(project_id));
        assertEquals(p.deleted, 1);
        assertEquals(p.archived_by, alice);
        assert(p.archived_time);
        const donePage = await asUser(alice, () => renderRoute(`rabid.project.detailPage(${project_id})`));
        assert(hasText(donePage, 'Done'));
        assert(hasText(donePage, 'Reopen project'));

        // Reopen clears the provenance (the existing unarchive path).
        asUser(alice, () => rabid.project.reopen(project_id));
        const p2 = asSystem(() => rabid.project.getById(project_id));
        assertEquals(p2.deleted, 0);
        assertEquals(p2.archived_time ?? null, null);
    });
});

test("Add completed item: born-done checklist entry with provenance (work-log workflow)", async () => {
    await withTestDb(async ({ bob }) => {
        const {task_id, group_id} = seedTask();
        addToGroup(group_id, bob);

        // The dialog variant exists (done=1 rides hidden); the action inserts
        // a checked item stamped to the actor.
        const dialog = await asUser(bob, () => renderRoute(`rabid.subtask.addItemDialog(${task_id},true)`));
        assert(hasText(dialog, 'Add completed item'));
        const res = asUser(bob, () => rabid.subtask.addItem({
            task_id: String(task_id), title: 'Sorted the parts bin', done: '1'})) as any;
        assertEquals(res.action, 'reload');
        const item = asSystem(() => rabid.subtask.forTask.all({task_id}))
            .find(s => s.title === 'Sorted the parts bin')!;
        assertEquals(item.done, 1);
        assertEquals(item.done_by, bob);
        assert(item.done_time);

        // Renders checked, with the who/when provenance and the quiet ×; the
        // add actions live in the task block's ☰ menu (and the detail page's
        // buttons), not in the checklist fragment itself.
        const checklist = await asUser(bob, () => renderRoute(`rabid.subtask.renderChecklist(${task_id})`));
        assert(hasText(checklist, 'Sorted the parts bin'));
        assert(!hasText(checklist, 'Add completed item'));
        assert(!!find(checklist, byClass('lm-remove-x')));
        const block = await asUser(bob, () => renderRoute(`rabid.task.renderTaskBlockById(${task_id})`));
        assert(!!find(block, byClass('lm-action-menu')));
        assert(hasText(block, 'Add completed item…'));
        const detail = await asUser(bob, () => renderRoute(`rabid.task.detailPage(${task_id})`));
        assert(hasText(detail, 'Add completed item'));
    });
});

test("projects and tasks record creation provenance (who to ask about it)", async () => {
    await withTestDb(async ({ alice }) => {
        // Created through the normal host flow (saveForm inserts): both
        // managed stamps land without appearing in any form.
        asUser(alice, () => rabid.project.saveForm({name: 'Paint Shop', 'before-name': ''}));
        const p = asSystem(() => rabid.project.activeProjects.all({}))
            .find(p => p.name === 'Paint Shop')!;
        assertEquals(p.created_by, alice);
        assert(p.created_time);

        asUser(alice, () => rabid.task.saveForm({
            title: 'Buy brushes', 'before-title': '',
            project_id: String(p.project_id), 'before-project_id': ''}));
        const t = asSystem(() => rabid.task.tasksForProject.all({project_id: p.project_id}))[0];
        assertEquals(t.created_by, alice);
        assert(t.created_time);

        // Both detail pages say who to ask.
        const projPage = await asUser(alice, () => renderRoute(`rabid.project.detailPage(${p.project_id})`));
        assert(hasText(projPage, 'Created'));
        assert(hasText(projPage, 'Alice Host'));
        const taskPage = await asUser(alice, () => renderRoute(`rabid.task.detailPage(${t.task_id})`));
        assert(hasText(taskPage, 'Created'));
        assert(hasText(taskPage, 'Alice Host'));

        // System writes (seeds, imports) stamp the time but no creator.
        const {project_id} = seedTask();
        const seeded = asSystem(() => rabid.project.getById(project_id));
        assertEquals(seeded.created_by ?? null, null);
        assert(seeded.created_time);
    });
});

test("checklist items edit via the pencil: title-only dialog, reload targets the task's checklist", async () => {
    await withTestDb(async ({ bob, carol }) => {
        const {task_id, group_id} = seedTask();
        addToGroup(group_id, bob);
        asUser(bob, () => rabid.subtask.addItem({task_id, title: 'Get qotes'}));
        const item = asSystem(() => rabid.subtask.forTask.all({task_id}))[0];

        // The row carries the pencil for the assignee, not for others.
        const bobList = await asUser(bob, () => renderRoute(`rabid.subtask.renderChecklist(${task_id})`));
        assert(!!find(getByTestId(bobList, `subtask-row-${item.subtask_id}`), byClass('lm-edit-pencil')));
        const carolList = await asUser(carol, () => renderRoute(`rabid.subtask.renderChecklist(${task_id})`));
        assert(!find(carolList, byClass('lm-edit-pencil')));

        // The dialog is title-only: no done checkbox, no task picker (done-ness
        // is the toggle path, which stamps provenance).
        const form = await asUser(bob, () =>
            renderRoute(`rabid.subtask.renderForm(rabid.subtask.getById(${item.subtask_id}))`));
        assert(!!find(form, n => tagOf(n) === 'input' && attr(n, 'name') === 'title'));
        assert(!find(form, n => (tagOf(n) === 'input' || tagOf(n) === 'select')
                                && attr(n, 'name') === 'done'));
        assert(!find(form, n => (tagOf(n) === 'input' || tagOf(n) === 'select')
                                && attr(n, 'name') === 'task_id'));

        // Saving renames, and reloads the TASK's checklist fragment (not the
        // generic pk target, which nothing on the page carries).
        const res = asUser(bob, () => rabid.subtask.saveForm({
            subtask_id: String(item.subtask_id), title: 'Get quotes', 'before-title': 'Get qotes'})) as any;
        assertEquals(res.targets, [`.-subtask-${task_id}-`]);
        assertEquals(asSystem(() => rabid.subtask.getById(item.subtask_id)).title, 'Get quotes');

        // Gated: a non-assignee cannot even render the form.
        await asUser(carol, () => assertRejects(
            () => renderRoute(`rabid.subtask.renderForm(rabid.subtask.getById(${item.subtask_id}))`),
            Error, 'Not permitted'));
    });
});

test("assignment inheritance: project assignees work all non-overridden tasks; overrides are EXCLUSIVE", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        // A project assigned to bob+carol with two tasks: one inherited, one
        // overridden to bob alone.
        const {inherited, overridden} = asSystem(() => {
            const project_id = rabid.project.insert({name: 'Yard Sale', deleted: 0});
            const pg = rabid.project.getById(project_id).group_id;
            rabid.group_member.insert({group_id: pg, volunteer_id: bob});
            rabid.group_member.insert({group_id: pg, volunteer_id: carol});
            const inherited = rabid.task.insert({project_id, title: 'Price stickers', deleted: 0});
            const overridden = rabid.task.insert({project_id, title: 'Borrow tables', deleted: 0});
            rabid.task.overrideAssignees(overridden);
            rabid.group_member.insert({group_id: rabid.task.getById(overridden).group_id!,
                                       volunteer_id: bob});
            return {inherited, overridden};
        });
        const mine = (v: number) => asSystem(() =>
            rabid.task.openTasksForVolunteer.all({volunteer_id: v}).map(t => t.title).sort());

        // Inherited task: any project assignee can work it.
        asUser(carol, () => rabid.task.saveForm({
            task_id: String(inherited), status: 'in-progress', 'before-status': 'open'}));

        // EXCLUSIVE override: the task is on bob's list and LEAVES carol's -
        // carol can clear her list without doing bob's task - and carol may
        // not edit it.
        assertEquals(mine(bob), ['Borrow tables', 'Price stickers']);
        assertEquals(mine(carol), ['Price stickers']);
        assertThrows(() => asUser(carol, () => rabid.task.saveForm({
            task_id: String(overridden), status: 'done', 'before-status': 'open'})),
            Error, 'Not permitted');
        asUser(bob, () => rabid.task.saveForm({
            task_id: String(overridden), status: 'in-progress', 'before-status': 'open'}));

        // Revert (host): back to inheritance - the whole team again, and the
        // orphaned override group is gone.
        const og = asSystem(() => rabid.task.getById(overridden)).group_id!;
        asUser(alice, () => rabid.task.revertAssignees(overridden));
        assertEquals(asSystem(() => rabid.task.getById(overridden)).group_id ?? null, null);
        assertThrows(() => asSystem(() => rabid.volunteer_group.getById(og)));
        assertEquals(mine(carol), ['Borrow tables', 'Price stickers']);
    });
});

test("project assignCommittee: live committee assignment, inherited by tasks; customize snapshots", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const c = seedCommittee('Logistics Committee', [bob]);
        const project_id = asSystem(() => rabid.project.insert({name: 'Drive', deleted: 0}));
        const ownGroup = asSystem(() => rabid.project.getById(project_id)).group_id;

        // Host assigns the committee: project aliases the NAMED group, the
        // old owned adhoc group is dropped.
        asUser(alice, () => rabid.project.assignCommittee({project_id, committee_id: c.committee_id}));
        assertEquals(asSystem(() => rabid.project.getById(project_id)).group_id, c.group_id);
        assertThrows(() => asSystem(() => rabid.volunteer_group.getById(ownGroup)));

        // A task in the project INHERITS it: committee member bob can work
        // the task with no task-level assignment at all.
        const task_id = asSystem(() => rabid.task.insert({project_id, title: 'Sort donations', deleted: 0}));
        asUser(bob, () => rabid.subtask.addItem({task_id, title: 'now allowed'}));

        // The project page shows the committee assignment; the task detail's
        // inherited state names the project and offers the override actions.
        const page = await asUser(alice, () => renderRoute(`rabid.project.detailPage(${project_id})`));
        assert(hasText(page, 'Assigned to'));
        assert(hasText(page, 'Membership follows the committee'));
        const detail = await asUser(alice, () => renderRoute(`rabid.task.detailPage(${task_id})`));
        assert(hasText(detail, 'Everyone assigned to'));
        assert(hasText(detail, 'Assign specific people'));

        // Customize: snapshot into a project-owned adhoc group, provenance kept.
        asUser(alice, () => rabid.project.customizeMembers(project_id));
        const p = asSystem(() => rabid.project.getById(project_id));
        const g = asSystem(() => rabid.volunteer_group.getById(p.group_id));
        assertEquals(g.group_kind, 'adhoc');
        assertEquals(g.owner_table, 'project');
        assertEquals(g.owner_id, project_id);
        assertEquals(g.derived_from, 'Logistics Committee');
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id: p.group_id}))
            .map(m => m.volunteer_id), [bob]);
    });
});

test("merged project page: toggleDone completes/reopens from the block checkbox (provenance stamped)", async () => {
    await withTestDb(async ({ bob, carol }) => {
        const {task_id, group_id} = seedTask();
        addToGroup(group_id, bob);

        // Gated like every task edit.
        assertThrows(() => asUser(carol, () => rabid.task.toggleDone(task_id)),
                     Error, 'Not permitted');

        // Check: done, provenance stamped, block reloads.
        const res = asUser(bob, () => rabid.task.toggleDone(task_id)) as any;
        assertEquals(res.targets, [`.-task-${task_id}-`]);
        const t = asSystem(() => rabid.task.getById(task_id));
        assertEquals(t.status, 'done');
        assertEquals(t.done_by, bob);
        // The block renders struck-through with the box checked.
        const block = await asUser(bob, () => renderRoute(`rabid.task.renderTaskBlockById(${task_id})`));
        assert(!!find(block, n => tagOf(n) === 'input' && attr(n, 'checked') !== undefined));
        assert(!!find(block, n => String(attr(n, 'class') ?? '').includes('text-decoration-line-through')));

        // Uncheck: reopens (to 'open'), provenance cleared.
        asUser(bob, () => rabid.task.toggleDone(task_id));
        const t2 = asSystem(() => rabid.task.getById(task_id));
        assertEquals(t2.status, 'open');
        assertEquals(t2.done_time ?? null, null);
    });
});
