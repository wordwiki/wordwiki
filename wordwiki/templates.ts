// deno-lint-ignore-file no-explicit-any

import * as config from './config.ts';
import {block} from "../liminal/strings.ts";
import {htmxConfigMeta, htmxScriptTag} from "../liminal/htmx.ts";
import {assetUrl} from "../liminal/assets.ts";
import {pencilIcon} from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
import {siteConfig} from './site-config.ts';

export interface PageContent {
    title?: any;
    head?: any;
    body?: any;
    showTestClientLink?: boolean;
    // Opt out of the centred reading column (a wide tool like the page-image
    // editor needs the full viewport width).
    fullBleed?: boolean;
    // The liveness poller's bootstrap (LiminalApp.liveClientConfig), rendered
    // as window.__liminalLive.  Set by the dispatcher; the poller only runs on
    // pages that also contain an 'lm-live' fragment.
    liveConfig?: {poll: string, epoch: string, seq: number};
}

// --- Page results -----------------------------------------------------------
//
// The liminal page model (same as rabid): a route that is a full *page* (a
// navigable entry point) returns page(title, body) rather than assembling a
// document itself.  WordWiki.coercePageResult then wraps it in the standard
// htmx page template for a top-level navigation, or returns just the body +
// <title> for an htmx request.  Routes that produce *fragments* (the common
// case) just return plain markup and are never wrapped.
//
// Not-yet-migrated routes (home/search/reports) call pageTemplate (below)
// directly - a plain document shell that shares the same navBar, so the
// chrome is identical site-wide.

export const pageMarker: unique symbol = Symbol('page');

export interface Page {
    [pageMarker]: true;
    title: any;
    body: any;
}

export function page(title: any, body: any): Page {
    return {[pageMarker]: true, title, body};
}

export function isPage(v: any): v is Page {
    return !!v && v[pageMarker] === true;
}

// A link that navigates to another page via htmx: it swaps just #content (so
// the navbar, modal and scripts persist).
export function pageLink(href: string, ...content: any[]): any {
    return ['a', {...pageLinkProps(href)}, ...content];
}

export function pageLinkProps(href: string): Record<string, string> {
    return {href, 'hx-boost': 'true', 'hx-target': '#content', 'hx-swap': 'innerHTML show:window:top'};
}

// --- Lexeme links -----------------------------------------------------------
//
// A lexeme link DEFAULTS to the read-only word VIEW (wordwiki.wordView -
// researchers are usually just looking; the editor is a clunky viewer), with
// a small pencil beside it straight to the word EDITOR (wordwiki.wordEditor)
// so a contributor still reaches edit in one tap.  This is the ONE place both
// URLs and the pencil are decided, so every link stays consistent and the
// pencil can later gate on a real edit permission.  The word view itself also
// carries a top Edit bar (wordViewEditBar).

/** Whether the current actor may edit lexemes - the pencil's gate.  Every
 *  logged-in user can edit today; this is the seam for a future read-only /
 *  researcher role (then researchers get clean, pencil-free links). */
export function mayEditLexemes(): boolean {
    return security.current()?.actorId !== undefined;
}

/** The STANDARD liminal edit pencil (as in the user/category lists), but as a
 *  navigation <a> to `editUrl` rather than a record-form button - so it can
 *  point at the word editor.  Same look (.lm-edit-pencil + pencilIcon). */
export function pencilLink(editUrl: string,
                           opts: {newTab?: boolean, extraClass?: string} = {}): any {
    const nav = opts.newTab ? {href: editUrl, target: '_blank'} : pageLinkProps(editUrl);
    const cls = 'edit lm-edit-pencil' + (opts.extraClass ? ` ${opts.extraClass}` : '');
    return ['a', {...nav, class: cls, 'aria-label': 'Edit', title: 'Edit'}, pencilIcon()];
}

/** The word editor URL, carrying a review-sitting anchor when given (the feed),
 *  so a pencil -> edit -> review still shows this sitting's receipts. */
function wordEditorUrl(entry_id: number, editAnchor?: number): string {
    return editAnchor
        ? `/ww/wordwiki.wordEditor(${entry_id},${editAnchor})`
        : `/ww/wordwiki.wordEditor(${entry_id})`;
}

