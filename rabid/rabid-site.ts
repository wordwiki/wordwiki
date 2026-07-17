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
import * as action from "../liminal/action.ts";
import * as templates from "./templates.ts";
import * as config from "./config.ts";
import { assetUrl } from "../liminal/assets.ts";
import { SiteView } from "../components/site-view.ts";
import { registerBlockKind, type BlockCtx } from "../components/block-registry.ts";
import { FieldSet, ImageField, EnumField, MarkdownField, liveReloadableProps, editButtonProps } from "../liminal/table.ts";
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
    static readonly BRAND = 'Red Raccoon Bike Rescue';

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

    // --- Brand chrome: the Red Raccoon site presentation (public + editor) ----

    // The brand frame a page renders inside - the SAME chrome for the published site
    // and the editor (dz's "edit on the nice version").  Published: static masthead +
    // nav + footer.  Editing: the top (masthead + edit toolbar + tabs) is a live
    // fragment so publish/new/delete refresh it in place, the tabs link to sibling
    // editors, and the block flow (body) carries its edit affordances.
    protected override renderPageChrome(page: Page, body: Markup, ctx: BlockCtx): Markup {
        return [h.div, {class: 'rrbr-site' + (ctx.editing ? ' rrbr-site-editing' : '')},
            ctx.editing
                ? [h.div, {}, this.renderEditFloatNav(), this.renderEditTop(page.page_id)]
                : [h.div, {}, this.renderMasthead(page, false), this.renderSiteNav(page, false)],
            [h.main, {class: 'rrbr-site-main'},
             [h.div, {class: 'rrbr-site-container'}, body]],
            [h.footer, {class: 'rrbr-site-footer'},
             [h.div, {class: 'rrbr-site-container'},
              [h.span, {}, RabidSiteView.BRAND],
              [h.span, {class: 'rrbr-site-footer-tag'}, 'A volunteer-run community bike shop']]]];
    }

    // The one "leave the editor" affordance: a small chip floating in the top-left,
    // out of the layout flow (so the editor keeps looking like the real page).
    private renderEditFloatNav(): Markup {
        return [h.a, {href: '/', class: 'rrbr-edit-floatnav', 'hx-boost': 'false',
                      title: 'Back to the app'}, '← App'];
    }

    // The editor's top, as a live fragment on the page's row + the site page-shape
    // key: a settings save, publish, create, delete or reorder reloads it so the
    // header (title/hero) and tabs refresh in place.
    @route(authenticated)
    renderEditTop(page_id: number): Markup {
        const page = this.pageTable.getById(page_id);
        const props = liveReloadableProps(
            [this.pageTable.siteShapeKey(page.site_id), this.pageTable.rowKey(page_id)],
            `${this}.renderEditTop(${page_id})`);
        return [h.div, {...props},
            this.renderMasthead(page, true),
            this.renderSiteNav(page, true)];
    }

    private renderMasthead(page: Page, editing: boolean): Markup {
        const heroImg = (page.hero_image && page.hero_image !== '')
            ? rabid.photo.aspectImg(page.hero_image, 'landscape', 'detail', {class: 'rrbr-site-hero-img'})
            : undefined;
        const brand = [h.a, {href: editing ? '/site' : '/p/', class: 'rrbr-site-brand', 'hx-boost': 'false'},
                       RabidSiteView.BRAND];

        if(!editing) {
            return [h.header, {class: 'rrbr-site-header' + (heroImg ? ' has-hero' : '')},
                heroImg ? [h.div, {class: 'rrbr-site-hero'}, heroImg] : undefined,
                [h.div, {class: 'rrbr-site-container rrbr-site-masthead'},
                 brand,
                 page.page_title ? [h.h1, {class: 'rrbr-site-title'}, page.page_title] : undefined]];
        }

        // Editing: the header IS the page's content editor.  The hero + title are
        // click-to-edit (-> Page settings) and hover grey, exactly like a block; the
        // brand and the page ☰ sit outside the click target.
        const settingsUrl = `/${this}.editPageSettings(${page.page_id})`;
        const clickEdit = (child: Markup, cls: string): Markup =>
            [h.div, {...editButtonProps(settingsUrl), class: cls + ' rrbr-editable',
                     role: 'button', tabindex: '0', 'aria-label': 'Edit page settings'}, child];
        const title = page.page_title
            ? [h.h1, {class: 'rrbr-site-title'}, page.page_title]
            : [h.h1, {class: 'rrbr-site-title rrbr-site-title-empty'}, 'Untitled page — click to edit'];
        return [h.header, {class: 'rrbr-site-header rrbr-site-header-editing' + (heroImg ? ' has-hero' : '')},
            heroImg ? clickEdit([h.div, {class: 'rrbr-site-hero'}, heroImg], 'rrbr-hero-edit') : undefined,
            [h.div, {class: 'rrbr-site-container rrbr-site-masthead'},
             brand,
             clickEdit(title, 'rrbr-title-edit'),
             this.renderPageMenu(page)]];
    }

    // The page ☰ (top-right of the header): the page-level actions the old toolbar
    // held.  Publish/Unpublish's LABEL conveys the state, so there is no standing
    // badge (the draft state is transient - dz).
    private renderPageMenu(page: Page): Markup {
        const id = page.page_id;
        return [h.div, {class: 'rrbr-page-menu'}, action.actionMenu([
            {label: 'Page settings…', mode: {kind: 'modal', dialogUrl: `/${this}.editPageSettings(${id})`}},
            {label: page.published ? 'Unpublish' : 'Publish',
             mode: {kind: 'immediate', expr: `${this}.togglePublished(${id})`}},
            'divider',
            {label: 'New page…', mode: {kind: 'modal', dialogUrl: `/${this}.newPageDialog(${page.site_id})`}},
            {label: 'Delete page…', mode: {kind: 'confirm',
                message: 'Delete this page and all its blocks?', expr: `${this}.deletePage(${id})`}},
            {label: 'All pages', link: templates.pageLinkProps('/site({list:1})')},
            'divider',
            {label: 'Preview →', link: {href: this.publicPageUrl(id) ?? '#', target: '_blank',
                rel: 'noopener', 'hx-boost': 'false'}},
        ], {ariaLabel: 'Page actions'})];
    }

    // The public URL for a page: pretty /p/<slug>, or /p/ (the home) for a
    // slug-less page.  Full-page navigation (this is the standalone public site).
    private publicHref(page: Page): string {
        return '/p/' + (page.slug ? encodeURIComponent(page.slug) : '');
    }

    // The site nav.  Published: published, nav-visible pages -> /p/<slug>.  Editing:
    // nav-visible pages (+ the current one) -> their editors, drafts marked.
    private renderSiteNav(page: Page, editing: boolean): Markup {
        let pages = security.runSystem(() => this.pageTable.forSite.all({site_id: page.site_id}));
        pages = editing
            ? pages.filter(p => p.nav_visible || p.page_id === page.page_id)
            : pages.filter(p => p.published && p.nav_visible);
        if(pages.length === 0 && !editing) return undefined as unknown as Markup;
        const href = (p: Page) => editing ? `/site({page:${p.page_id}})` : this.publicHref(p);
        return [h.nav, {class: 'rrbr-site-nav', 'aria-label': 'Site'},
            [h.ul, {class: 'rrbr-site-container rrbr-site-nav-list'},
             pages.map(p => [h.li, {class: 'rrbr-site-nav-item' + (p.page_id === page.page_id ? ' active' : '')},
                 [h.a, {href: href(p), 'hx-boost': 'false',
                        ...(p.page_id === page.page_id ? {'aria-current': 'page'} : {})},
                  p.page_title || '(untitled)',
                  editing && !p.published ? [h.span, {class: 'rrbr-nav-draft', title: 'Draft'}, ' •'] : undefined]])]];
    }

    // --- The editor entry (rabid pages-map `site`) --------------------------

    // Entry: a page's branded editor when given ?page; the page LIST when ?list; else
    // single-site jumps straight into its first page's editor (skip the list), and
    // multi-site (or empty) shows the list.
    renderEditEntry(q?: Record<string, any>): templates.Page {
        const page_id = q && q.page != null ? Number(q.page) : undefined;
        if(page_id) return this.renderEditPage(page_id);
        if(!(q && q.list)) {
            const sites = security.runSystem(() => this.siteTable.listAll.all({}));
            if(sites.length === 1) {
                const first = security.runSystem(() => this.pageTable.forSite.all({site_id: sites[0].site_id})[0]);
                if(first) return this.renderEditPage(first.page_id);
            }
        }
        return templates.page('Site pages', this.renderSiteIndex());
    }

    // The branded editor for one page: the SAME chrome as the published view, in edit
    // mode, wrapped in a chromeless (no rabid navbar) full document so it owns the top
    // yet still gets htmx, the modal skeleton, and the live poller.
    renderEditPage(page_id: number): templates.Page {
        const page = this.pageTable.getById(page_id);
        return templates.page(page.page_title || 'Site editor', this.renderPage(page_id, true), {noNavbar: true});
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

// The recurring-events schedule (recurring-events.md), rendered from the RULES -
// so it's correct with no dependence on materialized instances.
registerBlockKind({
    kind: 'rabid-schedule', label: 'Recurring schedule', category: 'app',
    schema: new FieldSet('rabid-schedule', []),
    render: (_p, _ctx): Markup =>
        [h.div, {class: 'site-block-rabid-schedule'}, rabid.event_series.renderPublicSchedule()],
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
        new MarkdownField('text', {default: '', prompt: 'Text'}),
    ]),
    isEmpty: (p) => !(typeof p.image === 'string' && p.image !== '') && !String(p.text ?? '').trim(),
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
