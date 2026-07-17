// The site editor wired into rabid: the shared components render through rabid's
// mounted SiteView, the app-injected `rabid-upcoming-events` block reaches rabid's
// own DB, and the edit policy gates by rabid role (host/admin).
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { find, findAll, hasClass, hasText, attr, tagOf } from "../liminal/testing/markup-assert.ts";
import { withTestDb, asUser, asSystem, asAnon, renderRoute, invoke } from "./testing.ts";
import { getRabid } from "./rabid.ts";
import { blockKind } from "../components/block-registry.ts";

test("rabid mounts the site editor: a site + page + block flow renders through SiteView", async () => {
    await withTestDb((fx) => {
        const r = getRabid();
        const { page_id } = asSystem(() => {
            const site_id = r.site.insert({site_title: 'redraccoon.org'});
            const page_id = r.sitePage.insert({site_id, page_title: 'Welcome'});
            return { page_id };
        });
        // Host adds two blocks through the shared edit dispatch.
        asUser(fx.alice, () => {
            r.siteView.addBlock(page_id, 'title');
            r.siteView.addBlock(page_id, 'rabid-upcoming-events');
        });
        const m = asUser(fx.alice, () => r.siteView.renderPage(page_id, false));
        // Rabid's brand chrome wraps the flow; the block flow rendered.
        assert(find(m, n => hasClass(n, 'rrbr-site')));
        assert(find(m, n => hasClass(n, 'site-page')));
        // The app-injected block rendered rabid content (NOT an unknown-block stub).
        assert(find(m, n => hasClass(n, 'site-block-rabid-events')));
        assertEquals(findAll(m, n => hasClass(n, 'site-block-unknown')).length, 0);
    });
});

test("the rabid-upcoming-events block is registered from the app (the injection seam)", () => {
    const k = blockKind('rabid-upcoming-events');
    assert(k && k.category === 'app');
});

// Route-level dispatch (the direct-call tests above would miss a missing @route -
// see the route-undeclared bug pattern): the /site page + the authoring mutations
// must resolve through the interpreter, POST-gated.
test("authoring UI dispatches through routes (page + create mutations)", async () => {
    await withTestDb(async (fx) => {
        // The /site index page renders.
        const index = await asUser(fx.alice, () => renderRoute('site'));
        assert(find(index, n => hasText(n, 'New site')));
        // createSite -> createPage over the route layer, then the editor page renders.
        const s = await asUser(fx.alice, () => invoke('rabid.siteView.createSite($arg0)', {site_title: 'Live'}));
        assertEquals(s.action, 'reload');
        const site_id = asSystem(() => getRabid().site.listAll.all({})[0].site_id);
        await asUser(fx.alice, () => invoke('rabid.siteView.createPage($arg0)', {site_id, page_title: 'Home'}));
        const page_id = asSystem(() => getRabid().sitePage.forSite.all({site_id})[0].page_id);
        // /site({page:N}) now opens the BRANDED editor (edit mode) for that page.
        const editor = await asUser(fx.alice, () => renderRoute(`site({page:${page_id}})`));
        assert(find(editor, n => hasClass(n, 'rrbr-site-editing')));
        assert(find(editor, n => hasClass(n, 'rrbr-edit-toolbar')));
        assert(find(editor, n => hasText(n, 'Home')));
        // A regular volunteer is refused at the route layer too.
        await asUser(fx.bob, async () => {
            let threw = false;
            try { await invoke('rabid.siteView.createSite($arg0)', {site_title: 'No'}); } catch { threw = true; }
            assert(threw);
        });
    });
});

