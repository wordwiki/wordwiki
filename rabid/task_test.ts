// deno-lint-ignore-file no-explicit-any
// The project/task/subtask model (task.ts): host-gated project/task creation,
// the owned adhoc assignee group + assignee edit rights, the prefilled new-task
// dialog (empty before-snapshots on insert), the thin subtask checklist with
// its task-stamp touching, and the standard list/detail markup.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem, as } from "./testing.ts";
import { find, tagOf, attr, hasText, getByTestId } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";
import { db } from "../liminal/db.ts";

// A project + one task, inserted as system; returns the ids and the task's group.
function seedTask(): {project_id: number, task_id: number, group_id: number} {
    return asSystem(() => {
        const project_id = rabid.project.insert({name: 'Bike Drive', deleted: 0});
        const task_id = rabid.task.insert({project_id, title: 'Book truck', deleted: 0});
        return {project_id, task_id, group_id: rabid.task.getById(task_id).group_id};
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

test("task insert creates its owned adhoc assignee group (backlink patched in)", async () => {
    await withTestDb(() => {
        const {task_id, group_id} = seedTask();
        const g = asSystem(() => rabid.volunteer_group.getById(group_id));
        assertEquals(g.group_kind, 'adhoc');
        assertEquals(g.owner_table, 'task');
        assertEquals(g.owner_id, task_id);
        // Owned-group display name falls through to the task's title.
        assertEquals(asSystem(() => rabid.volunteer_group.displayName(g)), 'Book truck');
        // "Unassigned" is an EMPTY group, not NULL.
        assertEquals(asSystem(() => rabid.volunteer_group.members.all({group_id})).length, 0);
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

test("pages: two row species; task detail embeds the member editor and checklist", async () => {
    await withTestDb(async ({ alice, bob, carol }) => {
        const {project_id, task_id, group_id} = seedTask();
        addToGroup(group_id, bob);
        asUser(bob, () => rabid.subtask.addItem({task_id, title: 'Get quotes'}));

        // Projects page: host sees the New-project affordance, regulars don't.
        const hostPage = await asUser(alice, () => renderRoute('rabid.project.renderProjectsPage()'));
        assert(hasText(hostPage, 'New project'));
        const volPage = await asUser(carol, () => renderRoute('rabid.project.renderProjectsPage()'));
        assert(!hasText(volPage, 'New project'));
        // ...and the row species follow recordEdit: editable div for the host,
        // navigable <a> for the regular volunteer.
        assertEquals(tagOf(getByTestId(hostPage, `project-row-${project_id}`)), 'div');
        assertEquals(tagOf(getByTestId(volPage, `project-row-${project_id}`)), 'a');

        // Task rows: the assignee gets the editable species, others navigate.
        const bobTasks = await asUser(bob, () => renderRoute(`rabid.task.renderProjectTasks(${project_id})`));
        assertEquals(tagOf(getByTestId(bobTasks, `task-row-${task_id}`)), 'div');
        const carolTasks = await asUser(carol, () => renderRoute(`rabid.task.renderProjectTasks(${project_id})`));
        assertEquals(tagOf(getByTestId(carolTasks, `task-row-${task_id}`)), 'a');
        assert(hasText(carolTasks, '1 assigned'));
        assert(hasText(carolTasks, '0/1 done'));

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
