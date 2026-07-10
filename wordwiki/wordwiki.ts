// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as model from './model.ts';
import * as renderPageEditor from './render-page-editor.ts';
import * as server from '../liminal/http-server.ts';
import {VersionedDb} from  './workspace.ts';
import * as config from './config.ts';
import * as entry from './entry-schema.ts';
import * as orthography from './orthography.ts';
import * as entryMeta from './render-entry-meta.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as templates from './templates.ts';
import * as orderkey from '../liminal/orderkey.ts';
import * as audio from './audio.ts';
import {block} from '../liminal/strings.ts';
import {db} from "../liminal/db.ts";
import * as publish from './publish.ts';
import {asyncRenderToStringViaLinkeDOM} from '../liminal/markup.ts';
import {selectScannedDocumentByFriendlyId, selectAllScannedDocuments, allScannedDocumentSchemaDml} from './scanned-document.ts';
import {Assertion, createAssertionDml, ensureAssertionColumns} from './assertion.ts';
import {pageEditor} from './render-page-editor.ts';

import {LiminalApp, type TestClientSession, type TestCase} from '../liminal/liminal.ts';
import * as security from '../liminal/security.ts';
import * as passwordUtils from '../liminal/password.ts';
import * as date from '../liminal/date.ts';
import * as markdown from '../liminal/markdown.ts';
import {serialize, path} from '../liminal/serializable.ts';
import {route, routeMutation, authenticated, hostOrAdmin, publicRoute} from '../liminal/security.ts';
import {lazy} from '../liminal/lazy.ts';
import {LexemeEditor} from './lexeme-editor.ts';
import {ChangeFeed} from './change-feed.ts';
import {ActivityReport} from './activity-report.ts';
import {SpellingReports} from './spelling-duplicates.ts';
import {RecentWords} from './recent-words.ts';
import {LexemeOps} from './lexeme-ops.ts';
import {reloadableProps} from '../liminal/table.ts';
import * as user from './user.ts';
import * as category from './category.ts';
import * as tag from './tag.ts';
import * as lexicalForm from './lexical-form.ts';
import {DictionaryStore} from './dictionary-store.ts';
import {siteConfig} from './site-config.ts';
import {filterEntryVariants} from './publish-source.ts';
import {SiteView} from './site-view.ts';
import { VariantReports } from './variant-scan.ts';
import { TransliterationReports } from './auto-transliterate.ts';
import { EditorReports } from './reports.ts';

/**
 *
 */
export class WordWiki extends LiminalApp {
    routes: Record<string, any>;

    /** The versioned model layer (workspace + tx machinery + the
     *  orthography-agnostic projections) - see dictionary-store.ts. */
    readonly store: DictionaryStore;

    // Report-world cache: a db query, not a projection, but derived from the
    // same data - dropped on every store invalidation like the projections.
    #entryCountByPage: Map<string, Array<[number, number]>> = new Map();

    /**
     *
     */
    constructor() {
        super();

        this.store = new DictionaryStore({onDerivedInvalidated: () => {
            this.#entryCountByPage = new Map();
        }});

        // The navbar renders the working-orthography status (brand suffix,
        // switcher, override banner) through this provider - templates.ts
        // cannot import the app (cycle), so it is injected once here.
        templates.setOrthographyStatusProvider(() => this.orthographyStatus());
        // Publicness is asked IN THE WORKING LANE ('mm'/unset = any lane).
        entry.setOrthographyAbbrHook(slug => this.orthographyAbbr(slug));
        templates.setEntryPublicnessProvider(id =>
            this.store.publicEntryIdsIn(this.currentWorkingOrthography() ?? 'mm').has(id));
        // The page-editor word sidebar renders word summaries in the working
        // lane - same cycle-avoiding injection as the templates providers.
        renderPageEditor.setPageEditorAppProvider(() => this);
        // Bylines (the session log) show the user's NAME, not the login.
        entry.setUsernameDisplayHook(username => {
            try {
                return security.runSystem(() =>
                    this.users.byUsername.first({username}))?.name || undefined;
            } catch { return undefined; }   // pre-migration db
        });

        // --- Set up our routes
        // The page-editor / audio / publish routes are NOT spread in here as
        // bare top-level functions anymore: they live under the @route-gated
        // `wordwiki.pages` / `wordwiki.audio` / `wordwiki.publish` namespaces
        // (see the getters below), so the strict route interpreter's member gate
        // covers them.  The root scope now binds only the app itself.
        this.routes = Object.assign(
            {},
            {wordwiki: this},
        );
    }

    // ----- Store delegates ----------------------------------------------------
    // The historical WordWiki surface for the model layer, preserved so the
    // many existing consumers (and tests) keep working; new code should reach
    // app.store directly, and consumers migrate as they are touched.
    get dictSchema(): model.Schema { return this.store.dictSchema; }
    get workspace(): VersionedDb { return this.store.workspace; }
    get entries(): entry.Entry[] { return this.store.entries; }
    get entriesById(): Map<number, entry.Entry> { return this.store.entriesById; }
    get entriesByReferenceGroupId(): Map<number, entry.Entry> { return this.store.entriesByReferenceGroupId; }
    get publishedProjection(): entry.Entry[] { return this.store.publishedProjection; }
    get lastAllocatedTxTimestamp() { return this.store.lastAllocatedTxTimestamp; }
    allocTxTimestamps(count: number=1, opts: {quiet?: boolean} = {}) {
        return this.store.allocTxTimestamps(count, opts);
    }
    applyTransactions(assertions: Assertion[]) { this.store.applyTransactions(assertions); }
    applyTransaction(assertions: Assertion[], opts: {quiet?: boolean} = {}) {
        this.store.applyTransaction(assertions, opts);
    }
    requestWorkspaceReload() { this.store.requestWorkspaceReload(); }
    requestEntriesJSONReload() { this.store.requestEntriesJSONReload(); }

    // ----- Site-view delegates -------------------------------------------------
    // The per-orthography site view (site-view.ts).  Every consumer of "the
    // public dictionary" goes through here; for now everything renders THE
    // public site's orthography - render-time selection by the user's
    // working orthography is the next step of the multi-orthography work.
    site(orthography: string = entry.PUBLIC_SITE_ORTHOGRAPHY): SiteView {
        return this.store.site(orthography);
    }
    /** The EDITOR's working-lane entry pool (dz 2026-07-09): the CURRENT
     *  projection (work in progress included) filtered by editorial
     *  PRESENCE in the working lane - any current fact tagged exactly that
     *  orthography (store.entriesWithContentIn).  NOT the public/pub-gate
     *  notion: a word whose SF content is mid-edit belongs to the SF
     *  editor's views precisely then.  ALL ('mm') and unset lanes filter
     *  nothing.  Public-site FEATURES - publish, the word-a-day picker,
     *  "is it on the site" markers - stay pinned to site(). */
    workingEntries(): entry.Entry[] {
        const w = this.currentWorkingOrthography();
        if(!w || w === 'mm') return this.store.activeEntries;
        const present = this.store.entriesWithContentIn(w);
        return this.store.activeEntries.filter(e => present.has(e.entry_id));
    }

    /** The working lane as a display fact for report headers: the SPECIFIC
     *  lane's slug+name, or undefined when unset/ALL (no filtering). */
    workingLane(): {orthography: string, name: string} | undefined {
        const w = this.currentWorkingOrthography();
        if(!w || w === 'mm') return undefined;
        return {orthography: w, name: this.orthographyDisplayName(w)};
    }
    get sourceLangCollator(): Intl.Collator { return this.site().collator; }
    get publishedEntries(): entry.Entry[] { return this.site().publicEntries; }
    get entriesByCategory(): Map<string, entry.Entry[]> { return this.site().entriesByCategory; }
    getCategories(): Map<string, number> { return this.site().categoryCounts(); }
    getEntriesForCategory(category: string): entry.Entry[] {
        return this.site().entriesForCategory(category);
    }

