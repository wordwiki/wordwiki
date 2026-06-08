// deno-lint-ignore-file no-explicit-any

import * as config from './config.ts';
import {block} from "../liminal/strings.ts";
import * as view from '../datawiki/view.ts';
import {h} from '../liminal/markup.ts';

export interface PageContent {
    title?: any;
    head?: any;
    body?: any;
}

export function pageTemplate(content: PageContent): any {
    return (
        [h.html, {},

         [h.head, {},
          [h.meta, {charset:"utf-8"}],
          [h.meta, {name:"viewport", content:"width=device-width, initial-scale=1"}],
          content.title !== undefined ? [h.title, {}, content.title] : undefined,
          config.bootstrapCssLink,
          [h.link, {href: '/resources/instance.css', rel:'stylesheet', type:'text/css'}],
          [h.link, {href: '/resources/page-editor.css', rel:'stylesheet', type:'text/css'}],
          [h.link, {href: '/resources/context-menu.css', rel:'stylesheet', type:'text/css'}],
          [h.link, {href: '/resources/rabid.css', rel:'stylesheet', type:'text/css'}],
          // Tom Select: a vanilla-JS filterable <select> picker with a Bootstrap 5
          // theme.  Initialised on .ts-picker selects by rabid-scripts.js (after
          // htmx swaps, so it works on modal-loaded forms).
          [h.link, {href: 'https://cdn.jsdelivr.net/npm/tom-select@2.3.1/dist/css/tom-select.bootstrap5.min.css', rel:'stylesheet'}],
          [h.script, {src: 'https://cdn.jsdelivr.net/npm/tom-select@2.3.1/dist/js/tom-select.complete.min.js'}],
          [h.script, {src: '/resources/context-menu.js'}],
          [h.script, {src: 'https://unpkg.com/htmx.org@2.0.4'}],
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

          navBar(),

          // TODO probably move this somewhere else
          [h.audio, {id:'audioPlayer', preload:'none'},
           [h.source, {src:'', type:'audio/mpeg'}]],

          content.body,

          renderModalEditorSkeleton(),

          config.bootstrapScriptTag,

          [h.script, {src: '/resources/rabid-scripts.js'}],
          
         ] // body
        ] // html
    );
}

export function navBar(): any {
    return [
        [h.nav, {class:"navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body", 'data-bs-theme':"dark"},
         [h.div, {class:"container-fluid"},
          [h.a, {class:"navbar-brand", href:"/rr/"}, 'RRBR'],
          [h.button, {class:"navbar-toggler", type:"button", 'data-bs-toggle':"collapse", 'data-bs-target':"#navbarSupportedContent", 'aria-controls':"navbarSupportedContent", 'aria-expanded':"false", 'aria-label':"Toggle navigation"},
           [h.span, {class:"navbar-toggler-icon"}],
          ], //button

          [h.div, {class:"collapse navbar-collapse", id:"navbarSupportedContent"},
           [h.ul, {class:"navbar-nav me-auto mb-2 mb-lg-0"},

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/ww/wordwiki.categoriesDirectory()"}, 'Home'],
            ], //li

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/ww/wordwiki.categoriesDirectory()"}, 'Volunteers'],
            ], //li

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/ww/wordwiki.categoriesDirectory()"}, 'Events'],
            ], //li

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/ww/wordwiki.categoriesDirectory()"}, 'Service'],
            ], //li

            [h.li, {class:"nav-item"},
             [h.a, {class:"nav-link", href:"/ww/wordwiki.categoriesDirectory()"}, 'Sales'],
            ], //li
            

            // Reports
            [h.li, {class:"nav-item dropdown"},
             [h.a, {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
              'Reports'
             ], //a
             [h.ul, {class:"dropdown-menu"},
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/ww/wordwiki.entriesByPDMPageDirectory()'}, 'Entries by PDM page']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/ww/wordwiki.categoriesDirectory()'}, 'Entries by Category']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/ww/wordwiki.todoReport(null, null)'}, 'TODO Report']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/ww/wordwiki.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/ww/wordwiki.entriesByPronunciation()'}, 'Entries By Pronunciation']],              
              //[h.li, {}, [h.a, {class:"dropdown-item", href:'/ww/wordwiki.entriesByEnglishGloss()'}, 'Entries by English Gloss']],              
             ], //ul
            ], //li

            // Admin
            [h.li, {class:"nav-item dropdown"},
             [h.a, {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
              'Admin'
             ], //a
             [h.ul, {class:"dropdown-menu"},
              [h.li, {}, [h.a, {class:"dropdown-item", href:'/ww/startPublish()'}, 'Publish']],
             ], //ul
            ], //li
            
           //  ['li', {class:"nav-item"},
           //   ['a', {class:"nav-link disabled", 'aria-disabled':"true"}, 'Disabled'],
           //  ], //li

            
           ], //ul

           // Search form
           [h.form, {class:"d-flex me-3", role:"search", method:'get', action:'/ww/wordwiki.searchPage(query)'},
            [h.input, {id:'searchText', name:'searchText', class:"form-control me-2", type:"search", placeholder:"Search", 'aria-label':"Search"}],
            [h.button, {class:"btn btn-outline-success", type:"submit"}, 'Search'],
           ], //form

           // Logout (session_token is bound in the route scope by rabid.rpcHandler).
           // Uses hx-post so the state change is a POST (not a prefetchable GET);
           // the server replies with an HX-Redirect that htmx follows to /.
           [h.ul, {class:"navbar-nav"},
            [h.li, {class:"nav-item"},
             [h.button, {type:"button", class:"nav-link btn btn-link",
                         'hx-post':"/rabid/rabid.logout(session_token)", 'hx-swap':"none"}, 'Logout'],
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
                 'data-bs-backdrop':'static', 'data-bs-keyboard':'false',
                 tabindex:'-1', 'aria-labelledby':'modalEditorLabel',
                 'aria-hidden':'true'},
         //[h.div, {class:'modal-dialog modal-dialog-scrollable modal-fullscreen'},
          [h.div, {class:'modal-dialog modal-dialog-scrollable modal-lg'},

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
