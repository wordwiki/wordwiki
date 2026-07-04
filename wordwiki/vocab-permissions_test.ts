// deno-lint-ignore-file no-explicit-any
/**
 * The dedicated management grants: edit-users / edit-categories /
 * edit-lexical-forms (admin implies each, per the approve-role convention).
 * Without the grant the edit buttons don't render (canEditRecord drives
 * them) and the server refuses the form/save; with it both work.  The
 * users table keeps self-service edits, and its permissions FIELD stays
 * admin-only so edit-users cannot escalate itself.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "../liminal/testing/assert.ts";
import { withTestDb, as, type Fixture } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";

const plain = {actorId: 999, roles: []};                       // no grants at all

test("categories: edit-categories (or admin) gates buttons, form, and save", async () => {
    await withTestDb((fx) => {
        const cats = fx.ww.categories;
        // Without the grant: no New button on the page, form refused.
        as(fx, plain, () => {
            assertEquals(cats.canEditRecord({} as any), false);
            const page = markupToString(cats.renderCategoriesPage());
            assertEquals(page.includes('newDialog'), false);
            assertThrows(() => cats.renderForm({} as any), Error, 'Not permitted');
            assertThrows(() => cats.saveForm({slug: 'zoo', 'before-slug': '',
                                              name: 'Zoo', 'before-name': ''}));
        });
        // With the dedicated grant (NOT admin): everything works.
        as(fx, {actorId: 999, roles: ['edit-categories']}, () => {
            assert(cats.canEditRecord({} as any));
            assertStringIncludes(markupToString(cats.renderCategoriesPage()), 'newDialog');
            cats.saveForm({slug: 'zoo', 'before-slug': '', name: 'Zoo', 'before-name': ''});
            assertEquals(cats.bySlug.first({slug: 'zoo'})?.name, 'Zoo');
        });
    });
});

test("lexical forms: edit-lexical-forms (or admin) gates the same way", async () => {
    await withTestDb((fx) => {
        const forms = fx.ww.lexicalForms;
        as(fx, plain, () => {
            assertEquals(forms.canEditRecord({} as any), false);
            assertThrows(() => forms.renderForm({} as any), Error, 'Not permitted');
        });
        as(fx, {actorId: 999, roles: ['edit-lexical-forms']}, () => {
            assert(forms.canEditRecord({} as any));
            forms.saveForm({slug: 'vta', 'before-slug': '', name: 'verb ta', 'before-name': ''});
            assertEquals(forms.bySlug.first({slug: 'vta'})?.name, 'verb ta');
        });
    });
});

test("users: edit-users manages records but cannot touch permissions; self-edit survives", async () => {
    await withTestDb((fx) => {
        const users = fx.ww.users;
        const dmm = as(fx, 'system', () => users.byUsername.first({username: 'dmm'})!);
        const gml = as(fx, 'system', () => users.byUsername.first({username: 'gml'})!);

        // Without any grant: someone ELSE's record is refused...
        as(fx, plain, () => {
            assertEquals(users.canEditRecord(gml), false);
            assertThrows(() => users.renderForm(gml), Error, 'Not permitted');
        });
        // ...but a user still edits their OWN record (self-service fields).
        as(fx, 'gml', () => {
            assert(users.canEditRecord(gml));
            users.saveForm({user_id: String(gml.user_id),
                            name: 'G. Laroque', 'before-name': gml.name});
            assertEquals(as(fx, 'system', () => users.getById(gml.user_id)).name,
                         'G. Laroque');
        });
        // The edit-users grant manages anyone...
        as(fx, {actorId: 999, roles: ['edit-users']}, () => {
            assert(users.canEditRecord(dmm));
            users.saveForm({user_id: String(dmm.user_id),
                            name: 'Diane M.', 'before-name': dmm.name});
            // ...EXCEPT the permissions field (admin-only: no self-escalation).
            assertThrows(() => users.saveForm({user_id: String(dmm.user_id),
                                               permissions: 'admin',
                                               'before-permissions': dmm.permissions ?? ''}));
        });
        // Admin can grant roles.
        as(fx, 'djz', () => {
            users.saveForm({user_id: String(gml.user_id),
                            permissions: 'edit-categories',
                            'before-permissions': gml.permissions ?? ''});
            assertEquals(as(fx, 'system', () => users.getById(gml.user_id)).permissions,
                         'edit-categories');
        });
    });
});

test("users: username is immutable after create (assertion data stores it)", async () => {
    await withTestDb((fx) => {
        const users = fx.ww.users;
        const dmm = as(fx, 'system', () => users.byUsername.first({username: 'dmm'})!);
        // NOT even admin renames an existing user - the initials live in the
        // dictionary's assertion attributes; a rename would strand that data.
        as(fx, 'djz', () => {
            assertThrows(() => users.saveForm({user_id: String(dmm.user_id),
                                               username: 'renamed',
                                               'before-username': dmm.username}));
        });
        // ...nor the user themselves.
        as(fx, 'dmm', () => {
            assertThrows(() => users.saveForm({user_id: String(dmm.user_id),
                                               username: 'renamed',
                                               'before-username': dmm.username}));
        });
        // At CREATE the username is settable (it has to be).
        as(fx, {actorId: 999, roles: ['edit-users']}, () => {
            users.saveForm({username: 'zz9', 'before-username': '',
                            name: 'New Person', 'before-name': ''});
            assertEquals(as(fx, 'system', () => users.byUsername.first({username: 'zz9'}))?.name,
                         'New Person');
        });
    });
});