    [serialize](): string {
        return 'wordwiki';
    }

    // ----- New-style (liminal Table) tables ----------------------------------

    // Service getters are navigation (the leaf method carries its own route perm);
    // reaching any table requires a login.  The internal auth tables
    // (passwordHash/userSession) are deliberately NOT exposed as routes.
    @route(authenticated) @path get config() { return new config.ConfigTable(); }
    @route(authenticated) @path get users() { return new user.UserTable(this); }
    @path get passwordHash() { return new user.PasswordHashTable(); }
    @path get userSession() { return new user.UserSessionTable(); }
    @route(authenticated) @path get categories() { return new category.CategoryTable(this); }
    @route(authenticated) @path get tags() { return new tag.TagTable(this); }
    @route(authenticated) @path get lexicalForms() { return new lexicalForm.LexicalFormTable(this); }
    @route(authenticated) @path get orthographies() { return new orthography.OrthographyTable(this); }

    // The new-style tables (auto-created at startup; the legacy raw-DML tables
    // - scanned documents, bounding boxes, the dict assertion table - stay in
    // schema.ts).  More rabid-style tables will be added here over time.
    @lazy get tables() {
        return [this.config, this.users, this.passwordHash, this.userSession,
                this.categories, this.lexicalForms, this.orthographies,
                this.tags];
    }

    // Create the new-style tables if missing (idempotent CREATE IF NOT EXISTS).
    // Also seeds the (tiny, fixed) orthography vocabulary - reads first, so a
    // seeded db sees no writes - and applies the LATE dict columns (aside):
    // serve startup did this via createAllTables, but a FRESHLY PULLED V1 db
    // meets its first workspace load inside the import pipeline's
    // subcommands, which reach the db through THIS hook (bitten 2026-07-07:
    // 'no such column: aside' at import-categories on a fresh pull - the
    // long-lived dev db had the column and masked the gap).
    ensureNewStyleTables() {
        for(const t of this.tables)
            db().executeStatements(t.createDMLString());
        ensureAssertionColumns('dict');
        orthography.seedOrthographies(this.orthographies);
        tag.seedTags(this.tags);
    }

    // ----- Route namespaces ---------------------------------------------------
    // NAMING: each getter (= the URL namespace) is the lowerCamel of its
    // class - EditorReports is wordwiki.editorReports.* (dz 2026-07-08;
    // 'reports' vs 'report' was unreadable).
    // LIFECYCLE: these memoized instances are ROUTE NAMESPACES, not caches -
    // created once and NEVER dropped on data invalidation.  They must
    // therefore hold NO data state: every data cache belongs in
    // DictionaryStore / SiteView (dropped wholesale on every mutation).
    // Audited 2026-07-08: all namespace classes are stateless (per-render
    // closure memos are fine; instance fields holding data are not).

    // The v2 (server-side htmx) lexeme editor, reachable as wordwiki.lexeme.*
    // (e.g. /ww/wordwiki.lexeme.entryPage(<entry_id>)).  See lexeme-editor-design.md.
    #lexeme: LexemeEditor|undefined = undefined;
    @route(authenticated) @path get lexeme(): LexemeEditor {
        return this.#lexeme ??= new LexemeEditor(this);
    }

    // The global change feed, reachable as wordwiki.feed.* (page alias:
    // wordwiki.changes(<before>)).  See change-feed.ts.
    #feed: ChangeFeed|undefined = undefined;
    @route(authenticated) @path get feed(): ChangeFeed {
        return this.#feed ??= new ChangeFeed(this);
    }

    // The duplicate-spelling report, reachable as wordwiki.spellingReports.*
    // (wordwiki.spellingReports.duplicatesReport()).  See spelling-duplicates.ts.
    #spellingReports: SpellingReports|undefined = undefined;
    @route(authenticated) @path get spellingReports(): SpellingReports {
        return this.#spellingReports ??= new SpellingReports();
    }

    // The LIVE variant-cleanup report (the language staff's triage queue,
    // drains as fixes land), reachable as wordwiki.variantReports.cleanupReport().
    // See variant-scan.ts VariantReports.
    #variantReports: VariantReports|undefined = undefined;
    @route(authenticated) @path get variantReports(): VariantReports {
        return this.#variantReports ??= new VariantReports(this);
    }

    // The transliteration corrections/accuracy report (the transliterator's
    // development loop), reachable as wordwiki.transliterationReports.
    // correctionsReport().  See auto-transliterate.ts.
    #transliterationReports: TransliterationReports|undefined = undefined;
    @route(authenticated) @path get transliterationReports(): TransliterationReports {
        return this.#transliterationReports ??= new TransliterationReports(this);
    }

    // The misc editor reports (categories directory, TODO, twitter post
    // status, the word-a-day picker, entries-by-PDM-page, the import
    // report), reachable as wordwiki.editorReports.*.  See reports.ts - the
    // constructor takes the NARROW ReportsApp interface.
    #editorReports: EditorReports|undefined = undefined;
    @route(authenticated) @path get editorReports(): EditorReports {
        return this.#editorReports ??= new EditorReports(this);
    }


    // The monthly activity report, reachable as wordwiki.activityReport.* (page
    // alias: wordwiki.activity({months, restrict_to_user})).  See
    // activity-report.ts.
    #activityReport: ActivityReport|undefined = undefined;
    @route(authenticated) @path get activityReport(): ActivityReport {
        return this.#activityReport ??= new ActivityReport(this);
    }

    // Recently changed WORDS - the reviewer's word-at-a-time approval loop
    // (page alias: wordwiki.recentlyChangedWords()).  See recent-words.ts.
    #recentWords: RecentWords|undefined = undefined;
    @route(authenticated) @path get recentWords(): RecentWords {
        return this.#recentWords ??= new RecentWords(this);
    }

    // The scanned-document / page editor, reachable as wordwiki.pages.*
    // (e.g. /ww/wordwiki.pages.renderPageEditorByPageId(...)).  The namespace
    // getter is `authenticated` (the view routes are embedded in the lexeme
    // editor for any contributor); individual mutation routes further require
    // hostOrAdmin.  See render-page-editor.ts PageRoutes.
    #pages: renderPageEditor.PageRoutes|undefined = undefined;
    @route(authenticated) @path get pages(): renderPageEditor.PageRoutes {
        return this.#pages ??= new renderPageEditor.PageRoutes();
    }

    // Audio routes, reachable as wordwiki.audio.* (e.g. the lexeme editor's
    // eager recording upload).  `authenticated`; uploadRecording is POST-only.
    #audioRoutes: audio.AudioRoutes|undefined = undefined;
    @route(authenticated) @path get audio(): audio.AudioRoutes {
        return this.#audioRoutes ??= new audio.AudioRoutes();
    }

    // Publish routes, reachable as wordwiki.publish.* (start a publish / view
    // its status).  `hostOrAdmin` - pushing the public site is a release task.
    #publishRoutes: publish.PublishRoutes|undefined = undefined;
    @route(hostOrAdmin) @path get publish(): publish.PublishRoutes {
        return this.#publishRoutes ??= new publish.PublishRoutes();
    }

    // The assertion-mutation domain verbs (lexeme-ops.ts), shared by the
    // lexeme editor and the table pages' buttons.  Not itself a dispatch
    // target: pages expose their own verbs and delegate here.
    #lexemeOps: LexemeOps|undefined = undefined;
    get lexemeOps(): LexemeOps {
        return this.#lexemeOps ??= new LexemeOps(this);
    }

    // ----- New-style pages ----------------------------------------------------

    @route(authenticated)
    usersPage(): templates.Page {
        return templates.page('Users', this.users.renderUsersPage());
    }

