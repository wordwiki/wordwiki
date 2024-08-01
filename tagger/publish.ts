// deno-lint-ignore-file no-unused-vars

import * as markup from '../utils/markup.ts';
import * as config from './config.ts';
import * as templates from './templates.ts';
import {db} from "./db.ts";
import {panic} from '../utils/utils.ts';
import * as utils from '../utils/utils.ts';
import {block} from '../utils/strings.ts';
import * as server from '../utils/http-server.ts';
import {getWordWiki, WordWiki} from './wordwiki.ts';
import { writeUTF8FileIfContentsChanged } from '../utils/ioutils.ts';
import * as entryschema from './entry-schema.ts';
import {Entry} from './entry-schema.ts';
import * as audio from './audio.ts';  // REMOVE_FOR_WEB

import {renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM} from '../utils/markup.ts';

export class PublishStatus {
    startTime?: number = undefined;
    endTime?: number = undefined;
    log: string[] = [];
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
        this.log = [];
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

        (publishStatus.log.length > 0) ? [
            ['h2', {}, 'Recent Tasks'],
            ['ul', {},
             publishStatus.log.slice(-20).map(e=>[
                 ['li', {}, e]
             ])
            ]] : [],
    ];

    const autoRefreshScript = ['script', {}, block`
/**/  window.addEventListener("load", e => {
/**/     setTimeout(()=>location.reload(), 5000);
/**/  });`];

    return templates.pageTemplate({title, body, head: autoRefreshScript});
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


