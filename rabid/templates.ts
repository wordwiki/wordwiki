// deno-lint-ignore-file no-explicit-any

import * as config from './config.ts';
import {block} from "../liminal/strings.ts";
import {h} from '../liminal/markup.ts';
import * as action from "../liminal/action.ts";
import {htmxConfigMeta, htmxScriptTag} from "../liminal/htmx.ts";
import {assetUrl} from "../liminal/assets.ts";

export interface PageContent {
    title?: any;
    head?: any;
    body?: any;
    // Show the (test-only) "Test client" nav link.  Set by the dispatcher from
    // rabid.isTestDb (memoized), so this never costs a per-render db query.
    showTestClientLink?: boolean;
    // Show admin-only Admin-menu items (e.g. rebuild photo cache).  Set by the
    // dispatcher from the viewer's roles.
    isAdmin?: boolean;
    // Show host/admin-only nav (e.g. "Today's Ad-hoc", which materialises the
    // day's catch-all event).  Set by the dispatcher from the viewer's roles.
    isHostOrAdmin?: boolean;
    // The liveness poller's bootstrap (LiminalApp.liveClientConfig), rendered
    // as window.__liminalLive.  Set by the dispatcher; the poller only runs on
    // pages that also contain an 'lm-live' fragment.
    liveConfig?: {poll: string, epoch: string, seq: number};
    // The browser test-client routes (LiminalApp.testClientRoutes).  Set by the
    // dispatcher ONLY for a 'testing'-permission viewer on a non-production db.
    // When present, every full page load starts the test agent (opt-in + poll),
    // so ANY page - not just the test-client page - can be driven from server-side
    // test code (evalInBrowser).  Injected outside #content so it survives boosted
    // navigations (the agent keeps polling as you move between pages).
    testAgent?: {optIn: string, poll: string, result: string};
}

// --- Page results -----------------------------------------------------------
//
// A route that is a full *page* (a navigable entry point) returns page(title,
// body) rather than assembling a document itself.  The dispatcher then wraps it
// in pageTemplate for a top-level navigation, or returns just the body for an
// htmx request (see Rabid.rpcHandler).  Routes that produce *fragments* (the
// common case - they replace part of a page) just return plain markup and are
// never wrapped.
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

// A link that navigates to another page via htmx: it swaps just #content (so the
// navbar, modal and scripts persist) and scrolls back to the top.  Centralising
// the htmx attributes here keeps that complexity out of call sites, and in one
// place to adjust across htmx versions.
export function pageLink(href: string, ...content: any[]): any {
    return [h.a, {...pageLinkProps(href)}, ...content];
}

// The attrs alone, for call sites that need to add their own (e.g. a class).
export function pageLinkProps(href: string): Record<string, string> {
    return {href, 'hx-boost': 'true', 'hx-target': '#content', 'hx-swap': 'innerHTML show:window:top'};
}

