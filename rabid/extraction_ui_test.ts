// The scan -> extract UI (extraction_job.renderEventImports + the gallery menu item):
// the live imports section on the event page, its review grid + Land/Discard, the
// forEvent (json_extract) lookup, and the "Import scanned records…" entry point.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, asUser, asSystem } from "./testing.ts";
import { hasText, findByTestId } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

function insertEvent(desc = 'Repair Night'): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: desc, location_description: '', location_url: '',
        is_remote_event: 0, volunteer_only: 0, start_time: '2026-06-20 19:00:00',
        end_time: '2026-06-20 21:30:00', total_cash_collected: 0, notes: ''} as any));
}
function insertSheet(event_id: number, tag: string): number {
    return asSystem(() => rabid.gallery_photo.insert({
        owner_table: 'event', owner_id: event_id, scope: 'service-sheets',
        photo: `content/photos/${tag}/${tag}${'0'.repeat(61)}.jpg`} as any));
}
function reviewJob(event_id: number, gid: number): number {
    return asSystem(() => rabid.extraction_job.insert({
        target_kind: 'service', target_context: JSON.stringify({event_id}), status: 'review',
        stage_status: JSON.stringify({[String(gid)]: {status: 'done'}}),
        staged_output: JSON.stringify({[String(gid)]: {records: [
            {client_name: 'Ada Lovelace', service_kind: 'full', bike_description: 'Red mtb'},
            {client_name: 'Alan Turing', service_kind: 'diy', bike_description: 'Blue road'},
        ]}}),
    } as any));
}

test("forEvent uses json_extract: returns only this event's jobs", async () => {
    await withTestDb(async () => {
        const e1 = insertEvent('One'); const e2 = insertEvent('Two');
        const j1 = reviewJob(e1, insertSheet(e1, 'aaa'));
        reviewJob(e2, insertSheet(e2, 'bbb'));
        const forE1 = rabid.extraction_job.forEvent(e1);
        assertEquals(forE1.length, 1, 'one job for event 1');
        assertEquals(forE1[0].extraction_job_id, j1);
        assertEquals(rabid.extraction_job.forEvent(e2).length, 1);
        assertEquals(rabid.extraction_job.forEvent(insertEvent('Three')).length, 0, 'none for a fresh event');
    });
});

test("renderEventImports: review job shows status, staged rows, Land + Discard for a host", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        reviewJob(id, insertSheet(id, 'aaa'));
        const sect = await asUser(alice, () => renderRoute(`rabid.extraction_job.renderEventImports(${id})`));
        assert(findByTestId(sect, `event-imports-${id}`), 'the section renders');
        assert(hasText(sect, 'Scanned record imports'), 'heading');
        assert(hasText(sect, 'Needs review'), 'status badge');
        assert(hasText(sect, 'Ada Lovelace') && hasText(sect, 'Alan Turing'), 'staged rows previewed');
        assert(hasText(sect, 'Land 2 records'), 'a Land button with the count');
        assert(hasText(sect, 'Discard'), 'a Discard button');
    });
});

test("renderEventImports: a regular volunteer sees the rows but no Land/Discard actions", async () => {
    await withTestDb(async ({ bob }) => {
        const id = insertEvent();
        reviewJob(id, insertSheet(id, 'aaa'));
        const sect = await asUser(bob, () => renderRoute(`rabid.extraction_job.renderEventImports(${id})`));
        assert(hasText(sect, 'Needs review'), 'status is visible to all');
        assert(!hasText(sect, 'Land 2 records'), 'no Land button for a non-editor');
        assert(!hasText(sect, 'Discard'), 'no Discard button for a non-editor');
    });
});

test("renderEventImports is empty (no heading) when the event has no imports", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        const sect = await asUser(alice, () => renderRoute(`rabid.extraction_job.renderEventImports(${id})`));
        assert(!hasText(sect, 'Scanned record imports'), 'no heading with zero jobs');
    });
});

test("the event detail page carries the imports section after a job exists", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        reviewJob(id, insertSheet(id, 'aaa'));
        const page = await asUser(alice, () => renderRoute(`rabid.event.detailPage(${id})`));
        assert(findByTestId(page, `event-imports-${id}`), 'imports section on the event page');
        assert(hasText(page, 'Ada Lovelace'), 'staged rows show on the page');
    });
});

test("the service-sheets gallery ☰ offers 'Import scanned records…'", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        insertSheet(id, 'aaa');
        const gallery = await asUser(alice, () =>
            renderRoute(`rabid.gallery_photo.renderGallery('event', ${id}, 'service-sheets', 'Service Record Sheets')`));
        assert(hasText(gallery, 'Import scanned records'), 'the menu offers the import action');
        // A plain (non-sheets) gallery does not.
        insertSheet(id, 'bbb');   // noise
        const plain = await asUser(alice, () => renderRoute(`rabid.gallery_photo.renderGallery('event', ${id})`));
        assert(!hasText(plain, 'Import scanned records'), 'the ordinary gallery has no import action');
    });
});
