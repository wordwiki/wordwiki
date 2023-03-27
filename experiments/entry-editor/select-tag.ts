// Credit: This file is a modified version of the stock 'liquidjs' for loop tag.
//   SOURCE: https://github.com/harttle/liquidjs/blob/1380ac931a51dcb236c913aba64acc613f81c1ad/src/tags/for.ts
//   LICENSE: MIT

import { Hash, Value, ValueToken, Liquid, Tag, Tokenizer, evalToken, Expression, Emitter, TagToken, TopLevelToken, Context, Template, ParseStream, Drop } from "https://esm.sh/v107/liquidjs@10.6.0";
import {reversed, offset, limit, toEnumerable}  from './liquid-utils.ts';
import XRegExp from  'https://deno.land/x/xregexp/src/index.js';

import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";

const MODIFIERS = ['offset', 'limit', 'reversed'];

type valueof<T> = T[keyof T];


export default class extends Tag {
    variable: string;
    collection: ValueToken|undefined; // XXX
    hash: Hash;
    templates: Template[];
    elseTemplates: Template[];
    preparedQuery: PreparedQuery;
    parmExprs: Value[];
    columnNames: string[];

    constructor (token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainTokens, liquid)
        const tokenizer = new Tokenizer(token.args, this.liquid.options.operators);

        const select_begin = tokenizer.p;
        const select_end_punctuation = tokenizer.readToDelimiter('::');
        let select: string;
        if (select_end_punctuation === -1) {
            select = 'select '+tokenizer.input;
            this.hash = new Hash('');
        } else {
            select = 'select '+tokenizer.input.substring(0, select_end_punctuation-2);
            this.hash = new Hash(tokenizer.remaining());
        }

        console.info('** select', select);
        //console.info('** select hash', this.hash);
        //console.info('** select hash.name', (this.hash.hash?.name as any)?.propertyName);

        // if starts with * or variable list, or variable list with AS, then FROM and a single table name, then WHERE -
        // grab the table name.
        //

        // XXX make less skeezy XXX VERY BAD XXX
        let explicit_variable_name = (this.hash.hash?.name as any)?.propertyName as string|undefined;
        if (explicit_variable_name) {
            this.variable = explicit_variable_name;
        } else {
            const simple_table_name:string|undefined =
                XRegExp.cache(`\\s+from\\s+(\\w+)\\s+where\\s`, 'xi').exec(select)?.[1];
            console.info('simple table name', simple_table_name);
            if (simple_table_name) {
                this.variable = simple_table_name;
            } else {
                throw new Error('select must either have a simple table name in the select clause or be given an explicit table name');
            }
        }

        this.parmExprs = [];
        let select_with_query_parms = select.replaceAll(XRegExp.cache(`[{][{].*?[}][}]`, 'xig'),
                          (match) => {
                              let arg_expr_text = match.substring(2, match.length-2);
                              this.parmExprs.push(new Value(arg_expr_text, this.liquid));
                              return '?';
                          });

        const db = get_db_from_globals(liquid);

        // --- Prepare query (we do it here rather than at eval time, not
        //     just for performance, but so that we get errors at template
        //     parse time).
        console.info('preparing query', select_with_query_parms);
        this.preparedQuery = db.prepareQuery(select_with_query_parms);
        console.info('prepared query', this.preparedQuery);

        // --- Get output column names and give error if not unique
        this.columnNames = this.preparedQuery.columns().map(c=>c.name);
        let alreadySeenColumnNames = new Set();
        for(let columnName of this.columnNames) {
            if(alreadySeenColumnNames.has(columnName))
                throw new Error(`Duplicate output column name ${columnName} - please rename using AS`);
            alreadySeenColumnNames.add(columnName);
        }
        console.info('Column names', this.columnNames);
        
        this.collection = undefined;
        this.templates = [];
        this.elseTemplates = [];

        let p;
        const stream: ParseStream = this.liquid.parser.parseStream(remainTokens)
            .on('start', () => (p = this.templates))
            .on('tag:else', () => (p = this.elseTemplates))
            .on('tag:endselect', () => stream.stop())
            .on('template', (tpl: Template) => p.push(tpl))
            .on('end', () => {
                throw new Error(`tag ${token.getText()} not closed`)
            });

