// Rabid's mount of the shared site editor (components/): the app-specific pieces
// that components can't know - the edit-permission policy and rabid's own block
// kinds.  See site-editor.md.
//
// This is the whole injection seam in practice: `rabid-upcoming-events` is a block
// registered FROM the app, whose render fn reaches into rabid's own DB.  components
// never imports rabid; rabid pushes the block in here at import.

import { h, type Markup } from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import { route, authenticated } from "../liminal/security.ts";
import * as templates from "./templates.ts";
import * as config from "./config.ts";
import { assetUrl } from "../liminal/assets.ts";
import { SiteView } from "../components/site-view.ts";
import { registerBlockKind, type BlockCtx } from "../components/block-registry.ts";
import { FieldSet } from "../liminal/table.ts";
import type { Page } from "../components/site.ts";
import { rabid } from "./rabid.ts";

function viewerIsHostOrAdmin(): boolean {
    const ctx = security.current();
    return !!(ctx?.system || ctx?.roles.has('host') || ctx?.roles.has('admin'));
}

// Rabid's site-edit + site-admin policy: host or admin (or system).  Supplied to
// the shared SiteView by override, so the 'host'/'admin' roles never leak into
// components.
export class RabidSiteView extends SiteView {
    protected override canEditSite(_site_id: number): boolean { return viewerIsHostOrAdmin(); }
    protected override canAdminSites(): boolean { return viewerIsHostOrAdmin(); }

    // AUTHORING links swap just rabid's #content region (keeping navbar + scripts).
    // The PUBLIC site nav (renderSiteNav) navigates full pages instead.
    protected override pageNavProps(href: string): Record<string, string> {
        return templates.pageLinkProps(href);
    }

    // The published look for a page (opened from the editor's "View published").
    protected override publicPageUrl(page_id: number): string | undefined {
        return `/${this}.renderPublicPage(${page_id})`;
    }

    // --- Brand chrome: the public Red Raccoon site presentation --------------

    // The brand frame every published page renders inside: a masthead (brand + the
    // page's hero image + title), the site's nav, the block flow, and a footer.  This
    // is the app-subclass power the chrome hook exists for - it reaches rabid's photo
    // pipeline and page table, which components can't.  Structure + `rrbr-site-*`
    // classes only (restyleable), per the CSS goal.
    protected override renderPageChrome(page: Page, body: Markup, _ctx: BlockCtx): Markup {
        return [h.div, {class: 'rrbr-site'},
            this.renderMasthead(page),
            this.renderSiteNav(page),
            [h.main, {class: 'rrbr-site-main'},
             [h.div, {class: 'rrbr-site-container'}, body]],
            [h.footer, {class: 'rrbr-site-footer'},
             [h.div, {class: 'rrbr-site-container'},
              [h.span, {}, 'Red Raccoon Bikes'],
              [h.span, {class: 'rrbr-site-footer-tag'}, 'A volunteer-run community bike shop']]]];
    }

    private renderMasthead(page: Page): Markup {
        const hero = (page.hero_image && page.hero_image !== '')
            ? [h.div, {class: 'rrbr-site-hero'},
               rabid.photo.aspectImg(page.hero_image, 'landscape', 'detail', {class: 'rrbr-site-hero-img'})]
            : undefined;
        return [h.header, {class: 'rrbr-site-header' + (hero ? ' has-hero' : '')},
            hero,
            [h.div, {class: 'rrbr-site-container rrbr-site-masthead'},
             [h.a, {href: `/${this}.renderPublicHome()`, class: 'rrbr-site-brand', 'hx-boost': 'false'},
              'Red Raccoon Bikes'],
             page.page_title ? [h.h1, {class: 'rrbr-site-title'}, page.page_title] : undefined]];
    }

    // The nav: the site's published, nav-visible pages, current page marked.
    private renderSiteNav(page: Page): Markup {
        const pages = security.runSystem(() => this.pageTable.forSite.all({site_id: page.site_id}))
            .filter(p => p.published && p.nav_visible);
        if(pages.length === 0) return undefined as unknown as Markup;
        return [h.nav, {class: 'rrbr-site-nav', 'aria-label': 'Site'},
            [h.ul, {class: 'rrbr-site-container rrbr-site-nav-list'},
             pages.map(p => [h.li, {class: 'rrbr-site-nav-item' + (p.page_id === page.page_id ? ' active' : '')},
                 [h.a, {href: this.publicPageUrl(p.page_id), 'hx-boost': 'false',
                        ...(p.page_id === page.page_id ? {'aria-current': 'page'} : {})},
                  p.page_title || '(untitled)']])]];
    }

    // Serve a published page as a STANDALONE branded document (its own <head> +
    // brand CSS), NOT inside the rabid app shell.  Only the page's author (or, once
    // public serving lands, anyone for a published page) may view it; drafts stay
    // host/admin.  renderPage(..false) applies the brand chrome above.
    @route(authenticated)
    renderPublicPage(page_id: number): Markup {
        const page = this.pageTable.getById(page_id);
        return this.publicDocument(page.page_title || 'Red Raccoon Bikes', this.renderPage(page_id, false));
    }

    // The public site home: the first published+nav-visible page of the first site
    // (a convenience landing for the brand link).  404-ish empty state otherwise.
    @route(authenticated)
    renderPublicHome(): Markup {
        const site = this.siteTable.listAll.all({})[0];
        const first = site && this.pageTable.forSite.all({site_id: site.site_id})
            .find(p => p.published && p.nav_visible);
        if(!first)
            return this.publicDocument('Red Raccoon Bikes',
                [h.div, {class: 'rrbr-site container py-5'}, [h.p, {}, 'No published pages yet.']]);
        return this.renderPublicPage(first.page_id);
    }

    private publicDocument(title: string, content: Markup): Markup {
        return [h.html, {lang: 'en'},
            [h.head, {},
             [h.meta, {charset: 'utf-8'}],
             [h.meta, {name: 'viewport', content: 'width=device-width, initial-scale=1'}],
             [h.title, {}, title],
             config.bootstrapCssLink,
             [h.link, {href: assetUrl('/resources/instance.css'), rel: 'stylesheet', type: 'text/css'}]],
            [h.body, {}, content]];
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