/** A lexeme link: the read-only word view, plus (for editors) the standard
 *  pencil to the editor - on EVERY link, bulk lists included (dz 2026-07-09:
 *  the view-then-edit two-page hop was bugging the primary editor; a pencil
 *  per row is one tap to edit).  A subtle 'not public' badge marks words
 *  not yet on any public site (the inverse - published is the common case -
 *  so an editor seeing an error on a draft knows it is not live).
 *  `newTab` for the change feed (no-store, must not navigate). */
export function lexemeLink(entry_id: number, content: any,
                           opts: {pencil?: boolean, newTab?: boolean,
                                  editAnchor?: number, linkClass?: string,
                                  // The word view's ONE-WORD orthography
                                  // lens (see wordwiki.wordView): reports
                                  // presenting a word in a non-default
                                  // orthography link the matching view.
                                  viewOrthography?: string,
                                  // Tight contexts (the page-editor word
                                  // sidebar) drop the not-public badge -
                                  // dz: not important enough for the
                                  // clutter there.
                                  badge?: boolean} = {}): any {
    const viewUrl = opts.viewOrthography
        ? `/ww/wordwiki.wordView(${entry_id}, ${JSON.stringify(opts.viewOrthography)})`
        : `/ww/wordwiki.wordView(${entry_id})`;
    const viewNav = opts.newTab ? {href: viewUrl, target: '_blank'} : pageLinkProps(viewUrl);
    const viewCls = opts.linkClass ? `lm-lexeme-view ${opts.linkClass}` : 'lm-lexeme-view';
    const pencil = (opts.pencil ?? true) && mayEditLexemes();
    return ['span', {class: 'lm-lexeme-link d-inline-flex align-items-center gap-1'},
        ['a', {...viewNav, class: viewCls}, content],
        (opts.badge ?? true) ? notPublicBadge(entry_id) : undefined,
        pencil
            ? pencilLink(wordEditorUrl(entry_id, opts.editAnchor),
                         {newTab: opts.newTab, extraClass: opts.linkClass})
            : undefined];
}

/**
 * The standard (htmx) page template for new-style pages: htmx + the liminal
 * client scripts + the shared modal editor + the audio player.  Used by
 * coercePageResult for every page() result (login, users, the v2 lexeme
 * editor, ...).  Deliberately separate from the legacy pageTemplate below,
 * which loads the old client-side editor's module scripts and its own
 * #modalEditor - the two editors don't share a page.
 */
export function htmxPageTemplate(content: PageContent): any {
    return (
        ['html', {},
         ['head', {},
          ['meta', {charset:'utf-8'}],
          ['meta', {name:'viewport', content:'width=device-width, initial-scale=1'}],
          htmxConfigMeta(),
          content.title !== undefined ? ['title', {}, content.title] : undefined,
          config.bootstrapCssLink,
          // Shared MMO theme (accent + link treatment + type), same file the
          // public site loads; then framework + app styles.
          ['link', {href: assetUrl('/resources/site-theme.css'), rel:'stylesheet', type:'text/css'}],
          ['link', {href: assetUrl('/resources/instance.css'), rel:'stylesheet', type:'text/css'}],
          ['link', {href: assetUrl('/resources/liminal.css'), rel:'stylesheet', type:'text/css'}],
          // The document-reference boxes on the word view are INLINE svg
          // (svg.box > rect.frame); page-editor.css makes those frames
          // transparent (fill-opacity 0) - without it a bare rect defaults to
          // solid black and hides the scan.  Fully svg.group/svg.box-scoped, so
          // it's inert on pages with no reference image.
          ['link', {href: assetUrl('/resources/page-editor.css'), rel:'stylesheet', type:'text/css'}],
          htmxScriptTag(),
          ['script', {}, block`
/**/       function playAudio(src) {
/**/         const audioPlayer = document.getElementById("audioPlayer");
/**/         if(!audioPlayer) throw new Error('could not find audio player');
/**/         audioPlayer.src = src;
/**/         audioPlayer.play();
/**/       }`],
          content.head,
         ],
         ['body', {},
          navBar(content.showTestClientLink),
          ['audio', {id:'audioPlayer', preload:'none'},
           ['source', {src:'', type:'audio/mpeg'}]],
          // The page body lives in #content, the swap target for hx-boosted
          // nav links (the navbar, modal skeleton and scripts persist).
          // .ww-content gives it the shared centred column + link treatment.
          ['main', {id:'content', class: content.fullBleed ? 'ww-content ww-full' : 'ww-content'},
           content.body],
          renderHtmxModalEditorSkeleton(),
          config.bootstrapScriptTag,
          // Liveness poller bootstrap (persists across boosted navs).
          content.liveConfig
              ? ['script', {}, `window.__liminalLive = ${JSON.stringify(content.liveConfig)};`]
              : undefined,
          ['script', {src: assetUrl('/resources/liminal-scripts.js')}],
          ['script', {src: assetUrl('/resources/rabid-scripts.js')}],
          ['script', {src: assetUrl('/resources/lexeme-editor-scripts.js')}],
         ]]);
}