export function pageTemplate(content: PageContent): any {
    return (
        [h.html, {},

         [h.head, {},
          [h.meta, {charset:"utf-8"}],
          [h.meta, {name:"viewport", content:"width=device-width, initial-scale=1"}],
          // htmx config (boost scroll + the back-button/history fix) lives in
          // the shared liminal helper - see liminal/htmx.ts for the rationale.
          htmxConfigMeta(),
          content.title !== undefined ? [h.title, {}, content.title] : undefined,
          config.bootstrapCssLink,
          // Self-hosted css/js go through assetUrl(): content-addressed URLs
          // once interned at startup (liminal/assets.ts), the plain
          // /resources/ path otherwise (tests, un-interned).  CDN links
          // (bootstrap/tom-select) are external and left as-is.
          [h.link, {href: assetUrl('/resources/instance.css'), rel:'stylesheet', type:'text/css'}],
          [h.link, {href: assetUrl('/resources/page-editor.css'), rel:'stylesheet', type:'text/css'}],
          [h.link, {href: assetUrl('/resources/context-menu.css'), rel:'stylesheet', type:'text/css'}],
          // Framework styles before app styles, so rabid.css can override.
          [h.link, {href: assetUrl('/resources/liminal.css'), rel:'stylesheet', type:'text/css'}],
          [h.link, {href: assetUrl('/resources/rabid.css'), rel:'stylesheet', type:'text/css'}],
          // Tom Select: a vanilla-JS filterable <select> picker with a Bootstrap 5
          // theme.  Initialised on .ts-picker selects by rabid-scripts.js (after
          // htmx swaps, so it works on modal-loaded forms).
          [h.link, {href: 'https://cdn.jsdelivr.net/npm/tom-select@2.3.1/dist/css/tom-select.bootstrap5.min.css', rel:'stylesheet'}],
          [h.script, {src: 'https://cdn.jsdelivr.net/npm/tom-select@2.3.1/dist/js/tom-select.complete.min.js'}],
          [h.script, {src: assetUrl('/resources/context-menu.js')}],
          htmxScriptTag(),
          [h.script, {}, block`
/**/           let imports = {};
/**/           let activeViews = undefined`],

//           ['script', {type: 'module'}, block`
// /**/           //import * as workspace from '/scripts/datawiki/workspace.js';
// /**/           
// /**/           imports = Object.assign(
// /**/                        {},
// /**/                        view.exportToBrowser(),
// /**/                        workspace.exportToBrowser());
// /**/
// /**/           activeViews = imports.activeViews;
// /**/
// /**/           document.addEventListener("DOMContentLoaded", (event) => {
// /**/             console.log("DOM fully loaded and parsed");
// /**/             view.run();
// /**/             //workspace.renderSample(document.getElementById('root'))
// /**/           });
// /**/
// `
          // ],
          content.head,
         ], // head

         [h.body, {},

          navBar(content.showTestClientLink, content.isAdmin, content.isHostOrAdmin),

          // TODO probably move this somewhere else
          [h.audio, {id:'audioPlayer', preload:'none'},
           [h.source, {src:'', type:'audio/mpeg'}]],

          // The page body lives in #content, the swap target for hx-boosted nav
          // links: a boosted navigation replaces just this region (the navbar,
          // modal skeleton and scripts persist), while a full-page load renders
          // the same content inside the document.
          [h.main, {id:'content'}, content.body],

          renderModalEditorSkeleton(),

          config.bootstrapScriptTag,

          // The liveness poller's bootstrap (persists across boosted navs -
          // this script sits outside #content).
          content.liveConfig
              ? [h.script, {}, `window.__liminalLive = ${JSON.stringify(content.liveConfig)};`]
              : undefined,

          // The browser test agent (opt-in + long-poll for JS to run), on EVERY
          // page for a testing viewer.  Outside #content, so a boosted nav leaves
          // it running.  It sets the config, then appends the agent script.
          content.testAgent
              ? [h.script, {}, `window.__liminalTestAgent = ${JSON.stringify(content.testAgent)};
(function(){var s=document.createElement('script');s.src='/resources/test-agent.js';s.async=true;document.body.appendChild(s);})();`]
              : undefined,

          // Framework scripts before app scripts (same ordering rule as the css).
          [h.script, {src: assetUrl('/resources/liminal-scripts.js')}],
          [h.script, {src: assetUrl('/resources/rabid-scripts.js')}],
          
         ] // body
        ] // html
    );
}