test("brand chrome: published page renders a standalone document with masthead, nav, footer", async () => {
    await withTestDb(async (fx) => {
        const r = getRabid();
        const { home_id } = asSystem(() => {
            const site_id = r.site.insert({site_title: 'redraccoon.org'});
            const home_id = r.sitePage.insert({site_id, page_title: 'Home', published: 1, nav_visible: 1});
            r.sitePage.insert({site_id, page_title: 'About', slug: 'about', published: 1, nav_visible: 1});
            r.sitePage.insert({site_id, page_title: 'Secret', published: 0, nav_visible: 1});  // draft: not in nav
            return { home_id };
        });
        asUser(fx.alice, () => r.siteView.addBlock(home_id, 'title'));
        const doc = asUser(fx.alice, () => r.siteView.renderPublicPage(home_id));
        // A full standalone document (its own <head> with the brand stylesheet).
        assertEquals(find(doc, n => hasClass(n, 'rrbr-site-title') && hasText(n, 'Home')) !== undefined, true);
        assert(find(doc, n => (n[0] as any) === 'head'));
        // Masthead brand + footer.
        assert(find(doc, n => hasClass(n, 'rrbr-site-brand')));
        assert(find(doc, n => hasClass(n, 'rrbr-site-footer')));
        // Nav lists the two PUBLISHED pages (not the draft), with Home active.
        const navItems = findAll(doc, n => hasClass(n, 'rrbr-site-nav-item'));
        assertEquals(navItems.length, 2);
        assertEquals(navItems.filter(n => hasClass(n, 'active')).length, 1);
        assert(navItems.some(n => hasText(n, 'About')));
        assertEquals(findAll(doc, n => hasText(n, 'Secret')).length, 0);
        // The block flow rendered inside the chrome.
        assert(find(doc, n => hasClass(n, 'site-page')));
        // The public route dispatches (would catch a missing @route).
        const viaRoute = await asUser(fx.alice, () => renderRoute(`rabid.siteView.renderPublicPage(${home_id})`));
        assert(find(viaRoute, n => hasClass(n, 'rrbr-site-brand')));
        // The standalone doc must link rabid.css (holds the .rrbr-site-*/.site-block-*
        // rules) - else the public page renders unstyled (caught in a puppeteer run).
        assert(find(doc, n => tagOf(n) === 'link' && String(attr(n, 'href')).includes('rabid.css')));
    });
});

test("public home (/p/) resolves the slug-less published page even when an earlier site has none", async () => {
    await withTestDb(async () => {
        const r = getRabid();
        asSystem(() => {
            // An earlier site (lower id) with ONLY a draft page - must not shadow the
            // real home (the /p/ bug: home resolution had picked the first site by id).
            const draftSite = r.site.insert({site_title: 'Old Draft Site'});
            r.sitePage.insert({site_id: draftSite, page_title: 'WIP', slug: '', published: 0, nav_visible: 1});
            // The live site, with a published slug-less home.
            const liveSite = r.site.insert({site_title: 'redraccoon.org'});
            r.sitePage.insert({site_id: liveSite, page_title: 'Welcome Home', slug: '', published: 1, nav_visible: 1});
        });
        const home = await asAnon(() => renderRoute('rabid.renderPublicSite("")'));
        assert(find(home, n => hasClass(n, 'rrbr-site-title') && hasText(n, 'Welcome Home')));
        assertEquals(findAll(home, n => hasText(n, 'Page not found')).length, 0);
    });
});

test("editor shows a 'View published' link to the brand-chrome page", async () => {
    await withTestDb((fx) => {
        const r = getRabid();
        const page_id = asSystem(() => {
            const site_id = r.site.insert({site_title: 'S'});
            return r.sitePage.insert({site_id, page_title: 'P'});
        });
        const editor = asUser(fx.alice, () => r.siteView.renderPageEditor(page_id));
        const link = find(editor, n => tagOf(n) === 'a' && hasText(n, 'View published'))!;
        assert(link);
        // Emitted route exprs must self-resolve to the mounted path (regression:
        // SiteView is not a Table, so `${this}` needs its own toString) - NOT
        // '[object Object]'.
        assertEquals(attr(link, 'href'), `/rabid.siteView.renderPublicPage(${page_id})`);
    });
});

test("public serving: /p/<slug> rewrites to the anonymous published-page route", () => {
    const r = getRabid() as any;
    assertEquals(r.routeExprFromPath('/p/about'), 'rabid.renderPublicSite("about")');
    assertEquals(r.routeExprFromPath('/p/'), 'rabid.renderPublicSite("")');
    assertEquals(r.routeExprFromPath('/p'), 'rabid.renderPublicSite("")');
    // A normal path is untouched.
    assertEquals(r.routeExprFromPath('/volunteers'), 'volunteers');
});

