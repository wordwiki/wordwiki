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
import { FieldSet, ImageField, EnumField, StringField } from "../liminal/table.ts";
import { markdownToMarkup } from "../liminal/markdown.ts";
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
             [h.a, {href: '/p/', class: 'rrbr-site-brand', 'hx-boost': 'false'}, 'Red Raccoon Bikes'],
             page.page_title ? [h.h1, {class: 'rrbr-site-title'}, page.page_title] : undefined]];
    }

    // The public URL for a page: pretty /p/<slug>, or /p/ (the home) for a
    // slug-less page.  Full-page navigation (this is the standalone public site).
    private publicHref(page: Page): string {
        return '/p/' + (page.slug ? encodeURIComponent(page.slug) : '');
    }

    // The nav: the site's published, nav-visible pages, current page marked.
    private renderSiteNav(page: Page): Markup {
        const pages = security.runSystem(() => this.pageTable.forSite.all({site_id: page.site_id}))
            .filter(p => p.published && p.nav_visible);
        if(pages.length === 0) return undefined as unknown as Markup;
        return [h.nav, {class: 'rrbr-site-nav', 'aria-label': 'Site'},
            [h.ul, {class: 'rrbr-site-container rrbr-site-nav-list'},
             pages.map(p => [h.li, {class: 'rrbr-site-nav-item' + (p.page_id === page.page_id ? ' active' : '')},
                 [h.a, {href: this.publicHref(p), 'hx-boost': 'false',
                        ...(p.page_id === page.page_id ? {'aria-current': 'page'} : {})},
                  p.page_title || '(untitled)']])]];
    }

    // PUBLIC serving: a published page by pretty slug.  Called INTERNALLY by the
    // app's single public entry (Rabid.renderPublicSite <- /p/<slug>), so it carries
    // no @route of its own - the public gate lives on that one audited entry.  Only
    // PUBLISHED pages resolve, so drafts are never exposed (staff preview a draft via
    // the authenticated renderPublicPage below).  Empty slug = the site home.
    renderPublicBySlug(slug: string): Markup {
        const page = this.resolvePublicPage(String(slug ?? ''));
        if(!page)
            return this.publicDocument('Not found',
                [h.div, {class: 'rrbr-site'},
                 [h.main, {class: 'rrbr-site-main'},
                  [h.div, {class: 'rrbr-site-container'}, [h.h1, {}, 'Page not found']]]]);
        return this.publicDocument(page.page_title || 'Red Raccoon Bikes', this.renderPage(page.page_id, false));
    }

    private resolvePublicPage(slug: string): Page | undefined {
        return security.runSystem(() => {
            // A published page whose slug matches (empty slug = the home page).
            const bySlug = this.pageTable.publishedBySlug.first({slug});
            if(bySlug) return bySlug;
            // A named slug that doesn't resolve is a genuine 404.  For the home
            // (empty slug) with no slug-less page, fall back to the first published,
            // nav-visible page of any site so `/p/` still lands somewhere.
            if(slug !== '') return undefined;
            for(const s of this.siteTable.listAll.all({})) {
                const p = this.pageTable.forSite.all({site_id: s.site_id}).find(x => x.published && x.nav_visible);
                if(p) return p;
            }
            return undefined;
        });
    }

    // STAFF preview: a page (incl. drafts) as the branded document, from the editor's
    // "View published" link.  Authenticated - the public route above only serves
    // published pages.  renderPage(..false) applies the brand chrome above.
    @route(authenticated)
    renderPublicPage(page_id: number): Markup {
        const page = this.pageTable.getById(page_id);
        return this.publicDocument(page.page_title || 'Red Raccoon Bikes', this.renderPage(page_id, false));
    }

    private publicDocument(title: string, content: Markup): Markup {
        const css = (p: string) => [h.link, {href: assetUrl(p), rel: 'stylesheet', type: 'text/css'}];
        return [h.html, {lang: 'en'},
            [h.head, {},
             [h.meta, {charset: 'utf-8'}],
             [h.meta, {name: 'viewport', content: 'width=device-width, initial-scale=1'}],
             [h.title, {}, title],
             // Match the app's stylesheet chain so blocks + the brand chrome are
             // styled: bootstrap, then liminal (framework), then rabid.css (which
             // holds the .site-block-* and .rrbr-site-* rules).  page-editor /
             // context-menu sheets are editor-only, so the public doc omits them.
             config.bootstrapCssLink,
             css('/resources/instance.css'),
             css('/resources/liminal.css'),
             css('/resources/rabid.css')],
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

// Image + text, side by side (stacks on mobile).  App-registered rather than a
// components built-in because the photo pipeline is rabid's: the payload's
// ImageField points at rabid's photo store (so the block editor's file picker
// uploads through it), and render frames the image via rabid.photo.  components
// stays photo-agnostic - this is the injection seam doing the photo work.
registerBlockKind({
    kind: 'image-and-text', label: 'Image + text', category: 'content',
    schema: new FieldSet('image-and-text', [
        new ImageField('image', 'rabid.photo', {aspect: 'landscape', nullable: true, prompt: 'Image'}),
        new EnumField('image_side', {left: 'Left', right: 'Right'}, {default: 'left'}),
        new StringField('text', {default: '', prompt: 'Text (markdown)'}),
    ]),
    render: (p, _ctx): Markup => {
        const has = typeof p.image === 'string' && p.image !== '';
        const side = p.image_side === 'right' ? ' side-right' : ' side-left';
        return [h.div, {class: 'site-block-image-text' + side},
            has
                ? [h.div, {class: 'site-block-image-text-media'},
                   rabid.photo.aspectImg(String(p.image), 'landscape', 'detail',
                       {class: 'site-block-image-text-img'})]
                : undefined,
            [h.div, {class: 'site-block-image-text-prose'}, markdownToMarkup(String(p.text ?? ''))]];
    },
});