// The shared modal that edit/insert dialogs load into (rabid-style skeleton;
// showModalEditor/hideModalEditor in liminal-scripts.js drive it).
export function renderHtmxModalEditorSkeleton(): any {
    return (
        ['div', {class: 'modal', id:'modalEditor',
                 // static backdrop: a stray click outside must not close a
                 // half-filled form.  Esc IS allowed (keyboard editing's
                 // natural exit) - the discard guard (liminal-scripts.js)
                 // intercepts the hide and asks when the form is dirty.
                 'data-bs-backdrop':'static', 'data-bs-keyboard':'true',
                 tabindex:'-1', 'aria-labelledby':'modalEditorLabel', 'aria-hidden':'true'},
         ['div', {class:'modal-dialog modal-dialog-scrollable modal-fullscreen-sm-down modal-lg'},
          ['div', {class:'modal-content'},
           ['div', {class:'modal-header'},
            ['h1', {class:'modal-title fs-5', id:'modalEditorLabel'}, 'Edit'],
            ['button', {type:'button', class:'btn-close', 'data-bs-dismiss':'modal', 'aria-label':'Close'}]],
           ['div', {class:'modal-body', id:'modalEditorBody'}],
          ]]]);
}

/**
 * THE site navbar, shared by both page templates so the chrome is identical
 * everywhere.  Everything here works without htmx: mutations (Add New Entry,
 * Logout) are plain form POSTs that the server answers with a redirect, and
 * the dropdowns only need bootstrap (loaded by both templates).
 */
// Whether navbars show the (test-only) test-client link by default - set once
// at server startup from isTestDb, so legacy-template pages (which don't go
// through coercePageResult) get the same chrome as page() pages.
let defaultShowTestClientLink = false;

// Kill switch over BOTH paths (the startup default above and the explicit
// per-page showTestClientLink): the link is hidden for now (dz 2026-07-02 -
// rarely used, and it pushed the navbar past the hamburger breakpoint).
// Flip to false to bring it back; the test-client PAGE itself stays reachable
// at /ww/wordwiki.testClientPage().
const testClientLinkHidden = true;
// --- Working-orthography status (dz 2026-07-09) -----------------------------
//
// TWO display levels: the EFFECTIVE working orthography is a subtle brand
// suffix ("MMO Editor · SF" - the abbreviation, same vocabulary as the
// editor's lane badges), shown whenever one is set - it names YOUR lane,
// including the default one.  The session OVERRIDE additionally gets a
// PROMINENT amber banner on every page (it changes what SAVING does -
// modality must be un-missable) with the one-click way out inline.
// The app injects the provider (templates cannot import the app - cycle);
// undefined = anonymous/pre-migration: no orthography UI at all.

export interface OrthographyStatus {
    effective?: {slug: string, abbr: string};
    override?: {slug: string, name: string};
    choices: {slug: string, name: string}[];
}