test("public serving: a published page is reachable ANONYMOUSLY by slug; drafts are not", async () => {
    await withTestDb(async () => {
        const r = getRabid();
        asSystem(() => {
            const site_id = r.site.insert({site_title: 'redraccoon.org'});
            const home = r.sitePage.insert({site_id, page_title: 'Home', slug: '', published: 1, nav_visible: 1});
            r.sitePage.insert({site_id, page_title: 'About', slug: 'about', published: 1, nav_visible: 1});
            r.sitePage.insert({site_id, page_title: 'Draft', slug: 'draft', published: 0, nav_visible: 1});
            return home;
        });
        // Anonymous visitor: /p/about resolves and renders the brand chrome.
        const about = await asAnon(() => renderRoute('rabid.renderPublicSite("about")'));
        assert(find(about, n => hasClass(n, 'rrbr-site-title') && hasText(n, 'About')));
        assert(find(about, n => hasClass(n, 'rrbr-site-brand')));
        // Empty slug -> the home page.
        const home = await asAnon(() => renderRoute('rabid.renderPublicSite("")'));
        assert(find(home, n => hasClass(n, 'rrbr-site-title') && hasText(n, 'Home')));
        // A draft slug is NOT served publicly (published-only) -> not found.
        const draft = await asAnon(() => renderRoute('rabid.renderPublicSite("draft")'));
        assert(find(draft, n => hasText(n, 'Page not found')));
        assertEquals(findAll(draft, n => hasClass(n, 'rrbr-site-title')).length, 0);
        // The relaxed siteView OBJECT gate must not expose authoring: anon reaching
        // an authenticated method through it is still denied at the method.
        let denied = false;
        try { await asAnon(() => renderRoute('rabid.siteView.renderSiteIndex()')); } catch { denied = true; }
        assert(denied);
    });
});

test("public serving: nav links use pretty /p/<slug> URLs", async () => {
    await withTestDb(async () => {
        const r = getRabid();
        const about = asSystem(() => {
            const site_id = r.site.insert({site_title: 'S'});
            r.sitePage.insert({site_id, page_title: 'Home', slug: '', published: 1, nav_visible: 1});
            return r.sitePage.insert({site_id, page_title: 'About', slug: 'about', published: 1, nav_visible: 1});
        });
        const doc = await asAnon(() => renderRoute(`rabid.renderPublicSite("about")`));
        const navLink = find(doc, n => tagOf(n) === 'a' && hasText(n, 'About'))!;
        assertEquals(attr(navLink, 'href'), '/p/about');
        // The slug-less home links to /p/.
        const homeLink = find(doc, n => tagOf(n) === 'a' && hasText(n, 'Home'))!;
        assertEquals(attr(homeLink, 'href'), '/p/');
        assert(Number.isInteger(about));
    });
});

test("image-and-text: app-registered block renders image + prose with a side class", async () => {
    assertEquals(blockKind('image-and-text')?.category, 'content');
    await withTestDb((fx) => {
        const r = getRabid();
        const page_id = asSystem(() => {
            const site_id = r.site.insert({site_title: 'S'});
            return r.sitePage.insert({site_id, page_title: 'P', published: 1, nav_visible: 1});
        });
        asUser(fx.alice, () => {
            r.siteView.addBlock(page_id, 'image-and-text');
            const bid = asSystem(() => r.block.forPage.all({page_id})[0].block_id);
            r.siteView.editBlockPayload({block_id: bid, image: 'abc123.jpg', image_side: 'right', text: '**hi**'});
        });
        const m = asUser(fx.alice, () => r.siteView.renderPage(page_id, false));
        assert(find(m, n => hasClass(n, 'site-block-image-text') && hasClass(n, 'side-right')));
        assert(find(m, n => tagOf(n) === 'img' && hasClass(n, 'site-block-image-text-img')));
        assert(find(m, n => tagOf(n) === 'strong'));   // markdown **hi** -> <strong>
    });
});