        stream.start();
    }

    * render (ctx: Context, emitter: Emitter): Generator<unknown, void | string, Template[]> {
        const r = this.liquid.renderer;

        // console.info('PARM EXPRS', this.parmExprs);
        // let e0 = this.parmExprs[0];
        // console.info('E0', e0);
        // let v0 = (yield e0.value(ctx));
        // console.info('V0', v0);
        // console.info('typeof V0', typeof v0);
        
        // let e0v = e0.evaluate(ctx);
        // console.info('E0V', e0v);
        // console.info('PUPPY', e0v.next().value);
        // let e0all = [...e0v];
        // console.info('E0V all', e0all);
        

        let args:QueryParameter[] = [];
        //let args: any[] = [];
        for(let parm of this.parmExprs) {
            // XXX THIS IS WROING AND VERY BAD - FIGURE OUT HOW TO DO PROPERLY!!!
            args.push((yield parm.value(ctx)) as any as QueryParameter);
        }
        console.info('args', args);
        let row_tuples = this.preparedQuery.all(args);
        console.info('RESULTS', row_tuples);

        let rows = [];
        for(let row_tuple of row_tuples) {
            let row = {} as any;  // XXX TODO fix typing
            for(let col_idx=0; col_idx<this.columnNames.length; col_idx++) {
                row[this.columnNames[col_idx]] = row_tuple[col_idx];
            }
            rows.push(row);
        }

        console.info('rows', rows);
        // let collection = toEnumerable(yield evalToken(this.collection, ctx));

        if (!rows.length) {
            yield r.renderTemplates(this.elseTemplates, ctx, emitter);
            return;
        }

        // const continueKey = 'continue-' + this.variable + '-' + this.collection.getText();
        // ctx.push({ continue: ctx.getRegister(continueKey) });
        // const hash = yield this.hash.render(ctx);
        // ctx.pop();

        // const modifiers = this.liquid.options.orderedFilterParameters
        //   ? Object.keys(hash).filter(x => MODIFIERS.includes(x))
        //   : MODIFIERS.filter(x => hash[x] !== undefined)

        // collection = modifiers.reduce((collection, modifier: valueof<typeof MODIFIERS>) => {
        //   if (modifier === 'offset') return offset(collection, hash['offset'])
        //   if (modifier === 'limit') return limit(collection, hash['limit'])
        //   return reversed(collection)
        // }, collection)

        // // XXX ADD this back in.
        // //ctx.setRegister(continueKey, (hash['offset'] || 0) + collection.length)

        const scope = { select: new SelectDrop(rows.length, /*this.collection.getText()*/'XXX', this.variable) };
        ctx.push(scope);
        
        for (const item of rows) {
            // @ts-ignore: suppressImplicitAnyIndexErrors 
            scope[this.variable] = item;

            yield r.renderTemplates(this.templates, ctx, emitter);
            // @ts-ignore: suppressImplicitAnyIndexErrors 
            if (emitter['break']) {
                // @ts-ignore: suppressImplicitAnyIndexErrors 
                emitter['break'] = false;
                break
            }
            // @ts-ignore: suppressImplicitAnyIndexErrors 
            emitter['continue'] = false;

            // @ts-ignore: suppressImplicitAnyIndexErrors 
            emitter['break'] = false;
            // @ts-ignore: suppressImplicitAnyIndexErrors 
            emitter['continue'] = false;
            
            scope.select.next();
        }
        ctx.pop();
    }
}

export class SelectDrop extends Drop {
    protected i = 0;
    public name: string;
    public length: number;
    public constructor (length: number, collection: string, variable: string) {
        super();
        this.length = length;
        this.name = `${variable}-${collection}`;
    }
    public next () {
        this.i++;
    }
    public index0 () {
        return this.i;
    }
    public index () {
        return this.i + 1;
    }
    public first () {
        return this.i === 0;
    }
    public last () {
        return this.i === this.length - 1;
    }
    public rindex () {
        return this.length - this.i;
    }
    public rindex0 () {
        return this.length - this.i - 1;
    }
    public valueOf () {
        return JSON.stringify(this);
    }
}

/**
 * Fetch the 'db' that should have been stashed in the liquid.js globals,
 * with some typing and error checking.
 */
export function get_db_from_globals(liquid: Liquid): DB {
    const db = (liquid.options.globals as {db?: any}).db;
    if(!(db instanceof DB))
        throw new Error('configuration error: Expected to have a db available in the liquid.js globals');
    return db;
}
