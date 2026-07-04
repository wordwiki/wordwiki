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
import * as orderkey from "../liminal/orderkey.ts";

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

test("fkKey/shapeKey validate the field is a declared foreign key", async () => {
    await withTestDb(() => {
        assertEquals(rabid.subtask.fkKey('task_id', 7), '-subtask-task_id-7-');
        assertEquals(rabid.subtask.shapeKey('task_id', 7), '-subtask-task_id-7-shape-');
        assertEquals(rabid.subtask.tableShapeKey(), '-subtask-shape-');
        assertThrows(() => rabid.subtask.fkKey('title', 7), Error, 'not a declared foreign key');
        assertThrows(() => rabid.subtask.fkKey('tsk_id', 7), Error, 'not a declared foreign key');
        assertThrows(() => rabid.subtask.shapeKey('title', 7), Error, 'not a declared foreign key');
    });
});

test("shapeFields default: the ordering column + soft-delete flag where declared", async () => {
    await withTestDb(() => {
        assertEquals(rabid.task.shapeFields, ['order_key', 'deleted']);
        assertEquals(rabid.project.shapeFields, ['deleted']);
        assertEquals(rabid.subtask.shapeFields, ['order_key']);
        assertEquals(rabid.timesheet_entry.shapeFields, []);
    });
});

test("shape emission: inserts/deletes always; updates only on fk moves or shape-field changes", async () => {
    await withTestDb(async () => {
        const { project_id, task_id } = seedTask();
        const shape = `.-task-project_id-${project_id}-shape-`;
        const p2 = asSystem(() => rabid.project.insert({name: 'Plant Sale', deleted: 0}));
        const t2 = asSystem(() => rabid.task.insert({project_id, title: 'Mover', deleted: 0}));

        // Content-only update (status toggle): NO shape keys.
        const toggle = await withDirtyTargets(() =>
            asSystem(() => rabid.task.update(task_id, {status: 'done'})));
        has(toggle.targets, `.-task-project_id-${project_id}-`);
        hasNot(toggle.targets, shape);
        hasNot(toggle.targets, '.-task-shape-');

        // order_key update: shape (a move changes the list's order).
        const last = asSystem(() => rabid.task.getById(t2)).order_key;
        const move = await withDirtyTargets(() =>
            asSystem(() => rabid.task.update(task_id, {order_key: orderkey.between(last, undefined)})));
        has(move.targets, shape);
        has(move.targets, '.-task-shape-');

        // deleted flip: shape (membership of the deleted=0 lists changes).
        const archive = await withDirtyTargets(() =>
            asSystem(() => rabid.task.update(task_id, {deleted: 1})));
        has(archive.targets, shape);

        // fk move: BOTH the old and the new subset's shape keys.
        const moved = await withDirtyTargets(() =>
            asSystem(() => rabid.task.update(t2, {project_id: p2})));
        has(moved.targets, `.-task-project_id-${project_id}-shape-`);
        has(moved.targets, `.-task-project_id-${p2}-shape-`);

        // Insert and delete always emit shape.
        const ins = await withDirtyTargets(() =>
            asSystem(() => rabid.subtask.insert({task_id, title: 'step', done: 0})));
        has(ins.targets, `.-subtask-task_id-${task_id}-shape-`);
        has(ins.targets, '.-subtask-shape-');
        const sid = ins.result as number;
        const del = await withDirtyTargets(() => asSystem(() => rabid.subtask.delete(sid)));
        has(del.targets, `.-subtask-task_id-${task_id}-shape-`);
    });
});

test("speculatedSaveTargets derives from dirtyKeysFor 'all' (content + shape superset)", async () => {
    await withTestDb(() => {
        assertEquals(rabid.subtask.speculatedSaveTargets({subtask_id: 3, task_id: 9} as any),
                     ['.-subtask-', '.-subtask-3-', '.-subtask-task_id-9-',
                      '.-subtask-task_id-9-shape-', '.-subtask-shape-']);
        // Insert dialog over a prefilled record: no pk, fk + shape keys ride.
        assertEquals(rabid.task.speculatedSaveTargets({project_id: 88} as any),
                     ['.-task-', '.-task-project_id-88-',
                      '.-task-project_id-88-shape-', '.-task-shape-']);
        assertEquals(rabid.project.speculatedSaveTargets({} as any),
                     ['.-project-', '.-project-shape-']);
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
