// deno-lint-ignore-file no-explicit-any
/**
 * Tiny query helpers over liminal markup - the `[tag, attrs, ...children]` arrays
 * a render produces - so tests can assert on structure WITHOUT serializing to
 * HTML.  Think "minimal Testing Library for arrays."
 *
 * Deliberately framework-agnostic: no test-runner imports, only the markup shape.
 * So a move off `deno test` rewrites the test wrappers, not these helpers.
 */
import { isElemMarkup } from "../markup.ts";

export type ElemNode = [any, Record<string, any>, ...any[]];

// --- node accessors ---------------------------------------------------------

// Tag of an element node as a string ('div', 'a', ...; function tags use .name).
export function tagOf(node: ElemNode): string {
    const t = node[0];
    return typeof t === "function" ? t.name : String(t);
}
export function attrsOf(node: ElemNode): Record<string, any> { return node[1] ?? {}; }
export function attr(node: ElemNode, name: string): any { return attrsOf(node)[name]; }
export function childrenOf(node: ElemNode): any[] { return node.slice(2); }
export function classesOf(node: ElemNode): string[] {
    return String(attr(node, "class") ?? "").split(/\s+/).filter(Boolean);
}
export function hasClass(node: ElemNode, cls: string): boolean { return classesOf(node).includes(cls); }
export function testIdOf(node: ElemNode): string | undefined { return attr(node, "data-testid"); }

// --- traversal --------------------------------------------------------------

// Every element node in document order (depth-first), descending into fragments
// (arrays of nodes) as well as element children.
export function* elements(markup: any): Generator<ElemNode> {
    if(!Array.isArray(markup)) return;          // string / number / null / undefined leaf
    if(isElemMarkup(markup)) {
        yield markup as ElemNode;
        for(const c of childrenOf(markup as ElemNode)) yield* elements(c);
    } else {
        for(const c of markup) yield* elements(c);  // fragment: an array of nodes
    }
}

export type Predicate = (n: ElemNode) => boolean;

export function findAll(markup: any, pred: Predicate): ElemNode[] { return [...elements(markup)].filter(pred); }
export function find(markup: any, pred: Predicate): ElemNode | undefined { return [...elements(markup)].find(pred); }

export const byTestId = (id: string): Predicate => (n) => testIdOf(n) === id;
export const byTag = (tag: string): Predicate => (n) => tagOf(n) === tag;
export const byClass = (cls: string): Predicate => (n) => hasClass(n, cls);

export function findByTestId(markup: any, id: string): ElemNode | undefined { return find(markup, byTestId(id)); }
export function getByTestId(markup: any, id: string): ElemNode {
    const n = findByTestId(markup, id);
    if(!n) throw new Error(`no element with data-testid=${JSON.stringify(id)}`);
    return n;
}

// --- text -------------------------------------------------------------------

// Concatenated text of all string/number leaves under a node (or markup tree).
export function text(markup: any): string {
    let out = "";
    const rec = (n: any) => {
        if(typeof n === "string") out += n;
        else if(typeof n === "number") out += String(n);
        else if(Array.isArray(n)) {
            if(isElemMarkup(n)) childrenOf(n as ElemNode).forEach(rec);
            else n.forEach(rec);
        }
    };
    rec(markup);
    return out;
}
export function hasText(markup: any, s: string): boolean { return text(markup).includes(s); }

// '***' is what a redacted field renders as (see renderFieldValue); a convenience
// for "is this field hidden from the current viewer?".
export function isRedactedMarkup(markup: any): boolean { return text(markup).trim() === "***"; }
