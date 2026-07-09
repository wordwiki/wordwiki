// The generic photo gallery (gallery.ts): an ordered list of captioned photos
// attachable to ANY owner (owner_table, owner_id) - event / service / committee.
// Edit permission follows the OWNER record's; the section is shape-keyed, cards
// row-keyed.  (Migrated from the old event-specific photo tests + owner-generic
// coverage.)
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { hasText, findByTestId, findAll } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

function insertEvent(): number {
    return asSystem(() => rabid.event.insert({
        event_kind: 'public', description: 'Repair Night', location_description: '',
        location_url: '', is_remote_event: 0, volunteer_only: 0,
        start_time: '2026-06-20 19:00:00', end_time: '2026-06-20 21:30:00',
        total_cash_collected: 0, notes: ''} as any));
}
const ownerPhotos = (owner_table: string, owner_id: number) =>
    asSystem(() => rabid.gallery_photo.forOwner.all({owner_table, owner_id, scope: ''}));

test("gallery: a host sees the section + Add; a regular sees none when empty (on an event)", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();
        const bare = await asUser(bob, () => renderRoute(`rabid.event.detailPage(${id})`));
        assertEquals(findByTestId(bare, `gallery-event-${id}`), undefined, 'no section for a non-editor when empty');

        const host = await asUser(alice, () => renderRoute(`rabid.event.detailPage(${id})`));
        const section = findByTestId(host, `gallery-event-${id}`);
        assert(section, 'host sees the photos section');
        assert(hasText(section, 'Photos') && hasText(section, 'No photos yet'));
    });
});

test("gallery addPhoto: card created; delete removes it; add follows the OWNER's edit permission", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const id = insertEvent();
        // A regular volunteer may not add to an event's gallery (event edit = host/admin).
        await asUser(bob, () => assertRejects(() =>
            invoke(`rabid.gallery_photo.addPhoto($arg0)`, {owner_table: 'event', owner_id: id})));

        const res = await asUser(alice, () =>
            invoke(`rabid.gallery_photo.addPhoto($arg0)`,
                {owner_table: 'event', owner_id: id, caption: 'Before we started'}));
        assertEquals(res.action, 'reload');
        const rows = ownerPhotos('event', id);
        assertEquals(rows.length, 1);
        assertEquals(rows[0].caption, 'Before we started');
        assertEquals(rows[0].owner_table, 'event');
        assertEquals(rows[0].owner_id, id);

        await asUser(alice, () => invoke(`rabid.gallery_photo.remove($arg0)`, rows[0].gallery_photo_id));
        assertEquals(ownerPhotos('event', id).length, 0);
    });
});

test("gallery card: image + caption + photographer; Edit caption form omits the bound owner fields", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        const photoPath = `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`;
        const pid = asSystem(() => rabid.gallery_photo.insert(
            {owner_table: 'event', owner_id: id, caption: 'Big turnout',
             photographer: 'Ada Lens', photo: photoPath} as any));

        const card = await asUser(alice, () => renderRoute(`rabid.gallery_photo.renderPhotoCardById(${pid})`));
        assert(hasText(card, 'Big turnout'));
        assert(hasText(card, 'Ada Lens'));
        const imgs = findAll(card, (m: any) => Array.isArray(m) && m[0] === 'img');
        assert(imgs.length >= 1, 'the image renders');
        assertStringIncludes((imgs[0] as any[])[1].src, 'rabid.photo');

        // The caption/photographer form carries those fields, NOT the bound owner.
        const form = await asUser(alice, () => renderRoute(`rabid.gallery_photo.renderDetailsForm(${pid})`));
        const input = (name: string) => findAll(form, (m: any) =>
            Array.isArray(m) && m[0] === 'input' && (m[1] as any)?.name === name);
        assertEquals(input('owner_id').length, 0, 'no owner_id field');
        assertEquals(input('owner_table').length, 0, 'no owner_table field');
        assert(input('caption').length >= 1, 'has a caption field');
        assert(input('photographer').length >= 1, 'has a photographer field');
    });
});

