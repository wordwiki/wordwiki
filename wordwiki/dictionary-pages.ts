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
import * as renderPageEditor from './render-page-editor.ts';
import * as schemaRoles from './schema-roles.ts';
import * as dictionaryConfig from './dictionary-config.ts';
import { route, authenticated } from '../liminal/security.ts';
import { dynamicRouteMember, type DynamicRouteResolution } from '../liminal/routeterp.ts';
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
        // The Tags/Log sections, generalized by role (dz 2026-07-28):
        // the shared surface over THIS dictionary's store; renders nothing
        // when the schema has no workflow relations (see
        // ensure-workflow-relations).
        renderLexemeWorkflow: (entry_id: number) =>
            base.renderLexemeWorkflow(entry_id, store.assertionTable),
    };
    return facade;
}

/** The DYNAMIC dictionaries namespace (routeterp dynamicRouteMember):
 *  wordwiki.dicts.<table>.* - the member names ARE the discovered
 *  dictionaries, resolved per dispatch (drop a table pair into the db and
 *  its routes exist).  Mounted on its own object so dynamic names can
 *  never collide with static route members. */
export class DictionariesRoutes {
    constructor(readonly app: WordWiki) {}

    [serialize](): string { return 'wordwiki.dicts'; }

    [dynamicRouteMember](name: string): DynamicRouteResolution|undefined {
        if(!this.app.dictionaries().includes(name)) return undefined;
        return {value: new DictionaryPages(this.app, this.app.storeFor(name)),
                perm: authenticated};
    }
}

export class DictionaryPages {
    constructor(readonly base: WordWiki, readonly store: DictionaryStore) {}

    /** Route-path identity: the CANONICAL dotted form (table names are
     *  identifier-shaped by construction), so @path children (the lexeme
     *  editor) serialize under it and every emitted URL reads
     *  wordwiki.dicts.toy.... - the dict('toy') call form remains a valid
     *  alias whose handle emits the same canonical URLs. */
    [serialize](): string { return `wordwiki.dicts.${this.table}`; }

    /** The per-dictionary LEXEME EDITOR: the standard editor over this
     *  dictionary's store, emitting URLs inside its own route base. */
    @route(authenticated) @path get lexeme(): LexemeEditor {
        return new LexemeEditor(editorAppFor(this.base, this.store),
                                `/ww/wordwiki.dicts.${this.table}.lexeme`);
    }

    get table(): string { return this.store.assertionTable; }
    get slug(): string {
        return dictionaryConfig.readConfigValue(this.table, 'slug') ?? this.table;
    }
    get displayName(): string {
        return dictionaryConfig.readConfigValue(this.table, 'name') ?? this.slug;
    }

    private wordUrl(id: number): string {
        return `/ww/wordwiki.dicts.${this.table}.word(${id})`;
    }
    /** The STANDARD editor for this dictionary: the generalized META editor
     *  (metaEditPage) - never the classic look, whose renderers are typed
     *  to the default dictionary (dz's 'No spellings' rand report). */
    private editUrl(id: number): string {
        return `/ww/wordwiki.dicts.${this.table}.lexeme.metaEditPage(${id})`;
    }
    /** A word row: navigate on the row, pencil-only edit (the house list
     *  recipe). */
    private wordRow(id: number, content: Markup): Markup {
        return ['div', {class: 'list-group-item d-flex align-items-center gap-2'},
            ['a', {...templates.pageLinkProps(this.wordUrl(id)),
                   class: 'flex-grow-1 text-decoration-none'}, content],
            templates.pencilLink(this.editUrl(id))];
    }

    /** The dictionary's search form (shared by home and the search page):
     *  a plain GET, so the URL carries the query. */
    private searchForm(searchText = ''): Markup {
        return ['form', {method: 'get', class: 'row g-2 align-items-center mb-3',
                         action: `/ww/wordwiki.dicts.${this.table}.search(query)`},
            ['div', {class: 'col-auto'},
             ['input', {type: 'text', class: 'form-control', name: 'searchText',
                        placeholder: `Search ${this.displayName}…`, value: searchText}]],
            ['div', {class: 'col-auto'},
             ['button', {type: 'submit', class: 'btn btn-outline-primary'}, 'Search']]];
    }

