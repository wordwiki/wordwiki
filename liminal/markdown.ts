/**
 * Markdown -> Markup (our element model), for MarkdownField and anywhere
 * else user-entered notes render.
 *
 * Deliberately NOT markdown -> HTML string: our markup layer has no raw-HTML
 * injection point (that absence is a security property - see markup.ts), and
 * this module keeps it that way by mapping the parsed mdast AST onto markup
 * arrays.  Safety falls out by construction:
 *   - only the element types this file emits can ever appear;
 *   - raw HTML in the source renders as visible TEXT (never parsed) - the
 *     classic markdown XSS channel is simply absent;
 *   - link/image URLs pass a protocol allowlist (http/https/mailto/tel, or
 *     relative); a hostile scheme (javascript: etc.) renders as plain text.
 *
 * Parser: mdast-util-from-markdown - the micromark/remark family's
 * CommonMark-exact parser, pure data out - plus the GFM extensions
 * (autolinks, strikethrough, tables, task lists: the dialect people
 * actually type into notes).
 */

import {fromMarkdown} from 'npm:mdast-util-from-markdown@2.0.2';
import {gfm} from 'npm:micromark-extension-gfm@3.0.0';
import {gfmFromMarkdown} from 'npm:mdast-util-gfm@3.1.0';
import type {Markup} from './markup.ts';

/**
 * Render markdown source as display markup (a div.lm-markdown).  Empty/null
 * source renders as nothing.
 */
export function markdownToMarkup(src: string|null|undefined): Markup {
    if(src == null || src.trim() === '') return undefined;
    const tree = fromMarkdown(src, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
    });
    return ['div', {class: 'lm-markdown'}, nodes(tree.children)];
}

// http(s)/mailto/tel, or scheme-less relative paths; anything else (most
// importantly javascript: and data:) is refused and renders as text.
function safeUrl(url: unknown): string|undefined {
    if(typeof url !== 'string') return undefined;
    const u = url.trim();
    if(/^(?:https?:|mailto:|tel:)/i.test(u)) return u;
    if(!/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//')) return u;  // relative
    return undefined;
}

function nodes(children: any[]): Markup[] {
    return (children ?? []).map(node);
}

function node(n: any): Markup {
    switch(n.type) {
        case 'paragraph':     return ['p', {}, nodes(n.children)];
        case 'heading':       return [`h${Math.min(6, Math.max(1, n.depth))}`, {}, nodes(n.children)];
        case 'text':          return n.value;
        case 'strong':        return ['strong', {}, nodes(n.children)];
        case 'emphasis':      return ['em', {}, nodes(n.children)];
        case 'delete':        return ['del', {}, nodes(n.children)];      // GFM ~~strikethrough~~
        case 'inlineCode':    return ['code', {}, n.value];
        case 'code':          return ['pre', {}, ['code', {}, n.value]];
        case 'blockquote':    return ['blockquote', {class: 'lm-markdown-quote'}, nodes(n.children)];
        case 'thematicBreak': return ['hr', {}];
        case 'break':         return ['br', {}];

        case 'list':          return [n.ordered ? 'ol' : 'ul', {}, nodes(n.children)];
        case 'listItem': {
            // GFM task-list items show their (display-only) checkbox.  Tight
            // list items unwrap their paragraph so <li> stays one line.
            const box = n.checked == null ? undefined
                : ['input', {type: 'checkbox', disabled: '',
                             class: 'form-check-input me-1',
                             ...(n.checked ? {checked: ''} : {})}];
            const content = (n.children ?? []).map((c: any) =>
                c.type === 'paragraph' && !n.spread ? nodes(c.children) : node(c));
            return ['li', {}, box, content];
        }

        case 'link': {
            const href = safeUrl(n.url);
            return href
                ? ['a', {href, target: '_blank', rel: 'noopener'}, nodes(n.children)]
                : ['span', {}, nodes(n.children)];           // hostile scheme: just the text
        }
        case 'image': {
            const src = safeUrl(n.url);
            return src
                ? ['img', {src, alt: n.alt ?? '', class: 'lm-markdown-img'}]
                : (n.alt ?? '');
        }

        // GFM tables (alignment ignored - notes, not spreadsheets).
        case 'table':     return ['table', {class: 'table table-sm lm-markdown-table'},
                                  ['tbody', {}, nodes(n.children)]];
        case 'tableRow':  return ['tr', {}, nodes(n.children)];
        case 'tableCell': return ['td', {}, nodes(n.children)];

        // Raw HTML shows AS TEXT (escaped downstream by the markup renderer).
        case 'html':      return n.value;

        // Unknown node kinds: render their content, never their markup.
        default:
            return Array.isArray(n.children) ? nodes(n.children) : (n.value ?? '');
    }
}