export function startPublish(): any {
    if(publishStatusSingleton.isRunning) {
        return server.forwardResponse('/publishStatus(true)');
    } else {
        (async ()=>{
            publishStatusSingleton.start();
            try {
                const wordWiki = getWordWiki();
                const publish = new Publish(publishStatusSingleton,
                                            wordWiki,
                                            wordWiki.entriesJSON);
                await publish.publish();
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


/**
 *
 */
export class Publish {
    entryToPublicId: Map<Entry, string>;
    defaultVariant: string = 'mm-li';

    constructor(public status: PublishStatus, public wordWiki: WordWiki,
                public entries: Entry[],
                public publishRoot: string = '.') {
        this.entryToPublicId = this.computeEntryPublicIds(entries, this.defaultVariant);
    }

    async publish(): Promise<void> {
        // --- If publish root dir does not exist, create it.
        await Deno.mkdir(this.publishRoot, {recursive: true});

        // --- Publish home page
        await this.publishItem('Home Page', ()=>this.publishHomePage());

        // --- Publish all entries
        await this.publishEntries();

        // --- Publish categories
        await this.publishCategoriesDirectory();
        await this.publishCategories();

    }

    async publishItem(itemDesc: string, itemPromise: ()=>Promise<void>): Promise<void> {
        let error: Error|undefined = undefined;
        console.info(`publish ${itemDesc}`);
        try {
            await (itemPromise());
        } catch(e) {
            error = e;
        } finally {
            console.timeEnd(`publish ${itemDesc}`);
        }
        if(error)
            this.status.errors.push(`${itemDesc}: ${error.toString()}`);
        else
            this.status.log.push(itemDesc);
    }
    
    get homePath(): string {
        return this.publishRoot+'/index.html';
    }
    
    async publishHomePage(): Promise<void> {

        const allSearchTerms = Array.from(new Set(
            this.entries.flatMap(entry=>entryschema.computeNormalizedSearchTerms(entry))));
        
        const head = [
            ['style', {}, block`
/**/                .def { display:none; }
/**/                _search_ { display: list-item; }`],
            ['script', {src:'resources/search.js'}],
            ['script', {}, block`
/**/                allSearchTerms = ${JSON.stringify(allSearchTerms)};
/**/                `],
        ];
        const title = "Mi'gmaq/Mi'kmaq Online Talking Dictionary";
        const body =
            ['div', {},
             ['h1', {}, title],

             // --- Search Box
             ['form', {onsubmit:"updateCurrentSearchFromInput(); event.preventDefault();"},
              ['label', {for:"search"}, 'Search:'],
              ['input', {type:"text", size:"20",
                         name:"search", id:"search", label:"Search", autofocus:"",
                         placeholder:"Mi'gmaq or English Search",
                         oninput:"updateCurrentSearchFromInput();"}],
             ], // /form      

             // --- If we are returning to this page - restore the search from the fragment id in the URL
             ['script', {}, block`
/**/              updateCurrentSearchFromDocumentHash();
/**/         `],

             // --- Search instructions display until user starts typing a search
             ['div', {id:"searchInstructions"},
              ['ul', {},
               ['li', {}, "You can search in Mi'gmaq/Mi'kmaq or English."],
               ['li', {}, "Search results will update as you type (after the first 3 letters)."],
               ['li', {}, "Click on 🔉 to hear a recording of the word."],
               ['li', {}, "To do an exact word search, end the word with a space."],
               ['li', {}, "You can use a * for parts of a word you do not want to spell."],
               ['li', {}, "You can do searches with multiple words.  For example 'wild cat'."],
              ],
             ],

             ['ul', {},
              this.entries.map(entry=>[
                  ['li', {class:entryschema.computeNormalizedSearchTerms(entry).join(' ')+' def'},
                   this.renderEntryPublicLink('./', entry)
                  ]
              ])
             ],
            ];
        
        await writePageFromMarkupIfChanged(this.homePath, this.publicPageTemplate('', {title, head, body}));
    }

    /**
     *
     */
    renderEntryPublicLink(rootPath: string, e: Entry, includeAudioLink: boolean=true): any {
        // TODO handle dialects here.
        const spellings = e.spelling.map(s=>s.text);
        const glosses = e.subentry.flatMap(se=>se.gloss.map(gl=>gl.gloss));
        const sampleRecording = entryschema.getStableFeaturedRecording(e);
        //console.info('SAMPLE RECORDING IS', spellings, sampleRecording);
        return [
            ['a', {href: rootPath+this.pathForEntry(e)}, ['strong', {}, spellings.join(', ')], ' : ', glosses.join(' / ')],
            (includeAudioLink && sampleRecording) ?
                audio.renderAudio(sampleRecording.recording, '🔉', undefined, rootPath) : [],
        ];
    }

    /**
     *
     */
    async publishEntries(): Promise<void> {
        // TODO: filter for only published words
        for(const entry of this.entries) {
            await this.publishItem(`Entry ${this.getPublicIdForEntry(entry)}`, ()=>this.publishEntry(entry));
        }
    }
    
    /**
     *
     */
    async publishEntry(entry: Entry): Promise<void> {
        const rootPath = '../../../';
        const entryPath = this.pathForEntry(entry);
        const entryDir = this.dirForEntry(entry);
        await Deno.mkdir(entryDir, {recursive: true});
        const title = 'title';
        const entryMarkup:any[] = entryschema.renderEntry({rootPath}, entry);
        // renderCategoriesForEntry here.

        const entryCategories = entry.subentry.flatMap(s=>s.category.flatMap(c=>c.category));
        const relatedCategoryMarkup =
            entryCategories.map(category=>[
                ['h3', {}, `Related entries for category "${category}"`],
                ['div', {},
                 ['ul', {},
                  (this.wordWiki.entriesByCategory.get(category)??[])
                      .map(e=>['li', {}, this.renderEntryPublicLink(rootPath, e, false)]),
                 ] // ul
                ] // div
            ]);

        const body = [
            entryMarkup,
            relatedCategoryMarkup,
        ];
                                
        await writePageFromMarkupIfChanged(entryPath, this.publicPageTemplate(rootPath, {title, body}));
    }


    get categoriesDir(): string {
        return 'categories';
    }
    
    get categoriesDirectoryPath(): string {
        return 'categories.html';
    }

    pathForCategory(category: string): string {
        return `${this.categoriesDir}/${category.replaceAll(/[^a-zA-Z0-9-']/g, '_')}.html`;
    }
    
    /**
     *
     */
    async publishCategoriesDirectory(): Promise<void> {
        const title = `Categories Directory`;

        const body = [
            ['h1', {}, title],
            ['ul', {},
             Array.from(this.wordWiki.getCategories().entries()).map(cat=>
                 ['li', {}, ['a',
                             {href:this.pathForCategory(cat[0])},
                             cat[0], ` (${cat[1]} entries)`]]),
            ]
        ];
        await writePageFromMarkupIfChanged(this.categoriesDirectoryPath, this.publicPageTemplate('', {title, body}));
    }

    /**
     *
     */
    async publishCategories(): Promise<void> {
        await Deno.mkdir(this.categoriesDir, {recursive: true});
        for(const category of this.wordWiki.getCategories().keys()) {
            await this.publishItem(`Category ${category}`, ()=>this.publishCategory(category));
        }
    }
    
    /**
     *
     */
    async publishCategory(category: string): Promise<void> {

        //const entriesForCategory = this.wordWiki.getEntriesForCategory(category);
        const entriesForCategory = this.wordWiki.entriesByCategory.get(category)??[];
        
        const title = ['Entries for category ', category];
        
        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesForCategory
                  .map(e=>['li', {}, this.renderEntryPublicLink('../../', e)]),
             ] // ul
            ] // div
        ];

        await writePageFromMarkupIfChanged(this.pathForCategory(category), this.publicPageTemplate('../../', {title, body}));
    }
        
    dirForEntry(entry: Entry): string {
        const publicId = this.getPublicIdForEntry(entry);
        const cluster = this.clusterForEntry(entry);
        return `${this.publishRoot}/entries/${cluster}/${publicId}`;
    }

    clusterForEntry(entry: Entry): string {
        return (this.getPublicIdForEntry(entry)[0]??'_').toLowerCase();
    }
    
    pathForEntry(entry: Entry): string {
        const publicId = this.getPublicIdForEntry(entry);
        return `${this.dirForEntry(entry)}/${publicId}.html`;
    }

    getPublicIdForEntry(entry: Entry): string {
        const publicId = this.entryToPublicId.get(entry);
        return publicId || `-${entry.entry_id}`;
    }

    computeEntryPublicIds(entries: Entry[], defaultVariant: string): Map<Entry, string> {
        const entryIdToDefaultPublicId = new Map(
            entries.map(e=>[e, this.computeDefaultPublicIdForEntry(e, defaultVariant)]));
        const duplicateIds = utils.duplicateItems([...entryIdToDefaultPublicId.values()]);
        return new Map(
            entries.map(entry=>{
                const defaultId = entryIdToDefaultPublicId.get(entry) ?? panic();
                if(duplicateIds.has(defaultId))
                    return [entry, `${defaultId}-${entry.entry_id}`]; // Note '-' is reserved for this
                else
                    return [entry, defaultId];
            }));
    }

    computeDefaultPublicIdForEntry(entry: Entry, defaultVariant: string): string {
        const publicIdBase = this.getDefaultPublicIdBase(entry, defaultVariant);
        // TODO: make this fancier if we want to support other languages.
        const urlSafePublicIdBase = publicIdBase.replaceAll(/[^a-zA-Z0-9']/g, '_');
        return urlSafePublicIdBase;
    }

    getDefaultPublicIdBase(entry: Entry, defaultVariant: string): string {

        // --- If the entry has spellings in the default variant, use the first
        //     such spelling as the base for the public id.
        const firstSpellingInDefaultVariant =
            entry.spelling.filter(s=>s.variant === defaultVariant)[0]?.text;
        if(firstSpellingInDefaultVariant)
            return firstSpellingInDefaultVariant;

        // --- Otherwise, if the entry has a spelling in any variant, use the first
        //     such spelling as the base for the public id.
        const firstSpellingInAnyVariant = entry.spelling[0];
        if(firstSpellingInAnyVariant)
            return firstSpellingInAnyVariant.text

        // --- Otherwise, use the entryId converted to a string as the base for the
        //     public id.
        return String(entry.entry_id);
    }

    /**
     *
     */
    publicPageTemplate(rootPath: string, content: PublicPageContent): any {
        return (
            ['html', {},

             ['head', {},
              ['meta', {charset:"utf-8"}],
              ['meta', {name:"viewport", content:"width=device-width, initial-scale=1"}],
              content.title !== undefined ? ['title', {}, content.title] : undefined,
              config.bootstrapCssLink,
              // TODO remove most of these css for the public side
              ['link', {href: `${rootPath}resources/instance.css`, rel:'stylesheet', type:'text/css'}],
              ['link', {href: `${rootPath}resources/page-editor.css`, rel:'stylesheet', type:'text/css'}],
              ['link', {href: `${rootPath}resources/context-menu.css`, rel:'stylesheet', type:'text/css'}],
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

              this.publicNavBar(rootPath),

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


    publicNavBar(rootPath: string): any {
        return [
            ['nav', {class:"navbar navbar-expand-lg bg-body-tertiary bg-dark border-bottom border-body", 'data-bs-theme':"dark"},
             ['div', {class:"container-fluid"},
              ['a', {class:"navbar-brand", href:rootPath+this.homePath}, 'MMO'],
              ['button', {class:"navbar-toggler", type:"button", 'data-bs-toggle':"collapse", 'data-bs-target':"#navbarSupportedContent", 'aria-controls':"navbarSupportedContent", 'aria-expanded':"false", 'aria-label':"Toggle navigation"},
               ['span', {class:"navbar-toggler-icon"}],
              ], //button

              ['div', {class:"collapse navbar-collapse", id:"navbarSupportedContent"},
               ['ul', {class:"navbar-nav me-auto mb-2 mb-lg-0"},

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath+this.homePath}, 'Home'],
                ], //li

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath+this.categoriesDirectoryPath}, 'Categories'],
                ], //li

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath+this.homePath}, 'All Words'], // XXX FIX PATH XXX
                ], //li

                ['li', {class:"nav-item"},
                 ['a', {class:"nav-link", href:rootPath}, 'About Us'], // FIX PATH XXX
                ], //li




                // // --- Reference Books
                // ['li', {class:"nav-item dropdown"},
                //  ['a', {class:"nav-link dropdown-toggle", href:"#", role:"button", 'data-bs-toggle':"dropdown", 'aria-expanded':"false"},
                //   'Reference Books'
                //  ], //a
                //  ['ul', {class:"dropdown-menu"},
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("PDM")'}, 'PDM']],
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("Rand")'}, 'Rand']],
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("Clark")'}, 'Clark']],
                //   ['li', {}, ['a', {class:"dropdown-item", href:'/pageEditor("RandFirstReadingBook")'}, 'RandFirstReadingBook']],
                //   //['li', {}, ['hr', {class:"dropdown-divider"}]],
                //   //['li', {}, ['a', {class:"dropdown-item", href:"#"}, 'Something else here']],
                //  ], //ul
                // ], //li

               ], //ul

               // // Search form
               // ['form', {class:"d-flex", role:"search", method:'get', action:'/wordwiki.searchPage(query)'},
               //  ['input', {id:'searchText', name:'searchText', class:"form-control me-2", type:"search", placeholder:"Search", 'aria-label':"Search"}],
               //  ['button', {class:"btn btn-outline-success", type:"submit"}, 'Search'],
               // ], //form

              ], //div navbar-collaplse

             ], //div container
            ], //nav
        ];
    }
}

export async function writePageFromMarkupIfChanged(path: string, pageMarkup: any): Promise<boolean> {
    const html = await asyncRenderToStringViaLinkeDOM(pageMarkup);
    return writeUTF8FileIfContentsChanged(path, html);
}



export const routes = ()=> ({
    startPublish,
    publishStatus,
});