test("image-and-text: the block editor form has the photo picker (file input) + text field", async () => {
    await withTestDb((fx) => {
        const r = getRabid();
        const page_id = asSystem(() => {
            const site_id = r.site.insert({site_title: 'S'});
            return r.sitePage.insert({site_id, page_title: 'P'});
        });
        const bid = asUser(fx.alice, () => {
            r.siteView.addBlock(page_id, 'image-and-text');
            return asSystem(() => r.block.forPage.all({page_id})[0].block_id);
        });
        const form = asUser(fx.alice, () => r.siteView.renderBlockEditForm(bid));
        // The ImageField picker: a file input that uploads through rabid's photo store.
        assert(find(form, n => tagOf(n) === 'input' && attr(n, 'type') === 'file'));
        // The hidden path field + the text field.
        assert(find(form, n => tagOf(n) === 'input' && attr(n, 'name') === 'image'));
        assert(find(form, n => tagOf(n) === 'input' && attr(n, 'name') === 'text'));
    });
});

test("single-site /site opens the branded editor directly; edit tabs link to page editors + mark drafts", async () => {
    await withTestDb(async (fx) => {
        const r = getRabid();
        asSystem(() => {
            const s = r.site.insert({site_title: 'RRBR'});
            r.sitePage.insert({site_id: s, page_title: 'Home', published: 1, nav_visible: 1});
            r.sitePage.insert({site_id: s, page_title: 'About', slug: 'about', published: 0, nav_visible: 1});
        });
        // One site -> straight into the branded editor (NOT the page list).
        const entry = await asUser(fx.alice, () => renderRoute('site'));
        assert(find(entry, n => hasClass(n, 'rrbr-site-editing')));
        assert(find(entry, n => hasClass(n, 'rrbr-edit-toolbar')));
        // Tabs link to sibling page EDITORS, and the draft is marked.
        const aboutTab = find(entry, n => tagOf(n) === 'a' && hasText(n, 'About'))!;
        assert(String(attr(aboutTab, 'href')).startsWith('/site({page:'));
        assert(find(entry, n => hasClass(n, 'rrbr-nav-draft')));
        // The page list stays reachable at /site({list:1}).
        const list = await asUser(fx.alice, () => renderRoute('site({list:1})'));
        assert(find(list, n => hasText(n, 'New page')));
    });
});

test("renderEditPage is a chromeless (no-navbar) page so the branded editor owns the top", () => {
    const r = getRabid();
    return withTestDb((fx) => {
        const pid = asSystem(() => {
            const s = r.site.insert({site_title: 'S'});
            return r.sitePage.insert({site_id: s, page_title: 'P'});
        });
        const pg = asUser(fx.alice, () => r.siteView.renderEditPage(pid));
        assertEquals(pg.noNavbar, true);
    });
});

test("togglePublished flips the flag (admin only)", async () => {
    await withTestDb((fx) => {
        const r = getRabid();
        const pid = asSystem(() => {
            const s = r.site.insert({site_title: 'S'});
            return r.sitePage.insert({site_id: s, page_title: 'P', published: 0});
        });
        asUser(fx.alice, () => r.siteView.togglePublished(pid));
        assertEquals(asSystem(() => r.sitePage.getById(pid).published), 1);
        asUser(fx.alice, () => r.siteView.togglePublished(pid));
        assertEquals(asSystem(() => r.sitePage.getById(pid).published), 0);
        asUser(fx.bob, () => assertThrows(() => r.siteView.togglePublished(pid), Error, 'Not permitted'));
    });
});

test("edit policy: host/admin may edit, a regular volunteer may not", async () => {
    await withTestDb((fx) => {
        const r = getRabid();
        const page_id = asSystem(() => {
            const site_id = r.site.insert({site_title: 'S'});
            return r.sitePage.insert({site_id, page_title: 'P'});
        });
        // A regular volunteer is blocked by the injected canEditSite policy.
        asUser(fx.bob, () =>
            assertThrows(() => r.siteView.addBlock(page_id, 'divider'), Error, 'Not permitted'));
        assertEquals(asSystem(() => r.block.forPage.all({page_id}).length), 0);
        // Host and admin may.
        asUser(fx.alice, () => r.siteView.addBlock(page_id, 'divider'));
        asUser(fx.dave, () => r.siteView.addBlock(page_id, 'title'));
        assertEquals(asSystem(() => r.block.forPage.all({page_id}).length), 2);
    });
});
