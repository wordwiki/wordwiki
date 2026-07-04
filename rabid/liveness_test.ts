// deno-lint-ignore-file no-explicit-any
// App-level liveness wiring (liminal.ts recordLiveActivity + the livePoll
// route): mutation dirty sets reach the live log and stamp mutation-shaped
// responses with {seq, epoch}; the poll route answers through routeterp under
// the normal auth gate (production-enabled - no test-harness gating).
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects } from "../liminal/testing/assert.ts";
import { withTestDb, invoke, asUser, asSystem, asAnon } from "./testing.ts";
import { rabid, getRabid } from "./rabid.ts";

function seedChecklistItem(): {task_id: number, subtask_id: number} {
    return asSystem(() => {
        const project_id = rabid.project.insert({name: 'Bike Drive', deleted: 0});
        const task_id = rabid.task.insert({project_id, title: 'Book truck', deleted: 0});
        const subtask_id = rabid.subtask.insert({task_id, title: 'step', done: 0});
        return {task_id, subtask_id};
    });
}

test("recordLiveActivity appends dirty keys and stamps mutation-shaped responses", async () => {
    await withTestDb(async ({ alice }) => {
        const app = getRabid();
        const before = app.liveLog.seq;

        // A reload-shaped mutation result: appended AND stamped.
        const { task_id, subtask_id } = seedChecklistItem();
        const result = await asUser(alice, () => invoke(`rabid.subtask.toggle($arg0)`, subtask_id));
        const stamped = app.recordLiveActivity(result, []);
        assertEquals(stamped.seq, before + 1);
        assertEquals(stamped.epoch, app.liveLog.epoch);
        assert(stamped.targets.includes(`.-subtask-task_id-${task_id}-`));

        // An alert-shaped result with collected keys: appended, NOT stamped.
        const alert = app.recordLiveActivity({action: 'alert', message: 'x'}, ['.-task-1-']);
        assertEquals(app.liveLog.seq, before + 2);
        assertEquals(alert, {action: 'alert', message: 'x'});

        // Nothing dirty: no append, no stamp.
        const quiet = app.recordLiveActivity({action: 'reload', targets: []}, []);
        assertEquals(app.liveLog.seq, before + 2);
        assertEquals(quiet.seq, undefined);
    });
});

test("a parked poll wakes when another actor's mutation touches a watched key", async () => {
    await withTestDb(async ({ alice }) => {
        const app = getRabid();
        const { task_id, subtask_id } = seedChecklistItem();
        const watchKey = `.-subtask-task_id-${task_id}-`;

        const parked = app.liveLog.poll(
            {epoch: app.liveLog.epoch, sinceSeq: app.liveLog.seq, keys: [watchKey]},
            {timeoutMs: 5_000});

        // "Another actor" toggles the item; production shape = invoke result
        // fed through recordLiveActivity (what rpcHandler does).
        const result = await asUser(alice, () => invoke(`rabid.subtask.toggle($arg0)`, subtask_id));
        app.recordLiveActivity(result, []);

        const answer: any = await parked;
        assertEquals(answer.entries.length, 1);
        assert(answer.entries[0].keys.includes(watchKey));
    });
});

test("livePoll routes through routeterp: resync/immediate answers; anonymous is denied", async () => {
    await withTestDb(async ({ bob }) => {
        const app = getRabid();

        // Stale epoch -> immediate resync (no park, so safe to invoke).
        const resync = await asUser(bob, () =>
            invoke(`rabid.livePoll($arg0)`, {epoch: 'stale', sinceSeq: 0, keys: ['.-task-']}));
        assertEquals(resync, {epoch: app.liveLog.epoch, seq: app.liveLog.seq, resync: true});

        // Pending intersecting entry -> immediate entries.
        app.liveLog.append(['.-task-']);
        const answer = await asUser(bob, () =>
            invoke(`rabid.livePoll($arg0)`,
                   {epoch: app.liveLog.epoch, sinceSeq: app.liveLog.seq - 1, keys: ['.-task-']}));
        assertEquals(answer.entries.length, 1);

        // Anonymous: @route(authenticated) denies under the strict policy.
        await asAnon(() => assertRejects(
            () => invoke(`rabid.livePoll($arg0)`, {keys: ['.-task-']}),
            Error, 'not permitted'));
    });
});

test("the page skeleton carries the poller bootstrap (liveClientConfig)", async () => {
    await withTestDb(() => {
        const app = getRabid();
        const config = app.liveClientConfig();
        assertEquals(config.poll, '/rabid.livePoll($arg0)');
        assertEquals(config.epoch, app.liveLog.epoch);
        assertEquals(typeof config.seq, 'number');
    });
});
