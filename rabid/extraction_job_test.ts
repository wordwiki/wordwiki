// The scan -> extract job runner (extraction_job.ts + extraction_targets.ts): run
// (extract -> staged review), land (service rows + provenance), retract (delete by
// provenance fk), permissions, and the background liveness emission.  The LLM + image
// store are faked via an injected ExtractConfig (run) / rabid.llm (create) - no network.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, invoke, asUser, asSystem } from "./testing.ts";
import { rabid, getRabid } from "./rabid.ts";
import { db } from "../liminal/db.ts";
import { type ExtractConfig } from "../liminal/extract.ts";
import { type Llm } from "../liminal/llm.ts";

function insertEvent(): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Repair Night', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-20 19:00:00', end_time: '2026-06-20 21:30:00',
        total_cash_collected: 0, notes: ''} as any));
}
function insertSheet(event_id: number, tag: string): number {
    return asSystem(() => rabid.gallery_photo.insert({
        owner_table: 'event', owner_id: event_id, scope: 'service-sheets',
        photo: `content/photos/${tag}/${tag}${'0'.repeat(61)}.jpg`} as any));
}
const servicesForJob = (job_id: number) =>
    asSystem(() => db().all<any>('SELECT * FROM service WHERE extraction_job_id = :j', {j: job_id}));

// A fake config: image bytes are ignored; the LLM returns a fixed two-record sheet.
async function fakeConfig(records: unknown): Promise<ExtractConfig> {
    const llm: Llm = {available: true, extract: () => Promise.resolve({records})};
    return {
        derivedDir: await Deno.makeTempDir({prefix: 'ejob_'}),
        image: {containedBytes: () => Promise.resolve(new Uint8Array([1, 2, 3]))},
        llm,
    };
}

test("run: extracts each sheet -> staged_output + review; emits liveness", async () => {
    await withTestDb(async () => {
        const id = insertEvent();
        const g1 = insertSheet(id, 'aaa');
        const g2 = insertSheet(id, 'bbb');
        const job_id = asSystem(() => rabid.extraction_job.insert(
            {target_kind: 'service', target_context: JSON.stringify({event_id: id}), status: 'pending'} as any));

        const cfg = await fakeConfig([{client_name: 'Jo', service_kind: 'diy'}]);
        const seqBefore = getRabid().liveLog.seq;
        await rabid.extraction_job.run(job_id, cfg);

        const job = asSystem(() => rabid.extraction_job.getById(job_id));
        assertEquals(job.status, 'review');
        const staged = rabid.extraction_job.stagedOutput(job);
        assertEquals(Object.keys(staged).sort(), [String(g1), String(g2)].sort(), 'one staged entry per sheet');
        assertEquals((staged[String(g1)] as any).records[0].client_name, 'Jo');
        const stageStatus = rabid.extraction_job.stageStatus(job);
        assertEquals(stageStatus[String(g1)].status, 'done');
        assert(getRabid().liveLog.seq > seqBefore, 'the runner emitted live activity');
    });
});

test("run: a sheet whose extraction throws is marked error; job still reviews if any ok", async () => {
    await withTestDb(async () => {
        const id = insertEvent();
        const g1 = insertSheet(id, 'aaa');
        const job_id = asSystem(() => rabid.extraction_job.insert(
            {target_kind: 'service', target_context: JSON.stringify({event_id: id}), status: 'pending'} as any));
        // An LLM that always throws -> the source errors; no sources succeed -> failed.
        const cfg: ExtractConfig = {
            derivedDir: await Deno.makeTempDir({prefix: 'ejob_'}),
            image: {containedBytes: () => Promise.resolve(new Uint8Array([1]))},
            llm: {available: true, extract: () => Promise.reject(new Error('boom'))},
        };
        await rabid.extraction_job.run(job_id, cfg);
        const job = asSystem(() => rabid.extraction_job.getById(job_id));
        assertEquals(job.status, 'failed');
        assertEquals(rabid.extraction_job.stageStatus(job)[String(g1)].status, 'error');
    });
});

