// deno-lint-ignore-file no-unused-vars

import * as markup from '../utils/markup.ts';
import * as config from './config.ts';
import * as templates from './templates.ts';
import {db} from "./db.ts";
import {panic} from '../utils/utils.ts';
import {block} from '../utils/strings.ts';
import * as server from '../utils/http-server.ts';
import {getWordWiki, WordWiki} from './wordwiki.ts';
import * as entry from './entry-schema.ts';
import { writeUTF8FileIfContentsChanged } from '../utils/ioutils.ts';

import {renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM} from '../utils/markup.ts';

export class PublishStatus {
    startTime?: number = undefined;
    endTime?: number = undefined;
    completedTasks: string[] = [];
    errors: string[] = [];

    constructor() {
    }

    get isRunning(): boolean {
        return !!this.startTime && !this.endTime;
    }

    start() {
        if(this.isRunning)
            throw new Error('publish is already running');
        this.startTime = +new Date();
        this.endTime = undefined;
        this.completedTasks = [];
        this.errors = [];
    }

    end() {
        this.endTime = +new Date();
    }
}

// We only want one publish running at a time, we model this
// by having the publish status be a singleton.
export const publishStatusSingleton = new PublishStatus();

export function publishStatus(joiningExistingPublish: boolean=false,
                              publishStatus: PublishStatus = publishStatusSingleton) {

    const title = `Publish Status`;
    const body = [
        ['h1', {}, title],
        
        joiningExistingPublish ?
            [['h2', {style: "color: red"},
              'Showing the progress of an already in process publish'],
             ['h3', {}, 'A new publish was not started']] : [],

        publishStatus.startTime ? 
            [
                ['h2', {}, `Publish started on ${new Date(publishStatus.startTime)}`],
                `Publish started ${Math.round((+new Date() - publishStatus.startTime)/1000)} seconds ago`
            ] :
            ['h2', {}, `A publish has not been started`],
        
        publishStatus.endTime ?
            [
                ['h2', {style: publishStatus.errors.length > 0 ? "color: red" : "color: green"}, `Publish completed on ${new Date(publishStatus.endTime)}`],
                `Publish took ${Math.round((publishStatus.endTime - (publishStatus.startTime??0))/1000)} seconds`                
            ]: [],
        
        (publishStatus.errors.length > 0) ? [
            ['h2', {style: "color: red"}, 'Errors'],
            ['ul', {},
             publishStatus.errors.map(e=>[
                 ['li', {}, e]
             ])
            ]] : [],

        (publishStatus.completedTasks.length > 0) ? [
            ['h2', 'Recent Tasks'],
            ['ul', {},
             publishStatus.completedTasks.slice(-20).map(e=>[
                 ['li', {}, e]
             ])
            ]] : [],
    ];

    const autoRefreshScript = ['script', {}, block`
/**/  window.addEventListener("load", e => {
/**/     setTimeout(()=>location.reload(), 2000);
/**/  });`];

    return templates.pageTemplate({title, body, head: autoRefreshScript});
}

export async function publishc(): Promise<void> {
    // Compute promises for all pages we want to publish (one per word, one per category, one per home page etc).
    // - If we await them all, then the server will be swamped with work, and may be unresponsive to outside requests until
    //   publish done (but will not be very long anyway - just a few 10's of thousands of pages).
    // - do one at a time to avoid this.
}

/**
 *
 */
export async function publishWordPage(publishRoot: string): Promise<void> {
    
}

export interface PublicPageContent {
    title?: any;
    head?: any;
    body?: any;
}

export function publicPageTemplate(content: PublicPageContent): any {
    return (
        ['html', {},

         ['head', {},
          ['meta', {charset:"utf-8"}],
          ['meta', {name:"viewport", content:"width=device-width, initial-scale=1"}],
          content.title !== undefined ? ['title', {}, content.title] : undefined,
          config.bootstrapCssLink,
          // TODO remove most of these css for the public side
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

          content.head,
         ], // head

         ['body', {},

          publicNavBar(),

          // TODO probably move this somewhere else
          ['audio', {id:'audioPlayer', preload:'none'},
           ['source', {src:'', type:'audio/mpeg'}]],

          content.body,

          //view.renderModalEditorSkeleton(),

          config.bootstrapScriptTag

         ] // body
        ] // html
    );
}


export function publicNavBar(): any {
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

            // Reports
            ['li', {class:"nav-item dropdown"},
             ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
              'Admin'
             ], //a
             ['ul', {class:"dropdown-menu"},
              ['li', {}, ['a', {class:"dropdown-item", href:'/wordwiki.startPublish()'}, 'Publish']],
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

export function startPublish(): any {
    if(publishStatusSingleton.isRunning) {
        return server.forwardResponse('/publishStatus(true)');
    } else {
        (async ()=>{
            publishStatusSingleton.start();
            try {
                const ctx = new PublishCtx(publishStatusSingleton, getWordWiki());
                await publish(ctx);
            } catch (e) {
                publishStatusSingleton.errors.push(e.toString());
                console.info('ERROR WHILE PUBLISHING', e.toString());
                console.info(e.stack);
            }
            publishStatusSingleton.end();
        })();
        return server.forwardResponse('/publishStatus(false)');
    }
}

class PublishCtx {
    #entryPublicIds: Map<number, string>|undefined;

    constructor(public status: PublishStatus, public wordWiki: WordWiki,
                public publishRoot: string = 'published') {
    }

    get entryPublicIds(): Map<number, string> {
        return this.#entryPublicIds ??= new Map();
    }
}


export async function publish(ctx: PublishCtx): Promise<void> {
    // --- If publish root dir does not exist, create it.
    await Deno.mkdir(ctx.publishRoot, {recursive: true});
    await publishWords(ctx);

    // --- Publish all words
    await publishWords(ctx);
}

export async function publishWords(ctx: PublishCtx): Promise<void> {
    // TODO: filter for only published words
    for(const entry of ctx.wordWiki.entriesJSON) {
        await publishWord(ctx,  entry);
    }
}

/*
-


 */


export async function publishWord(ctx: PublishCtx, entry: entry.Entry): Promise<void> {
    const path = `${ctx.publishRoot}/entry-${entry.entry_id}.html`;
    const title = 'title';
    const body:any[] = [];
    
    const wordMarkup = publicPageTemplate({title, body});
    //const wordMarkup = ['h1', {}, title];
    await writePageFromMarkupIfChanged(path, wordMarkup);
}

export async function writePageFromMarkupIfChanged(path: string, pageMarkup: any): Promise<boolean> {
    const html = await asyncRenderToStringViaLinkeDOM(pageMarkup);
    return writeUTF8FileIfContentsChanged(path, html);
}



export const routes = ()=> ({
    startPublish,
    publishStatus,
});