    /** The dictionary's browsable word list: every current entry, sorted by
     *  its headword, letter-indexed, each row navigating to the word view. */
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
        const mirrorSource = dictionaryConfig.readConfigValue(this.table, 'import_mirror') === 'true'
            ? (dictionaryConfig.readConfigValue(this.table, 'import_source') ?? 'an SFM import')
            : undefined;
        // Letter groups (fold-first-letter), for the jump index a
        // book-sized list needs.
        const letterOf = (t: string) =>
            (t.normalize('NFD').replace(/\p{Mark}/gu, '').toLowerCase()
                .match(/[a-z]/)?.[0] ?? '#');
        const groups = new Map<string, typeof rows>();
        for(const r of rows) {
            const l = letterOf(r.text);
            (groups.get(l) ?? groups.set(l, []).get(l)!).push(r);
        }
        const body: Markup = ['div', {class: 'container py-3'},
            ['h1', {}, this.displayName],
            ['p', {class: 'text-muted small'},
             `${rows.length} word(s) — dictionary '${this.slug}' (table ${this.table})`],
            // Import mirrors are re-created by re-import: edits belong in
            // the TRANSFORMED dictionary (survey phase 5).
            mirrorSource === undefined ? undefined :
                ['div', {class: 'alert alert-info py-2'},
                 `Import mirror of ${mirrorSource} — edits belong in the transformed dictionary, not here.`],
            this.searchForm(),
            groups.size > 1
                ? ['p', {}, [...groups.keys()].map(l =>
                    ['a', {href: `#letter-${l}`, class: 'me-2 text-decoration-none'},
                     l.toUpperCase()])]
                : undefined,
            rows.length === 0
                ? ['p', {class: 'text-muted'}, 'No words yet.']
                : [...groups.entries()].map(([l, rs]) => [
                    ['h5', {id: `letter-${l}`, class: 'mt-3'}, l.toUpperCase()],
                    ['div', {class: 'list-group lm-list'},
                     rs.map(r => this.wordRow(r.id, r.text))]])];
        return templates.page(title, body, {dictionary: this.table});
    }

    /** Generic search over THIS dictionary: diacritic/case-insensitive
     *  substring over every spelling lane (headword roles + source-
     *  orthography texts) and every gloss. */
    @route(authenticated)
    search(query?: {searchText?: string}|string): templates.Page {
        // Reached both ways: .search(query) from the GET form (querystring
        // object, the searchPage convention) and .search("...") direct.
        const searchText = typeof query === 'string' ? query : (query?.searchText ?? '');
        const schema = this.store.dictSchema;
        const pk = schema.relationFields[0].primaryKeyField.name;
        const fold = (s: string) => s.normalize('NFD').replace(/\p{Mark}/gu, '')
            .toLowerCase().replace(/[^a-z0-9 ]/g, '');
        const q = fold(searchText ?? '').trim();
        const LIMIT = 300;
        const hits: {id: number, text: string, gloss: string}[] = [];
        let total = 0;
        if(q !== '') {
            for(const e of this.store.entries as any[]) {
                const spellings = [
                    ...schemaRoles.headwordsAllLanes(schema, e).map(h => h.text),
                    ...schemaRoles.sourceOrthographyTexts(schema, e).map(h => h.text)];
                const glosses = schemaRoles.glossTexts(schema, e);
                if([...spellings, ...glosses].some(t => fold(t ?? '').includes(q))) {
                    total++;
                    if(hits.length < LIMIT)
                        hits.push({id: e[pk],
                                   text: schemaRoles.headwordFallback(schema, e)?.text
                                         ?? `(entry ${e[pk]})`,
                                   gloss: glosses[0] ?? ''});
                }
            }
        }
        const body: Markup = ['div', {class: 'container py-3'},
            ['h1', {}, `Search ${this.displayName}`],
            this.searchForm(searchText ?? ''),
            q === ''
                ? ['p', {class: 'text-muted'}, 'Type a word or part of a gloss.']
                : ['p', {class: 'text-muted small'},
                   `${total} match(es)${total > LIMIT ? ` — first ${LIMIT} shown` : ''}`],
            ['div', {class: 'list-group lm-list'},
             hits.map(h => this.wordRow(h.id,
                 [['b', {}, h.text],
                  h.gloss ? ['span', {class: 'text-muted'}, ` — ${h.gloss}`] : undefined]))]];
        return templates.page(`Search ${this.displayName}`, body, {dictionary: this.table});
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
            // The standard pencil (house recipe: detail pages carry the
            // pencil).  Just the pencil - the meta renderer below draws the
            // entry heading itself (all lanes); a second title line here
            // duplicated it (dz).
            e === undefined ? undefined :
                ['div', {class: 'd-flex justify-content-end'},
                 templates.pencilLink(this.editUrl(id))],
            e === undefined
                ? ['p', {class: 'text-muted'}, 'Word not found.']
                : ['div', {class: 'page-content'},
                   entryMeta.renderEntryMeta(
                       {rootPath: '/', audience: 'internal',
                        // The reference scan (a boundingGroup-shaped field):
                        // same composition as the MMO word view - the scan
                        // crop linking to its page-editor page.  Group-scoped,
                        // so dictionary-agnostic; a dangling group id renders
                        // a quiet note rather than crashing the word page.
                        renderBoundingGroup: (gid: number) => {
                            try {
                                const scan = renderPageEditor.renderStandaloneGroup('/', gid);
                                let url = ''; try { url = renderPageEditor.pageEditorURLForBoundingGroup(gid); } catch { /**/ }
                                let desc = ''; try { desc = renderPageEditor.imageRefDescription(gid); } catch { /**/ }
                                return ['div', {},
                                    ['div', {class: 'lm-me-scan'}, url ? ['a', {href: url}, scan] : scan],
                                    desc ? ['div', {}, url ? ['a', {href: url}, desc] : desc] : ''];
                            } catch {
                                return ['div', {class: 'text-muted small'}, `(scan group ${gid})`];
                            }
                        }},
                       schema.relationFields[0], e)],
            ['p', {class: 'mt-3'},
             ['a', {...templates.pageLinkProps(
                 `/ww/wordwiki.dicts.${this.table}.home()`)},
              `← All ${this.displayName} words`]],
            // The workflow surface (Tags + Log + the capture dock) - same
            // one-way-everywhere rule as the MMO word view.
            e === undefined ? undefined
                : this.base.renderLexemeWorkflow(id, this.table)];
        return templates.page(title, body, {dictionary: this.table});
    }
}
