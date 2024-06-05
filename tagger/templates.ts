// deno-lint-ignore-file no-explicit-any

import * as config from './config.ts';
import {block} from "../utils/strings.ts";
import * as view from './view.ts';

export interface PageContent {
    title?: any;
    head?: any;
    body?: any;
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

          //['script', {src:'/scripts/tagger/instance.js', type: 'module'}],
          ['script', {type: 'module'}, block`
/**/           import * as workspace from '/scripts/tagger/workspace.js';
/**/           import * as view from '/scripts/tagger/view.js';
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
          ['a', {class:"navbar-brand", href:"/"}, 'MMO'],
          ['button', {class:"navbar-toggler", type:"button", 'data-bs-toggle':"collapse", 'data-bs-target':"#navbarSupportedContent", 'aria-controls':"navbarSupportedContent", 'aria-expanded':"false", 'aria-label':"Toggle navigation"},
           ['span', {class:"navbar-toggler-icon"}],
          ], //button

          ['div', {class:"collapse navbar-collapse", id:"navbarSupportedContent"},
           ['ul', {class:"navbar-nav me-auto mb-2 mb-lg-0"},

            ['li', {class:"nav-item"},
             ['a', {class:"nav-link", href:"/wordwiki.categoriesDirectory()"}, 'Categories'],
            ], //li

            // --- Reference Books
            ['li', {class:"nav-item dropdown"},
             ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
              'Reference Books'
             ], //a
             ['ul', {class:"dropdown-menu"},
              ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("PDM")'}, 'PDM']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("Rand")'}, 'Rand']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("Clark")'}, 'Clark']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("RandFirstReadingBook")'}, 'RandFirstReadingBook']],
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
              ['li', {}, ['a', {class:"dropdown-item", href:'/wordwiki.entriesByPDMPageDirectory()'}, 'Entries by PDM page']],
              ['li', {}, ['a', {class:"dropdown-item", href:'/wordwiki.categoriesDirectory()'}, 'Entries by Category']],
             ], //ul
            ], //li

           //  ['li', {class:"nav-item"},
           //   ['a', {class:"nav-link disabled", 'aria-disabled':"true"}, 'Disabled'],
           //  ], //li


            ['li', {class:"nav-item"},
             ['a', {class:"nav-link", 'aria-current':"page", href:"#", onclick:'imports.launchNewLexeme()'}, 'Add New Entry'],
            ], //li

           ], //ul

           // Search form
           ['form', {class:"d-flex", role:"search", method:'get', action:'/wordwiki.searchPage(query)'},
            ['input', {id:'searchText', name:'searchText', class:"form-control me-2", type:"search", placeholder:"Search", 'aria-label':"Search"}],
            ['button', {class:"btn btn-outline-success", type:"submit"}, 'Search'],
           ], //form

          ], //div navbar-collaplse

         ], //div container
        ], //nav
    ];
}
