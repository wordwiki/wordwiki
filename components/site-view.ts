// The site renderer: turns a Page's block flow into markup, wrapped in the app's
// chrome.  A coordinator over the three schema tables (site.ts), app-subclassed for
// chrome (site-editor.md "Page chrome is app-subclassed").  The hosting app mounts a
// subclass that overrides renderPageChrome (brand header, nav, footer) and supplies
// the edit-permission policy (added with the edit dispatch).
//
// Importing this module registers the built-in block kinds (via block-kinds.ts).

import { h, type Markup } from "../liminal/markup.ts";
import { blockKind, readPayload, type BlockCtx, type Heading } from "./block-registry.ts";
import { slugify } from "./block-kinds.ts";
import "./block-kinds.ts";
import type { Page, SiteTable, PageTable, BlockTable, Block } from "./site.ts";

export class SiteView {
    constructor(
        public siteTable: SiteTable,
        public pageTable: PageTable,
        public blockTable: BlockTable,
    ) {}

    // Render a page: its block flow, wrapped in the app chrome.  `editing` selects
    // the read/output path (published site + static generator) vs the editable path
    // (edit affordances added with the edit dispatch).
    renderPage(page_id: number, editing = false): Markup {
        const page = this.pageTable.getById(page_id);
        const blocks = this.blockTable.forPage.all({page_id});
        const ctx: BlockCtx = {
            site_id: page.site_id, dict: {}, editing,
            headings: this.collectHeadings(blocks),
        };
        const body = [h.div, {class: 'site-page'}, blocks.map(b => this.renderBlock(b, ctx))];
        return this.renderPageChrome(page, body, ctx);
    }

    // One block: dispatch to its kind.  A kind absent from the registry (e.g. a
    // rabid-only block rendered under wordwiki) is skipped in output, flagged in edit.
    renderBlock(b: Block, ctx: BlockCtx): Markup {
        const k = blockKind(b.kind);
        if(!k)
            return ctx.editing
                ? [h.div, {class: 'site-block-unknown'}, `Unknown block: ${b.kind}`]
                : '';
        return k.render(readPayload(k, b.payload), ctx);
    }

    // The page's headings in order, from every block whose kind defines heading().
    private collectHeadings(blocks: Block[]): Heading[] {
        const out: Heading[] = [];
        for(const b of blocks) {
            const k = blockKind(b.kind);
            if(k?.heading) {
                const hd = k.heading(readPayload(k, b.payload));
                if(hd) out.push({...hd, anchor: slugify(hd.text)});
            }
        }
        return out;
    }

    // The app-subclassed frame.  Default: page title + body.  A hosting app overrides
    // this to render its brand header (page.hero_image + page.page_title), nav (from
    // this.pageTable.forSite), and footer.  This is "more power than CSS".
    protected renderPageChrome(page: Page, body: Markup, _ctx: BlockCtx): Markup {
        return [h.div, {class: 'site-page-outer'},
            page.page_title ? [h.h1, {class: 'site-page-title'}, page.page_title] : undefined,
            body];
    }
}
