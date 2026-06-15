/**
 * A system for representing markup as JS values.
 *
 * Elements are represented as:
 *   [tagName: string, attrs: Record<string, any>, content: ...any]
 *
 * The only position that a JS Object can appear is as in the attrs position
 * of an elem, so we can use the presense of the {} in the second position to
 * identify an element.
 * 
 * All other arrays are flattened inline.
 *
 * Primitive values are converted to strings, escaped and serialized as text.
 *
 * Null and undefined are elided.
 *
 * If the async renderer is used, promise values are awaited and the results
 * are rendered.  This saves a massive amount of function coloring and also
 * removes the awkwardness of generating async content using 'map' and friends.
 *
 * Example usage:
 
 * ['table', {'class': 'numbers'},
 *    ['tr', {},
 *       [1,2,3].map(n=>['td', {}, n])]
 * ]
 *
 * A TS compatible JSX interface is also provided so that this structure can
 * be generated TSX for those that prefer that syntax.
 *
 * Note that there are two serializers to text here - use the LinkeDOM versions for
 * now - we haven't gotten the other one HTML spec compliant yet.
 */

import * as utils from './utils.ts';
import * as linkedom from "https://esm.sh/linkedom@0.18.10/worker";

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
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

export const html = {
    html: 'html',
    
    // Document metadata
    base: 'base',
    head: 'head',
    link: 'link',
    meta: 'meta',
    style: 'style',
    title: 'title',
    
    // Sectioning root
    body: 'body',
    
    // Content sectioning
    address: 'address',
    article: 'article',
    aside: 'aside',
    footer: 'footer',
    header: 'header',
    h1: 'h1',
    h2: 'h2',
    h3: 'h3',
    h4: 'h4',
    h5: 'h5',
    h6: 'h6',
    hgroup: 'hgroup',
    main: 'main',
    nav: 'nav',
    section: 'section',
    search: 'search',
    
    // Text content
    blockquote: 'blockquote',
    dd: 'dd',
    div: 'div',
    dl: 'dl',
    dt: 'dt',
    figcaption: 'figcaption',
    figure: 'figure',
    hr: 'hr',
    li: 'li',
    menu: 'menu',
    ol: 'ol',
    p: 'p',
    pre: 'pre',
    ul: 'ul',
    
    // Inline text semantics
    a: 'a',
    abbr: 'abbr',
    b: 'b',
    bdi: 'bdi',
    bdo: 'bdo',
    br: 'br',
    cite: 'cite',
    code: 'code',
    data: 'data',
    dfn: 'dfn',
    em: 'em',
    i: 'i',
    kbd: 'kbd',
    mark: 'mark',
    q: 'q',
    rp: 'rp',
    rt: 'rt',
    ruby: 'ruby',
    s: 's',
    samp: 'samp',
    small: 'small',
    span: 'span',
    strong: 'strong',
    sub: 'sub',
    sup: 'sup',
    time: 'time',
    u: 'u',
    var: 'var',
    wbr: 'wbr',
    
    // Image and multimedia
    area: 'area',
    audio: 'audio',
    img: 'img',
    map: 'map',
    track: 'track',
    video: 'video',
    
    // Embedded content
    embed: 'embed',
    iframe: 'iframe',
    object: 'object',
    picture: 'picture',
    portal: 'portal',
    source: 'source',
    
    // SVG and MathML
    svg: 'svg',
    math: 'math',
    
    // Scripting
    canvas: 'canvas',
    noscript: 'noscript',
    script: 'script',
    
    // Demarcating edits
    del: 'del',
    ins: 'ins',
    
    // Table content
    caption: 'caption',
    col: 'col',
    colgroup: 'colgroup',
    table: 'table',
    tbody: 'tbody',
    td: 'td',
    tfoot: 'tfoot',
    th: 'th',
    thead: 'thead',
    tr: 'tr',
    
    // Forms
    button: 'button',
    datalist: 'datalist',
    fieldset: 'fieldset',
    form: 'form',
    input: 'input',
    label: 'label',
    legend: 'legend',
    meter: 'meter',
    optgroup: 'optgroup',
    option: 'option',
    output: 'output',
    progress: 'progress',
    select: 'select',
    textarea: 'textarea',
    
    // Interactive elements
    details: 'details',
    dialog: 'dialog',
    summary: 'summary',
    
    // Web Components
    slot: 'slot',
    template: 'template',
};

