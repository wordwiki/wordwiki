import * as utils from './utils.ts';
import * as linkedom from "https://esm.sh/linkedom@0.16.8";

export type DumpOpts = Record<string, any>;

export type Markup = any;

export type Tag = string|Function|symbol;
//export type ElemExprLiteral = any; //[string|Function|symbol, Record<string, any>, ...ElemExprContentLiteralItem];
export type ElemExprLiteral = [Tag, Record<string, any>, ...any];
export type ElemExprContentLiteralItem = any; //ElemExprLiteral|string|number|Function;

export function createElement(tag: Tag|undefined, props: Record<string, any>, ...children: ElemExprContentLiteralItem[]): ElemExprLiteral|any[] {
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

export function isElemMarkup(n: any): n is ElemExprLiteral {
    return Array.isArray(n) && n.length >= 2 && utils.isObjectLiteral(n[1]);
}

export function getElemId(n: any): string|undefined {
    const idVal = n?.[1]?.id;
    return typeof idVal === 'string' ? idVal : undefined;
}

// ----------------------------------------------------------------------------
// --- Render -----------------------------------------------------------------
// ----------------------------------------------------------------------------


export function markupToString(markup: any, indent: string='') {
    return new MarkupRenderer().renderContentMarkupItem(markup, indent);
}

// NOTE: Our HTML rendering rules are half baked!  We will come back to
//       this later. XXX TODO

// Source: https://html.spec.whatwg.org/#elements-2
// end tags must not be specified for void elements. (ie <img> not <img/> or <img></img>)
export const htmlVoidElements = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'source', 'track', 'wbr']);

export const htmlTemplateElement = 'template';
export const htmlRawTextElements = new Set(['script', 'style']);
export const escapableRawTextElements = new Set(['textarea', 'title']);

// https://html.spec.whatwg.org/#phrasing-content-2
// We are suppressing adding new indentation related whitespace into
// these elements in contexts where there is not already whitespace.
export const phrasingContentElements = new Set([
    'a', 'abbr', 'area', 'audio', 'b', 'bdi', 'bdo', 'br', 'button', 'canvas',
    'cite', 'code', 'data', 'datalist', 'del', 'dfn', 'em', 'embed', 'i', 'iframe',
    'img', 'input', 'ins', 'kbd', 'label', 'link', 'map', 'mark', 'math', 'meta',
    'meter', 'noscript', 'object', 'output', 'picture', 'progress', 'q',
    'ruby', 's', 'samp', 'script', 'select', 'slot', 'small', 'span',
    'strong', 'sub', 'sup', 'svg', 'template', 'textarea', 'time', 'u',
    'var', 'video', 'w', 'br']);

export class MarkupRenderer {

