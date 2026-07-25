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
import { path, serialize } from '../liminal/serializable.ts';
import type { Markup } from '../liminal/markup.ts';
import type { DictionaryStore } from './dictionary-store.ts';
import { LexemeOps } from './lexeme-ops.ts';
import { LexemeEditor, type LexemeEditorApp } from './lexeme-editor.ts';
import type { WordWiki } from './wordwiki.ts';

/** The per-dictionary EDITOR APP: the LexemeEditorApp surface satisfied
 *  over an arbitrary store - store-scoped members bind the dictionary,
 *  app-global services delegate to the base WordWiki.  The vocab tables
 *  are instance-GLOBAL by design (survey §3.1). */
export function editorAppFor(base: WordWiki, store: DictionaryStore): LexemeEditorApp {
    let ops: LexemeOps | undefined;
    const facade: LexemeEditorApp = {
        get dictSchema() { return store.dictSchema; },
        get workspace() { return store.workspace; },
        get assertionTable() { return store.assertionTable; },
        get entriesById() { return store.entriesById; },
        get lastAllocatedTxTimestamp() { return store.lastAllocatedTxTimestamp; },
        applyTransaction: (a, o) => store.applyTransaction(a, o ?? {}),
        applyTransactions: (a) => store.applyTransactions(a),
        allocTxTimestamps: (c, o) => store.allocTxTimestamps(c, o),
        requestWorkspaceReload: () => store.requestWorkspaceReload(),
        requestEntriesJSONReload: () => store.requestEntriesJSONReload(),
        currentUsername: () => base.currentUsername(),
        currentWorkingOrthography: () => base.currentWorkingOrthography(),
        newContentOrthography: () => base.newContentOrthography(),
        get orthographies() { return base.orthographies; },
        get tags() { return base.tags; },
        get lexicalForms() { return base.lexicalForms; },
        get categories() { return base.categories; },
        get lexemeOps() { return ops ??= new LexemeOps(facade); },
        // The custom Tags/Log sections are the DEFAULT dictionary's feature
        // (wordwiki.renderLexemeWorkflow reads the default store); a facade
        // dictionary renders none - its generic rows are suppressed only
        // when its schema declares the workflow roles, which then deserve
        // the real sections (a listed residual).
        renderLexemeWorkflow: (_entry_id: number) => [],
    };
    return facade;
}

export class DictionaryPages {
    constructor(readonly base: WordWiki, readonly store: DictionaryStore) {}

    /** Route-path identity: this handle IS the expression that reaches it,
     *  so @path children (the lexeme editor) serialize under it. */
    [serialize](): string { return `wordwiki.dict(${JSON.stringify(this.table)})`; }

    /** The per-dictionary LEXEME EDITOR: the standard editor over this
     *  dictionary's store, emitting URLs inside its own route base. */
    @route(authenticated) @path get lexeme(): LexemeEditor {
        return new LexemeEditor(editorAppFor(this.base, this.store),
                                `/ww/wordwiki.dict(${JSON.stringify(this.table)}).lexeme`);
    }

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
