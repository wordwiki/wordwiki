// deno-lint-ignore-file no-explicit-any
/**
 * Category table: the controlled vocabulary for lexeme categories.
 *
 * Covers the design decisions that matter (see category.ts):
 *  - admin-only vocabulary changes; any logged-in user can view;
 *  - slug validation + immutability after creation;
 *  - retired categories excluded from the picker query;
 *  - '~' = internal marker;
 *  - order keys append, so the seeded order is presentation order.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertFalse, assertThrows, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, renderRoute } from "./testing.ts";
import { isInternalCategorySlug, Category } from "./category.ts";
import { markupToString } from "../liminal/markup.ts";

test("category slugs: validation and the internal marker", async () => {
    await withTestDb((fx) => {
        as(fx, 'system', () => {
            const cats = fx.ww.categories;
            cats.insert({slug: 'smell-and-taste', name: 'Smell, Taste & Touch'});
            cats.insert({slug: '~old-smell', name: 'smell (old)', retired: 1});
            assertThrows(() => cats.insert({slug: 'Bad Slug!', name: 'nope'}));
            assertThrows(() => cats.insert({slug: '', name: 'nope'}));
            assertThrows(() => cats.insert({slug: '-leading-dash', name: 'nope'}));

            assert(isInternalCategorySlug('~old-smell'));
            assert(isInternalCategorySlug('~needs-human'));
            assertFalse(isInternalCategorySlug('smell-and-taste'));
        });
    });
});

test("category edits are admin-only; viewing is for any logged-in user", async () => {
    await withTestDb(async (fx) => {
        // djz is admin; find a seeded user with NO roles for the other side
        // (dmm is also an admin, so filter by permissions, not by name).
        const nonAdmin = as(fx, 'system', () =>
            fx.ww.users.allUsersByName.all({}).find(u => !u.permissions)!.username);

        as(fx, 'djz', () => {
            fx.ww.categories.insert({slug: 'weather', name: 'Weather',
                                     theme: 'Land, Water & Sky',
                                     description: 'Rain, snow, wind, storms.'});
        });

        // Non-admin: can see the page (open books), gets no edit affordance,
        // and direct mutation attempts are refused.
        await as(fx, nonAdmin, async () => {
            const page = markupToString(await renderRoute(fx.ww, 'wordwiki.categoriesPage()'));
            assertStringIncludes(page, 'Weather');
            const c = fx.ww.categories.bySlug.required({slug: 'weather'});
            assertFalse(fx.ww.categories.canEditRecord(c));
            assertThrows(() => fx.ww.categories.renderForm(c));
            assertThrows(() => fx.ww.categories.saveForm(
                {category_id: String(c.category_id), name: 'Hacked', 'before-name': 'Weather'}));
        });

        // Admin: rename the display name (slug stays).
        as(fx, 'djz', () => {
            const c = fx.ww.categories.bySlug.required({slug: 'weather'});
            assert(fx.ww.categories.canEditRecord(c));
            fx.ww.categories.saveForm({category_id: String(c.category_id),
                                       name: 'Weather & Sky', 'before-name': 'Weather'});
            assertEquals(fx.ww.categories.bySlug.required({slug: 'weather'}).name,
                         'Weather & Sky');
        });
    });
});

test("slug is offered on create but immutable on an existing category", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const cats = fx.ww.categories;

            // Create form offers the slug input...
            const createForm = markupToString(cats.newDialog());
            assertStringIncludes(createForm, 'input-slug');

            cats.insert({slug: 'fire', name: 'Fire & Light'});
            const c = cats.bySlug.required({slug: 'fire'});

            // ...the edit form of an existing record does not.
            const editForm = markupToString(cats.renderForm(c));
            assertFalse(editForm.includes('input-slug'));
            assertStringIncludes(editForm, 'input-name');
        });
    });
});

test("retired categories are excluded from the picker query, kept in the list", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const cats = fx.ww.categories;
            cats.insert({slug: 'body', name: 'Body'});
            cats.insert({slug: '~old-body', name: 'body (old)', retired: 1});

            assertEquals(cats.activeByOrder.all({}).map((c: Category) => c.slug),
                         ['body']);
            assertEquals(cats.allByOrder.all({}).map((c: Category) => c.slug),
                         ['body', '~old-body']);
        });
    });
});

test("insertion order is presentation order (order keys append)", async () => {
    await withTestDb((fx) => {
        as(fx, 'djz', () => {
            const cats = fx.ww.categories;
            // Seed out of alphabetical order: presentation must follow seeding.
            for(const slug of ['family', 'body', 'animals', '~old-zzz', '~old-aaa'])
                cats.insert({slug, name: slug});
            assertEquals(cats.allByOrder.all({}).map((c: Category) => c.slug),
                         ['family', 'body', 'animals', '~old-zzz', '~old-aaa']);
        });
    });
});
