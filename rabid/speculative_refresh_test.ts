// deno-lint-ignore-file no-explicit-any
// Speculative one-round-trip refresh (liminal.ts applySpeculation + the
// txd/renderForm speculation declarations): a mutation whose ACTUAL dirty set
// is a subset of the client's SPECULATED set gets its affected fragments
// rendered into the same response ({action:'swap'}); anything else falls back
// to the plain {action:'reload'} two-trip flow, annotated with a
// speculation marker.  Section urls are client-supplied and go through the
// normal route interpreter as GETs, so mutations/denied/undeclared routes all
// fall back rather than render.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, asUser, asSystem, as } from "./testing.ts";
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

test("speculation hit: mutation + section render in one response; over-speculated sections skipped", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = rabid.task.toggleDone(task_id) as any;
            assertEquals(result, {action: 'reload', targets: [`.-task-${task_id}-`]});

            const swapped = await getRabid().applySpeculation(result, {
                deps: [`.-task-${task_id}-`, '.-volunteer-'],
                sections: [
                    {url: blockUrl(task_id), keys: [`.-task-${task_id}-`]},
                    // matched only by an over-speculated (not actually dirty)
                    // key - must NOT be rendered.
                    {url: 'rabid.task.renderTaskBlockById(999999)', keys: ['.-volunteer-']},
                ],
            });
            assertEquals(swapped.action, 'swap');
            assertEquals(swapped.targets, [`.-task-${task_id}-`]);
            assertEquals(swapped.sections.length, 1);
            assertEquals(swapped.sections[0].url, blockUrl(task_id));
            // The html is the bare fragment (no document wrapper), rendered
            // with the post-mutation state.
            const expected = await markup.asyncRenderToStringViaLinkeDOM(
                await getRabid().dispatch(blockUrl(task_id), {httpMethod: 'GET'}), false);
            assertEquals(swapped.sections[0].html, expected);
            assert(!swapped.sections[0].html.includes('<html'));
            assert(swapped.sections[0].html.includes('Book truck'));
        });
    });
});

test("speculation hit: a leading '/' on a section url is tolerated (wordwiki-style hx-gets)", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = rabid.task.toggleDone(task_id) as any;
            const swapped = await getRabid().applySpeculation(result, {
                deps: [`.-task-${task_id}-`],
                sections: [{url: '/' + blockUrl(task_id), keys: [`.-task-${task_id}-`]}],
            });
            assertEquals(swapped.action, 'swap');
            assertEquals(swapped.sections.length, 1);
        });
    });
});

test("under-speculation: an unanticipated target falls back with speculation:'miss'", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            // moveUp dirties the whole table ('.-task-'), which the (bad)
            // speculation below did not anticipate.
            const result = rabid.task.moveUp(task_id) as any;
            assertEquals(result.targets, ['.-task-']);
            const out = await getRabid().applySpeculation(result, {
                deps: [`.-task-${task_id}-`],
                sections: [{url: blockUrl(task_id), keys: [`.-task-${task_id}-`]}],
            });
            assertEquals(out, {...result, speculation: 'miss'});
        });
    });
});

test("a section url naming a mutation is rejected (GET) and falls back with speculation:'error'", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = rabid.task.toggleDone(task_id) as any;
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

test("insert: whole-table speculation ('.-table-') covers the no-pk saveForm path", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        await as(alice, async () => {
            const result = rabid.project.saveForm({name: 'Plant Sale', 'before-name': ''}) as any;
            assertEquals(result, {action: 'reload', targets: ['.-project-']});
            // The section stands in for a list wrapper tagged '.-project-'.
            const swapped = await getRabid().applySpeculation(result, {
                deps: ['.-project-'],
                sections: [{url: blockUrl(task_id), keys: ['.-project-']}],
            });
            assertEquals(swapped.action, 'swap');
            assertEquals(swapped.sections.length, 1);
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

test("speculatedSaveTargets mirrors saveForm: base pk/no-pk, subtask task-key, timesheet volunteer_time rider", async () => {
    await withTestDb(({ bob }) => {
        // Base default: pk -> row key; no pk -> table key.
        assertEquals(rabid.project.speculatedSaveTargets({project_id: 7} as any), ['.-project-7-']);
        assertEquals(rabid.project.speculatedSaveTargets({} as any), ['.-project-']);
        // Subtask: keyed by the parent TASK (matches its saveForm retarget).
        assertEquals(rabid.subtask.speculatedSaveTargets({subtask_id: 3, task_id: 9} as any),
                     ['.-subtask-9-']);
        // Timesheet: the volunteer_time fragment rides along on updates
        // (matches its saveForm target-append).
        assertEquals(rabid.timesheet_entry.speculatedSaveTargets(
                         {timesheet_entry_id: 4, volunteer_id: bob} as any),
                     ['.-timesheet_entry-4-', `.-volunteer_time-${bob}-`]);
        assertEquals(rabid.timesheet_entry.speculatedSaveTargets({} as any),
                     ['.-timesheet_entry-']);
    });
});

test("renderForm's default dispatch speculates via txd(speculatedSaveTargets)", async () => {
    await withTestDb(async ({ alice }) => {
        const { task_id } = seedTask();
        const form = await as(alice, () =>
            rabid.task.renderForm(asSystem(() => rabid.task.getById(task_id))));
        const onsubmit = findOnsubmit(form);
        assert(typeof onsubmit === 'string', 'edit form has an onsubmit');
        assert(onsubmit!.includes(`txd(["` + `.-task-${task_id}-` + `"])`),
               `onsubmit speculates the row key: ${onsubmit}`);
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