    // The category VOCABULARY admin page (the controlled list of categories) -
    // distinct from categoriesDirectory(), the entries-by-category report.
    @route(authenticated)
    categoriesPage(): templates.Page {
        return templates.page('Category Table', this.categories.renderCategoriesPage());
    }

    // The tag vocabulary admin page (the editorial tagging model - tag.ts).
    @route(authenticated)
    tagsPage(): templates.Page {
        return templates.page('Tag Table', this.tags.renderTagsPage());
    }

    // The lexical form (part of speech) vocabulary admin page.
    @route(authenticated)
    lexicalFormsPage(): templates.Page {
        return templates.page('Lexical Form Table', this.lexicalForms.renderLexicalFormsPage());
    }

    // The orthography (writing system) vocabulary admin page.
    @route(authenticated)
    orthographiesPage(): templates.Page {
        return templates.page('Orthography Table', this.orthographies.renderOrthographiesPage());
    }

    /**
     * Create a new (empty) lexeme - an entry with one subentry - and redirect
     * to it in the editor.  Reached by the navbar "Add New Entry" form POST
     * (a POST so link prefetch/prerender can't create entries).
     */
    @routeMutation(authenticated)   // POSTed by the new-lexeme form; creates an entry
    newLexemeAction(): server.Response {
        const tx_time = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);  // placeholder; applyTransaction allocates

        const entry_id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        const newEntryAssertion: Assertion = {
            assertion_id: entry_id,
            valid_from: tx_time,
            valid_to: timestamp.END_OF_TIME,
            id: entry_id,
            ty: 'ent',
            ty0: 'dct',
            ty1: 'ent',
            id1: entry_id,
            order_key: orderkey.new_range_start_string,
            change_by_username: this.currentUsername(),
        };

        const subentry_id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        const newSubEntryAssertion: Assertion = {
            assertion_id: subentry_id,
            valid_from: timestamp.nextTime(tx_time),
            valid_to: timestamp.END_OF_TIME,
            id: subentry_id,
            ty: 'sub',
            ty0: 'dct',
            ty1: 'ent',
            id1: entry_id,
            ty2: 'sub',
            id2: subentry_id,
            order_key: orderkey.new_range_start_string,
            change_by_username: this.currentUsername(),
        };

        this.applyTransactions([newEntryAssertion, newSubEntryAssertion]);

