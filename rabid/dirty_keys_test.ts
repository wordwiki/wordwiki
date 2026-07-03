// deno-lint-ignore-file no-explicit-any
// The richer dependency model's emission half (liminal/dirty.ts +
// Table.dirtyKeysFor and the insert/updateNamedFields/delete funnels): every
// write notifies ALL levels - the whole-table key, the row key, and one fk
// key per declared foreign key (before-values always, new values when an fk
// changes).  Collected ambiently per request and merged into response
// targets; a no-collector call records nothing.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, withDirtyTargets, invoke, asUser, asSystem } from "./testing.ts";
import { rabid } from "./rabid.ts";
import * as dirty from "../liminal/dirty.ts";

function seedTask(): {project_id: number, task_id: number} {
    return asSystem(() => {
        const project_id = rabid.project.insert({name: 'Bike Drive', deleted: 0});
        const task_id = rabid.task.insert({project_id, title: 'Book truck', deleted: 0});
        return {project_id, task_id};
    });
}

const has = (targets: string[], key: string) =>
    assert(targets.includes(key), `expected ${key} in [${targets.join(', ')}]`);
const hasNot = (targets: string[], key: string) =>
    assert(!targets.includes(key), `expected NO ${key} in [${targets.join(', ')}]`);

test("insert emits table + row + fk keys (null fks skipped)", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        const { result: sid, targets } = await withDirtyTargets(() =>
            asUser(alice, () => rabid.subtask.insert({task_id, title: 'step', done: 0})));
        has(targets, '.-subtask-');
        has(targets, `.-subtask-${sid}-`);
        has(targets, `.-subtask-task_id-${task_id}-`);
        // done_by is null on an unchecked insert - no fk key for it.
        hasNot(targets, '.-subtask-done_by-null-');
        // task.touch is DELIBERATELY silent (raw write, poll-only consumer).
        hasNot(targets, `.-task-${task_id}-`);
    });
});

test("update emits row + UNCHANGED before-fk keys + changed-fk NEW values", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        const sid = asSystem(() => rabid.subtask.insert({task_id, title: 'step', done: 0}));

        // A title-only rename still notifies the checklist's task fk key.
        const rename = await withDirtyTargets(() =>
            asUser(alice, () => rabid.subtask.update(sid, {title: 'step 2'})));
        has(rename.targets, '.-subtask-');
        has(rename.targets, `.-subtask-${sid}-`);
        has(rename.targets, `.-subtask-task_id-${task_id}-`);

        // Toggling done sets done_by - the provenance fk's NEW value is emitted.
        const toggle = await withDirtyTargets(() =>
            asUser(alice, () => rabid.subtask.toggle(sid)));
        has(toggle.targets, `.-subtask-task_id-${task_id}-`);
        has(toggle.targets, `.-subtask-done_by-${alice}-`);
    });
});

test("an fk CHANGE emits both the old and the new parent's keys", async () => {
    await withTestDb(async () => {
        const { project_id, task_id } = seedTask();
        const p2 = asSystem(() => rabid.project.insert({name: 'Plant Sale', deleted: 0}));
        const { targets } = await withDirtyTargets(() =>
            asSystem(() => rabid.task.update(task_id, {project_id: p2})));
        has(targets, `.-task-project_id-${project_id}-`);   // the list it left
        has(targets, `.-task-project_id-${p2}-`);           // the list it joined
        has(targets, `.-task-${task_id}-`);
        has(targets, '.-task-');
    });
});

test("Table.delete emits from the before-row; subtask.remove goes through it", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        const sid = asSystem(() => rabid.subtask.insert({task_id, title: 'doomed', done: 0}));
        const { targets } = await withDirtyTargets(() =>
            asUser(alice, () => rabid.subtask.remove(sid)));
        has(targets, '.-subtask-');
        has(targets, `.-subtask-${sid}-`);
        has(targets, `.-subtask-task_id-${task_id}-`);
        assertEquals(asSystem(() => rabid.subtask.forTask.all({task_id})).length, 0);
    });
});

test("collector survives runSystem blocks; absent collector records nothing; empty update emits nothing", async () => {
    await withTestDb(async () => {
        // Separate AsyncLocalStorage: a system block inside the collector
        // still records (production mutations routinely runSystem sub-steps).
        const { targets } = await withDirtyTargets(() =>
            asSystem(() => rabid.project.insert({name: 'Sys', deleted: 0})));
        has(targets, '.-project-');

        // Without a collector, record() is a silent no-op.
        assertEquals(dirty.current(), undefined);
        dirty.record(['.-nowhere-']);   // must not throw
        const p = asSystem(() => rabid.project.insert({name: 'Uncollected', deleted: 0}));
        assert(p > 0);

        // Zero named fields: db().update no-ops, and so does emission.
        const empty = await withDirtyTargets(() =>
            asSystem(() => rabid.project.update(p, {} as any)));
        assertEquals(empty.targets, []);
    });
});

test("fkKey validates the field is a declared foreign key", async () => {
    await withTestDb(() => {
        assertEquals(rabid.subtask.fkKey('task_id', 7), '-subtask-task_id-7-');
        assertThrows(() => rabid.subtask.fkKey('title', 7), Error, 'not a declared foreign key');
        assertThrows(() => rabid.subtask.fkKey('tsk_id', 7), Error, 'not a declared foreign key');
    });
});

test("speculatedSaveTargets derives from dirtyKeysFor (table + row + record fk keys)", async () => {
    await withTestDb(() => {
        assertEquals(rabid.subtask.speculatedSaveTargets({subtask_id: 3, task_id: 9} as any),
                     ['.-subtask-', '.-subtask-3-', '.-subtask-task_id-9-']);
        // Insert dialog over a prefilled record: no pk, fk keys ride.
        assertEquals(rabid.task.speculatedSaveTargets({project_id: 88} as any),
                     ['.-task-', '.-task-project_id-88-']);
        assertEquals(rabid.project.speculatedSaveTargets({} as any), ['.-project-']);
    });
});

test("invoke() merges emitted keys like production rpcHandler does", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        const sid = asSystem(() => rabid.subtask.insert({task_id, title: 'step', done: 0}));
        const result = await asUser(alice, () => invoke(`rabid.subtask.toggle($arg0)`, sid));
        assertEquals(result.action, 'reload');
        has(result.targets, `.-subtask-task_id-${task_id}-`);
        has(result.targets, `.-subtask-${sid}-`);
    });
});