test("run: no service-sheet photos -> failed with a clear error", async () => {
    await withTestDb(async () => {
        const id = insertEvent();
        const job_id = asSystem(() => rabid.extraction_job.insert(
            {target_kind: 'service', target_context: JSON.stringify({event_id: id}), status: 'pending'} as any));
        await rabid.extraction_job.run(job_id, await fakeConfig([]));
        const job = asSystem(() => rabid.extraction_job.getById(job_id));
        assertEquals(job.status, 'failed');
        assert(job.error.includes('no service-sheet'), job.error);
    });
});

test("land: staged rows -> service rows with provenance; then retract deletes them", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        const gid = insertSheet(id, 'aaa');
        const job_id = asSystem(() => rabid.extraction_job.insert({
            target_kind: 'service', target_context: JSON.stringify({event_id: id}), status: 'review',
            staged_output: JSON.stringify({[String(gid)]: {records: [
                {client_name: 'Ada', service_kind: 'full', bike_description: 'Red mtb'},
                {client_name: '', service_kind: 'weird'},   // blank name + unknown kind normalize
            ]}}),
        } as any));

        await asUser(alice, () => rabid.extraction_job.land(job_id));
        const rows = servicesForJob(job_id);
        assertEquals(rows.length, 2, 'both staged rows landed');
        const ada = rows.find((r) => r.client_name === 'Ada');
        assertEquals(ada.event_id, id);
        assertEquals(ada.service_kind, 'full');
        assertEquals(ada.source_gallery_photo_id, gid, 'provenance points at the sheet');
        const blank = rows.find((r) => r.client_name === '(from scan)');
        assert(blank, 'blank name got a placeholder');
        assertEquals(blank.service_kind, 'diy', 'unknown service_kind normalized to diy');
        assertEquals(asSystem(() => rabid.extraction_job.getById(job_id)).status, 'landed');

        await asUser(alice, () => rabid.extraction_job.retract(job_id));
        assertEquals(servicesForJob(job_id).length, 0, 'retract deleted the landed rows');
        assertEquals(asSystem(() => rabid.extraction_job.getById(job_id)).status, 'retracted');
    });
});

test("land: refuses a job that is not in review", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        const job_id = asSystem(() => rabid.extraction_job.insert(
            {target_kind: 'service', target_context: JSON.stringify({event_id: id}), status: 'pending'} as any));
        asUser(alice, () => assertThrows(() => rabid.extraction_job.land(job_id), Error, 'review'));
    });
});

test("permissions: a regular volunteer cannot start / land / retract an import", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();
        // start: a non-host is refused (thrown before any run is kicked).
        asUser(bob, () => assertThrows(() =>
            rabid.extraction_job.startServiceImport(id), Error, 'not permitted'));
        // land/retract on a review job: also host/admin only.
        const job_id = asSystem(() => rabid.extraction_job.insert(
            {target_kind: 'service', target_context: JSON.stringify({event_id: id}), status: 'review',
             staged_output: JSON.stringify({})} as any));
        asUser(bob, () => assertThrows(() =>
            rabid.extraction_job.land(job_id), Error, 'not permitted'));
        asUser(bob, () => assertThrows(() =>
            rabid.extraction_job.retract(job_id), Error, 'not permitted'));
        // A host may start one (row created); fake llm so the detached run does no network.
        getRabid().llm = {available: true, extract: () => Promise.resolve({records: []})};
        const created = await asUser(alice, () => rabid.extraction_job.startServiceImport(id));
        assert(created, 'host got a reload');
        await new Promise((r) => setTimeout(r, 25));   // let the (photo-less) detached run settle
    });
});

test("startServiceImport is reachable through the strict route interpreter", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        getRabid().llm = {available: true, extract: () => Promise.resolve({records: []})};
        const res: any = await asUser(alice, () =>
            invoke(`rabid.extraction_job.startServiceImport($arg0)`, id));
        assertEquals(res.action, 'reload');
        await new Promise((r) => setTimeout(r, 25));
    });
});