        return server.forwardResponse(`/ww/wordwiki.entry(${entry_id})`);
    }

    // The word EDITOR - the METADATA-DRIVEN editor is the default now (dz,
    // 2026-07-05; the classic per-relation-card look stays reachable at
    // wordwiki.lexeme.entryPage, and review mode lives there too).  `since`
    // was the classic editor's sitting anchor - accepted and ignored so old
    // in-flight links keep resolving.  `entry` is the older legacy alias.
    @route(authenticated)
    wordEditor(entry_id: number, _since: number = 0): templates.Page | server.Response {
        return this.lexeme.metaEditPage(entry_id);
    }
    @route(authenticated)
    entry(entry_id: number, _since: number = 0): templates.Page | server.Response {
        return this.lexeme.metaEditPage(entry_id);
    }

    // The word VIEW: a read-only rendering of the lexeme (for now the same
    // renderer the public site uses - entrySchema.renderEntry - but over the
    // CURRENT internal data, so it shows the latest values incl. pending
    // edits, and internal notes).  This is the DEFAULT target of a lexeme
    // link (researchers are usually just looking); a top Edit bar and the
    // per-link pencils reach the editor.  Grows later (a simplified history,
    // etc.) away from the public renderer.
    // `orthography` is the ONE-WORD LENS (dz 2026-07-08): an explicit
    // per-page override that shows THIS word as that orthography's site
    // would (variant-tagged content filtered to the lane via the same
    // provenance-aware filter the publish bundle uses; $sourceOrthography
    // reference fields always pass).  Deliberately NOT a site-wide switch -
    // the session-level working-orthography selector is coming separately -
    // but reports like SF-Ready Words link here so an li-primary researcher
    // gets a meaningful target page.  The lens is announced PROMINENTLY.
    @route(authenticated)
    wordView(entry_id: number, orthography: string = ''): templates.Page {
        const raw = this.entriesById.get(entry_id);
        const e = raw && orthography
            ? filterEntryVariants(raw, [orthography]) : raw;
        const title = e ? entry.renderEntrySpellingsSummary(e, orthography || undefined)
                        || `Entry ${entry_id}` : `Entry ${entry_id}`;
        const lensBanner = e && orthography
            ? ['div', {class: 'alert alert-info py-2 mb-3'},
               'Viewing this word through the ',
               ['b', {}, this.orthographyDisplayName(orthography)],
               ' orthography lens — content in other orthographies is hidden. ',
               ['a', {href: `/ww/wordwiki.wordView(${entry_id})`}, 'View normally']]
            : undefined;
        const rendered: any = e
            ? entryMeta.renderEntryMeta(
                  {rootPath: '/', audience: 'internal', publicKeys: ['borrowed-word'],
                   renderBoundingGroup: this.wordViewBoundingGroup,
                   valueLabel: (f, v) =>
                       f.name === 'speaker' ? this.speakerDisplayLabel(String(v)) : undefined,
                   // The TITLE shows the working lane's spelling ('mm'/unset
                   // = every lane, '/'-joined); the body shows all lanes,
                   // marked with the editor's Li/SF badges.
                   titleOrthography: orthography || this.currentWorkingOrthography(),
                   orthographyBadge: (slug: string) => this.orthographyAbbr(slug),
                   titleAffordance: this.wordViewPencil(entry_id, e, orthography || undefined)},
                  this.dictSchema.relationsByTag[entry.EntryTag], e)
            : ['p', {class: 'text-muted'}, 'Word not found.'];
        return templates.page(title,
            ['div', {class: 'container py-3'},
             lensBanner,
             ['div', {class: 'page-content'}, rendered],
             // The session-log pane (dz 2026-07-09): the word view is
             // where the speakers group sits, so feedback capture lives
             // HERE - non-modal (the floating dock), the page stays
             // readable while the note is typed.
             e ? this.renderLexemeLogPane(entry_id) : undefined]);
    }

    /** The word view's LOG pane: the entry's session-log facts (top-posted
     *  - the order_key IS the presentation order) with feed-style bylines,
     *  and the quick Post box.  One post = one fact via lexemeOps.postLog
     *  (born-approved under a published entry; see the verb). */
    /** The word view's Log presence: the floating capture DOCK + the
     *  reading section (a reloadable fragment).  Also appended to the
     *  LEXEME EDITOR page - posting refreshes registered fragments on
     *  either page through the normal liminal reload machinery (no page
     *  reload; dz: a full refresh would be unacceptable on the editor). */
    private renderLexemeLogPane(entry_id: number): any {
        return [this.renderLexemeLogDock(entry_id),
                this.renderLexemeLogSection(entry_id)];
    }

    /** The log's READING presentation: a standard reloadable fragment
     *  (key `-lexeme-log-<id>-`), refreshed in place when the dock posts. */
    @route(authenticated)
    renderLexemeLogSection(entry_id: number): any {
        // The byline comes from each fact's FIRST version (the post; later
        // touch-ups don't re-date it); the text from the current one.
        const versions = db().all<{id: number, attr1: string, order_key: string,
                                   valid_from: number, valid_to: number,
                                   change_by_username: string|null}, {entry_id: number}>(
            block`
/**/     SELECT id, attr1, order_key, valid_from, valid_to, change_by_username
/**/       FROM dict
/**/       WHERE ty = :ty AND id1 = :entry_id
/**/       ORDER BY id, valid_from`, {ty: entry.LogTag, entry_id} as any);
        const byId = new Map<number, {first: typeof versions[0], current?: typeof versions[0]}>();
        for(const v of versions) {
            const g = byId.get(v.id) ?? (() => {
                const g = {first: v, current: undefined as typeof versions[0]|undefined};
                byId.set(v.id, g); return g;
            })();
            if(v.valid_to === timestamp.END_OF_TIME && v.valid_from !== v.valid_to)
                g.current = v;
        }
        const rows = [...byId.values()]
            .filter(g => g.current !== undefined)
            .toSorted((a, b) => (a.current!.order_key < b.current!.order_key ? -1 : 1));

        // Open todos: TODO-marked tags (the tag table's is_todo set), not
        // done - the ACTIONABLE peer of the log, visible right where the
        // sitting works.  Plain (non-todo) tags show in the editor, not
        // here.
        const todoSlugs = tag.todoTagSlugs(this.tags);
        const tagNames = new Map(this.tags.allByOrder.all({}).map(t => [t.slug, t.name]));
        const openTodos = (this.entriesById.get(entry_id)?.tag ?? [])
            .filter(t => !t.done && todoSlugs.has(t.tag));
        const tagName = (slug: string) => tagNames.get(slug) ?? entry.todos[slug] ?? slug;
        const todoLabel = (t: entry.Tag) =>
            [t.value || undefined,
             t.tag !== 'Todo' ? `[${tagName(t.tag)}]` : undefined,
             t.assigned_to && t.assigned_to !== '___' ? `\u2192 ${entry.displayUsername(t.assigned_to)}` : undefined]
            .filter(s => s).join('  ') || tagName(t.tag);

        // Layout (dz 2026-07-10): Todos FIRST under their own title (only
        // when there are any), then the log entries with NO title (the
        // bylines make them self-evident; the old 'Log' heading + its
        // instruction line were part of the confusion).
        return ['div', {...reloadableProps([`-lexeme-log-${entry_id}-`],
                                           `/ww/wordwiki.renderLexemeLogSection(${entry_id})`),
                        id: 'wwLogSection'},
            (openTodos.length > 0 || rows.length > 0)
                ? ['div', {class: 'container ww-log-pane mt-4 pt-3 border-top'},
                   openTodos.length > 0
                       ? ['div', {class: 'ww-log-todos'},
                          ['h2', {class: 'fs-5'}, 'Todos'],
                          ['ul', {class: 'mb-1'},
                           openTodos.map(t => ['li', {}, todoLabel(t)])]]
                       : undefined,
                   rows.length === 0
                       ? undefined
                       : ['div', {class: 'ww-log-list mt-2'},
                          rows.map(g => {
                              const byline =
                                  ['span', {class: 'ww-log-byline text-muted'},
                                   entry.displayUsername(g.first.change_by_username || '?'), ' (',
                                   ['span', {title: timestamp.formatTimestampAsLocalTime(g.first.valid_from)},
                                    timestamp.formatTimestampRelative(g.first.valid_from)],
                                   '): '];
                              // Single-paragraph markdown rides the byline's
                              // line; real block markdown (lists...) sits
                              // INDENTED under it (inline rendering made
                              // blocks ragged and way in - dz).
                              const md = markdown.markdownToMarkup(g.current!.attr1 ?? '');
                              const inline = entryMeta.markdownInline(md);
                              return inline !== undefined
                                  ? ['div', {class: 'ww-log-entry mb-1'}, byline, inline]
                                  : ['div', {class: 'ww-log-entry mb-1'},
                                     ['div', {}, byline],
                                     ['div', {class: 'ww-log-body'}, md]];
                          })]]
                : undefined];
    }

    /** The floating capture dock (dz: notes are taken WHILE reviewing the
     *  word - one click away at any scroll position): a fab lower-left
     *  toggling a drawer fixed to the bottom edge.  ONE draft box; the
     *  draft survives toggling and navigate-away-and-back (sessionStorage,
     *  per word); a red dot on the fab marks an unposted draft.  Posting
     *  goes through tx (the standard mutation client) so ONLY the
     *  registered fragments refresh - usable on the editor page too.
     *  "Post as todo" is the ACTIONABLE peer (dz: tag errors as they are
     *  noticed): same capture, structured landing - a generic unassigned
     *  todo with the text as details, queued in the todo report. */
    renderLexemeLogDock(entry_id: number): any {
        if(!templates.mayEditLexemes()) return undefined;
        return [['button', {type: 'button', id: 'wwLogFab', class: 'ww-log-fab',
                            onclick: 'wwLogToggle()',
                            title: 'Log a note on this word'},
                 '\u{1F4DD}',
                 ['span', {id: 'wwLogFabDot', class: 'ww-log-fab-dot', style: 'display:none'}]],
                ['div', {id: 'wwLogDrawer', class: 'ww-log-drawer', style: 'display:none'},
                 ['textarea', {name: 'text', id: 'wwLogText', rows: '3',
                               class: 'form-control',
                               placeholder: 'Log a note on this word — posted under your name, no approval step…'}],
                 ['div', {class: 'mt-1 d-flex gap-2 align-items-center'},
                  ['button', {type: 'button', class: 'btn btn-sm btn-primary',
                              onclick: "wwLogPost('log')"}, 'Post'],
                  ['button', {type: 'button', class: 'btn btn-sm btn-outline-primary',
                              onclick: "wwLogPost('todo')",
                              title: 'File this text as a todo on this word (actionable - shows in the todo report)'},
                   'Post as todo'],
                  ['button', {type: 'button', class: 'btn btn-sm btn-link ms-auto',
                              onclick: 'wwLogToggle()'}, 'Close']]],
                ['script', {}, block`
/**/            const wwLogDraftKey = 'ww-log-draft-${entry_id}';
/**/            function wwLogToggle() {
/**/                const drawer = document.getElementById('wwLogDrawer');
/**/                const open = drawer.style.display === 'none';
/**/                drawer.style.display = open ? 'block' : 'none';
/**/                // The drawer is fixed to the bottom, so it covers the
/**/                // last stretch of content (invisible when already
/**/                // scrolled down).  Reserve exactly its height at the page
/**/                // foot while it is open, so that content can scroll clear.
/**/                document.body.style.paddingBottom =
/**/                    open ? (drawer.offsetHeight + 'px') : '';
/**/                if(open) document.getElementById('wwLogText').focus();
/**/            }
/**/            function wwLogSync() {
/**/                const text = document.getElementById('wwLogText');
/**/                const dot = document.getElementById('wwLogFabDot');
/**/                try { sessionStorage.setItem(wwLogDraftKey, text.value); } catch {}
/**/                dot.style.display = text.value.trim() !== '' ? 'block' : 'none';
/**/            }
/**/            async function wwLogPost(kind) {
/**/                const text = document.getElementById('wwLogText');
/**/                const value = text.value.trim();
/**/                if(value === '') return;
/**/                await tx\`wordwiki.postLexemeLog(\${${entry_id}}, \${value}, \${kind})\`;
/**/                text.value = '';
/**/                try { sessionStorage.removeItem(wwLogDraftKey); } catch {}
/**/                wwLogSync();
/**/            }
/**/            (function() {
/**/                const text = document.getElementById('wwLogText');
/**/                try { text.value = sessionStorage.getItem(wwLogDraftKey) || ''; } catch {}
/**/                wwLogSync();
/**/                text.addEventListener('input', wwLogSync);
/**/                addEventListener('keydown', (e) => {
/**/                    if(e.key === 'Escape') {
/**/                        const drawer = document.getElementById('wwLogDrawer');
/**/                        if(drawer.style.display !== 'none') wwLogToggle();
/**/                    }
/**/                });
/**/                addEventListener('beforeunload', (e) => {
/**/                    if(text.value.trim() !== '') {
/**/                        e.preventDefault();
/**/                        e.returnValue = '';
/**/                    }
/**/                });
/**/            })();`]];
    }

    /** Post a session-log entry (kind 'log' | 'todo') and return the
     *  standard reload directive: the word view's log section, and - when
     *  the dock sits on the LEXEME EDITOR page - the editor's own log
     *  relation fragments (targets that match nothing on a page are
     *  simply inert). */
    @routeMutation(authenticated)
    postLexemeLog(entry_id: number, text: string, kind: string = 'log'): any {
        if(!Number.isSafeInteger(entry_id)) throw new Error('bad entry_id');
        if(kind === 'todo') this.lexemeOps.postTag(entry_id, String(text ?? ''));
        else this.lexemeOps.postLog(entry_id, String(text ?? ''));
        const relTag = kind === 'todo' ? 'tdo' : 'log';
        return {action: 'reload', targets: [
            `.-lexeme-log-${entry_id}-`,
            // the lexeme editor's generic relation fragments + the
            // pending-count bar (changeKeys' scope:'parent' shape)
            `.-rel-${entry_id}-${relTag}-`,
            `.-rel-${entry_id}-${relTag}-shape-`,
            `.-entry-${entry_id}-activity-`,
        ]};
    }

    // The speaker's display label beside a recording - "Name (Region)" -
    // from the users TABLE (the publisher's twin reads the bundle's users
    // section).  Unknown usernames render as stored.
    private speakerDisplayLabel(username: string): string {
        try {
            const u = security.runSystem(() => this.users.byUsername.first({username}));
            if(u) return u.region ? `${u.name} (${u.region})` : u.name;
        } catch { /* pre-migration db */ }
        return entry.users[username] ?? username;
    }

    // The tiny lane marker (the editor's Li/SF badge vocabulary).
    private orthographyAbbr(slug: string): string {
        try {
            const row = security.runSystem(() => this.orthographies.allByOrder.all({}))
                .find(o => o.slug === slug);
            if(row) return row.abbreviation || row.name || slug;
        } catch { /* pre-migration db */ }
        return slug;
    }

    // The orthography's display name: the table is the authority, the seed
    // map the fallback, the raw slug the last resort.
    private orthographyDisplayName(slug: string): string {
        try {
            const row = this.orthographies.allByOrder.all({}).find(o => o.slug === slug);
            if(row?.name) return row.name;
        } catch { /* pre-migration db */ }
        return entry.variants[slug] ?? slug;
    }

    /** The edit pencil INSIDE the headword <h1> (trailing the glosses), so it
     *  reads as part of the title line and never drops to its own row. */
    private wordViewPencil(entry_id: number, e: entry.Entry, lens?: string): any {
        // The lens orthography beats the working lane: the question on a
        // lensed page is "is it public in THE LANE I AM LOOKING THROUGH".
        const lane = lens || this.currentWorkingOrthography() || 'mm';
        const notPublic = !this.store.publicEntryIdsIn(lane).has(entry_id)
            ? ['span', {class: 'badge border text-muted ms-2 align-middle fs-6',
                        title: 'This word is not on the public site yet'}, 'not public']
            : undefined;
        const pencil = e && templates.mayEditLexemes()
            ? ['span', {class: 'ms-2'}, templates.pencilLink(`/ww/wordwiki.wordEditor(${entry_id})`)]
            : undefined;
        return (pencil || notPublic) ? [pencil, notPublic] : undefined;
    }

    // The reference scan is a rich primitive: its scan + composed
    // reference-book link/description need a server-side lookup, so the
    // renderer takes it as an injected callback (keeps that module free of
    // the server-only deps, and lets the public export inject its own).
    private wordViewBoundingGroup(id: number): any {
        const scan = renderPageEditor.renderStandaloneGroup('/', id);
        let url = ''; try { url = renderPageEditor.pageEditorURLForBoundingGroup(id); } catch { /**/ }
        let desc = ''; try { desc = renderPageEditor.imageRefDescription(id); } catch { /**/ }
        return ['div', {},
            ['div', {class: 'lm-me-scan'}, url ? ['a', {href: url}, scan] : scan],
            desc ? ['div', {}, url ? ['a', {href: url}, desc] : desc] : ''];
    }

    /** The old side-by-side comparison page (hand renderer vs the metadata
     *  renderer), kept reachable for render tuning - the metadata renderer
     *  is the word view now. */
    @route(authenticated)
    wordViewCompare(entry_id: number): templates.Page {
        const e = this.entriesById.get(entry_id);
        const title = e ? entry.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;
        const pencil = e ? this.wordViewPencil(entry_id, e) : undefined;
        // The public renderer (.page-content-scoped public.css gives the
        // headword + gloss treatment); renderEntry leads with its own <h1>.
        const rendered: any = e
            ? entry.renderEntry({rootPath: '/', renderInternalNotes: true, glossInTitle: true}, e)
            : ['p', {class: 'text-muted'}, 'Word not found.'];
        const head = Array.isArray(rendered) ? rendered[0] : undefined;
        if(pencil && Array.isArray(head) && head[0] === 'h1')
            head.push(pencil);   // append into the h1's children
        const metaRendered: any = e
            ? entryMeta.renderEntryMeta(
                  {rootPath: '/', audience: 'internal', publicKeys: ['borrowed-word'],
                   renderBoundingGroup: this.wordViewBoundingGroup, titleAffordance: pencil},
                  this.dictSchema.relationsByTag[entry.EntryTag], e)
            : ['p', {class: 'text-muted'}, 'Word not found.'];
        const column = (label: string, content: any) =>
            ['div', {class: 'col-lg-6'},
             ['div', {class: 'text-uppercase small text-muted fw-bold mb-2 pb-1 border-bottom'}, label],
             ['div', {class: 'page-content'}, content]];
        const body = ['div', {class: 'container-fluid py-3'},
            ['div', {class: 'row g-4'},
             column('Hand renderer', rendered),
             column('Metadata renderer', metaRendered)]];
        return templates.page(title, body);
    }

    // The global change feed (see change-feed.ts).  One {}-literal query
    // argument (feedQuery) fully determines the page; a visit with no to_time
    // redirects here with it stamped, so the anchor rides in the browser URL.
    @route(authenticated)
    changes(q?: Record<string, any>): templates.Page | server.Response {
        return this.feed.changesPage(q);
    }

    // "My activity": the change feed as the logged-in user's THREADS - their
    // changes plus every comment/revert/approval that landed on top of them
    // (see change-feed.ts participating mode).  A one-click preset of the feed.
    @route(authenticated)
    myActivity(): templates.Page | server.Response {
        const me = this.currentUsername();
        return this.feed.changesPage(
            me ? {restrict_to_user: me, user_mode: 'participating'} : {});
    }

    // The monthly activity report (see activity-report.ts).  One {}-literal
    // query argument (activityQuery) fully determines the page.
    @route(authenticated)
    activity(q?: Record<string, any>): templates.Page {
        return this.activityReport.activityPage(q);
    }

    // Recently changed words (see recent-words.ts): one row per word, newest
    // change first, week-clumped; rows open the word's view-changes page.
    @route(authenticated)
    recentlyChangedWords(q?: Record<string, any>): templates.Page | server.Response {
        return this.recentWords.page(q);
    }

    @route(authenticated)
    home(): any {
        const title = "Dictionary Editor";
        const body = [
            ['h1', {}, title],

            ['br', {}],
            ['h3', {}, 'Search'],
            this.searchForm(),

            ['br', {}],
            ['h3', {}, 'Review'],
            ['ul', {},
             ['li', {}, ['a', {href:'/ww/wordwiki.myActivity()'}, 'My activity (my changes + what landed on top)']],
             ['li', {}, ['a', {href:'/ww/wordwiki.changes()'}, 'Recent changes']],
             ['li', {}, ['a', {href:'/ww/wordwiki.activity()'}, 'Monthly activity']]],

            ['br', {}],
            ['h3', {}, 'Reports'],
            ['ul', {},
             ['li', {}, ['a', {href:'/ww/wordwiki.editorReports.categoriesDirectory()'}, 'Entries by Category']],
             ['li', {}, ['a', {href:`/ww/wordwiki.editorReports.entriesByBookPageDirectory(${JSON.stringify(siteConfig.primarySourceBook)})`},
                         `Entries by ${siteConfig.primarySourceBook} Page`]],
             ['li', {}, ['a', {href:'/ww/wordwiki.spellingReports.duplicatesReport()'}, 'Duplicate Spellings']],
             ['li', {}, ['a', {href:'/ww/wordwiki.variantReports.cleanupReport()'}, 'Variant Cleanup']],
             ['li', {}, ['a', {href:'/ww/wordwiki.transliterationReports.correctionsReport()'}, 'Transliteration Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.transliterationReports.sfReadyReport()'}, 'SF-Ready Words']],
             ['li', {}, ['a', {href:'/ww/wordwiki.editorReports.archivedWords()'}, 'Archived Words']],
             ['li', {}, ['a', {href:'/ww/wordwiki.editorReports.importReport()'}, 'Import Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.editorReports.todoReport(null, null)'}, 'TODO Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.editorReports.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.editorReports.wordADayPicker()'}, 'Word-a-day Picker']],
            ],

            ['br', {}],
            ['h3', {}, 'Reference Books'],
            // Straight from the scanned_document table: another community's
            // books are a data change, not a code change.
            ['ul', {},
             selectAllScannedDocuments().all({}).map(d =>
                 ['li', {}, ['a', {href:`/ww/wordwiki.pages.pageEditor(${JSON.stringify(d.friendly_document_id)})`,
                                   title: d.title},
                             d.friendly_document_id]])],
        ];

        return templates.pageTemplate({title, body});
    }

    searchForm(search?: string): any {
        return [
            ['form', {class:'row row-cols-lg-auto g-3 align-items-center', name: 'search', method: 'get', action:'/ww/wordwiki.searchPage(query)'},

             // --- Search text row
             ['div', {class:'col-12'},
              ['label', {for:'searchText', class:'visually-hidden'}, 'Search Text'],
              ['div', {class:'input-group'},
               ['input', {type:'text',
                          class:'form-control',
                          id:'searchText', name:'searchText',
                          value:search ?? ''}]]
             ], // row

             ['div', {class:'col-12'},
              ['button', {type:'submit', class:'btn btn-primary'}, 'Search']],
            ], // form
        ];
    }


    @route(authenticated)
    searchPage(query?: {searchText?: string}): any {

        //console.info('ENTRIES', this.entries);

        const rawSearch = String(query?.searchText ?? '');


        // Extract and remove all #\B* terms (they are treated as filters and
        // handled separately)
        const filters:string[] = [];
        const search = rawSearch.replaceAll(/#c[^ ]*/g, filter=>{
            filters.push(filter);
            return ' ';
        });
        console.info('got filters', filters, 'reduced search is', search);


        // replace ' '* with .*\w
        //const searchRegexSrc = `\\b${search.replaceAll(/ /g, ' .*\\b')}`;
        const searchRegexSrc =
            search.startsWith('^') || search.startsWith('\\B') || search.startsWith('\\b')
            ? search
            : `\\b${search}`;
        const searchRegex = new RegExp(searchRegexSrc, 'i');
        console.info('SEARCH IS', search, 'REGEX IS', searchRegexSrc);

        // The pool is the editor's WORKING LANE (content presence, work in
        // progress included) - same as the category reports.  Matching still
        // looks at every lane's text of those words (an sf editor can find a
        // word by its li spelling).
        const pool = this.workingEntries();
        let matches: entry.Entry[] = [];
        if (search !== '') {
            const matchesSet:Set<entry.Entry> = new Set();
            for(const entry of pool) {
                for(const spelling of entry.spelling) {
                    if(searchRegex.test(spelling.text))
                        matchesSet.add(entry);
                }
                for(const subentry of entry.subentry) {
                    for(const gloss of subentry.gloss) {
                        if(searchRegex.test(gloss.gloss))
                            matchesSet.add(entry);
                    }
                }
            }
            matches = Array.from(matchesSet.values());
        } else {
            matches = pool;
        }

        const title = ['Query for ', search];

        // Present (and lens-link) each result in the working lane, like the
        // category listings.
        const lane = this.workingLane()?.orthography;
        function renderEntryItem(e: entry.Entry): any {
            return [
                templates.lexemeLink(e.entry_id,
                    entry.renderEntryCompactSummary(e, {orthography: lane}),
                    {viewOrthography: lane})
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Query form
            this.searchForm(search),

            // --- Results
            ['ul', {},
             matches.slice(0, 500).map(e=>['li', {}, renderEntryItem(e)]),
            ]
        ];

        return templates.pageTemplate({title, body});
    }


    /** Per-page dictionary-reference counts for one reference book (a
     *  scanned_document friendly id).  Cached per book; dropped with the
     *  projections. */
    entryCountByPage(book: string): Array<[number, number]> {
        let counts = this.#entryCountByPage.get(book);
        if(counts === undefined) {
            const documentId =
                selectScannedDocumentByFriendlyId()
                    .required({friendly_document_id: book})
                    .document_id;

            counts = db().
                all<{page_number: number, entry_count: number}>(
                    block`
/**/     SELECT pg.page_number AS page_number, COUNT(DISTINCT bg.bounding_group_id) as entry_count
/**/       FROM dict AS ref
/**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
/**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
/**/         LEFT JOIN scanned_page AS pg ON bb.page_id = pg.page_id
/**/       WHERE ref.ty = 'ref' AND
/**/             bg.document_id = :document_id AND
/**/             bb.page_id IS NOT NULL
/**/       GROUP BY pg.page_number ORDER BY pg.page_number`, {document_id: documentId}).
                map(e=>[e.page_number, e.entry_count] as [number, number]);
            this.#entryCountByPage.set(book, counts);
        }
        return counts;
    }
    
    /**
     *
     */
    // ----- LiminalApp hooks --------------------------------------------------

    get appName(): string { return 'wordwiki'; }
    // URLs live under /ww/ even though the route-scope name is 'wordwiki'.
    override get routeSegment(): string { return 'ww'; }
    // The bare /ww/ path renders the dictionary home.
    override get homeRouteExpr(): string { return 'wordwiki.home()'; }

    // Serve the published static site (and resources) from cwd; the longest-prefix
    // router lets the handler mounts (/ww/, /page/) win over this catch-all.
    async resourceContentDirs(): Promise<Record<string, string>> {
        return {'/': './'};
    }

    // wordwiki serves the whole run dir at '/' (Caddy serves the static dirs
    // directly in prod), so the default '/resources/'+'/content/' derivation
    // doesn't apply - point the asset ingestion at the run-dir subdirs
    // explicitly.  transpile.sh has already rsynced resources/ by the time the
    // server starts (wordwiki.sh), so ingestion reads the final bytes; the
    // hashed store lands in content/assets, served at /content/assets/.  This
    // fixes the "wordwiki serves stale transpiled JS" problem.
    protected override async assetIngestConfig() {
        return {resourceDir: 'resources', resourceUrlPrefix: '/resources/',
                contentRootDir: 'content', contentRootUrl: '/content/'};
    }
    override requestHandlerPaths(): Record<string, (request: server.Request) => Promise<server.Response>> {
        const handler = (request: server.Request) => this.requestHandler(request);
        return {'/ww/': handler, '/page/': handler};
    }

    // Resolve the session token into the request's security context (one trusted
    // lookup of the actor's own record, before any actor context exists).  The
    // try/catch keeps a not-yet-migrated db (no user_session table) working as
    // anonymous rather than erroring on every request.
    resolveSecurityContext(session_token: string | undefined): security.SecurityContext {
        return security.runSystem(() => {
            try {
                const session = session_token ? this.userSession.getBySessionToken.first({session_token}) : undefined;
                const actor = session ? this.users.getById(session.user_id) : undefined;
                return {
                    actorId: session?.user_id,
                    roles: security.rolesFromPermissionsField(actor?.permissions),
                    sessionToken: session?.session_token,
                };
            } catch (_e) {
                return {actorId: undefined, roles: new Set<string>()};
            }
        });
    }

    // The username (short code) of the logged-in user - stamped into
    // assertions as change_by_username.
    currentUsername(): string | undefined {
        const actorId = security.current()?.actorId;
        if(actorId === undefined) return undefined;
        try {
            return security.runSystem(() => this.users.getById(actorId).username);
        } catch (_e) {
            return undefined;
        }
    }

    // The logged-in user's WORKING ORTHOGRAPHY (fix-orthographies.md): for
    // now their user record's primary_orthography (the session-level
    // switcher is future work).  New variant-bearing content defaults its
    // orthography from this; undefined (unset) applies no default.
    currentUserPrimaryOrthography(): string | undefined {
        const actorId = security.current()?.actorId;
        if(actorId === undefined) return undefined;
        try {
            return security.runSystem(() =>
                this.users.getById(actorId).primary_orthography) || undefined;
        } catch (_e) {
            return undefined;
        }
    }

    // The session's TRANSIENT working-orthography override (dz 2026-07-09):
    // rides on the login-session row, set/cleared from the navbar switcher.
    sessionOrthographyOverride(): string | undefined {
        const token = security.current()?.sessionToken;
        if(!token) return undefined;
        try {
            return security.runSystem(() =>
                this.userSession.getBySessionToken.first({session_token: token})
                    ?.orthography_override) || undefined;
        } catch (_e) {
            return undefined;
        }
    }

    // THE working-orthography resolution (fix-orthographies.md): the
    // session override beats the user record's primary_orthography; every
    // consumer (new-tuple variant defaults, the working-site reports, the
    // editor's other-lane treatment) follows from here.
    currentWorkingOrthography(): string | undefined {
        return this.sessionOrthographyOverride() ?? this.currentUserPrimaryOrthography();
    }

    // The orthography NEW variant-bearing content defaults to: the working
    // orthography when it names a SPECIFIC lane.  The ALL ('mm') override
    // is a VIEWING mode - creation falls back to the profile lane (typing
    // wildcard-tagged content by default would be wrong).
    newContentOrthography(): string | undefined {
        const w = this.currentWorkingOrthography();
        return w && w !== 'mm' ? w : this.currentUserPrimaryOrthography();
    }

    // Set ('' clears) the session's working-orthography override - the
    // navbar switcher's plain form POST (no htmx dependency: the navbar
    // also appears on legacy-template pages).  Validated against the
    // non-retired orthography vocabulary.
    @routeMutation(authenticated)
    setOrthographyOverride(args: {orthography?: string, returnTo?: string}): server.Response {
        const orthography = args.orthography ?? '';
        const token = security.current()?.sessionToken;
        if(!token) throw new Error('no login session');
        // 'mm' is the ALL override: the multi-orthography rendering (every
        // lane on each page, with the Li/SF markers), not a table row.
        if(orthography !== '' && orthography !== 'mm') {
            const known = security.runSystem(() => this.orthographies.allByOrder.all({}))
                .some(o => o.slug === orthography && !o.retired);
            if(!known) throw new Error(`'${orthography}' is not an orthography`);
        }
        security.runSystem(() => this.userSession.setOrthographyOverride(token, orthography));
        // Back to the page the switch was made FROM, re-rendered in the new
        // orthography (dz: seeing the same result both ways is the common
        // want).  Site-relative paths only - never an open redirect.
        const returnTo = args.returnTo ?? '';
        const safe = returnTo.startsWith('/') && !returnTo.startsWith('//');
        return server.forwardResponse(safe ? returnTo : '/ww/');
    }

    // The navbar's orthography status (templates.setOrthographyStatusProvider,
    // wired in the constructor): the brand suffix, the switcher choices, and
    // the PROMINENT banner while the session override is active.
    orthographyStatus(): templates.OrthographyStatus | undefined {
        if(security.current()?.actorId === undefined) return undefined;
        try {
            const rows = security.runSystem(() => this.orthographies.allByOrder.all({}));
            const label = (slug: string) => {
                if(slug === 'mm') return {abbr: 'All', name: 'All orthographies'};
                const row = rows.find(o => o.slug === slug);
                return {abbr: row?.abbreviation || row?.name || slug,
                        name: row?.name || entry.variants[slug] || slug};
            };
            const override = this.sessionOrthographyOverride();
            const effective = this.currentWorkingOrthography();
            return {
                effective: effective
                    ? {slug: effective, abbr: label(effective).abbr} : undefined,
                override: override
                    ? {slug: override, name: label(override).name} : undefined,
                choices: [
                    ...rows.filter(o => !o.retired && o.publishable)
                        .map(o => ({slug: o.slug, name: o.name || o.slug})),
                    // The multi-orthography rendering (dz): every lane on
                    // each page, marked with the editor's Li/SF badges.
                    {slug: 'mm', name: 'All orthographies'},
                ],
            };
        } catch (_e) {
            return undefined;   // pre-migration db: no orthography table yet
        }
    }

    // Always read the db_purpose marker as a trusted op.
    getDbPurpose(): string | undefined {
        try { return security.runSystem(() => this.config.getDbPurpose()); }
        catch { return undefined; }
    }

    // Test-client durable identity lives on the login-session row.
    stampTestClientOptIn(session_token: string, now: string): void {
        this.userSession.stampTestClientOptIn(session_token, now);
    }
    stampTestClientHeartbeat(session_token: string, now: string): void {
        this.userSession.stampTestClientHeartbeat(session_token, now);
    }
    mostRecentTestClient(): TestClientSession | undefined {
        return this.userSession.mostRecentTestClient.first({});
    }

    makePage(title: any, body: any): any { return templates.page(title, body); }

    // Wrap a page() in the standard htmx document (full load) or reduce it to
    // body-only + <title> (htmx partial swap).  Legacy routes that build full
    // documents with the old pageTemplate pass through untouched.
    protected override coercePageResult(result: any, isHtmxRequest: boolean): any {
        if(templates.isPage(result))
            return isHtmxRequest
                ? [['title', {}, result.title], result.body]
                : templates.htmxPageTemplate({title: result.title, body: result.body,
                                              showTestClientLink: this.isTestDb,
                                              liveConfig: this.liveClientConfig()});
        return result;
    }

    // Where anonymous, denied requests are bounced.  The PUBLIC entry points
    // (login / loginRequest / logout) are no longer listed here - they carry
    // @route(publicRoute(...)), so the strict route interpreter lets them
    // through and only NON-public routes reach this bounce.  (The puppeteer GET
    // login shortcut - /ww/wordwiki.loginRequest(queryArgs)?username=...&password=...
    // - still works because loginRequest is publicRoute.  A GET puts the password
    // in the URL, so on PRODUCTION it is bounced to the login form by the GET
    // guard in requestHandler; on dev it goes through.)
    // The root-level /page/<Book>/<N>.html vanity endpoint is handled before this
    // gate in requestHandler and remains ungated.
    protected override loginRouteFor(requestUrl: string): string | undefined {
        return `wordwiki.login(${JSON.stringify(requestUrl)})`;
    }

    // Override so /eval server-target code sees WORDWIKI's lexical scope.
    protected override evalServer(js: string): Promise<any> {
        const wordwiki = this; // exposed to the eval'd code
        return security.runSystem(() =>
            // deno-lint-ignore no-eval
            eval(`(async () => { ${js}\n})()`));
    }

    testRuns(): Record<string, TestCase[]> { return {}; }

    // ----- Login / logout -----------------------------------------------------

    @route(publicRoute('login page — the unauthenticated entry point'))
    login(targetUrl: string, errorMessage?: string): templates.Page {
        const body = [
            ['div', {class: 'container mt-5'},
             ['div', {class: 'row justify-content-center'},
              ['div', {class: 'col-md-6 col-lg-5'},
               ['div', {class: 'card shadow'},
                ['div', {class: 'card-body p-5'},
                 ['h1', {class: 'text-center mb-2'}, siteConfig.editorName],
                 ['p', {class: 'text-center text-muted mb-4'}, siteConfig.editorSubtitle],
                 errorMessage
                     ? ['div', {class: 'alert alert-danger', role: 'alert'}, errorMessage]
                     : undefined,
                 ['form', {name: 'login', method: 'post', action: 'wordwiki.loginRequest(bodyArgs)'},
                  ['div', {class: 'form-group mb-3'},
                   ['label', {for: 'username'}, 'Username'],
                   ['input', {type: 'text', class: 'form-control', name: 'username', id: 'username',
                              placeholder: 'Your short user code (e.g. djz)', required: true}]],
                  ['div', {class: 'form-group mb-4'},
                   ['label', {for: 'password'}, 'Password'],
                   ['input', {type: 'password', class: 'form-control', name: 'password', id: 'password',
                              placeholder: 'Enter your password', required: true}]],
                  ['input', {type: 'hidden', name: 'targetUrl', value: targetUrl}],
                  ['button', {type: 'submit', class: 'btn btn-primary btn-block w-100'}, 'Sign In'],
                 ]]]]]],
        ];
        return templates.page('Login', body);
    }

    @route(publicRoute('login form submit — authenticates the user'))
    loginRequest(args: {username?: string, password?: string, targetUrl?: string}) {
        const {username, password} = args;
        const targetUrl = args.targetUrl || '/ww/';

        const reRenderWithError = (message: string) => this.login(targetUrl, message);

        if(!username) return reRenderWithError('Please enter your username');
        if(!password) return reRenderWithError('Please enter your password');

        const actor = security.runSystem(() => this.users.byUsername.first({username}));
        if(!actor || actor.disabled)
            return reRenderWithError('No account was found for that username');

        const passwordHashRecord = security.runSystem(() =>
            this.passwordHash.byUserId.first({user_id: actor.user_id}));
        const {password_salt, password_hash} = passwordHashRecord ?? {};
        if(!password_salt || !password_hash)
            return reRenderWithError('No password has been set for this account - ask an admin to set one');

        const hashedSuppliedPassword = passwordUtils.hashPassword(password, password_salt);
        if(!passwordUtils.constantTimeEqual(hashedSuppliedPassword, password_hash))
            return reRenderWithError('Incorrect password');

        return this.createSessionResponse(actor.user_id, targetUrl);
    }

    // Cookie attributes for the session cookie.  Secure on a production db
    // (served over HTTPS); dev runs on plain http://localhost.
    private sessionCookieAttrs(): string {
        const secure = this.getDbPurpose() === 'production' ? '; Secure' : '';
        return `Path=/; HttpOnly; SameSite=Lax${secure}`;
    }

    private createSessionResponse(user_id: number, targetUrl: string): server.Response {
        const now = date.currentSqliteDateTime();
        const session_token = passwordUtils.generateSessionToken();
        security.runSystem(() => this.userSession.insert({
            session_token,
            user_id,
            start_time: now,
            last_resume_time: now,
            last_ip: '', // TODO
        }));

        const response = server.forwardResponse(targetUrl);
        // Max-Age is the 400-day browser cap; the authoritative session lifetime
        // is the user_session row (deleting it ends the session regardless).
        const fourHundredDaysInSeconds = 400 * 24 * 60 * 60;
        response.headers['Set-Cookie'] =
            `${this.sessionCookieName}=${session_token}; ${this.sessionCookieAttrs()}; Max-Age=${fourHundredDaysInSeconds}`;
        return response;
    }

    @route(publicRoute('logout — clears the session; harmless when anonymous'))
    logout(session_token?: string): server.Response {
        if(session_token) {
            try { this.testClientChannel.drop(session_token); } catch (_e) { /* ignore */ }
            security.runSystem(() => this.userSession.deleteBySessionToken(session_token));
        }
        const response = server.forwardResponse('/ww/');
        response.headers['Set-Cookie'] =
            `${this.sessionCookieName}=; ${this.sessionCookieAttrs()}; Max-Age=0`;
        return response;
    }

    /**
     *
     */
    // Wordwiki keeps one root-level dynamic endpoint - the /page/<Book>/<N>.html
    // vanity URL.  Everything else under
    // /ww/ (plus shutdown/eval) is handled by the LiminalApp base, which also sets
    // the (anonymous) security context and dispatches via the shared route eval.
    override async requestHandler(request: server.Request): Promise<server.Response> {
        const filepath = decodeURIComponent(new URL(request.url).pathname);

        const pageRequest = /^(?<Page>\/page\/(?<Book>[a-zA-Z]+)\/(?<PageNumber>[0-9]+)[.]html)$/.exec(filepath);
        if(pageRequest !== null) {
            const {Book, PageNumber} = pageRequest.groups as any;
            if(typeof Book !== 'string') throw new Error('missing book');
            if(typeof PageNumber !== 'string') throw new Error('missing page number');
            const body = await pageEditor(Book, parseInt(PageNumber));
            const html = await asyncRenderToStringViaLinkeDOM(body);
            return {status: 200, headers: {}, body: html};
        }
        // Production GET guard for the login submit: loginRequest is publicRoute
        // (so the puppeteer/test single-navigation GET login shortcut works), but
        // a GET puts the password in the URL - tolerable on dev, not on the real
        // db.  Bounce a production GET at loginRequest to the login form so the
        // credentials in the query string are never read.  POST is unaffected.
        if(request.method === 'GET' &&
           /\bwordwiki\.loginRequest\b/.test(filepath) &&
           this.getDbPurpose() === 'production')
            return server.forwardResponse(`${this.routePrefix}wordwiki.login(${JSON.stringify('/ww/')})`, 303);

        return super.requestHandler(request);
    }
}


// Create the legacy raw-DML tables (both data worlds: the scanned-document
// tables and the dict assertion table).  Idempotent; the new-style liminal
// tables are created separately by WordWiki.ensureNewStyleTables().
// ensureAssertionColumns applies LATE COLUMNS to an existing dict table
// (CREATE TABLE IF NOT EXISTS adds new index lines but never new columns).
export function createAllTables() {
    db().executeStatements(allScannedDocumentSchemaDml + createAssertionDml('dict'));
    ensureAssertionColumns('dict');
}

export let wordwiki: WordWiki|undefined = undefined;

export function getWordWiki(): WordWiki {
    return wordwiki ??= new WordWiki();
}


if (import.meta.main) {
    // The CLI (serve + the import/migration pipeline subcommands) lives in
    // cli.ts.  cli.ts statically imports THIS module, so a top-level `await
    // import(...)` here would deadlock: this module would pause awaiting
    // cli.ts, which cannot finish evaluating until this module has.  .then()
    // lets this module complete first; a cliMain rejection surfaces as an
    // uncaught error (non-zero exit), same as the old inline main block.
    // wordwiki.sh still runs THIS file.
    import('./cli.ts').then(m => m.cliMain(Deno.args));
}
