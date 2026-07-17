// The site renderer: block dispatch, built-in kinds, the TOC built from title
// blocks, unknown-block handling, and app-subclassed chrome.
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assert } from "../liminal/testing/assert.ts";
import { openTestDb, clearAllData } from "../liminal/testing/db-harness.ts";
import * as security from "../liminal/security.ts";
import { setSerialized } from "../liminal/serializable.ts";
import { find, findAll, tagOf, attr, hasClass, hasText, text } from "../liminal/testing/markup-assert.ts";
import { SiteTable, PageTable, BlockTable, siteEditorTables, type Page } from "./site.ts";
import { blockKind, writePayload, type BlockCtx } from "./block-registry.ts";
import { SiteView } from "./site-view.ts";

const site = setSerialized(new SiteTable(), 'site');
const page = setSerialized(new PageTable(), 'page');
const blk = setSerialized(new BlockTable(), 'block');
const view = setSerialized(new SiteView(site, page, blk), 'siteView');

// Insert a block whose payload is built from its (registered) kind's schema.
function addBlock(page_id: number, kind: string, payload: Record<string, any>) {
    const k = blockKind(kind)!;
    blk.insert({page_id, kind, payload: writePayload(k, payload)});
}

// A page with one title, a paragraph, a divider, and a TOC.
function seedPage(): number {
    openTestDb(siteEditorTables);
    clearAllData(siteEditorTables);
    return security.runSystem(() => {
        const s = site.insert({site_title: 'RRBR'});
        const p = page.insert({site_id: s, page_title: 'Welcome'});
        addBlock(p, 'title', {level: 'h2', text: 'Our Hours'});
        addBlock(p, 'text', {text: 'We are **open** Saturdays.'});
        addBlock(p, 'divider', {});
        addBlock(p, 'table-of-contents', {});
        return p;
    });
}

test("built-in blocks render to their semantic tags + classes", () => {
    const p = seedPage();
    const m = security.runSystem(() => view.renderPage(p));
    const title = find(m, n => tagOf(n) === 'h2');
    assert(title && hasClass(title, 'site-block-title'));
    assertEquals(attr(title, 'id'), 'our-hours');           // slugified anchor
    assertEquals(text(title), 'Our Hours');
    assert(find(m, n => hasClass(n, 'site-block-text')));    // markdown block
    assert(find(m, n => tagOf(n) === 'strong'));            // **open** -> <strong>
    assert(find(m, n => tagOf(n) === 'hr' && hasClass(n, 'site-block-divider')));
});

test("table-of-contents links to the page's title anchors", () => {
    const p = seedPage();
    const m = security.runSystem(() => view.renderPage(p));
    const toc = find(m, n => hasClass(n, 'site-block-toc'));
    assert(toc);
    const link = find(toc, n => tagOf(n) === 'a')!;
    assertEquals(attr(link, 'href'), '#our-hours');          // matches the title's id
    assertEquals(text(link), 'Our Hours');
});

test("default chrome wraps the flow with the page title", () => {
    const p = seedPage();
    const m = security.runSystem(() => view.renderPage(p));
    const outer = find(m, n => hasClass(n, 'site-page-outer'));
    assert(outer);
    assert(find(outer, n => tagOf(n) === 'h1' && hasText(n, 'Welcome')));
    assert(find(outer, n => hasClass(n, 'site-page')));      // block flow inside
});

test("unknown block: skipped in output, flagged in edit view", () => {
    openTestDb(siteEditorTables);
    clearAllData(siteEditorTables);
    const { p } = security.runSystem(() => {
        const s = site.insert({site_title: 'S'});
        const p = page.insert({site_id: s, page_title: 'P'});
        blk.insert({page_id: p, kind: 'rabid-only-block', payload: '{}'});  // not registered here
        return { p };
    });
    const output = security.runSystem(() => view.renderPage(p, false));
    assertEquals(findAll(output, n => hasClass(n, 'site-block-unknown')).length, 0);
    const editing = security.runSystem(() => view.renderPage(p, true));
    assert(find(editing, n => hasClass(n, 'site-block-unknown')));
});

test("app-subclassed chrome overrides the frame", () => {
    class BrandedView extends SiteView {
        protected override renderPageChrome(page: Page, body: any, _ctx: BlockCtx) {
            return ['div', {class: 'rrbr-chrome'},
                ['header', {class: 'rrbr-header'}, `RRBR — ${page.page_title}`],
                body];
        }
    }
    const branded = new BrandedView(site, page, blk);
    const p = seedPage();
    const m = security.runSystem(() => branded.renderPage(p));
    assert(find(m, n => hasClass(n, 'rrbr-chrome')));
    assert(find(m, n => hasClass(n, 'rrbr-header') && hasText(n, 'RRBR — Welcome')));
    // The generic block flow still renders inside the app frame.
    assert(find(m, n => hasClass(n, 'site-block-title')));
});