    constructor(public useEmptyElementTags:boolean = false) {
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
        switch(true) {
                
            case htmlVoidElements.has(tagName): {
                // --- HTML void elements are not allowed to have any content -
                //     and also do not need closing tags.
                if(flattenedContent.length !== 0)
                    throw new Error(`unexpected content for void element ${tagName}`);
                out += '>';
                return out;
            }

            case flattenedContent.length === 0 && this.useEmptyElementTags: {
                out += '/>';
                return out;
            }

            case phrasingContentElements.has(tagName) || isShortInlineContent(flattenedContent, Math.max(100-indent.length, 40)): {
                // --- If is simple, short content, or content that we cannot insert
                //     leading/trailing whitespace into, render all on one line
                out += '>';
                out += this.renderContentMarkupArray(flattenedContent, indent);
                out += `</${tagName}>`;
                return out;
            }

            case htmlRawTextElements.has(tagName) || escapableRawTextElements.has(tagName): {
                // XXX THIS IS INCOMPLETE (+ should be different for raw/escapable anyway
                //     but is good enough to get our other stuff working.
                out += '>';
                out += this.renderContentMarkupArray(flattenedContent, indent);
                out += `</${tagName}>`;
                return out;
            }
                
            default: {
                out += '>';
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


export const ELEMENT_NODE = 1;
export const ATTRIBUTE_NODE = 2;
export const TEXT_NODE = 3;
export const CDATA_SECTION_NODE = 4;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_TYPE_NODE = 10;
export const DOCUMENT_FRAGMENT_NODE = 11;

export const NODE_END = -1;

//type HtmlDocument = ReturnType<typeof linkedom.parseJSON>;


export function renderToStringViaLinkeDOM(markup: any): string {
    return toLinkeDOM(markup).toString();
}

// export function toLinkeDOM(markup: any): any {
//     const jsdon = renderToJSDON(markup)
//     console.info(jsdon);
//     return linkedom.parseJSON(jsdon);
// }

export function toLinkeDOM(markup: any): any {
    return linkedom.parseJSON(renderToJSDON(markup));
}

/**
 * Render our markup to the JSDON format defined in:
 *
 * https://github.com/WebReflection/jsdon
 *
 * This allows us to load our markup into LinkeDOM - a DOM
 * implementation.
 *
 * We are primarily doing this to then serialized the markup
 * to HTML using the LinkeDOM serializer.  This is a lot of copying,
 * and at some point we should make our serializer good instead.
 */
type JSDON = Array<number|string>;

export function renderToJSDON(item: any, wrapInHtmlDocument: boolean=true): JSDON {
    const out: JSDON = [];
    if(wrapInHtmlDocument) {
        out.push(DOCUMENT_NODE);
        out.push(DOCUMENT_TYPE_NODE, "html");
    }        
    renderItemToJSDON(out, item);
    if(wrapInHtmlDocument) {
        out.push(NODE_END, NODE_END);
    }
    return out;
}

function renderItemToJSDON(out: JSDON, item: any) {
    switch(typeof item) {
        case 'undefined':
            break;
        case 'number':
        case 'boolean':
        case 'bigint':
            out.push(TEXT_NODE, String(item));
            break;
        case 'string':
            out.push(TEXT_NODE, item);
            break;
        case 'object':
            if(item == null)
                break;
            else if(Array.isArray(item)) {
                if(isElemMarkup(item)) {
                    renderElementToJSDON(out, item as ElemExprLiteral);
                    break;
                } else {
                    for(const i of item)
                        renderItemToJSDON(out, i);
                    break;
                }
            } else {
                throw new Error(`unhandled content object ${item} of type ${utils.className(item)}`);
            }

        default:
            throw new Error(`unhandled content item ${item} of type ${typeof item}`);
    }
}

function renderElementToJSDON(out: JSDON, e: ElemExprLiteral) {
    const [tag, {...attrs}, ...content] = e;
    const tagName = tag instanceof Function ? tag.name : String(tag);

    out.push(ELEMENT_NODE);
    out.push(tagName);
    for(let [name, value] of Object.entries(attrs as Record<string, any>)) {
        if(name !== '') {
            out.push(ATTRIBUTE_NODE, name);
            if(value != undefined)
                out.push(String(value));
        }
    }
    for(const c of content)
        renderItemToJSDON(out, c);
    out.push(NODE_END);
}

function linkeDOMPlay() {
    console.info(renderToStringViaLinkeDOM(
        ['div', {class: 'top', style: 'none', 'cat': null}, 'hello',
         ['img', {width: 7, height: 9}]]));
}



// ----------------------------------------------------------------------------
// --- Diff -------------------------------------------------------------------
// ----------------------------------------------------------------------------

/*
  - expect a single root node, and ids must match (if not throw Error)
  - recursive by-value compare of a and b contents, when an elem with an id
    is found, they are pairwise added to descendants collection.
  - if don't match, return [b] (b is replacement for a - they have the same
    id, so will be easy to find)
    - if do match, for all child elems with ids, rerun algo.
    - will be super easy to apply this to DOM.
 */


// Stopped working on for the moment.
// - I still think a V0 that can only replace entire nodes (ie. no insert, delete or move)
//   will be some benefit (and is super easy to implement) - so will probably finish.
// - Probably not super hard to add insert/delete ???

export function diffElem(a: ElemExprLiteral, b: ElemExprLiteral): ElemExprLiteral[] {
    if(!isElemMarkup(a) || !isElemMarkup(b))
        throw new Error('attempt to diff non-elems');
    const [aTag, aAttrs, ...aChildren] = a;
    const [bTag, bAttrs, ...bChildren] = b;
    const aId = aAttrs['id'];
    const bId = bAttrs['id'];
    if(aId === undefined || bId === undefined || aId !== bId)
        throw new Error('top level diff only works on two elements with identical ids');

    // --- Compare attrs, rerendering if any have changed (including order change)
    const aAttrEntries = aAttrs.entries();
    const bAttrEntries = bAttrs.entries();
    if(aAttrEntries.length !== bAttrEntries.length)
        return [b];
    for(let i=0; i<aAttrEntries.length; i++) {
        if(aAttrs[0] !== bAttrs[0] || aAttrs[1] !== bAttrs[1])
            return [b];
    }

    // --- Compare Children
    return diffContent(a, b, aChildren, bChildren);
}

function diffContent(aParent: ElemExprLiteral, bParent: ElemExprLiteral,
                     aContent: any[], bContent: any[]): ElemExprLiteral[] {
    const diffs = [];
    if(aContent.length !== bContent.length)
        return [bParent];
    for(let i=0; i<aContent.length; i++) {
        const a = aContent[i];
        const b = bContent[i];

        // --- Identical content --- So happy!
        if(a === b)
            continue;

        // --- If either side is an elem - compare as such
        if(isElemMarkup(a) || isElemMarkup(b)) {
            // TODO: handle non ide elems here 
            if(getElemId(a) !== getElemId(b))
                diffs.push(b);
            else
                diffs.push(...diffElem(a, b));
        }

        // ---

        
        // if(Array.isArray(a) && Array.isArray(b))
        //         const childElemDiffs = diffElem(a, b);
        //         if(childElemDiffs.length !== 0)
        //             diffs.push(...childElemDiffs);
        //         continue;
        //     }
                
            
        // }
        
    }


    return diffs;
}

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------


if (import.meta.main)
    linkeDOMPlay();



