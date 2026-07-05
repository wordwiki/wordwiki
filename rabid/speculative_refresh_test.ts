// deno-lint-ignore-file no-explicit-any
// Speculative one-round-trip refresh (liminal.ts applySpeculation + the
// txd/renderForm speculation declarations), HYBRID semantics: the mutation's
// actual dirty set (auto-emitted; see dirty_keys_test.ts) is partitioned
// against the client's speculation - anticipated keys get their sections
// rendered into the same response ({action:'swap'}), leftover keys ride along
// as reloadTargets for the client to resolve (and mostly prune) the old way.
// Only a round with NOTHING anticipated (or a malformed/failed speculation)
// falls back to the plain {action:'reload'} flow with a speculation marker.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, asUser, asSystem, as, invoke } from "./testing.ts";
import { rabid, getRabid } from "./rabid.ts";
import * as markup from "../liminal/markup.ts";

// A project + one task owned by the fixture's host (alice), matching
// task_test.ts's seed shape.
function seedTask(): {project_id: number, task_id: number} {
    return asSystem(() => {
        const project_id = rabid.project.insert({name: 'Bike Drive', deleted: 0});
        const task_id = rabid.task.insert({project_id, title: 'Book truck', deleted: 0});
        return {project_id, task_id};
    });
}

const blockUrl = (task_id: number) => `rabid.task.renderTaskBlockById(${task_id})`;

test("hybrid hit: anticipated section rendered in-response; leftover keys returned as reloadTargets", async () => {
    await withTestDb(async ({ alice }) => {
        const { project_id, task_id } = seedTask();
        await as(alice, async () => {
            // invoke = production shape: hand result merged with the
            // automatic emission (row + table + fk keys + provenance).
            const result = await invoke(`rabid.task.toggleDone($arg0)`, task_id);
            assert(result.targets.includes(`.-task-${task_id}-`));
            assert(result.targets.includes('.-task-'));
            assert(result.targets.includes(`.-task-project_id-${project_id}-`));

            const rowKey = `.-task-${task_id}-`;
            const swapped = await getRabid().applySpeculation(result, {
                deps: [rowKey, '.-volunteer-'],
                sections: [
                    {url: blockUrl(task_id), keys: [rowKey]},
                    // matched only by an over-speculated (not actually dirty)
                    // key - must NOT be rendered.
                    {url: 'rabid.task.renderTaskBlockById(999999)', keys: ['.-volunteer-']},
                ],
            });
            assertEquals(swapped.action, 'swap');
            assertEquals(swapped.sections.length, 1);
            assertEquals(swapped.sections[0].url, blockUrl(task_id));
            // Unanticipated keys (table key, fk keys, done_by provenance)
            // come back for the client to resolve/prune - NOT a miss.
            assert(Array.isArray(swapped.reloadTargets));
            assert(swapped.reloadTargets.includes('.-task-'));
            assert(swapped.reloadTargets.includes(`.-task-project_id-${project_id}-`));
            assert(!swapped.reloadTargets.includes(rowKey));
            // The html is the bare fragment, rendered with post-mutation state.
            const expected = await markup.asyncRenderToStringViaLinkeDOM(
                await getRabid().dispatch(blockUrl(task_id), {httpMethod: 'GET'}), false);
            assertEquals(swapped.sections[0].html, expected);
            assert(!swapped.sections[0].html.includes('<html'));
        });
    });
});

test("full-coverage speculation has no reloadTargets; leading '/' section urls tolerated", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = await invoke(`rabid.task.toggleDone($arg0)`, task_id);
            const swapped = await getRabid().applySpeculation(result, {
                deps: result.targets,   // speculate everything actually emitted
                sections: [{url: '/' + blockUrl(task_id), keys: [`.-task-${task_id}-`]}],
            });
            assertEquals(swapped.action, 'swap');
            assertEquals(swapped.sections.length, 1);
            assertEquals(swapped.reloadTargets, undefined);
        });
    });
});

test("a dirty key in deps but covered by NO rendered section -> reload (not a swap that drops it)", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            // The shape of a checklist-item title edit: the ITEM's row key is
            // dirtied (and over-speculated into deps), but the client sent only
            // the SHAPE-keyed list wrapper (removeContainedRoots pruned the row
            // as "contained"), and the shape key is NOT emitted by a title edit.
            // No section renders -> must fall back to reload and RETURN the row
            // key (it was silently dropped: {action:swap,sections:[],targets}
            // whose targets the client's swap handler ignores).
            const result = {action: 'reload',
                targets: ['.-subtask-', '.-subtask-5-', `.-subtask-task_id-${task_id}-`]};
            const out = await getRabid().applySpeculation(result, {
                deps: ['.-subtask-5-', `.-subtask-task_id-${task_id}-shape-`],   // over-speculated superset
                sections: [{url: `rabid.subtask.renderChecklist(${task_id})`,
                            keys: [`.-subtask-task_id-${task_id}-shape-`]}],   // shape key not emitted
            });
            assertEquals(out.action, 'reload');
            assertEquals(out.speculation, 'miss');
            assert(out.targets.includes('.-subtask-5-'), 'the item row key survives for the client to reload');
        });
    });
});

