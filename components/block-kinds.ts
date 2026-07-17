// The built-in block kinds, registered at import.  Each is a payload FieldSet + a
// render fn (site-editor.md); nothing here is a physical table.  These are the pure
// content blocks that need no app dependency - title, divider, text (markdown), and
// a table of contents built from the page's title blocks.  Blocks that need the
// app's photo pipeline (image-and-text) or app data (rabid-hours) are registered by
// the hosting app, not here.
//
// Renderers emit STRUCTURE + semantic classes only, never inline color/spacing, so a
// per-site stylesheet can restyle everything (site-editor.md CSS goal).

import { FieldSet, StringField, EnumField, type Tuple } from "../liminal/table.ts";
import { markdownToMarkup } from "../liminal/markdown.ts";
import { h, type Markup } from "../liminal/markup.ts";
import { registerBlockKind, type BlockCtx } from "./block-registry.ts";

export const title_level: Record<string, string> = { 'h1':'h1', 'h2':'h2', 'h3':'h3', 'h4':'h4' };

// A stable, url-safe anchor from heading text (title id <-> toc href must agree).
export function slugify(text: string): string {
    return String(text ?? '').toLowerCase().trim()
        .replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}

registerBlockKind({
    kind: 'title', label: 'Title', category: 'content',
    schema: new FieldSet('title', [
        new EnumField('level', title_level, {default: 'h2'}),
        new StringField('text', {default: '', prompt: 'Heading'}),
    ]),
    heading: (p) => p.text ? {level: String(p.level ?? 'h2'), text: String(p.text)} : undefined,
    isEmpty: (p) => !String(p.text ?? '').trim(),
    render: (p) => {
        const level = title_level[String(p.level)] ? String(p.level) : 'h2';
        return [level, {class: 'site-block-title', id: slugify(String(p.text ?? ''))}, String(p.text ?? '')];
    },
});

registerBlockKind({
    kind: 'divider', label: 'Divider', category: 'content',
    schema: new FieldSet('divider', []),
    render: () => [h.hr, {class: 'site-block-divider'}],
});

registerBlockKind({
    kind: 'text', label: 'Text', category: 'content',
    schema: new FieldSet('text', [
        new StringField('text', {default: '', prompt: 'Text (markdown)'}),
    ]),
    isEmpty: (p) => !String(p.text ?? '').trim(),
    render: (p) => [h.div, {class: 'site-block-text'}, markdownToMarkup(String(p.text ?? ''))],
});

registerBlockKind({
    kind: 'table-of-contents', label: 'Table of contents', category: 'content',
    schema: new FieldSet('table-of-contents', []),
    render: (_p, ctx: BlockCtx): Markup => {
        const headings = ctx.headings ?? [];
        if(headings.length === 0)
            return ctx.editing ? [h.div, {class: 'site-block-toc site-block-toc-empty'}, 'Table of contents (no headings yet)'] : '';
        return [h.nav, {class: 'site-block-toc', 'aria-label': 'Table of contents'},
            [h.ul, {class: 'site-block-toc-list'},
             headings.map(hd => [h.li, {class: `site-block-toc-item site-block-toc-${hd.level}`},
                 [h.a, {href: '#' + hd.anchor}, hd.text]])]];
    },
});

// Re-export for a page renderer that wants to fold a title payload into a heading.
export type { Tuple };