export const h = html;

// ----------------------------------------------------------------------------
// --- Render -----------------------------------------------------------------
// ----------------------------------------------------------------------------


/**
 * DEBUG-ONLY pretty printer.  Does NOT escape text or attribute values -
 * never serve its output as HTML; use renderToStringViaLinkeDOM /
 * asyncRenderToStringViaLinkeDOM for that.
 */
export function markupToString(markup: any, indent: string='') {
    return new MarkupRenderer().renderContentMarkupItem(markup, indent);
}

// NOTE: Our HTML rendering rules are half baked!  We will come back to
//       this later. XXX TODO.
//       For now we are using linkedom to render.

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
    'var', 'video', 'wbr']);

// --- Name validation for the JSDON/linkedom render path.  Tag and
//     attribute names are emitted into the HTML *unescaped* (there is no
//     valid escaping for them), so a name containing '>' or spaces is
//     direct markup injection.  Names come from code, not user data - but
//     code increasingly builds them from soft-schema strings, so we fail
//     loudly rather than emit an exploit.  The attr pattern allows the
//     conventions in live use: data-*, aria-*, hx-on::after-request,
//     xlink:href, @click.
const validTagNameRe = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const validAttrNameRe = /^[a-zA-Z@_][a-zA-Z0-9_:.@-]*$/;

function checkTagName(tagName: string): string {
    if(!validTagNameRe.test(tagName))
        throw new Error(`invalid element tag name: ${JSON.stringify(tagName)}`);
    return tagName;
}

function checkAttrName(name: string): string {
    if(!validAttrNameRe.test(name))
        throw new Error(`invalid attribute name: ${JSON.stringify(name)}`);
    return name;
}

// --- Raw text elements (script/style) have no escaping mechanism at all:
//     text content containing '</script' TERMINATES the element early and
//     the rest parses as HTML (the classic raw-text breakout).  All live
//     script content is static today; this guard keeps it safe when
//     someone inevitably embeds dynamic data.
function checkRawTextContent(tagName: string, s: string): string {
    if(s.toLowerCase().includes('</'+tagName))
        throw new Error(`content of <${tagName}> must not contain "</${tagName}" - ` +
                        `it would terminate the element early (raw-text breakout)`);
    return s;
}