export function navBar(showTestClientLink: boolean = false, isAdmin: boolean = false,
                       isHostOrAdmin: boolean = false): any {
    return [
        [h.nav, {class:"navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body", 'data-bs-theme':"dark"},
         [h.div, {class:"container-fluid"},
          [h.a, {class:"navbar-brand", href:"/"}, 'RRBR'],
          [h.button, {class:"navbar-toggler", type:"button", 'data-bs-toggle':"collapse", 'data-bs-target':"#navbarSupportedContent", 'aria-controls':"navbarSupportedContent", 'aria-expanded':"false", 'aria-label':"Toggle navigation"},
           [h.span, {class:"navbar-toggler-icon"}],
          ], //button

          [h.div, {class:"collapse navbar-collapse", id:"navbarSupportedContent"},
           // hx-boost: nav links navigate via htmx, swapping just #content (the
           // server returns a body-only response for HX-Request - see page()).
           // The browser tab title updates from the <title> in that response.
           [h.ul, {class:"navbar-nav me-auto mb-2 mb-lg-0",
                   'hx-boost':'true', 'hx-target':'#content', 'hx-swap':'innerHTML'},

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/"}, 'Home'],
            ], //li

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/volunteers"}, 'Volunteers'],
            ], //li

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/events"}, 'Events'],
            ], //li

            // Today's Ad-hoc: the day's Ad-hoc catch-all event, materialised on
            // demand.  Host/admin only - it's where they record drop-in activity
            // (NOT a log of all of today; just the not-in-an-event bucket).
            isHostOrAdmin
                ? [h.li, {class:"nav-item"},
                   [h.a, {class:"nav-link", href:"/todaysLog"}, "Today's Ad-hoc"],
                  ] //li
                : undefined,

            // (Service and Sales are no longer top-level pages: activity is logged
            // through events.  Their cross-event lists live under Reports below.)

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/committees"}, 'Committees'],
            ], //li

            // Reports
            [h.li, {class:"nav-item dropdown"},
             [h.a, {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false", 'hx-boost':"false"},
              'Reports'
             ], //a
             [h.ul, {class:"dropdown-menu"},
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/activityReport'}, 'Volunteer Activity Report']],
              // Cross-event activity: the windowed lists of every service / sale,
              // across all events (access to an individual record is via its event).
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/service'}, 'Services']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/sales'}, 'Sales']],
             ], //ul
            ], //li

            // Admin
            [h.li, {class:"nav-item dropdown"},
             [h.a, {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false", 'hx-boost':"false"},
              'Admin'
             ], //a
             [h.ul, {class:"dropdown-menu"},
              // Management/administrative surfaces - kept out of the main bar so
              // it isn't in a regular volunteer's face.  Projects are usually
              // reached via their owning object (an event/committee/etc.); the
              // Projects and Templates list pages and Timesheets live here.
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/projects'}, 'Projects']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/tasks'}, 'Tasks']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/templates'}, 'Templates']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/timesheets'}, 'Timesheets']],
              // Admin-only maintenance: rebuild the derived photo cache (after a
              // change to the crop/resize logic).  Confirm, then POST.
              isAdmin
                  ? [h.li, {}, action.actionButton('Rebuild photo sizes',
                      {kind: 'confirm', expr: 'rabid.rebuildPhotoDerivatives()',
                       message: 'Rebuild all photo sizes? Cached images are deleted and regenerated as they are next viewed.'},
                      'dropdown-item')]
                  : undefined,
              // Test client: only on a non-production db.  A <button>, not an
              // <a href>: prefetch/prerender of a link can *run scripts* and
              // silently opt this tab in (the opt-in lives in test-agent.js); a
              // button only fires on a real click.  Full load so the script runs.
              showTestClientLink
                  ? [h.li, {}, [h.button, {type:"button", class:"dropdown-item text-warning",
                                onclick:"window.location.href='/rabid.testClientPage()'",
                                title:'Test-mode only: act as the browser test client'},
                     'Test client ', [h.span, {class:'badge text-bg-warning'}, 'test']]]
                  : undefined,
             ], //ul
            ], //li
            
           //  ['li', {class:"nav-item"},
           //   ['a', {class:"nav-link disabled", 'aria-disabled':"true"}, 'Disabled'],
           //  ], //li

            
           ], //ul

           // Logout (session_token is bound in the route scope by rabid.rpcHandler).
           // Uses hx-post so the state change is a POST (not a prefetchable GET);
           // the server replies with an HX-Redirect that htmx follows to /.
           [h.ul, {class:"navbar-nav"},
            [h.li, {class:"nav-item"},
             [h.button, {type:"button", class:"nav-link btn btn-link",
                         'hx-post':"/rabid.logout(session_token)", 'hx-swap':"none"}, 'Logout'],
            ], //li
           ], //ul

          ], //div navbar-collaplse

         ], //div container
        ], //nav
    ];
}

export function renderModalEditorSkeleton() {

    return [
        // Add 'fade' to class list for modal fade effect
        [h.div, {class: 'modal',  id:'modalEditor',
                 // static backdrop: a stray click outside must not close a
                 // half-filled form.  Esc IS allowed (keyboard editing's
                 // natural exit) - the discard guard (liminal-scripts.js)
                 // intercepts the hide and asks when the form is dirty.
                 'data-bs-backdrop':'static', 'data-bs-keyboard':'true',
                 tabindex:'-1', 'aria-labelledby':'modalEditorLabel',
                 'aria-hidden':'true'},
          // fullscreen-sm-down: on a phone the editor is a full-screen sheet
          // (native edit-screen feel, and room for the soft keyboard); from sm
          // up it is a regular centered dialog.
          [h.div, {class:'modal-dialog modal-dialog-scrollable modal-fullscreen-sm-down modal-lg'},

          [h.div, {class:'modal-content'},

           [h.div, {class:'modal-header'},
            [h.h1, {class:'modal-title fs-5', id:'modalEditorLabel'},
             'Edit'],
            [h.button, {type:'button', class:'btn-close', 'data-bs-dismiss':'modal',
                        'aria-label':'Close'}]

           ], // div.modal-header

           [h.div, {class:'modal-body', id:'modalEditorBody'}

           ], // div.modal-body

           // ['div', {class:'modal-footer'},
           //  ['button', {type:'button', class:'btn btn-secondary',
           //              'data-bs-dismiss':'modal',
           //              //onclick:'activeViews().saveChanges()'}, 'Save']
           //              onclick:'location.reload()'}, 'Close']
           // ], // div.modal-footer

          ] // div.modal-content

         ] // div.modal-dialog

        ] // div.modal
    ];

}
