// deno-lint-ignore-file no-explicit-any
/**
 * THE dict() ROUTE FACADE (multi-dictionary-survey.md phase 3): the
 * per-dictionary page surface, reached as
 *
 *     /ww/wordwiki.dict('toy').home()
 *     /ww/wordwiki.dict('toy').word(5000)
 *
 * (routeterp evaluates the intermediate call: `dict` is authorized on
 * WordWiki with its argument, then `home`/`word` on this class - each
 * dispatch constructs a fresh handle, stateless by construction.)
 *
 * This is the facade's FIRST surface: a browsable face for any discovered
 * dictionary - the word list and the read-only word view - rendered
 * GENERICALLY from the dictionary's OWN schema (the meta renderer + the
 * role accessors; no typed Entry anywhere).  The default (MMO) dictionary
 * keeps its existing richer routes; the full per-dictionary EDITOR waits
 * on narrowing LexemeEditor's app interface (the listed phase-3 residual).
 */
import * as templates from './templates.ts';
import * as entryMeta from './render-entry-meta.ts';
import * as schemaRoles from './schema-roles.ts';
import * as dictionaryConfig from './dictionary-config.ts';
import { route, authenticated } from '../liminal/security.ts';
import type { Markup } from '../liminal/markup.ts';
import type { DictionaryStore } from './dictionary-store.ts';

export class DictionaryPages {
    constructor(readonly store: DictionaryStore) {}

    get table(): string { return this.store.assertionTable; }
    get slug(): string {
        return dictionaryConfig.readConfigValue(this.table, 'slug') ?? this.table;
    }
    get displayName(): string {
        return dictionaryConfig.readConfigValue(this.table, 'name') ?? this.slug;
    }

    private wordUrl(id: number): string {
        return `/ww/wordwiki.dict(${JSON.stringify(this.table)}).word(${id})`;
    }

    /** The dictionary's browsable word list: every current entry, sorted by
     *  its headword, each row navigating to the word view. */
    @route(authenticated)
    home(): templates.Page {
        const schema = this.store.dictSchema;
        const pk = schema.relationFields[0].primaryKeyField.name;
        const rows = (this.store.entries as any[])
            .map(e => ({id: e[pk] as number,
                        text: schemaRoles.headwordFallback(schema, e)?.text
                              ?? `(entry ${e[pk]})`}))
            .toSorted((a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
        const title = `${this.displayName} — dictionary`;
        const body: Markup = ['div', {class: 'container py-3'},
            ['h1', {}, this.displayName],
            ['p', {class: 'text-muted small'},
             `${rows.length} word(s) — dictionary '${this.slug}' (table ${this.table})`],
            rows.length === 0
                ? ['p', {class: 'text-muted'}, 'No words yet.']
                : ['div', {class: 'list-group lm-list'},
                   rows.map(r => ['a',
                       {...templates.pageLinkProps(this.wordUrl(r.id)),
                        class: 'list-group-item list-group-item-action'},
                       r.text])]];
        return templates.page(title, body);
    }

    /** One word, read-only, rendered generically from the dictionary's own
     *  schema by the metadata renderer. */
    @route(authenticated)
    word(id: number): templates.Page {
        const schema = this.store.dictSchema;
        const e = this.store.entriesById.get(id);
        const title = e
            ? (schemaRoles.headwordFallback(schema, e)?.text ?? `entry ${id}`)
            : `entry ${id}`;
        const body: Markup = ['div', {class: 'container py-3'},
            e === undefined
                ? ['p', {class: 'text-muted'}, 'Word not found.']
                : ['div', {class: 'page-content'},
                   entryMeta.renderEntryMeta(
                       {rootPath: '/', audience: 'internal'},
                       schema.relationFields[0], e)],
            ['p', {class: 'mt-3'},
             ['a', {...templates.pageLinkProps(
                 `/ww/wordwiki.dict(${JSON.stringify(this.table)}).home()`)},
              `← All ${this.displayName} words`]]];
        return templates.page(title, body);
    }
}