// Is this entry on SOME public site?  Injected by the app (store-backed);
// undefined provider (or anonymous rendering) marks nothing.  The BADGE is
// the inverse - 'not public' - because published is the common case.
let entryPublicnessProvider: ((entry_id: number) => boolean) | undefined;
export function setEntryPublicnessProvider(fn: (entry_id: number) => boolean): void {
    entryPublicnessProvider = fn;
}
function notPublicBadge(entry_id: number): any {
    try {
        if(entryPublicnessProvider && !entryPublicnessProvider(entry_id))
            return ['span', {class: 'badge border text-muted ms-1',
                             title: 'This word is not on the public site yet'},
                    'not public'];
    } catch { /* no marking beats a broken page */ }
    return undefined;
}

let orthographyStatusProvider: (() => OrthographyStatus | undefined) | undefined;
export function setOrthographyStatusProvider(fn: () => OrthographyStatus | undefined): void {
    orthographyStatusProvider = fn;
}
function orthographyStatus(): OrthographyStatus | undefined {
    try { return orthographyStatusProvider?.(); } catch { return undefined; }
}

// The switcher: the grey working-lane BADGE beside the brand IS the
// control (dz: more obvious than a menu item, and the collapsing navbar
// is already near the triple-bar threshold - no new menu items).  The
// dropdown-toggle caret + a title make the badge read as clickable; each
// choice is a plain form POST (no htmx dependency - the navbar also
// appears on legacy-template pages).  Lives OUTSIDE the collapse, so it
// stays visible on small screens too.
function orthographyBadgeSwitcher(status: OrthographyStatus): any {
    // Switching re-renders the SAME page in the new orthography (dz: it is
    // common to want to see one result both ways; a lane with no text may
    // render sparse - accepted).  returnTo is filled at submit time.
    const choiceItem = (label: any, orthography: string, active: boolean) =>
        ['li', {},
         ['form', {method: 'post', action: '/ww/wordwiki.setOrthographyOverride(bodyArgs)', class: 'm-0',
                   onsubmit: 'this.returnTo.value = location.pathname + location.search'},
          ['input', {type: 'hidden', name: 'orthography', value: orthography}],
          ['input', {type: 'hidden', name: 'returnTo', value: ''}],
          ['button', {type: 'submit',
                      class: `dropdown-item${active ? ' active' : ''}`}, label]]];
    return ['div', {class: 'dropdown d-inline-block me-2'},
        ['a', {class: 'dropdown-toggle text-light text-decoration-none', href: '#',
               role: 'button', 'data-bs-toggle': 'dropdown', 'aria-expanded': 'false',
               title: 'Working orthography — click to change'},
         ['span', {class: 'badge text-bg-secondary'},
          status.effective?.abbr ?? '–']],
        ['ul', {class: 'dropdown-menu'},
         ['li', {}, ['h6', {class: 'dropdown-header'}, 'Working orthography']],
         choiceItem('From my profile (default)', '', !status.override),
         ['li', {}, ['hr', {class: 'dropdown-divider'}]],
         status.choices.map(c =>
             choiceItem(`Override: ${c.name}`, c.slug, status.override?.slug === c.slug))]];
}

// The PROMINENT override banner, rendered as part of the site chrome
// (navBar returns it alongside the nav, so both page templates carry it).
function orthographyOverrideBanner(status: OrthographyStatus | undefined): any {
    if(!status?.override) return undefined;
    return ['div', {class: 'alert alert-warning rounded-0 border-0 py-2 mb-0 text-center'},
        '⚠ Working orthography overridden to ',
        ['b', {}, status.override.name],
        ' for this session — new content, defaults and reports use it. ',
        ['form', {method: 'post', action: '/ww/wordwiki.setOrthographyOverride(bodyArgs)',
                  class: 'd-inline m-0',
                  onsubmit: 'this.returnTo.value = location.pathname + location.search'},
         ['input', {type: 'hidden', name: 'orthography', value: ''}],
         ['input', {type: 'hidden', name: 'returnTo', value: ''}],
         ['button', {type: 'submit', class: 'btn btn-link btn-sm p-0 align-baseline'},
          'Clear override']]];
}

export function setDefaultShowTestClientLink(v: boolean): void {
    defaultShowTestClientLink = v;
}