test("nothing anticipated -> plain reload with speculation:'miss'", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = await invoke(`rabid.task.moveUp($arg0)`, task_id);
            const out = await getRabid().applySpeculation(result, {
                deps: ['.-task-999999-'],   // matches no actual target
                sections: [{url: blockUrl(task_id), keys: ['.-task-999999-']}],
            });
            assertEquals(out.action, 'reload');
            assertEquals(out.speculation, 'miss');
        });
    });
});

test("a section url naming a mutation is rejected (GET) and falls back with speculation:'error'", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = await invoke(`rabid.task.toggleDone($arg0)`, task_id);
            const out = await getRabid().applySpeculation(result, {
                deps: [`.-task-${task_id}-`],
                sections: [{url: `rabid.task.toggleDone(${task_id})`, keys: [`.-task-${task_id}-`]}],
            });
            assertEquals(out.action, 'reload');
            assertEquals(out.speculation, 'error');
            // ...and the sneaky section was NOT executed: still done from the
            // one legitimate toggle above.
            assertEquals(asSystem(() => rabid.task.getById(task_id)).status, 'done');
        });
    });
});

test("denied and undeclared section urls fall back with speculation:'error'", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const { project_id, task_id } = seedTask();
        // bob (a plain volunteer) may not reach the hostOrAdmin newDialog route.
        await as(bob, async () => {
            const result = {action: 'reload', targets: [`.-task-${task_id}-`]};
            const denied = await getRabid().applySpeculation(result, {
                deps: [`.-task-${task_id}-`],
                sections: [{url: `rabid.task.newDialog(${project_id})`, keys: [`.-task-${task_id}-`]}],
            });
            assertEquals(denied.speculation, 'error');
        });
        await as(alice, async () => {
            const result = {action: 'reload', targets: [`.-task-${task_id}-`]};
            const undeclared = await getRabid().applySpeculation(result, {
                deps: [`.-task-${task_id}-`],
                sections: [{url: 'rabid.task.noSuchRoute(1)', keys: [`.-task-${task_id}-`]}],
            });
            assertEquals(undeclared.speculation, 'error');
        });
    });
});

test("insert: whole-table speculation anticipates the wrapper; the new row's pk key is leftover", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = await invoke(`rabid.project.saveForm($arg0)`,
                                        {name: 'Plant Sale', 'before-name': ''});
            assert(result.targets.includes('.-project-'));
            // The section stands in for a list wrapper registered '.-project-'.
            const swapped = await getRabid().applySpeculation(result, {
                deps: ['.-project-'],
                sections: [{url: blockUrl(task_id), keys: ['.-project-']}],
            });
            assertEquals(swapped.action, 'swap');
            assertEquals(swapped.sections.length, 1);
            // The new row's pk key can't be speculated - it rides as leftover
            // (and the client prunes it: no fragment carries it yet).
            assert((swapped.reloadTargets ?? []).some((t: string) => /^\.-project-\d+-$/.test(t)));
        });
    });
});

test("malformed speculation and the section cap fall back ('error' / 'skipped')", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = {action: 'reload', targets: [`.-task-${task_id}-`]};
            for(const bad of [null, 'x', {deps: 'nope', sections: []},
                              {deps: [], sections: [{url: 7, keys: []}]},
                              {deps: [`.-task-${task_id}-`]}])
                assertEquals((await getRabid().applySpeculation(result, bad)).speculation, 'error');

            const tooMany = Array.from({length: 21}, (_, i) =>
                ({url: `rabid.task.renderTaskBlockById(${i})`, keys: [`.-task-${task_id}-`]}));
            const out = await getRabid().applySpeculation(result, {
                deps: [`.-task-${task_id}-`], sections: tooMany});
            assertEquals(out.speculation, 'skipped');
        });
    });
});

test("renderForm's default dispatch speculates via txd(dirtyKeysFor-derived defaults)", async () => {
    await withTestDb(async ({ alice }) => {
        const { project_id, task_id } = seedTask();
        const form = await as(alice, () =>
            rabid.task.renderForm(asSystem(() => rabid.task.getById(task_id))));
        const onsubmit = findOnsubmit(form);
        assert(typeof onsubmit === 'string', 'edit form has an onsubmit');
        assert(onsubmit!.startsWith('event.preventDefault(); txd('),
               `onsubmit dispatches via txd: ${onsubmit}`);
        assert(onsubmit!.includes(`.-task-${task_id}-`),
               `onsubmit speculates the row key: ${onsubmit}`);
        assert(onsubmit!.includes(`.-task-project_id-${project_id}-`),
               `onsubmit speculates the project fk key: ${onsubmit}`);
        assert(onsubmit!.includes('rabid.task.saveForm('),
               `onsubmit still dispatches saveForm: ${onsubmit}`);
    });
});

// renderParamForm returns [h.form, {attrs}, ...]; dig out the form's onsubmit
// wherever it sits (markup arrays nest).
function findOnsubmit(m: any): string | undefined {
    if(Array.isArray(m)) {
        if(m.length >= 2 && m[1] && typeof m[1] === 'object' && !Array.isArray(m[1])
           && typeof m[1].onsubmit === 'string')
            return m[1].onsubmit;
        for(const c of m) {
            const r = findOnsubmit(c);
            if(r !== undefined) return r;
        }
    }
    return undefined;
}
