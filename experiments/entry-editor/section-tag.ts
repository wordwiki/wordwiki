import { Value, Liquid, Tag, Tokenizer, Emitter, TagToken, TopLevelToken, Context, Template, ParseStream, Drop } from "https://esm.sh/v107/liquidjs@10.6.0";

import { stringify }  from './liquid-utils.ts';
export default class extends Tag {
    htmlTag: string|undefined;
    cssClasses: string[];
    sectionIdExpr: Value;
    templates: Template[];

    constructor (token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainTokens, liquid)
        const tokenizer = new Tokenizer(token.args, this.liquid.options.operators);

        let htmlTag: string|undefined;
        let cssClasses: string[] = [];
        if(tokenizer.peek() === '-') {
            tokenizer.advance();
            htmlTag = undefined;
        } else {
            let htmlTagToken = tokenizer.readIdentifier();
            if(!htmlTagToken.content) {
                throw new Error('section tag expected html tag name or "-" as first attr');
            }
            htmlTag = htmlTagToken.content;
            while(tokenizer.peek() === '.') {
                tokenizer.advance();
                let classIdentifier = tokenizer.readIdentifier();
                if(classIdentifier.content)
                    cssClasses.push(classIdentifier.content);
            }
        }
        this.htmlTag = htmlTag;
        this.cssClasses = cssClasses;
        
        this.sectionIdExpr = new Value(tokenizer.remaining(), this.liquid);

        this.templates = [];
        let p;
        const stream: ParseStream = this.liquid.parser.parseStream(remainTokens)
            .on('start', () => (p = this.templates))
            .on('tag:endsection', () => stream.stop())
            .on('template', (tpl: Template) => p.push(tpl))
            .on('end', () => {
                throw new Error(`tag ${token.getText()} not closed`)
            });

        stream.start();
    }

    /*
     * Note on HTML5 id attribute:
     *
     * Ids can contain any character other that ASCII whitespace:
     * (of course we will need to follow string quoting rules as well)
     *
     * "When specified on HTML elements, the id attribute value must be
     * unique amongst all the IDs in the element's tree and must
     * contain at least one character. The value must not contain any
     * ASCII whitespace."
     *
     * https://html.spec.whatwg.org/multipage/dom.html#global-attributes:the-id-attribute-2
     *
     * MDN reccommends a much smaller charset for targetting in CSS
     * etc: Note: Technically, the value for an id attribute may
     * contain any character, except whitespace characters. However,
     * to avoid inadvertent errors, only ASCII letters, digits, '_',
     * and '-' should be used and the value for an id attribute should
     * start with a letter. For example, . has a special meaning in
     * CSS (it acts as a class selector). Unless you are careful to
     * escape it in the CSS, it won't be recognized as part of the
     * value of an id attribute. It is easy to forget to do this,
     * resulting in bugs in your code that could be hard to detect.
     *
     * https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/id
     *
     * And of course, if we do weird quoting, we have to make that
     * work out everywhere the id is used, as well as in URLs - so we
     * should probably further restrict ourselves.
     */
    
    * render (ctx: Context, emitter: Emitter): Generator<unknown, void | string, Template[]> {

        if(!(emitter instanceof SectionedPageEmitter)) {
            throw new Error('section tags can only be used with a SectionedPageEmitter');
            // TODO: make fallback to render all if not section page emitter?
        }

        // --- Compute section path as parent path + local sectionId
        const sectionId = (yield this.sectionIdExpr.value(ctx)).toString();
        if(sectionId.indexOf('__') !== -1)
            throw new Error('section ids may not contain the "__" substring');
        const sectionPath =
            (emitter.currentSection?.path || '')+'__'+sectionId;

        // --- Section paths must be unique
        if(emitter.alreadyUsedSectionPaths.has(sectionPath))
            throw new Error('duplicate section path: '+sectionPath);
        emitter.alreadyUsedSectionPaths.add(sectionPath);
        
        // --- Push new section on section stack and set emitter mode based on visibility.
        //     (note: we are doing some things in the Emitter that we could have done with
        //     scopes because the scope version would not work across liquidjs partials)
        const parentSection = emitter.currentSection;
        const parentMode = emitter.mode;
        const parentEnabled = emitter.enabled;
        
        let mode: SectionPageEmitterMode;
        let enabled: boolean;
        switch(true) {
            case sectionPath.startsWith(emitter.rootPath):
                mode = SectionPageEmitterMode.PathWithinTargetSubtree;
                enabled = true;
                break;
            case emitter.rootPath.startsWith(sectionPath):
                mode = SectionPageEmitterMode.PathContainsTargetSubtree;
                enabled = false;
                break;
            default:
                mode = SectionPageEmitterMode.PathOutsideTargetSubtree;
                enabled = false;
                break;
        }

        const section = new SectionDrop(emitter.currentSection, sectionPath);
        emitter.currentSection = section;
        emitter.mode = mode;
        emitter.enabled = enabled;

        ctx.push({ section  });

        // --- Render (only if we are inside or above the target subtree)
        if(mode !== SectionPageEmitterMode.PathOutsideTargetSubtree) {

            // --- Emit the section open tag (if it has a corresponding shortcut tag)
            if(this.htmlTag) {
                emitter.write('<');
                emitter.write(this.htmlTag);
                if(this.cssClasses.length !== 0) {
                    emitter.write(' class="');
                    for(let cssClass of this.cssClasses) {
                        emitter.write(cssClass);
                        emitter.write(' ');
                    }
                    emitter.write('section');
                    emitter.write('"');
                }
                emitter.write(' id="');
                emitter.write(sectionPath); // XXX TODO escaping
                emitter.write('">');
            }

            // --- Render the body templates (note: Emitter.enabled may be set to false - if we are above
            //     the section we want to render - but we still need to render to find the section).
            yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);

            // ---- Emit the section close tag
            if(this.htmlTag) {
                emitter.write(`</${this.htmlTag}>`);
            }
        }

        // --- Pop section from section stack
        ctx.pop();
        emitter.currentSection = parentSection;
        emitter.mode = parentMode;
        emitter.enabled = parentEnabled;
    }
}

export class SectionDrop extends Drop {
    public constructor (public parent: SectionDrop|undefined, public path: string) {
        super();
    }
}

enum SectionPageEmitterMode {
    PathContainsTargetSubtree,
    PathWithinTargetSubtree,
    PathOutsideTargetSubtree,
}

export class SectionedPageEmitter implements Emitter {
    public rootPath: string;

    public currentSection: SectionDrop|undefined = undefined;
    public mode: SectionPageEmitterMode;
    enabled: boolean;

    alreadyUsedSectionPaths: Set<string> = new Set();
    
    public buffer = '';
    
    constructor(rootPath: string = '__') {
        this.rootPath = rootPath;

        // Setup defaults so we have correct behaviour
        // above our top level section tags.
        // (maybe we should instead have a single
        // top level section for section documents?)
        if(this.rootPath === '__') {
            this.mode = SectionPageEmitterMode.PathWithinTargetSubtree;
            this.enabled = true;
        } else {
            this.mode = SectionPageEmitterMode.PathContainsTargetSubtree;
            this.enabled = false;
        }
    }

    public write (html: any) {
        if (this.enabled)
            this.buffer += stringify(html);
    }
}