export function navBar(showTestClientLink: boolean = defaultShowTestClientLink): any {
    const oStatus = orthographyStatus();
    return ([
        ['nav', {class:'navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body', 'data-bs-theme':'dark'},
         ['div', {class:'container-fluid'},
          ['a', {class:'navbar-brand me-2', href:'/ww/'}, siteConfig.editorName],
          // The level-1 notice AND the switcher in one: the grey working-
          // lane badge beside the brand, click to change.
          oStatus ? orthographyBadgeSwitcher(oStatus) : undefined,
          ['button', {class:'navbar-toggler', type:'button', 'data-bs-toggle':'collapse', 'data-bs-target':'#navbarSupportedContent', 'aria-controls':'navbarSupportedContent', 'aria-expanded':'false', 'aria-label':'Toggle navigation'},
           ['span', {class:'navbar-toggler-icon'}]],
          ['div', {class:'collapse navbar-collapse', id:'navbarSupportedContent'},
           ['ul', {class:'navbar-nav me-auto mb-2 mb-lg-0'},

            ['li', {class:'nav-item'},
             ['a', {class:'nav-link', href:'/ww/wordwiki.editorReports.categoriesDirectory()'}, 'Categories']],

            // --- Reference Books
            ['li', {class:'nav-item dropdown'},
             ['a', {class:'nav-link dropdown-toggle', href:'#', role:'button', 'data-bs-toggle':'dropdown', 'aria-expanded':'false'},
              'Reference Books'],
             ['ul', {class:'dropdown-menu'},
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.pages.pageEditor("PDM")'}, 'PDM']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.pages.pageEditor("Rand")'}, 'Rand']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.pages.pageEditor("Clark")'}, 'Clark']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.pages.pageEditor("PacifiquesGeography")'}, 'PacifiquesGeography']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.pages.pageEditor("RandFirstReadingBook")'}, 'RandFirstReadingBook']],
             ]],

            // --- Reports
            ['li', {class:'nav-item dropdown'},
             ['a', {class:'nav-link dropdown-toggle', href:'#', role:'button', 'data-bs-toggle':'dropdown', 'aria-expanded':'false'},
              'Reports'],
             ['ul', {class:'dropdown-menu'},
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.myActivity()'}, 'My Activity']],
              ['li', {}, ['a', {class:'dropdown-item', href:"/ww/wordwiki.recentlyChangedWords({mode:'pending'})"}, 'Words Needing Review']],
              ['li', {}, ['a', {class:'dropdown-item', href:"/ww/wordwiki.recentlyChangedWords({mode:'all'})"}, 'Recently Changed Words']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.changes()'}, 'Recent Changes']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.activity()'}, 'Monthly Activity']],
              ['li', {}, ['a', {class:'dropdown-item',
                  href:`/ww/wordwiki.editorReports.entriesByBookPageDirectory(${JSON.stringify(siteConfig.primarySourceBook)})`},
            `Entries by ${siteConfig.primarySourceBook} page`]],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.editorReports.categoriesDirectory()'}, 'Entries by Category']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.spellingReports.duplicatesReport()'}, 'Duplicate Spellings']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.variantReports.cleanupReport()'}, 'Variant Cleanup']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.transliterationReports.correctionsReport()'}, 'Transliteration Report']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.transliterationReports.sfReadyReport()'}, 'SF-Ready Words']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.editorReports.archivedWords()'}, 'Archived Words']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.editorReports.importReport()'}, 'Import Report']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.editorReports.todoReport(null, null)'}, 'TODO Report']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.editorReports.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.editorReports.wordADayPicker()'}, 'Word-a-day Picker']],
             ]],

            // --- Admin
            ['li', {class:'nav-item dropdown'},
             ['a', {class:'nav-link dropdown-toggle', href:'#', role:'button', 'data-bs-toggle':'dropdown', 'aria-expanded':'false'},
              'Admin'],
             ['ul', {class:'dropdown-menu'},
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.publish.startPublish()'}, 'Publish']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.usersPage()'}, 'Users']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.categoriesPage()'}, 'Category Table']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.tagsPage()'}, 'Tag Table']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.lexicalFormsPage()'}, 'Lexical Form Table']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.orthographiesPage()'}, 'Orthography Table']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.audio.trimTuningPage()'}, 'Audio Trim Tuning']],
             ]],

            // A mutation, so a POST (a GET link could be prefetched/prerendered
            // into creating entries); the server responds with a redirect to
            // the new entry in the editor.
            ['li', {class:'nav-item'},
             ['form', {method:'post', action:'/ww/wordwiki.newLexemeAction()', class:'m-0'},
              ['button', {type:'submit', class:'nav-link btn btn-link text-nowrap'}, 'Add New Entry']]],

            ['li', {class:'nav-item'},
             ['a', {class:'nav-link text-nowrap', href:'/index.html'}, 'Public Site']],

            showTestClientLink && !testClientLinkHidden
                ? ['li', {class:'nav-item'},
                   ['button', {type:'button', class:'nav-link btn btn-link text-warning text-nowrap',
                               onclick:"window.location.href='/ww/wordwiki.testClientPage()'",
                               title:'Test-mode only: act as the browser test client'},
                    'Test client ',
                    ['span', {class:'badge text-bg-warning'}, 'test']]]
                : undefined,
           ],

           // Search form
           ['form', {class:'d-flex me-3', role:'search', method:'get', action:'/ww/wordwiki.searchPage(query)'},
            ['input', {name:'searchText', class:'form-control me-2', type:'search', placeholder:'Search', 'aria-label':'Search'}],
            ['button', {class:'btn btn-outline-success', type:'submit'}, 'Search']],

           // Logout: a plain form POST (no htmx dependency - this navbar also
           // appears on legacy-template pages); the server clears the session
           // and redirects.  session_token is bound in the route scope.
           ['ul', {class:'navbar-nav'},
            ['li', {class:'nav-item'},
             ['form', {method:'post', action:'/ww/wordwiki.logout(session_token)', class:'m-0'},
              ['button', {type:'submit', class:'nav-link btn btn-link'}, 'Logout']]]],
          ]]],
        // The level-2 notice: the override banner rides with the navbar so
        // BOTH page templates carry it on every page.
        orthographyOverrideBanner(oStatus)]);
}