// --- Text content adjustments by parent element.  linkedom serializes
//     textarea/title content RAW (no escaping) - but per spec they are
//     ESCAPABLE raw text, where character references do get decoded.  So
//     we pre-escape ourselves: that both displays correctly and closes the
//     '</textarea>' breakout - which matters, because textareas routinely
//     hold USER data (the record editors render stored field values into
//     them).
function textForParent(parentTag: string|undefined, s: string): string {
    if(parentTag === undefined)
        return s;
    if(htmlRawTextElements.has(parentTag))
        return checkRawTextContent(parentTag, s);
    if(escapableRawTextElements.has(parentTag))
        return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    return s;
}

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
                throw new Error(`unhandled content item ${item} of type ${typeof item} (0)`);
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
        // Debug formatting, not HTML escaping (see markupToString note).
        // (replaceAll: the old .replace only rewrote the FIRST occurrence.)
        const s = String(v).replaceAll('\n', '\\n').replaceAll('\t', '\\t');
        switch(true) {
            case s==='': return "''";
            case /^[a-zA-Z0-9_]+$/.test(s): return s;
            case s.indexOf("'") === -1: return `'${s}'`;
            case s.indexOf('"') === -1: return `"${s}"`;
            default: return "'"+s.replaceAll("'", "\\'")+"'";
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



// export function toLinkeDOM(markup: any): any {
//     const jsdon = renderToJSDON(markup)
//     console.info(jsdon);
//     return linkedom.parseJSON(jsdon);
// }

export function renderToStringViaLinkeDOM(markup: any, wrapInHtmlDocument: boolean=true, debug: boolean=false): string {
    //console.info('MARKUP', jsonStrIfPossible(markup));
    return linkeDOMToString(toLinkeDOM(markup, wrapInHtmlDocument, debug), wrapInHtmlDocument);
}

export function toLinkeDOM(markup: any, wrapInHtmlDocument: boolean=true, debug: boolean=false): any {
    return linkedom.parseJSON(renderToJSDON(markup, wrapInHtmlDocument, debug));
}

// Unwrapped markup is parsed as a DOCUMENT_FRAGMENT (see renderToJSDON), so
// serialize its children individually - the fragment's own toString() wraps
// them in literal <#document-fragment> tags.
function linkeDOMToString(dom: any, wrappedInHtmlDocument: boolean): string {
    return wrappedInHtmlDocument
        ? dom.toString()
        : [...dom.childNodes].map((c: any) => c.toString()).join('');
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

export function renderToJSDON(item: any, wrapInHtmlDocument: boolean=true, debug: boolean=false): JSDON {
    const out: JSDON = [];
    if(wrapInHtmlDocument) {
        out.push(DOCUMENT_NODE);
        out.push(DOCUMENT_TYPE_NODE, "html");
    } else {
        // Wrap unwrapped markup in a document fragment: linkedom.parseJSON
        // otherwise keeps only the FIRST root node, silently dropping the
        // rest of a multi-root fragment.
        out.push(DOCUMENT_FRAGMENT_NODE);
    }
    renderItemToJSDON(out, item, debug);
    if(wrapInHtmlDocument)
        out.push(NODE_END, NODE_END);
    else
        out.push(NODE_END);
    return out;
}

function renderItemToJSDON(out: JSDON, item: any, debug: boolean=false, parentTag?: string) {
    switch(typeof item) {
        case 'undefined':
            break;
        case 'number':
        case 'boolean':
        case 'bigint':
            out.push(TEXT_NODE, String(item));
            break;
        case 'string':
            out.push(TEXT_NODE, textForParent(parentTag, item));
            break;
        case 'object':
            if(item == null)
                void 0;
            else if(Array.isArray(item)) {
                if(isElemMarkup(item)) {
                    if(debug)
                        console.info('renderElementToJSDON', item);
                    renderElementToJSDON(out, item as ElemExprLiteral, debug);
                } else {
                    if(debug)
                        console.info('renderArrayToJSDON', item);
                    for(const i of item)
                        renderItemToJSDON(out, i, debug, parentTag);
                }
            } else if(true && item instanceof Promise) {
                out.push(TEXT_NODE, '*** UNRESOLVED PROMISE ***')
            } else {
                throw new Error(`unhandled content object ${strIfPossible(item)} of type ${utils.className(item)} - ${utils.className(item)} - ${jsonStrIfPossible(item)} - ${typeof item}`);
            }
            break;

        default:
            throw new Error(`unhandled content item ${strIfPossible(item)} of type ${typeof item} - ${utils.className(item)} - ${jsonStrIfPossible(item)} (1)`);
    }
}

function strIfPossible(v: any): string {
    if(v instanceof Error)
        return v.message;
    try {
        return String(v);
    } catch(e) {
        return '--';
    }
}

function jsonStrIfPossible(v: any): string {
    try {
        const jsonStr = JSON.stringify(v);
        if(jsonStr.length > 500)
            return jsonStr.substr(0, 500)+'...';
        else
            return jsonStr;
    } catch(e) {
        return '--';
    }
}


function renderElementToJSDON(out: JSDON, e: ElemExprLiteral, debug: boolean = false) {
    const [tag, {...attrs}, ...content] = e;
    const tagName = checkTagName(tag instanceof Function ? tag.name : String(tag));

    out.push(ELEMENT_NODE);
    out.push(tagName);
    for(let [name, value] of Object.entries(attrs as Record<string, any>)) {
        // Null/undefined attr values mean ABSENT (per the module doc "null
        // and undefined are elided", matching the JSX convention).  (The
        // historical version emitted the attr name without a value, which
        // linkedom serialized as a PRESENT empty attr - so {required:
        // cond ? '' : undefined} was always required.)
        if(name !== '' && value != undefined) {
            out.push(ATTRIBUTE_NODE, checkAttrName(name));
            out.push(String(value));
        }
    }
    for(const c of content)
        renderItemToJSDON(out, c, debug, tagName);
    out.push(NODE_END);
}

/**
 * Async version of rendering markup to html text via linkedom.
 *
 * Promises that appear in the content or attr value position will be forced.
 *
 * Probably quite a bit slower than the sync one - so keeping that one around as
 * well.
 */
export async function asyncRenderToStringViaLinkeDOM(markup: any, wrapInHtmlDocument: boolean=true): Promise<string> {
    return (new AsyncRenderToJSDON()).
        asyncRenderToStringViaLinkeDOM(markup, wrapInHtmlDocument);
}

class AsyncRenderToJSDON {

    async asyncRenderToStringViaLinkeDOM(markup: any, wrapInHtmlDocument: boolean=true): Promise<string> {
        return linkeDOMToString(await this.asyncToLinkeDOM(markup, wrapInHtmlDocument),
                                wrapInHtmlDocument);
    }

    async asyncToLinkeDOM(markup: any, wrapInHtmlDocument: boolean=true): Promise<any> {
        return linkedom.parseJSON(await this.asyncRenderToJSDON(markup, wrapInHtmlDocument));
    }

    async asyncRenderToJSDON(item: any, wrapInHtmlDocument: boolean=true): Promise<JSDON> {
        const out: JSDON = [];
        if(wrapInHtmlDocument) {
            out.push(DOCUMENT_NODE);
            out.push(DOCUMENT_TYPE_NODE, "html");
        } else {
            out.push(DOCUMENT_FRAGMENT_NODE);   // see renderToJSDON note
        }
        await this.asyncRenderItemToJSDON(out, item);
        if(wrapInHtmlDocument)
            out.push(NODE_END, NODE_END);
        else
            out.push(NODE_END);
        return out;
    }

    async asyncRenderItemToJSDON(out: JSDON, item: any, parentTag?: string) {
        switch(typeof item) {
            case 'undefined':
                break;
            case 'number':
            case 'boolean':
            case 'bigint':
                out.push(TEXT_NODE, String(item));
                break;
            case 'string':
                out.push(TEXT_NODE, textForParent(parentTag, item));
                break;
            case 'object':
                if(item == null)
                    void 0;
                else if(Array.isArray(item)) {
                    if(isElemMarkup(item)) {
                        await this.asyncRenderElementToJSDON(out, item as ElemExprLiteral);
                    } else {
                        for(const i of item)
                            await this.asyncRenderItemToJSDON(out, i, parentTag);
                    }
                } else if(item instanceof Promise) {
                    await this.asyncRenderItemToJSDON(out, await item, parentTag);
                } else {
                    throw new Error(`unhandled content object ${item} of type ${utils.className(item)}`);
                }
                break;

            default:
                throw new Error(`unhandled content item ${item} of type ${typeof item} (2)`);
        }
    }

    async asyncRenderElementToJSDON(out: JSDON, e: ElemExprLiteral) {
        let [tag, {...attrs}, ...content] = e;
        const tagName = checkTagName(tag instanceof Function ? tag.name : String(tag));

        out.push(ELEMENT_NODE);
        out.push(tagName);
        for(let [name, value] of Object.entries(attrs as Record<string, any>)) {
            while(value instanceof Promise)
                value = await value;
            // Null/undefined (incl a promise resolving to them) means the
            // attr is ABSENT - see the sync renderer note.
            if(name !== '' && value != undefined) {
                out.push(ATTRIBUTE_NODE, checkAttrName(name));
                out.push(String(value));
            }
        }

        await this.asyncRenderItemToJSDON(out, content, tagName);

        out.push(NODE_END);
    }
}

// (A markup diff facility - diffElem/diffContent - lived here as unfinished
// WIP until June 2026; it crashed on first call (plain-object .entries())
// and had no callers.  Recover from git history if the fragment-diff plan
// revives.)



