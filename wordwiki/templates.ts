// deno-lint-ignore-file no-explicit-any

import * as config from './config.ts';
import {block} from "../liminal/strings.ts";
import {htmxConfigMeta, htmxScriptTag} from "../liminal/htmx.ts";

export interface PageContent {
    title?: any;
    head?: any;
    body?: any;
    showTestClientLink?: boolean;
    // Opt out of the centred reading column (a wide tool like the page-image
    // editor needs the full viewport width).
    fullBleed?: boolean;
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
          ['link', {href: '/resources/site-theme.css', rel:'stylesheet', type:'text/css'}],
          ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          ['link', {href: '/resources/liminal.css', rel:'stylesheet', type:'text/css'}],
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
          ['script', {src: '/resources/liminal-scripts.js'}],
          ['script', {src: '/resources/rabid-scripts.js'}],
          ['script', {src: '/resources/lexeme-editor-scripts.js'}],
         ]]);
}

// The shared modal that edit/insert dialogs load into (rabid-style skeleton;
// showModalEditor/hideModalEditor in liminal-scripts.js drive it).
export function renderHtmxModalEditorSkeleton(): any {
    return (
        ['div', {class: 'modal', id:'modalEditor',
                 'data-bs-backdrop':'static', 'data-bs-keyboard':'false',
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
export function setDefaultShowTestClientLink(v: boolean): void {
    defaultShowTestClientLink = v;
}

export function navBar(showTestClientLink: boolean = defaultShowTestClientLink): any {
    return (
        ['nav', {class:'navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body', 'data-bs-theme':'dark'},
         ['div', {class:'container-fluid'},
          ['a', {class:'navbar-brand', href:'/ww/'}, 'MMO Editor'],
          ['button', {class:'navbar-toggler', type:'button', 'data-bs-toggle':'collapse', 'data-bs-target':'#navbarSupportedContent', 'aria-controls':'navbarSupportedContent', 'aria-expanded':'false', 'aria-label':'Toggle navigation'},
           ['span', {class:'navbar-toggler-icon'}]],
          ['div', {class:'collapse navbar-collapse', id:'navbarSupportedContent'},
           ['ul', {class:'navbar-nav me-auto mb-2 mb-lg-0'},

            ['li', {class:'nav-item'},
             ['a', {class:'nav-link', href:'/ww/wordwiki.categoriesDirectory()'}, 'Categories']],

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
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.entriesByPDMPageDirectory()'}, 'Entries by PDM page']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.categoriesDirectory()'}, 'Entries by Category']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.todoReport(null, null)'}, 'TODO Report']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.entriesByPronunciation()'}, 'Entries By Pronunciation']],
             ]],

            // --- Admin
            ['li', {class:'nav-item dropdown'},
             ['a', {class:'nav-link dropdown-toggle', href:'#', role:'button', 'data-bs-toggle':'dropdown', 'aria-expanded':'false'},
              'Admin'],
             ['ul', {class:'dropdown-menu'},
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.changes()'}, 'Recent Changes']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.publish.startPublish()'}, 'Publish']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.usersPage()'}, 'Users']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.categoriesPage()'}, 'Category Table']],
              ['li', {}, ['a', {class:'dropdown-item', href:'/ww/wordwiki.lexicalFormsPage()'}, 'Lexical Form Table']],
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
          ]]]);
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
          ['link', {href: '/resources/site-theme.css', rel:'stylesheet', type:'text/css'}],
          ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          ['link', {href: '/resources/page-editor.css', rel:'stylesheet', type:'text/css'}],
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


