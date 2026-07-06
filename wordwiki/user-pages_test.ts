// deno-lint-ignore-file no-explicit-any
/**
 * The users admin pages, verified VIA DISPATCH (renderRoute) - the
 * route-undeclared pattern's lesson: a method reached by URL but missing
 * @route 404s under strict routeterp, and direct-call tests can't see it
 * (the users detail page shipped unreachable exactly this way).
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertFalse, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, as, renderRoute } from "./testing.ts";
import { markupToString } from "../liminal/markup.ts";

test("users list: quiet navigable rows (no pencil / no inline Activity); ☰ only for editors", async () => {
    await withTestDb(async (fx) => {
        const nonAdmin = as(fx, 'system', () =>
            fx.ww.users.allUsersByName.all({}).find(u => !u.permissions)!.username);

        const adminPage = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, 'wordwiki.usersPage()')));
        // Rows: accent-link names to the detail page, nothing else.
        assertStringIncludes(adminPage, 'lm-nav-link');
        assertStringIncludes(adminPage, 'users.detailPage(');
        assertFalse(adminPage.includes('lm-edit-pencil'), 'row pencils are retired');
        assertFalse(adminPage.includes('Activity'), 'inline Activity buttons are retired');
        // The create verb lives in the header ☰ (editors only).
        assertStringIncludes(adminPage, 'New user…');

        const viewerPage = markupToString(await as(fx, nonAdmin, () =>
            renderRoute(fx.ww, 'wordwiki.usersPage()')));
        assertFalse(viewerPage.includes('New user…'));
    });
});

test("user detail: reachable via dispatch; pencil gates on edit; Activity feed embedded", async () => {
    await withTestDb(async (fx) => {
        const nonAdmin = as(fx, 'system', () =>
            fx.ww.users.allUsersByName.all({}).find(u => !u.permissions)!.username);
        const djzId = as(fx, 'system', () =>
            fx.ww.users.allUsersByName.all({}).find(u => u.username === 'djz')!.user_id);

        const adminPage = markupToString(await as(fx, 'djz', () =>
            renderRoute(fx.ww, `wordwiki.users.detailPage(${djzId})`)));
        assertStringIncludes(adminPage, 'djz');
        assertStringIncludes(adminPage, 'lm-edit-pencil');
        // The embedded participating feed (the old inline button's home).
        assertStringIncludes(adminPage, 'Activity');
        assertStringIncludes(adminPage, 'lm-feed');

        const viewerPage = markupToString(await as(fx, nonAdmin, () =>
            renderRoute(fx.ww, `wordwiki.users.detailPage(${djzId})`)));
        assertFalse(viewerPage.includes('lm-edit-pencil'));
        assertStringIncludes(viewerPage, 'lm-feed');
    });
});

test("users fragment + dialog routes dispatch (the hx-get / dialog URLs)", async () => {
    await withTestDb(async (fx) => {
        const djzId = as(fx, 'system', () =>
            fx.ww.users.allUsersByName.all({}).find(u => u.username === 'djz')!.user_id);
        for (const expr of ['wordwiki.users.renderUserList()',
                            `wordwiki.users.renderUserRowById(${djzId})`,
                            `wordwiki.users.renderDetail(${djzId})`,
                            'wordwiki.users.newDialog()']) {
            const html = markupToString(await as(fx, 'djz', () => renderRoute(fx.ww, expr)));
            assert(html.length > 0, `${expr} must dispatch`);
        }
        // The sibling latent gaps: the category / lexical-form LIST fragments
        // (their post-insert reload targets) must dispatch too.
        for (const expr of ['wordwiki.categories.renderCategoryList()',
                            'wordwiki.lexicalForms.renderLexicalFormList()']) {
            const html = markupToString(await as(fx, 'djz', () => renderRoute(fx.ww, expr)));
            assert(html.length > 0, `${expr} must dispatch`);
        }
    });
});
