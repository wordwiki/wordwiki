// deno-lint-ignore-file no-explicit-any

import * as config from './config.ts';
import {block} from "../liminal/strings.ts";
import * as view from '../datawiki/view.ts';

export interface PageContent {
    title?: any;
    head?: any;
    body?: any;
    showTestClientLink?: boolean;
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
// The OLD editor's routes keep calling pageTemplate (below) directly - that
// legacy template loads the old client-side editor's module scripts and stays
// untouched until the old editor is retired.

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
          ['meta', {name:'htmx-config', content:'{"scrollIntoViewOnBoost":false}'}],
          content.title !== undefined ? ['title', {}, content.title] : undefined,
          config.bootstrapCssLink,
          ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          ['link', {href: '/resources/liminal.css', rel:'stylesheet', type:'text/css'}],
          ['script', {src: 'https://unpkg.com/htmx.org@2.0.4'}],
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
          htmxNavBar(content.showTestClientLink),
          ['audio', {id:'audioPlayer', preload:'none'},
           ['source', {src:'', type:'audio/mpeg'}]],
          // The page body lives in #content, the swap target for hx-boosted
          // nav links (the navbar, modal skeleton and scripts persist).
          ['main', {id:'content'}, content.body],
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

// The navbar for new-style (htmx) pages.  Deliberately does NOT reuse the old
// navBar below: that one's "Add New Entry" calls into the old editor's
// browser modules, which the htmx template doesn't load.
export function htmxNavBar(showTestClientLink: boolean = false): any {
    return (
        ['nav', {class:'navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body', 'data-bs-theme':'dark'},
         ['div', {class:'container-fluid'},
          ['a', {class:'navbar-brand', href:'/ww/'}, 'MMO Editor'],
          ['button', {class:'navbar-toggler', type:'button', 'data-bs-toggle':'collapse', 'data-bs-target':'#navbarSupportedContent', 'aria-controls':'navbarSupportedContent', 'aria-expanded':'false', 'aria-label':'Toggle navigation'},
           ['span', {class:'navbar-toggler-icon'}]],
          ['div', {class:'collapse navbar-collapse', id:'navbarSupportedContent'},
           ['ul', {class:'navbar-nav me-auto mb-2 mb-lg-0'},
            ['li', {class:'nav-item'},
             ['a', {class:'nav-link', href:'/ww/wordwiki.usersPage()'}, 'Users']],
            showTestClientLink
                ? ['li', {class:'nav-item'},
                   ['button', {type:'button', class:'nav-link btn btn-link text-warning',
                               onclick:"window.location.href='/ww/wordwiki.testClientPage()'",
                               title:'Test-mode only: act as the browser test client'},
                    'Test client ',
                    ['span', {class:'badge text-bg-warning'}, 'test']]]
                : undefined,
           ],
           ['form', {class:'d-flex me-3', role:'search', method:'get', action:'/ww/wordwiki.searchPage(query)'},
            ['input', {name:'searchText', class:'form-control me-2', type:'search', placeholder:'Search', 'aria-label':'Search'}],
            ['button', {class:'btn btn-outline-success', type:'submit'}, 'Search']],
           ['ul', {class:'navbar-nav'},
            ['li', {class:'nav-item'},
             ['button', {type:'button', class:'nav-link btn btn-link',
                         'hx-post':'/ww/wordwiki.logout(session_token)', 'hx-swap':'none'}, 'Logout']]],
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
          ['link', {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          ['link', {href: '/resources/page-editor.css', rel:'stylesheet', type:'text/css'}],
          ['link', {href: '/resources/context-menu.css', rel:'stylesheet', type:'text/css'}],
          ['script', {}, block`
/**/           let imports = {};
/**/           let activeViews = undefined`],


          ['script', {}, block`
/**/           function playAudio(src) {
/**/             const audioPlayer = document.getElementById("audioPlayer");
/**/             if(!audioPlayer) throw new Error('could not find audio player');
/**/             audioPlayer.src = src;
/**/             audioPlayer.play ();
/**/          }`],

          ['script', {type: 'module'}, block`
/**/           import * as workspace from '/scripts/datawiki/workspace.js';
/**/           import * as view from '/scripts/datawiki/view.js';
/**/
/**/           imports = Object.assign(
/**/                        {},
/**/                        view.exportToBrowser(),
/**/                        workspace.exportToBrowser());
/**/
/**/           activeViews = imports.activeViews;
/**/
/**/           document.addEventListener("DOMContentLoaded", (event) => {
/**/             console.log("DOM fully loaded and parsed");
/**/             view.run();
/**/             //workspace.renderSample(document.getElementById('root'))
/**/           });
/**/
`
          ],
          content.head,
         ], // head

         ['body', {},

          navBar(),

          // TODO probably move this somewhere else
          ['audio', {id:'audioPlayer', preload:'none'},
           ['source', {src:'', type:'audio/mpeg'}]],

          content.body,

          view.renderModalEditorSkeleton(),

          config.bootstrapScriptTag

         ] // body
        ] // html
    );
}

export function navBar(): any {
    return [
        ['nav', {class:"navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body", 'data-bs-theme':"dark"},
         ['div', {class:"container-fluid"},
          ['a', {class:"navbar-brand", href:"/ww/"}, 'MMO Editor'],
          ['button', {class:"navbar-toggler", type:"button", 'data-bs-toggle':"collapse", 'data-bs-target':"#navbarSupportedContent", 'aria-controls':"navbarSupportedContent", 'aria-expanded':"false", 'aria-label':"Toggle navigation"},
           ['span', {class:"navbar-toggler-icon"}],
          ], //button

          ['div', {class:"collapse navbar-collapse", id:"navbarSupportedContent"},
           ['ul', {class:"navbar-nav me-auto mb-2 mb-lg-0"},

            ['li', {class:"nav-item"},
             ['a', {class:"nav-link", href:"/ww/wordwiki.categoriesDirectory()"}, 'Categories'],
            ], //li

            // --- Reference Books
            ['li', {class:"nav-item dropdown"},
             ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
              'Reference Books'
             ], //a
             ['ul', {class:"dropdown-menu"},
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/pageEditor("PDM")'}, 'PDM']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/pageEditor("Rand")'}, 'Rand']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/pageEditor("Clark")'}, 'Clark']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/pageEditor("PacifiquesGeography")'}, 'PacifiquesGeography']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/pageEditor("RandFirstReadingBook")'}, 'RandFirstReadingBook']],
              //['li', {}, ['hr', {class:"dropdown-divider"}]],
              //['li', {}, ['a', {class:"dropdown-item", href:"#"}, 'Something else here']],
             ], //ul
            ], //li

            // Reports
            ['li', {class:"nav-item dropdown"},
             ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
              'Reports'
             ], //a
             ['ul', {class:"dropdown-menu"},
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/wordwiki.entriesByPDMPageDirectory()'}, 'Entries by PDM page']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/wordwiki.categoriesDirectory()'}, 'Entries by Category']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/wordwiki.todoReport(null, null)'}, 'TODO Report']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/wordwiki.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/wordwiki.entriesByPronunciation()'}, 'Entries By Pronunciation']],              
              //['li', {}, ['a', {class:"dropdown-item", href:'/ww/wordwiki.entriesByEnglishGloss()'}, 'Entries by English Gloss']],              
             ], //ul
            ], //li

            // Reports
            ['li', {class:"nav-item dropdown"},
             ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
              'Admin'
             ], //a
             ['ul', {class:"dropdown-menu"},
              ['li', {}, ['a', {class:"dropdown-item", href:'/ww/startPublish()'}, 'Publish']],
             ], //ul
            ], //li
            
           //  ['li', {class:"nav-item"},
           //   ['a', {class:"nav-link disabled", 'aria-disabled':"true"}, 'Disabled'],
           //  ], //li


            ['li', {class:"nav-item"},
             ['a', {class:"nav-link", 'aria-current':"page", href:"#", onclick:'imports.launchNewLexeme()'}, 'Add New Entry'],
            ], //li

            ['li', {class:"nav-item"},
             ['a', {class:"nav-link", 'aria-current':"page", href:"/index.html"}, 'Public Site'],
            ], //li

            ['li', {class:"nav-item"},
             ['a', {class:"nav-link", href:"/ww/wordwiki.usersPage()"}, 'Users'],
            ], //li
            
           ], //ul

           // Search form
           ['form', {class:"d-flex", role:"search", method:'get', action:'/ww/wordwiki.searchPage(query)'},
            ['input', {id:'searchText', name:'searchText', class:"form-control me-2", type:"search", placeholder:"Search", 'aria-label':"Search"}],
            ['button', {class:"btn btn-outline-success", type:"submit"}, 'Search'],
           ], //form

          ], //div navbar-collaplse

         ], //div container
        ], //nav
    ];
}
