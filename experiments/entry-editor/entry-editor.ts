import {DenoHttpServer} from '../../server/deno-http-server.ts';
import * as server from '../../server/server.ts';
import { parse as toml_parse, stringify as toml_stringify } from "https://deno.land/std@0.177.0/encoding/toml.ts";
// @deno-types='https://deno.land/x/xregexp/types/index.d.ts'
import XRegExp from  'https://deno.land/x/xregexp/src/index.js';
import * as liquid from "https://esm.sh/liquidjs@10.6.0";
import EditListTag from './editlist-tag.ts';
import SectionTag from './section-tag.ts';
import SelectTag from './select-tag.ts';
import {SectionedPageEmitter} from './section-tag.ts';
import { sleep } from "https://deno.land/x/sleep/mod.ts";
import {stringify}  from './liquid-utils.ts';

import { DB } from "https://deno.land/x/sqlite/mod.ts";

// TODO: inline a lexeme (as json)
// TODO: render a the lexeme using the template engine
// TODO: make a custom tag
// TODO: do a sample edit workflow

class EntryEditorServer {
    template_engine: liquid.Liquid;

    constructor(public entry: any, db: DB) {
        let templates_root = 'templates';
        this.template_engine = new liquid.Liquid({
            strictFilters: true,
            strictVariables: true,
            outputEscape: 'escape',
            root: `${templates_root}/pages`,
            partials: `${templates_root}/partials`,
            layouts: `${templates_root}/layouts`,
            globals: { db },
            //cache: true, // off while testing
        });

        console.info(this.template_engine.options.globals);

        
        this.template_engine.registerTag('editlist', EditListTag);
        this.template_engine.registerTag('section', SectionTag);
        this.template_engine.registerTag('select', SelectTag);
    }
    
    async handleRequest(request: server.Request): Promise<server.Response> {
        console.info('REQUEST URL', request.url);
        const url = new URL(request.url);
        let match: any = undefined;
        //console.info('url', url);
        //console.info('url.pathname', url.pathname);
        switch(true) {
            case !!(match=XRegExp.cache(`^/entry/(?<id>[\\w-]+)$`, 'x').exec(url.pathname)):
                console.info('match', match);
                //console.info('ENTRY', match.groups.id);
                return this.renderEntry(request.headers['ww-section']);
            case !!(url.pathname === '/actions/save'):
                console.info('SAVE', request.headers);
                await this.actionSave();
                // Then render the entry given in the hx-current-url, with the specified hx-target as the
                // section.
                request.url = request.headers['hx-current-url'];  // XXX add checking
                request.headers['ww-section'] = request.headers['hx-target'];
                // Somehow munge section in here as well.
                return this.handleRequest(request);
            default:
                //await sleep(1);
                break;
        }

        return Promise.resolve({
            status: 200,
            headers: {},
            url: 'foo',
            body: 'Hello <b>World!</b>',
        });
    }

    async actionSave() {
        console.info('INSIDE ACTION AVAV');
        this.entry.spelling[0].text += '*';
    }

    
    async renderEntry(section_path: string|undefined): Promise<server.Response> {
        const entry_editor_template =
            await this.template_engine.parseFile('entry-editor.liquidjs');


        //let scope: any = {entry: this.entry};
        //let body = await this.template_engine.render(entry_editor_template, scope);

        let scope = new liquid.Context({entry: this.entry}, this.template_engine.options, {});
        let emitter = new SectionedPageEmitter(section_path || '__');
        //emitter.write('foo');
        let body = await liquid.toPromise(this.template_engine.renderer.renderTemplates(entry_editor_template, scope, emitter));
        
        return Promise.resolve({
            status: 200,
            headers: {},
            url: 'foo',
            body: body,
        });
    }
}

async function test(): Promise<void> {


    const db = new DB('entry.db');
    db.execute(`DROP TABLE IF EXISTS people`);
    db.execute(`
         CREATE TABLE IF NOT EXISTS people (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT
         )
    `);

    // Run a simple query
    for (const name of ["Peter Parker", "Clark Kent", "Bruce Wayne"]) {
        db.query("INSERT INTO people (name) VALUES (?)", [name]);
    }

    // Print out data in table
    for (const [name] of db.query(`SELECT name FROM people WHERE name > 'C'`)) {
        console.log(name);
    }

    // TODO: maybe switch to positional?
    let prepped = db.prepareQuery('SELECT *, purps.id as id1, peeps.id as id2 FROM people as purps JOIN people as peeps WHERE purps.name > :startName');
    console.info(prepped.columns());
    console.info(prepped.all({ startName: 'A'}));

    let entry = toml_parse(await Deno.readTextFile('entry.toml'));
    let entryEditorServer = new EntryEditorServer(entry, db);
    await new DenoHttpServer({port: 9000}, entryEditorServer.handleRequest.bind(entryEditorServer)).run();
}


//import { stringify } from '../util'
//import { Emitter } from './emitter'

// export class PartialEmitter implements liquid.Emitter {
//     public buffer = '';

//     public write (html: any) {
//         //console.info('not emitting', stringify(html));
//         this.buffer += stringify(html)
//     }
// }



if (import.meta.main)
    test();

