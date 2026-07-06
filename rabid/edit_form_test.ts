// The generic field-subset edit form: Table.renderEditForm(record, [names]?) is
// the primary entry point (renderForm forwards to it with all fields).  Driven
// through the real route interpreter, since these are @route members and the
// example calls come straight from client URLs.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asSystem } from "./testing.ts";
import { findAll, hasText } from "../liminal/testing/markup-assert.ts";
import { rabid } from "./rabid.ts";

// Names of the <input> controls actually rendered in a form.
function inputNames(form: any): string[] {
    return findAll(form, (m: any) => Array.isArray(m) && m[0] === 'input')
        .map((m: any) => m[1]?.name).filter((n: any) => typeof n === 'string');
}

test("renderEditForm(record, [names]) renders only those fields (photo-only sub-form)", async () => {
    await withTestDb(async ({ alice, carol }) => {
        // alice (host) edits carol; ask for just the photo.
        const form = await asUser(alice, () =>
            renderRoute(`rabid.volunteer.renderEditForm(rabid.volunteer.getById(${carol}),["photo"])`));
        const names = inputNames(form);
        // The hidden pk is present (so saveForm knows the row) plus the photo
        // control - and nothing else (no name/email/phone inputs).
        assert(names.includes('volunteer_id'), 'hidden pk present');
        assert(names.includes('photo'), 'photo control present');
        assert(!names.includes('name') && !names.includes('email') && !names.includes('phone'),
               `only photo should be edited, got: ${names.join(',')}`);
        // The photo file picker is wired to lmPhotoFieldChange for 'photo'.
        const file = findAll(form, (m: any) =>
            Array.isArray(m) && m[0] === 'input' && m[1]?.type === 'file');
        assertEquals(file.length, 1);
        assertStringIncludes((file[0] as any[])[1].onchange, '"photo"');
    });
});

test("renderEditForm drops fields the actor may not edit; unknown names throw", async () => {
    await withTestDb(async ({ bob }) => {
        // bob edits himself.  is_staff is host-only to edit, so it is silently
        // dropped from bob's sub-form; photo (self-editable) stays.
        const form = await asUser(bob, () =>
            renderRoute(`rabid.volunteer.renderEditForm(rabid.volunteer.getById(${bob}),["photo","is_staff"])`));
        const names = inputNames(form);
        assert(names.includes('photo'));
        assert(!names.includes('is_staff'), 'host-only field dropped for a non-host self-editor');

        // An unknown field name is a caller bug -> throws (same-table resolution).
        await asUser(bob, () => assertRejects(() =>
            renderRoute(`rabid.volunteer.renderEditForm(rabid.volunteer.getById(${bob}),["nope"])`),
            Error, "Unknown field"));
    });
});

test("a photo-only save leaves the other fields untouched", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const before = asSystem(() => rabid.volunteer.getById(carol));
        const photoPath = `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`;
        // Submit only the photo field (+ its before-snapshot + pk), exactly as the
        // sub-form would.
        await asUser(alice, () => invoke('rabid.volunteer.saveForm($arg0)', {
            volunteer_id: String(carol), photo: photoPath, 'before-photo': '',
        }));
        const after = asSystem(() => rabid.volunteer.getById(carol));
        assertEquals(after.photo, photoPath);        // set
        assertEquals(after.name, before.name);       // untouched
        assertEquals(after.email, before.email);     // untouched
        assertEquals(after.phone, before.phone);     // untouched
    });
});

test("renderForm still works (forwards to renderEditForm with all fields)", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const full = await asUser(alice, () =>
            renderRoute(`rabid.volunteer.renderForm(rabid.volunteer.getById(${carol}))`));
        const names = inputNames(full);
        assert(names.includes('name') && names.includes('photo'),
               `full form should carry the ordinary fields, got: ${names.join(',')}`);
    });
});

test("the volunteer detail page offers a photo-only edit affordance", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const detail = await asUser(alice, () => renderRoute(`rabid.volunteer.detailPage(${carol})`));
        assert(hasText(detail, 'Add photo'), 'carol has no photo yet -> "Add photo"');
        assert(JSON.stringify(detail).includes('renderEditForm'),
               'the affordance targets renderEditForm');
    });
});