test("gallery add dialog goes straight to a file picker (+ caption/photographer)", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        const dialog = await asUser(alice, () =>
            renderRoute(`rabid.gallery_photo.newPhotoDialog('event', ${id})`));
        const s = JSON.stringify(dialog);
        assert(s.includes('lmPhotoFieldChange') && s.includes('rabid.photo'), 'has a photo file picker');
        assert(s.includes('caption') && s.includes('photographer'), 'has caption + photographer');
        assert(s.includes('addPhoto'), 'submits to addPhoto');
    });
});

test("gallery: insert-after and move-up reorder the cards", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        const order = () => ownerPhotos('event', id).map(p => p.gallery_photo_id);
        const add = () => asUser(alice, () =>
            invoke(`rabid.gallery_photo.addPhoto($arg0)`, {owner_table: 'event', owner_id: id}));
        await add(); await add();
        const [A, B] = order();

        await asUser(alice, () => invoke(`rabid.gallery_photo.insertRelative($arg0, $arg1)`, A, 'after'));
        const ids = order();
        assertEquals(ids.length, 3);
        assertEquals(ids[0], A);
        assertEquals(ids[2], B);

        await asUser(alice, () => invoke(`rabid.gallery_photo.moveUp($arg0)`, B));
        assertEquals(order()[1], B);
    });
});

test("gallery attaches to service + committee too (generic owner)", async () => {
    await withTestDb(async ({ alice }) => {
        // Service: add a photo, it shows on the detail page under its own gallery.
        const eid = insertEvent();
        const sid = asSystem(() => rabid.service.insert(
            {event_id: eid, client_name: 'Jo', service_kind: 'full', bike_description: 'Red mtb'} as any));
        await asUser(alice, () => invoke(`rabid.gallery_photo.addPhoto($arg0)`,
            {owner_table: 'service', owner_id: sid, caption: 'Bent rim'}));
        const sdetail = await asUser(alice, () => renderRoute(`rabid.service.detailPage(${sid})`));
        assert(findByTestId(sdetail, `gallery-service-${sid}`), 'service detail carries the gallery');
        assert(hasText(sdetail, 'Bent rim'), 'the service photo caption shows');

        // Committee: the section renders for a host (its own owner scope).
        const cid = asSystem(() => rabid.committee.insert({name: 'Outreach'} as any));
        const cdetail = await asUser(alice, () => renderRoute(`rabid.committee.detailPage(${cid})`));
        assert(findByTestId(cdetail, `gallery-committee-${cid}`), 'committee detail carries the gallery');
    });
});

test("scope: two galleries on one owner are independent (event photos vs service sheets)", async () => {
    await withTestDb(async ({ alice }) => {
        const id = insertEvent();
        await asUser(alice, () => invoke(`rabid.gallery_photo.addPhoto($arg0)`,
            {owner_table: 'event', owner_id: id, caption: 'Action shot'}));                 // default scope
        await asUser(alice, () => invoke(`rabid.gallery_photo.addPhoto($arg0)`,
            {owner_table: 'event', owner_id: id, scope: 'service-sheets', caption: 'Sheet 1'}));
        assertEquals(ownerPhotos('event', id).length, 1, 'default scope has just its photo');
        assertEquals(asSystem(() => rabid.gallery_photo.forOwner.all(
            {owner_table: 'event', owner_id: id, scope: 'service-sheets'})).length, 1, 'sheets scope has just its photo');

        // The event detail renders BOTH galleries - distinct testids + the sheets heading.
        const detail = await asUser(alice, () => renderRoute(`rabid.event.detailPage(${id})`));
        assert(findByTestId(detail, `gallery-event-${id}`), 'the default gallery');
        assert(findByTestId(detail, `gallery-event-${id}-service-sheets`), 'the service-sheets gallery');
        assert(hasText(detail, 'Service Record Sheets'), 'the sheets heading');
    });
});
