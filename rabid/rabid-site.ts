// Rabid's mount of the shared site editor (components/): the app-specific pieces
// that components can't know - the edit-permission policy and rabid's own block
// kinds.  See site-editor.md.
//
// This is the whole injection seam in practice: `rabid-upcoming-events` is a block
// registered FROM the app, whose render fn reaches into rabid's own DB.  components
// never imports rabid; rabid pushes the block in here at import.

import { h, type Markup } from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import { SiteView } from "../components/site-view.ts";
import { registerBlockKind, type BlockCtx } from "../components/block-registry.ts";
import { FieldSet } from "../liminal/table.ts";
import { rabid } from "./rabid.ts";

// Rabid's site-edit policy: host or admin (or system).  Supplied to the shared
// SiteView by override, so the 'host'/'admin' roles never leak into components.
export class RabidSiteView extends SiteView {
    protected override canEditSite(_site_id: number): boolean {
        const ctx = security.current();
        return !!(ctx?.system || ctx?.roles.has('host') || ctx?.roles.has('admin'));
    }

    // Rabid's chrome wraps the block flow in the standard page container.  (A fuller
    // brand header / nav is a later design pass; the default title + body suffices to
    // prove the app-subclass seam.)
    protected override renderPageChrome(page: { page_title: string }, body: Markup, _ctx: BlockCtx): Markup {
        return [h.div, {class: 'container py-3 rabid-site-page'},
            page.page_title ? [h.h2, {}, page.page_title] : undefined,
            body];
    }
}

// --- Rabid-specific blocks (the injection seam) ----------------------------

// Live upcoming-events list, straight from rabid's event table - a parameterized
// call into the host, exactly what a site-specific block is for.
registerBlockKind({
    kind: 'rabid-upcoming-events', label: 'Upcoming events', category: 'app',
    schema: new FieldSet('rabid-upcoming-events', []),
    render: (_p, _ctx): Markup =>
        [h.div, {class: 'site-block-rabid-events'}, rabid.event.renderUpcomingEvents()],
});