export function pageTemplate(content: PageContent): any {
    return (
        ['html', {},

         ['head', {},
          ['meta', {charset:"utf-8"}],
          ['meta', {name:"viewport", content:"width=device-width, initial-scale=1"}],
          content.title !== undefined ? ['title', {}, content.title] : undefined,
          config.bootstrapCssLink,
          // Shared MMO theme (accent + link treatment + type), same file the
          // public site and the htmx editor load.
          ['link', {href: assetUrl('/resources/site-theme.css'), rel:'stylesheet', type:'text/css'}],
          ['link', {href: assetUrl('/resources/instance.css'), rel:'stylesheet', type:'text/css'}],
          // liminal.css too: these legacy-template pages (search, reports, ...)
          // now carry lexeme links whose edit pencil is sized by
          // `.lm-edit-pencil svg` here - without it the pencil collapses to 0.
          ['link', {href: assetUrl('/resources/liminal.css'), rel:'stylesheet', type:'text/css'}],
          ['link', {href: assetUrl('/resources/page-editor.css'), rel:'stylesheet', type:'text/css'}],
          // The page editor's right-click menu reuses the shared menu look.
          ['link', {href: assetUrl('/resources/context-menu.css'), rel:'stylesheet', type:'text/css'}],
          ['script', {}, block`
/**/           function playAudio(src) {
/**/             const audioPlayer = document.getElementById("audioPlayer");
/**/             if(!audioPlayer) throw new Error('could not find audio player');
/**/             audioPlayer.src = src;
/**/             audioPlayer.play ();
/**/          }`],
          content.head,
         ], // head

         ['body', {},

          navBar(),

          // TODO probably move this somewhere else
          ['audio', {id:'audioPlayer', preload:'none'},
           ['source', {src:'', type:'audio/mpeg'}]],

          // Same centred column + link treatment as the htmx pages
          // (.ww-content); fullBleed pages - e.g. the page-image editor - opt out.
          ['main', {class: content.fullBleed ? 'ww-content ww-full' : 'ww-content'},
           content.body],

          config.bootstrapScriptTag

         ] // body
        ] // html
    );
}


