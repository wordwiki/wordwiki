import * as utils from './utils.ts';

export type DumpOpts = Record<string, any>;

export type Tag = string|Function|symbol;
export type ElemExprLiteral = any; //[string|Function|symbol, Record<string, any>, ...ElemExprContentLiteralItem];
export type ElemExprContentLiteralItem = any; //ElemExprLiteral|string|number|Function;

export function createElement(tag: Tag|undefined, props: Record<string, any>, ...children: ElemExprContentLiteralItem[]): ElemExprLiteral {
    if(tag === undefined) {
        if(props != null && Object.keys(props).length !== 0)
            throw new Error(`unexpected props for fragment: '${props}'`);
        return children;
    } else {
        return [tag, props ?? {}, ...children];
    }
}

export module JSX {
    export interface IntrinsicElements {
        [elemName: string]: any;
    }

    // export interface ElementClass {
    //     //render: any;
    // }

    // export interface ElementAttributesProperty {
    //     props: any; // specify the property name to use
    // }    
}





export function isElemMarkup(n: any): boolean {
    return Array.isArray(n) && n.length >= 2 && utils.isObjectLiteral(n[1]);
}

export class MarkupRenderer {

    constructor() {
    }

    renderContentMarkupItem(item: any, indent: string=''): string {
        switch(typeof item) {

            case 'undefined':
                return '';

            case 'number':
            case 'boolean':
            case 'bigint':
                return String(item);
                
            case 'string':
                // TODO escaping, multiline etc here.
                return item;

            case 'object':
                if(item == null)
                    return '';
                
                if(Array.isArray(item)) {
                    if(isElemMarkup(item))
                        return this.renderContentMarkupElemExprLiteral(item as ElemExprLiteral, indent);
                    else
                        return this.renderContentMarkupArray(item, indent);
                }

                
                return `unhandled content object ${item} of type ${utils.className(item)}`;
                
            default:
                throw new Error(`unhandled content item ${item} of type ${typeof item}`);
        }
    }

    renderContentMarkupString(s: string, indent: string): string {
        // TODO add escaping here + multiline stuff XXX
        return s;
    }

    renderContentMarkupArray(contentMarkupArray: any[], indent: string): string {
        return contentMarkupArray.map(
            c=>this.renderContentMarkupItem(c, indent)).join('');
    }
    
    renderContentMarkupElemExprLiteral(e: ElemExprLiteral, indent: string): string {
        const [tag, {...attrs}, ...content] = e;
        const tagName = tag instanceof Function ? tag.name : String(tag);

        //console.info('content is', content);
        
        let out = `<${tagName}`;

        const attrStartCol = out.length+1;
        const attrIndent = ' '.repeat(attrStartCol);
        const attrDumps =
            Object.entries(attrs)
            .filter(([n,v])=>v!==undefined)
            .map(([n,v])=>
                `${n}=${this.renderAttrValue(v)}`);
        const totalAttrLen = attrDumps.reduce((totalLen, attr)=>totalLen+attr.length, 0);

        let cursor = attrStartCol;
        for(const attr of attrDumps) {
            // --- If this is not the first attr on a line, and adding this
            //     attr would make this line to long.
            if(cursor > attrStartCol && cursor + attr.length > 100) {
                out += `\n${indent}`;
                cursor = attrStartCol;
            } else {
                out += ' ';
                cursor++;
            }

            // --- Render attr and advance cursor
            out += attr;
            cursor += attr.length;
        }

        const flattenedContent = flattenMarkup(content);
        
        // --- If we have no content fields, we can complete render as a self closing
        //     tag.
        if(flattenedContent.length === 0) {
            out += '/>';
            return out;
        }

        out += '>';

        if(isShortInlineContent(flattenedContent, Math.max(100-indent.length, 40))) {
            // --- If is simple, short content, render all on one line
            out += this.renderContentMarkupArray(flattenedContent, indent);
            out += `</${tagName}>`;
            return out;
        } else {
            const maxWidth = 100;
            const nestedIndent = indent + '    ';
            const newLineWithIndent = '\n'+nestedIndent;
            const contentStartCol = nestedIndent.length;

            out += newLineWithIndent;
            
            let cursor = contentStartCol;
            for(const item of flattenedContent) {
                // --- If this is not the first item on a line, and adding this
                //     item would make this line to long, start a new line
                const inlineContentItemLength = estimateInlineContentItemLength(item);
                if(inlineContentItemLength === -1) {
                    // --- Render block item (starting a new line if we are not
                    //     already at the beginning of a line)
                    if(cursor > contentStartCol) {
                        out += newLineWithIndent;
                    }
                    out += this.renderContentMarkupItem(item, nestedIndent);
                    cursor += maxWidth;
                } else {
                    // --- Render inline item
                    if(cursor > contentStartCol &&
                        cursor + inlineContentItemLength > maxWidth) {
                        out += newLineWithIndent;
                        cursor = contentStartCol;
                    }
                    const renderedItem = this.renderContentMarkupItem(item, nestedIndent);
                    out += renderedItem;
                    cursor += renderedItem.length;
                } 
            }

            out += `\n${indent}</${tagName}>`;

            return out;
        }
    }

    renderAttrValue(v: any): string {
        const s = String(v).replace('\n', '\\n').replace('\t', '\\t');
        switch(true) {
            case s==='': return "''";
            case /^[a-zA-Z0-9_]+$/.test(s): return s;
            case s.indexOf("'") === -1: return `'${s}'`;
            case s.indexOf('"') === -1: return `"${s}"`;
            default: return "'"+s.replace("'", "\\'")+"'";
        }
    }
}

export function flattenMarkup(markup: any): any[] {
    const out: any[] = [];
    collectMarkup(out, markup);
    return out;
}

function collectMarkup(out: any[], item: any) {
    if(Array.isArray(item) && !isElemMarkup(item)) {
        for(const c of item) 
            collectMarkup(out, c);
    } else {
        out.push(item);
    }
}

export function flattenMarkupDeep(markup: any): any {
    throw new Error('no impl yet');
}


function isShortInlineContent(flattenedMarkup: any[], maxLen: number): boolean {
    let total = 0;
    for(const m of flattenedMarkup) {
        switch(typeof m) {
            case 'undefined':
            case 'number':
            case 'boolean':
            case 'bigint':
            case 'string':
                const estimatedItemLength = estimateInlineContentItemLength(m);
                if(estimatedItemLength === -1)
                    throw new Error('internal error - unexpected failure to estimate inline content length');
                
                total += estimatedItemLength;
                if(total > maxLen)
                    return false;
                break;

            case 'object':
                if(m == null) {
                    break;
                } else if(Array.isArray(m)) {
                    if(isElemMarkup(m))
                        return false;
                    else
                        throw new Error('internal error: isShortInlineContent should only be called on flattened markup');
                } else {
                    return false;
                }

            default:
                return false;
        }
    }
    return true;       
}

function estimateInlineContentItemLength(item: any): number {
    switch(typeof item) {
        case 'undefined':
        case 'number':
        case 'boolean':
        case 'bigint':
            return String(item).length;
        case 'string':
            return item.length+2;
        default:
            if(item===null)
                return 0;
            else
                return -1;
    }
}

export function markupToString(markup: any, indent: string='') {
    return new MarkupRenderer().renderContentMarkupItem(markup, indent);
}

