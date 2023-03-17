// Credit: This file is a modified version of the stock 'liquidjs' for loop tag.
//   SOURCE: https://github.com/harttle/liquidjs/blob/1380ac931a51dcb236c913aba64acc613f81c1ad/src/tags/for.ts
//   LICENSE: MIT

import { Hash, ValueToken, Liquid, Tag, Tokenizer, evalToken, Emitter, TagToken, TopLevelToken, Context, Template, ParseStream, Drop } from "https://esm.sh/v107/liquidjs@10.6.0";
import {reversed, offset, limit, toEnumerable}  from './liquid-utils.ts';


/*
  {% section %}

  {% endsection %}

  - need expr for section label.
  - needs to get put in var that can be accessed in section.
  - should be able to .parent your way up though the section stack.
  - 


 */


//type valueof<T> = T[keyof T];

export default class extends Tag {
    variable: string;
    collection: ValueToken;
    hash: Hash;
    templates: Template[];
    editTemplates: Template[];
    elseTemplates: Template[];

    constructor (token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainTokens, liquid)
        const tokenizer = new Tokenizer(token.args, this.liquid.options.operators);
        const variable = tokenizer.readIdentifier();
        const inStr = tokenizer.readIdentifier();
        const collection = tokenizer.readValue();
        if (!variable.size() || inStr.content !== 'in' || !collection) {
            throw new Error(`illegal tag: ${token.getText()}`);
        }

        this.variable = variable.content;
        this.collection = collection;
        this.hash = new Hash(tokenizer.remaining());
        this.templates = [];
        this.editTemplates = [];
        this.elseTemplates = [];

        let p;
        const stream: ParseStream = this.liquid.parser.parseStream(remainTokens)
            .on('start', () => (p = this.templates))
            .on('tag:edit', () => (p = this.editTemplates))
            .on('tag:else', () => (p = this.elseTemplates))
            .on('tag:endeditlist', () => stream.stop())
            .on('template', (tpl: Template) => p.push(tpl))
            .on('end', () => {
                throw new Error(`tag ${token.getText()} not closed`)
            });

        stream.start();
    }

    * render (ctx: Context, emitter: Emitter): Generator<unknown, void | string, Template[]> {
        const r = this.liquid.renderer;
        let collection = toEnumerable(yield evalToken(this.collection, ctx));

        if (!collection.length) {
            yield r.renderTemplates(this.elseTemplates, ctx, emitter);
            return;
        }

        const continueKey = 'continue-' + this.variable + '-' + this.collection.getText();
        ctx.push({ continue: ctx.getRegister(continueKey) });
        const hash = yield this.hash.render(ctx);
        ctx.pop();

        // const modifiers = this.liquid.options.orderedFilterParameters
        //   ? Object.keys(hash).filter(x => MODIFIERS.includes(x))
        //   : MODIFIERS.filter(x => hash[x] !== undefined)

        // collection = modifiers.reduce((collection, modifier: valueof<typeof MODIFIERS>) => {
        //   if (modifier === 'offset') return offset(collection, hash['offset'])
        //   if (modifier === 'limit') return limit(collection, hash['limit'])
        //   return reversed(collection)
        // }, collection)

        // XXX ADD this back in.
        //ctx.setRegister(continueKey, (hash['offset'] || 0) + collection.length)

        const scope = { editlist: new EditListDrop(collection.length, this.collection.getText(), this.variable) };
        ctx.push(scope);
        
        for (const item of collection) {
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

            emitter.write('<div class=edit>\n');
            yield r.renderTemplates(this.editTemplates, ctx, emitter);
            emitter.write('</div>\n');
            // @ts-ignore: suppressImplicitAnyIndexErrors 
            emitter['break'] = false;
            // @ts-ignore: suppressImplicitAnyIndexErrors 
            emitter['continue'] = false;
            
            scope.editlist.next();
        }
        ctx.pop();
    }
}

export class EditListDrop extends Drop {
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

