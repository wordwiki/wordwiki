// deno-lint-ignore-file no-unused-vars, no-explicit-any
import * as markup from '../liminal/markup.ts';
import * as model from './model.ts';
import * as renderPageEditor from './render-page-editor.ts';
import * as server from '../liminal/http-server.ts';
import * as strings from "../liminal/strings.ts";
import * as utils from "../liminal/utils.ts";
import * as random from "../liminal/random.ts";
import {panic} from '../liminal/utils.ts';
import * as workspace from './workspace.ts';
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
import {ScannedDocument, ScannedPage, Layer, BoundingGroup, selectScannedDocumentByFriendlyId, selectBoundingBoxesForGroup, getOrCreateNamedLayer, selectScannedPageByPageNumber, allScannedDocumentSchemaDml} from './scanned-document.ts';
import {Assertion, updateAssertion, assertionPathToFields, getAssertionPath, highestTimestamp, selectAllAssertions, createAssertionDml, ensureAssertionColumns} from './assertion.ts';
import {dictSchemaJson} from "./entry-schema.ts";
import {pageEditor, PageEditorConfig, renderStandaloneGroup} from './render-page-editor.ts';
import * as pageEditorModule from './page-editor.ts';
import * as pageViewerModule from './page-viewer.ts';

import {LiminalApp, type TestClientSession, type TestCase} from '../liminal/liminal.ts';
import * as schemaUpgrade from '../liminal/schema-upgrade.ts';
import * as security from '../liminal/security.ts';
import * as passwordUtils from '../liminal/password.ts';
import * as date from '../liminal/date.ts';
import {serialize, path} from '../liminal/serializable.ts';
import {route, routeMutation, authenticated, hostOrAdmin, publicRoute} from '../liminal/security.ts';
import {lazy} from '../liminal/lazy.ts';
import {LexemeEditor} from './lexeme-editor.ts';
import {ChangeFeed} from './change-feed.ts';
import {ActivityReport} from './activity-report.ts';
import {SpellingReports} from './spelling-duplicates.ts';
import {RecentWords} from './recent-words.ts';
import {LexemeOps} from './lexeme-ops.ts';
import * as user from './user.ts';
import * as category from './category.ts';
import * as categoryImport from './category-import.ts';
import * as twitterPostImport from './twitter-post-import.ts';
import * as lexicalForm from './lexical-form.ts';
import * as instanceDir_ from './instance-dir.ts';
import * as lexicalFormImport from './lexical-form-import.ts';
import * as migrationVerify from './migration-verify.ts';
import { validateVersionedDb, assertVersionedDbValid, validateVariantInvariants,
         factViewsFromVersionedDb } from './versioned-db-validate.ts';
import { variantPolicyByTag } from './variant-policy.ts';
import { FindingsReport } from './findings.ts';
import { scanVariants, VariantReports } from './variant-scan.ts';
import { migrateVariants } from './variant-migrate.ts';
import { migrateStatus } from './status-migrate.ts';
import { TransliterationReports } from './auto-transliterate.ts';
import { repairAssertions } from './repair-assertions.ts';
import { backfillPublication } from './publication-backfill.ts';
import { normalizeShoeboxDates } from './creation-dates.ts';
import * as markdown from '../liminal/markdown.ts';

/**
 *
 */
export class WordWiki extends LiminalApp {
    routes: Record<string, any>;
    dictSchema: model.Schema;
    #workspace: VersionedDb|undefined = undefined;
    #entries: entry.Entry[]|undefined = undefined;
    #entriesById: Map<number, entry.Entry>|undefined = undefined;
    #entriesByCategory: Map<string, entry.Entry[]>|undefined = undefined;
    #publishedEntries: any|undefined = undefined;
    #publishedProjection: entry.Entry[]|undefined = undefined;
    #publishedEntriesByCategory: Map<string, entry.Entry[]>|undefined = undefined;
    #entriesByReferenceGroupId: Map<number, entry.Entry>|undefined = undefined;
    #entryCountByPage: Array<[number, number]>|undefined = undefined;
    #lastAllocatedTxTimestamp: number|undefined;
    sourceLangCollator = Intl.Collator('en'); // TODO make configurable XXX
    
    /**
     *
     */
    constructor() {
        super();

        // --- Load schema and create an empty workspace
        this.dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
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
    @route(authenticated) @path get lexicalForms() { return new lexicalForm.LexicalFormTable(this); }
    @route(authenticated) @path get orthographies() { return new orthography.OrthographyTable(this); }

    // The new-style tables (auto-created at startup; the legacy raw-DML tables
    // - scanned documents, bounding boxes, the dict assertion table - stay in
    // schema.ts).  More rabid-style tables will be added here over time.
    @lazy get tables() {
        return [this.config, this.users, this.passwordHash, this.userSession,
                this.categories, this.lexicalForms, this.orthographies];
    }

    // Create the new-style tables if missing (idempotent CREATE IF NOT EXISTS).
    // Also seeds the (tiny, fixed) orthography vocabulary - reads first, so a
    // seeded db sees no writes.
    ensureNewStyleTables() {
        for(const t of this.tables)
            db().executeStatements(t.createDMLString());
        orthography.seedOrthographies(this.orthographies);
    }

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

    // The duplicate-spelling report, reachable as wordwiki.spellings.*
    // (wordwiki.spellings.duplicatesReport()).  See spelling-duplicates.ts.
    #spellings: SpellingReports|undefined = undefined;
    @route(authenticated) @path get spellings(): SpellingReports {
        return this.#spellings ??= new SpellingReports();
    }

    // The LIVE variant-cleanup report (the language staff's triage queue,
    // drains as fixes land), reachable as wordwiki.variants.cleanupReport().
    // See variant-scan.ts VariantReports.
    #variants: VariantReports|undefined = undefined;
    @route(authenticated) @path get variants(): VariantReports {
        return this.#variants ??= new VariantReports(this);
    }

    // The transliteration corrections/accuracy report (the transliterator's
    // development loop), reachable as wordwiki.transliteration.
    // correctionsReport().  See auto-transliterate.ts.
    #transliteration: TransliterationReports|undefined = undefined;
    @route(authenticated) @path get transliteration(): TransliterationReports {
        return this.#transliteration ??= new TransliterationReports(this);
    }

    // The monthly activity report, reachable as wordwiki.report.* (page
    // alias: wordwiki.activity({months, restrict_to_user})).  See
    // activity-report.ts.
    #report: ActivityReport|undefined = undefined;
    @route(authenticated) @path get report(): ActivityReport {
        return this.#report ??= new ActivityReport(this);
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

    get lastAllocatedTxTimestamp() {
        // TODO as we add more tables, this will need to be extended.
        return this.#lastAllocatedTxTimestamp ??= highestTimestamp('dict');
    }

    allocTxTimestamps(count: number=1, opts: {quiet?: boolean} = {}) {
        const lastTxTimestamp = this.lastAllocatedTxTimestamp;
        const nextTxTimestamp = timestamp.nextTime(lastTxTimestamp);
        utils.assert(count>=1);
        this.#lastAllocatedTxTimestamp = nextTxTimestamp + count - 1;
        if(!opts.quiet)
            console.info('alloced timestamp', {last: lastTxTimestamp, next: nextTxTimestamp, next_txt: timestamp.formatTimestampAsLocalTime(nextTxTimestamp)});
        return nextTxTimestamp;
    }

    get workspace() {
        return this.#workspace ??= (()=>{

            // --- Create workspace
            const workspace = new VersionedDb([this.dictSchema]);

            // --- Do load of dictionary
            const assertions = selectAllAssertions('dict').all();
            assertions.forEach((a:Assertion)=>workspace.untrackedApplyAssertion(a));

            // --- Fail loud on a structurally broken store rather than letting
            //     derivations (and more edits) pile on top of corruption. The
            //     incremental apply above catches chain/overlap/dup-id; this
            //     adds the global/tail invariants (orphans, dangling heads,
            //     containment). Run repair-assertions / verify-workspace if it
            //     fires. (One O(n) sweep per full load - startup and post-
            //     failed-tx reload, not per edit.)
            assertVersionedDbValid(workspace);

            return workspace;
        })();
    }

    requestWorkspaceReload() {
        this.#workspace = undefined;
        this.requestEntriesJSONReload();
    }

    requestEntriesJSONReload() {
        this.#entries = undefined;
        this.#entriesByCategory = undefined;
        this.#entriesById = undefined;
        // This needs to be more complicated when publishing multiple dialects.
        this.#publishedEntries = undefined;
        this.#publishedProjection = undefined;
        this.#publishedEntriesByCategory = undefined;
        this.#entriesByReferenceGroupId = undefined;
        this.#entryCountByPage = undefined;
    }

    /**
     *
     */
    get entries(): entry.Entry[] {
        return this.#entries ??=
            new workspace.CurrentTupleQuery(this.workspace.getTableByTag('dct')).toJSON().entry;
    }

    /**
     * The PUBLISHED projection of the dictionary (publication-model.md): every
     * entry built from its published-current facts (published_to=END_OF_TIME),
     * not its valid-current facts. After the Phase 0 backfill this equals the
     * valid projection for approved data; once pending edits exist it diverges
     * (the public sees the last approved value, not the in-flight one).
     */
    get publishedProjection(): entry.Entry[] {
        return this.#publishedProjection ??=
            new workspace.PublishedTupleQuery(this.workspace.getTableByTag('dct')).toJSON().entry ?? [];
    }

    /**
     * The entries the public site renders - the COMPOSITION RULE
     * (fix-orthographies.md "Status"): the base projection is the PUBLISHED
     * one (per-fact approval), and an entry is on the site iff it is public
     * in the site's orthography - lifecycle not Archived* AND the
     * per-orthography pub gate is set (entryIsPublicIn).  Approval is used
     * while building too, so an in-progress entry may carry published facts,
     * but stays off the public site until someone makes it public.
     */
    get publishedEntries(): entry.Entry[] {
        return this.#publishedEntries ??=
            Array.from(this.publishedProjection.filter(
                e => entry.entryIsPublicIn(e, entry.PUBLIC_SITE_ORTHOGRAPHY)));
    }

    get entriesByReferenceGroupId(): Map<number, entry.Entry> {
        return this.#entriesByReferenceGroupId ??= (()=>{
            const refToEntry: Array<[number, entry.Entry]> = this.entries.flatMap(e=>e.subentry.flatMap(s=>
                s.document_reference.map(d=>[d.bounding_group_id, e] as [number, entry.Entry])));
            return new Map(refToEntry);
        })();
    }

    get entriesById(): Map<number, entry.Entry> {
        return this.#entriesById ??= (()=>
            new Map(this.entries.map(e=>[e.entry_id, e])))();
    }
    
    applyTransactions(assertions: Assertion[]) {

        // --- Partition assertions into txes by valid_from
        const txIds = assertions.map(a=>a.valid_from);
        utils.assert(txIds.join(',') === txIds.toSorted((a,b)=>a-b).join(','),
                     'assertions in a tx group must be in valid_from order');
        const transactionsById = Map.groupBy(assertions, a=>a.valid_from);

        try {
            db().transaction(()=>{
                Array.from(transactionsById.values()).forEach(a=>this.applyTransaction(a));
            });
        } catch (e) {
            // --- Request workspace reload
            this.requestWorkspaceReload();
            throw e;
        }
    }

    /**
     * This should probaly move to workspace.
     *
     */
    applyTransaction(assertions: Assertion[], opts: {quiet?: boolean} = {}) {

        if(!opts.quiet)
            console.info('Applying TX',
                         JSON.stringify(assertions, undefined, 2));

        // --- Allocate a new server timestamp for this tx
        //     TODO we may want to allocate multiple here to give client new base.
        const serverTimestamp = this.allocTxTimestamps(1, opts);

        // --- No assertions can be trivially applied (we check this
        //     because our consistency checks can't handle this case)
        if(assertions.length === 0)
            return;

        // ---- Validate that this is a single tx (all assertions have the same
        //      valid_from)
        // THIS WILL NOT BE TRUE FOR OUR NEW SAVE FEATURE, IT CONSISTS OF MULTIPLE TXes.
        // (with potential repeated writes to the same assertion).
        // HOW TO HANDLE THIS:
        //  - they will be in order - do we want to break it down into separate txes
        //    (or have that be part of the update protocol so we don't have to reverse
        //    engineer it.
        //  - do we want applying all the TXes to be one DB transaction? - if not, we can
        //    just break it down into multiple Txes and apply them separately.
        //  - this is probably fine for now (we can wrap the whole outer thing in a DB tx
        //    to ...)

        const clientTimestamp = assertions[0].valid_from;
        assertions.forEach(a=>{
            if(a.valid_from !== clientTimestamp)
                throw new Error(`All assertions in a transaction must have the same timestamp`);
            if(!(a.valid_to === timestamp.END_OF_TIME || a.valid_to === clientTimestamp))
                throw new Error(`Assertions can either be valid to the tx time (a delete tombstone) or valid till the end of time`);
        });

        try {
            // --- Rewrite client timestamps to our newly allocated server timestamp
            assertions.forEach(a=>{
                if(a.valid_from === clientTimestamp)
                    a.valid_from = serverTimestamp;
                if(a.valid_to === clientTimestamp)
                    a.valid_to = serverTimestamp;
            });

            if(!opts.quiet)
                console.info('Applying TX after advancing to server timestamp',
                             serverTimestamp,
                             JSON.stringify(assertions, undefined, 2));

            // --- Apply assertions to workspace (throwing exception if incompatible)
            // TODO swith to an apply method that gives us enough info to update the valid_to
            //      on the prev record.
            const updatedPrevAssertions =
                assertions.map(a=>this.workspace.applyProposedAssertion(a));

            // --- Apply assertions to DB (in a TX) doing some confirmation as we go.
            db().transaction(()=>{
                // Trick here is that we need prev txids - workspace can give us those.
                // Then can load them an confirm that their valid_to matches, then update.
                // We can get the whole prev anyway.
                // For now, just persist as they are.
                // TODO XXX embedding 'dict' in here is BAD (also in insert)
                updatedPrevAssertions.forEach(p=>
                    p && updateAssertion('dict', p.assertion_id, ['valid_to'], {valid_to: p.valid_to}));
                assertions.forEach(a=>
                    db().insert<Assertion, 'assertion_id'>('dict', a, 'assertion_id'));
            });

            // --- Request rebuld of entries JSON
            this.requestEntriesJSONReload();

        } catch (e) {
            // --- Request workspace reload
            this.requestWorkspaceReload();
            throw e;
        }
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
    @route(authenticated)
    wordView(entry_id: number): templates.Page {
        const e = this.entriesById.get(entry_id);
        const title = e ? entry.renderEntrySpellingsSummary(e) : `Entry ${entry_id}`;
        const rendered: any = e
            ? entryMeta.renderEntryMeta(
                  {rootPath: '/', audience: 'internal', publicKeys: ['borrowed-word'],
                   renderBoundingGroup: this.wordViewBoundingGroup,
                   titleAffordance: this.wordViewPencil(entry_id, e)},
                  this.dictSchema.relationsByTag[entry.EntryTag], e)
            : ['p', {class: 'text-muted'}, 'Word not found.'];
        return templates.page(title,
            ['div', {class: 'container py-3'},
             ['div', {class: 'page-content'}, rendered]]);
    }

    /** The edit pencil INSIDE the headword <h1> (trailing the glosses), so it
     *  reads as part of the title line and never drops to its own row. */
    private wordViewPencil(entry_id: number, e: entry.Entry): any {
        return e && templates.mayEditLexemes()
            ? ['span', {class: 'ms-2'}, templates.pencilLink(`/ww/wordwiki.wordEditor(${entry_id})`)]
            : undefined;
    }

    // The reference scan is a rich primitive: its scan + composed
    // reference-book link/description need a server-side lookup, so the
    // renderer takes it as an injected callback (keeps that module free of
    // the server-only deps, and lets the public export inject its own).
    private wordViewBoundingGroup(id: number): any {
        const scan = renderPageEditor.renderStandaloneGroup('/', id);
        let url = ''; try { url = renderPageEditor.singlePublicBoundingGroupEditorURL('/', id, ''); } catch { /**/ }
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
        return this.report.activityPage(q);
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
            // --- Add new entry button
            // ['div', {},
            //  ['button', {onclick:'imports.launchNewLexeme()'}, 'Add new Entry']],

            ['br', {}],
            ['h3', {}, 'Review'],
            ['ul', {},
             ['li', {}, ['a', {href:'/ww/wordwiki.myActivity()'}, 'My activity (my changes + what landed on top)']],
             ['li', {}, ['a', {href:'/ww/wordwiki.changes()'}, 'Recent changes']],
             ['li', {}, ['a', {href:'/ww/wordwiki.activity()'}, 'Monthly activity']]],

            ['br', {}],
            ['h3', {}, 'Reports'],
            ['ul', {},
             ['li', {}, ['a', {href:'/ww/wordwiki.categoriesDirectory()'}, 'Entries by Category']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByPDMPageDirectory()'}, 'Entries by PDM Page']],
             ['li', {}, ['a', {href:'/ww/wordwiki.spellings.duplicatesReport()'}, 'Duplicate Spellings']],
             ['li', {}, ['a', {href:'/ww/wordwiki.variants.cleanupReport()'}, 'Variant Cleanup']],
             ['li', {}, ['a', {href:'/ww/wordwiki.transliteration.correctionsReport()'}, 'Transliteration Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.todoReport(null, null)'}, 'TODO Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByTwitterPostStatus()'}, 'Twitter Post Report']],
             ['li', {}, ['a', {href:'/ww/wordwiki.wordADayPicker()'}, 'Word-a-day Picker']],
             ['li', {}, ['a', {href:'/ww/wordwiki.entriesByPronunciation()'}, 'Entries By Pronunciation']],
             //['li', {}, ['a', {href:'/ww/wordwiki.entriesByEnglishGloss()'}, 'Entries by English Gloss']],
            ],

            ['br', {}],
            ['h3', {}, 'Reference Books'],
            ['ul', {},
             ['li', {}, ['a', {href:`/ww/wordwiki.pages.pageEditor("PDM")`}, 'PDM']],
             ['li', {}, ['a', {href:`/ww/wordwiki.pages.pageEditor("Rand")`}, 'Rand']],
             ['li', {}, ['a', {href:`/ww/wordwiki.pages.pageEditor("Clark")`}, 'Clark']],
             ['li', {}, ['a', {href:`/ww/wordwiki.pages.pageEditor("PacifiquesGeography")`}, 'PacifiquesGeography']],
             ['li', {}, ['a', {href:`/ww/wordwiki.pages.pageEditor("RandFirstReadingBook")`}, 'RandFirstReadingBook']]],
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

        let matches: entry.Entry[] = [];
        if (search !== '') {
            const matchesSet:Set<entry.Entry> = new Set();
            for(const entry of this.entries) {
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
            matches = this.entries;
        }

        // if(filters.length > 0) {
        //     for(const entry of matches) {

        //     }
        // }


        // const entriesWithHouseGloss = search === '' ? [] :
        //     this.entries.filter(
        //         entry=>entry.subentry.some(
        //             subentry=>subentry.gloss.some(
        //                 gloss=>gloss.gloss.startsWith(search))));

        //console.info('entriesWithHouseGloss', JSON.stringify(entriesWithHouseGloss, undefined, 2));

        const title = ['Query for ', search];

        function renderEntryItem(e: entry.Entry): any {
            return [
                templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummary(e))
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Query form
            this.searchForm(search),

            // --- Add new entry button
            // ['div', {},
            //  ['button', {onclick:'imports.launchNewLexeme()'}, 'Add new Entry']],
            // --- Results
            ['ul', {},
             matches.slice(0, 500).map(e=>['li', {}, renderEntryItem(e)]),
            ]
        ];

        return templates.pageTemplate({title, body});
    }

    searchDocumentsForm(search?: string): any {
        return [
            ['form', {class:'row row-cols-lg-auto g-3 align-items-center', name: 'search', method: 'get', action:'/ww/wordwiki.searchDocumentsPage(query)'},

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
              ['button', {type:'submit', class:'btn btn-primary'}, 'Search Documents']],
            ], // form
        ];
    }


    @route(authenticated)
    searchDocumentsPage(query?: {searchText?: string}): any {
        throw new Error('not impl yetc');
    }

    get entriesByCategory(): Map<string, entry.Entry[]> {
        return this.#entriesByCategory ??= (()=>{
            //console.time('computing entriesByCategory');
            const entriesByCategoryArray: [string, entry.Entry][]  = 
                this.publishedEntries.flatMap(e=>e.subentry.flatMap(s=>
                    s.category.flatMap(c=>c.category).map(category=>[category, e] as [string, entry.Entry])));

            const entriesByCategory1: Map<string, [string, entry.Entry][]> =
                Map.groupBy(entriesByCategoryArray, a=>a[0])

            const entriesByCategory2: [string, entry.Entry[]][] =
                Array.from(entriesByCategory1.entries()).map(([category, ent])=>
                    [category, ent.map(e=>e[1])
                        .toSorted((a: entry.Entry, b: entry.Entry) =>
                            // TODO: pick spelling for sort better! (+locale etc)
                            this.sourceLangCollator
                                .compare((a.spelling[0]?.text)??'',
                                         (b.spelling[0]?.text)??''))]);
            
            const entriesByCategory = new Map(entriesByCategory2);
            
            //console.timeEnd('computing entriesByCategory');
            return entriesByCategory;
        })();
    }

    getEntriesForCategory(category: string): entry.Entry[] {
        return category === '' ? [] :
            this.publishedEntries.filter(
                entry=>entry.subentry.some(
                    subentry=>subentry.category.some(
                        cat=>cat.category === category)));        
    }

    getCategories0(): Map<string, number> {
        return new Map(Array.from(Map.groupBy(this.publishedEntries.
            flatMap(e=>
                e.subentry.flatMap(s=>
                    s.category.flatMap(c=>
                        c.category))), category=>category)
            .entries()).map(([category, insts]) => [category, insts.length] as [string, number])
            .toSorted((a: [string, number], b: [string, number])=>b[1]-a[1]));
    }

    getCategories(): Map<string, number> {
        return new Map(Array.from(Map.groupBy(this.publishedEntries.
            flatMap(e=>
                e.subentry.flatMap(s=>
                    s.category.flatMap(c=>
                        c.category))), category=>category)
            .entries()).map(([category, insts]) => [category, insts.length] as [string, number])
            .toSorted((a: [string, number], b: [string, number])=>
                this.sourceLangCollator
                    .compare(a[0]??'', b[0]??'')));
    }
    



    

    @route(authenticated)
    categoriesDirectory(): any {
        const title = `Categories Directory`;

        // Grouped by theme via the category table (the shared grouping:
        // themes in table order - so Internal and Old categories land at the
        // end - names sorted within).  This is the EDITOR report, so internal
        // '~' categories are shown; the public site filters them.  Values
        // with no table row (a pre-import db) trail in their own group.
        const counts = this.getCategories();
        const tabled = this.categories.allByOrder.all({}).filter(c => counts.has(c.slug));
        const tabledSlugs = new Set(tabled.map(c => c.slug));
        const untabled = Array.from(counts.keys())
            .filter(v => !tabledSlugs.has(v))
            .toSorted((a, b) => this.sourceLangCollator.compare(a, b));

        const categoryLink = (value: string, label: string) =>
            ['li', {}, ['a',
                        {href:`/ww/wordwiki.entriesForCategory(${JSON.stringify(value)})`},
                        label, ` (${counts.get(value)} entries)`]];

        const body = [
            ['h1', {}, title],
            category.groupByTheme(tabled).map(group => [
                ['h3', {}, group.theme],
                ['ul', {}, group.cats.map(c => categoryLink(c.slug, `${c.name} (${c.slug})`))],
            ]),
            untabled.length > 0
                ? [['h3', {}, 'Not in the category table'],
                   ['ul', {}, untabled.map(v => categoryLink(v, v))]]
                : undefined,
        ];

        return templates.pageTemplate({title, body});
    }

    @route(authenticated)
    todoReport(restrictToUser: string|null, restrictToTask: string|null): any {
        const userSummary = restrictToUser ? `for user "${entry.users[restrictToUser] ?? restrictToUser}"` : 'for all users';
        const taskSummary = restrictToTask ? `for task "${entry.todos[restrictToTask] ?? restrictToTask}"` : 'for all tasks';
        const title = `TODO report ${userSummary} ${taskSummary}`;

        const userPicker = ['div', {}, ['b', {}, 'Assigned To: '],
                            Object.entries(entry.users).map(([user_id, user_name])=>
                                [['a', {href:`/ww/wordwiki.todoReport(${JSON.stringify(user_id)}, ${JSON.stringify(restrictToTask)})`}, user_id], ' / ']),
                            ['a', {href:`/ww/wordwiki.todoReport(null, ${JSON.stringify(restrictToTask)})`}, 'ALL USERS']];

        const taskPicker = ['div', {}, ['b', {}, 'Task Kind: '],
                            Object.entries(entry.todos).map(([todo_id, todo_name])=>
                                [['a', {href:`/ww/wordwiki.todoReport(${JSON.stringify(restrictToUser)}, ${JSON.stringify(todo_id)})`}, todo_name], ' / ']),
                            ['a', {href:`/ww/wordwiki.todoReport(${JSON.stringify(restrictToUser)}, null)`}, 'ALL TASKS']];

        const entriesForTODO = this.getEntriesForTODO(restrictToUser, restrictToTask);
        
        const body = [
            ['h1', {}, title],
            userPicker,
            taskPicker,
            ['br', {}],
            ['ul', {},
             entriesForTODO.map(e=>
                 ['li', {},
                  templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummary(e))])]];

        return templates.pageTemplate({title, body});
    }

    getEntriesForTODO(restrictToUser: string|null, restrictToTask: string|null): entry.Entry[] {
        return this.entries.filter(
            entry=>
                entry.todo.some(todo=>
                    !todo.done &&
                    (restrictToTask == null || todo.todo === restrictToTask) &&
                    (restrictToUser == null || todo.assigned_to === restrictToUser)));
    }
    
    variantReport(): any {
        
        function findAllVariantFieldValues(entry: Record<string, any>,
                                           v: Record<string, any>,
                                           variants: Set<string>) {
            const variant = v['variant'];
            if(variant) {
                variants.add(variant);
                if(variant !== 'mm-li' && variant !== 'mm-sf')
                    console.info('VARIANT:', variant, typeof variant, entry);
            }
            for(const [key, val] of Object.entries(v)) {
                //console.info('CONSIDERING', key, val);
                if(Array.isArray(val))
                    val.forEach(a=>findAllVariantFieldValues(entry, a, variants));
                else if(val != null && utils.isObjectLiteral(val))
                    findAllVariantFieldValues(entry, val, variants);
            }
        }

        const variants = new Set<string>();
        this.entries.forEach(entry=>findAllVariantFieldValues(entry, entry, variants));
        
        const title = 'Variant Report';
        const body = ['div', {}, 'Variant report',
                      ['ul', {},
                       Array.from(variants.values()).map(v=>['li', {}, v])
                      ],
                     ];
        
        return templates.pageTemplate({title, body});
    }

    @route(authenticated)
    entriesForCategory(category?: string): any {
        category = String(category ?? '');

        const entriesForCategory = this.getEntriesForCategory(category);
        const title = ['Entries for category ', category];
        
        function renderEntryItem(e: entry.Entry): any {
            return [
                templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummary(e), {pencil: false})
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesForCategory
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }
    
    @route(authenticated)
    entriesByTwitterPostStatus(): any {
        
        function getTwitterPostStatusForEntry(e: entry.Entry): string|undefined {
            return e.subentry.flatMap(s=>
                s.attr.filter(a=>a.attr=='twitter-post').map(a=>a.value))[0];
        }
        
        function renderEntryItem(e: entry.Entry): any {
            return [
                (getTwitterPostStatusForEntry(e) ?? 'Not posted on twitter'),
                ' -- ', 
                templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummaryCore(e), {pencil: false})
            ];
        }

        const entriesByTwitterPostStatus =
            this.entries.toSorted((a: entry.Entry, b: entry.Entry)=> {
                const atwit = getTwitterPostStatusForEntry(a);
                const btwit = getTwitterPostStatusForEntry(b);
                if(atwit == btwit)
                    return 0
                if(atwit == undefined)
                    return 1;
                if(btwit == undefined)
                    return -1;
                return this.sourceLangCollator
                    .compare(atwit, btwit)
            });

        const title = "Entries by Twitter Post Status";
        const body = [
            ['h2', {}, title],
            ['div', {class: 'mb-2'},
             ['a', {href: '/ww/wordwiki.wordADayPicker()'},
              'Looking for a word to post?  The word-a-day picker']],

            ['div', {},
             ['ul', {},
              entriesByTwitterPostStatus
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }

    /** Is this entry already posted as a word-a-day (twitter/bluesky)?  The
     *  poster stamps the twitter-post attribute with a date; for the picker
     *  any non-empty value counts (same semantics as the twitter report:
     *  any subentry's attribute marks the whole word). */
    static isTwitterPosted(e: entry.Entry): boolean {
        return e.subentry.some(s =>
            s.attr.some(a => a.attr === 'twitter-post' && String(a.value ?? '').trim() !== ''));
    }

    /** The word-a-day picker: the whole category tree with every
     *  not-yet-posted PUBLIC word inline, so the poster (~20 years of
     *  word-a-day, ~3.8k words posted) can browse candidates by theme
     *  instead of hunting.  Runs off the in-memory publishedEntries model -
     *  the same pool and per-category sorted lists as the other category
     *  reports, so a picked word is always a finished, publicly visible
     *  one.  A word in several categories appears under EACH (a thematic
     *  picker wants that); the header counts distinct words.  Words with no
     *  category land in a final Uncategorized bucket so they stay pickable.
     *  Stamping twitter-post in the editor drops the word on next load. */
    @route(authenticated)
    wordADayPicker(): any {
        const title = 'Word-a-day picker';
        const unpostedIds = new Set(this.publishedEntries
            .filter(e => !WordWiki.isTwitterPosted(e)).map(e => e.entry_id));

        const byCat = new Map<string, entry.Entry[]>();
        for(const [cat, entries] of this.entriesByCategory.entries()) {
            const un = entries.filter(e => unpostedIds.has(e.entry_id));
            if(un.length > 0) byCat.set(cat, un);
        }
        const uncategorized = this.publishedEntries
            .filter(e => unpostedIds.has(e.entry_id)
                         && e.subentry.every(s => s.category.length === 0))
            .toSorted((a, b) => this.sourceLangCollator.compare(
                a.spelling[0]?.text ?? '', b.spelling[0]?.text ?? ''));

        // Theme grouping via the category table, like categoriesDirectory;
        // values with no table row trail in their own group.
        const tabled = this.categories.allByOrder.all({}).filter(c => byCat.has(c.slug));
        const tabledSlugs = new Set(tabled.map(c => c.slug));
        const untabled = Array.from(byCat.keys())
            .filter(v => !tabledSlugs.has(v))
            .toSorted((a, b) => this.sourceLangCollator.compare(a, b));
        const groups = category.groupByTheme(tabled);

        const anchor = (slug: string) => `cat-${slug}`;
        const indexLink = (slug: string, name: string) =>
            [['a', {class: 'text-nowrap', href: `#${encodeURIComponent(anchor(slug))}`},
              `${name} (${byCat.get(slug)!.length})`], ' '];
        const wordList = (entries: entry.Entry[]) =>
            ['ul', {class: 'list-unstyled ms-3 mb-4'},
             entries.map(e => ['li', {},
                 templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummaryCore(e), {pencil: false})])];
        const catSection = (slug: string, name: string) => [
            ['h4', {id: anchor(slug), class: 'mt-3'}, name, ' ',
             ['span', {class: 'text-muted fs-6'}, `(${byCat.get(slug)!.length})`]],
            wordList(byCat.get(slug)!)];

        const body = [
            ['h1', {}, title],
            ['div', {class: 'mb-3'},
             `${unpostedIds.size} public words not yet posted.  `,
             ['a', {href: '/ww/wordwiki.entriesByTwitterPostStatus()'},
              'Words already posted']],

            // The jump index: every category with its unposted count.
            ['div', {class: 'mb-4'},
             groups.map(g => ['div', {},
                 ['b', {}, g.theme, ': '],
                 g.cats.map(c => indexLink(c.slug, c.name))]),
             untabled.length > 0
                 ? ['div', {}, ['b', {}, 'Not in the category table: '],
                    untabled.map(v => indexLink(v, v))]
                 : undefined,
             uncategorized.length > 0
                 ? ['div', {}, ['a', {href: '#uncategorized-words'},
                    `Uncategorized (${uncategorized.length})`]]
                 : undefined],

            groups.map(g => [
                ['h3', {class: 'mt-4'}, g.theme],
                g.cats.map(c => catSection(c.slug, c.name))]),
            untabled.length > 0
                ? [['h3', {class: 'mt-4'}, 'Not in the category table'],
                   untabled.map(v => catSection(v, v))]
                : undefined,
            uncategorized.length > 0
                ? [['h3', {id: 'uncategorized-words', class: 'mt-4'}, 'Uncategorized ',
                    ['span', {class: 'text-muted fs-6'}, `(${uncategorized.length})`]],
                   wordList(uncategorized)]
                : undefined,
        ];

        return templates.pageTemplate({title, body});
    }

    @route(authenticated)
    entriesByPronunciation(): any {
        throw new Error('no working yet');
       const entriesByPronunciation = utils.multi_partition_by(
           this.entries,
           e=>e.subentry.flatMap(s=>s.pronunciation_guide.flatMap(p=>p.pronunciation_guide)));
                                             
       const entriesByPronunciationSorted =
           new Map(Array.from(entriesByPronunciation.entries()).
           toSorted((a, b) =>
               this.sourceLangCollator.compare(a[0], b[0])));
           
       

       //console.info('SORTED', entriesByPronunciationSorted);
       Array.from(entriesByPronunciationSorted.entries()).forEach((pronunciation, entries) => console.info('pron', pronunciation, 'entries', entries));
        // function renderEntryItem(e: entry.Entry): any {
        //     return [
        //         (getTwitterPostStatusForEntry(e) ?? 'Not posted on twitter'),
        //         ' -- ', 
        //         ['a', {href: `/ww/wordwiki.entry(${e.entry_id})`}, entry.renderEntryCompactSummaryCore(e)]
        //     ];
        // }

        const title = "Entries by Pronunciation";
        const body = [
            ['h2', {}, title],

            ['div', {},
             ['ul', {},
              Array.from(entriesByPronunciationSorted.entries()).map((pronunciation, entries) => ['li', {}, pronunciation])
             ], // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }
    
    @route(authenticated)
    entriesByEnglishGloss(): any {
    }
    
    
    // entriesByStatusDirectory(): any {
    //     const title = `Entries By Status`;

    //     const cats: [string, number][] = Array.from(Map.groupBy(this.entries.
    //         flatMap(e=>
    //             e.status.flatMap(s=>s.status))), e=>e)
    //             .toSorted((a: [string, number], b: [string, number])=>b[1]-a[1]);


    //     const body = [
    //         ['h1', {}, title],
    //         ['ul', {},
    //          cats.map(cat=>
    //              ['li', {}, ['a',
    //                          {href:`/ww/wordwiki.entriesForStatus(${JSON.stringify(cat[0])})`},
    //                          cat[0], ` (${cat[1]} entries)`]]),
    //         ]
    //     ];

    //     return templates.pageTemplate({title, body});
    // }

    @route(authenticated)
    entriesForStatus(status?: string): any {
        status = String(status ?? '');

        const entriesForStatus = status === '' ? [] :
            this.entries.filter(
                entry=>entry.status.some(
                    s=>s.status === status));
        const title = ['Entries for status ', status];

        function renderEntryItem(e: entry.Entry): any {
            return [
                templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummary(e), {pencil: false})
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesForStatus
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }


    emptyBoundingBoxes(): any {

    }

    entriesWithProblem(): any {
        const title = `Entries With empty example translation`;

        const entriesWithProblem =
            this.entries.filter(
                entry=>entry.subentry.some(
                    subentry=>subentry.example.some(
                        example=>example.example_translation.some(
                            example_translation=>example_translation.example_translation === ''))));

        function renderEntryItem(e: entry.Entry): any {
            return [
                templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummary(e))
            ];
        }

        const body = [
            ['h2', {}, title],

            // --- Add new entry button
            ['div', {},
             ['ul', {},
              entriesWithProblem
                  .map(e=>['li', {}, renderEntryItem(e)]),
             ] // ul
            ] // div
        ];

        return templates.pageTemplate({title, body});
    }

    get entryCountByPage(): Array<[number, number]> {
        return this.#entryCountByPage ??= (()=>{
            const pdmDocumentId =
                selectScannedDocumentByFriendlyId()
                    .required({friendly_document_id: 'PDM'})
                    .document_id;

            //console.time('entryCountByPage');
            const entryCountByPage = db().
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
/**/       GROUP BY pg.page_number ORDER BY pg.page_number`, {document_id: pdmDocumentId});
            //console.timeEnd('entryCountByPage');

            //console.info('entryCountByPage', entryCountByPage);
            return entryCountByPage.map(e=>[e.page_number, e.entry_count]);
        })();
    }
    
    @route(authenticated)
    entriesByPDMPageDirectory(): any {
        const title = `Entries by PDM Page Directory`;

//         const pdmDocumentId =
//             selectScannedDocumentByFriendlyId()
//                 .required({friendly_document_id: 'PDM'})
//                 .document_id;

//         console.time('entryCountByPage');
//         const entryCountByPage = db().
//             all<{page_number: number, entry_count: number}>(
//                 block`
// /**/     SELECT pg.page_number AS page_number, COUNT(DISTINCT bg.bounding_group_id) as entry_count
// /**/       FROM dict AS ref
// /**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
// /**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
// /**/         LEFT JOIN scanned_page AS pg ON bb.page_id = pg.page_id
// /**/       WHERE ref.ty = 'ref' AND
// /**/             bg.document_id = :document_id AND
// /**/             bb.page_id IS NOT NULL
// /**/       GROUP BY pg.page_number ORDER BY pg.page_number`, {document_id: pdmDocumentId});
//         console.timeEnd('entryCountByPage');

        //const entryCountByPageMap = Map.fromEntr

        
        // console.info('entryCountByPage', entryCountByPage);

        const entryCountByPage = this.entryCountByPage;
        
        const body = [
            ['h1', {}, title],
            ['ul', {},
             entryCountByPage.map(([page_number, entry_count])=>
                 ['li', {},
                  ['a', {href:`/ww/wordwiki.entriesByPDMPage(${page_number})`},
                   `PDM page ${page_number} has ${entry_count} entries`]
                 ])
            ]
        ];

        return templates.pageTemplate({title, body});
    }

    @route(authenticated)
    entriesByPDMPage(page_number: number): any {
        typeof page_number === 'number' || panic('expected page number');

        const title = `Entries for PDM Page ${page_number}`;

        const pdmDocumentId =
            selectScannedDocumentByFriendlyId()
                .required({friendly_document_id: 'PDM'})
                .document_id;

        const pdmPageId =
            selectScannedPageByPageNumber()
                .required({document_id: pdmDocumentId, page_number}).page_id;

        console.time('entriesInDocRefOrder');
        // TODO XXX the page_number returned here is pointless now that this
        //          is locked to a single page.
        const entriesInDocRefOrder = db().
            all<{x: number, bounding_group_id: number, entry_id: number}, {page_id: number}>(
                block`
/**/     SELECT DISTINCT bg.bounding_group_id AS bounding_group_id, ref.id1 AS entry_id
/**/       FROM dict AS ref
/**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
/**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
/**/       WHERE ref.valid_to = 9007199254740991 AND
/**/             ref.ty = 'ref' AND
/**/             bb.page_id = :page_id
/**/       ORDER BY bb.y, bb.x, ref.id1`, {page_id: pdmPageId});


//         const entriesInDocRefOrder = db().
//             all<{page_number: number, x: number, bounding_group_id: number, entry_id: number}, {document_id:number}>(
//                 block`
// /**/     SELECT DISTINCT pg.page_number AS page_number, bg.bounding_group_id AS bounding_group_id, ref.id1 AS entry_id
// /**/       FROM dict AS ref
// /**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
// /**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
// /**/         LEFT JOIN scanned_page AS pg ON bb.page_id = pg.page_id
// /**/       WHERE ref.ty = 'ref' AND
// /**/             pg.page_number = :page_number AND
// /**/             bg.document_id = :document_id
// /**/       ORDER BY pg.page_number, bb.y, bb.x, ref.id1`, {document_id: pdmDocumentId});
        console.timeEnd('entriesInDocRefOrder');

        console.info('entriesForPageInDocRefOrder', entriesInDocRefOrder);

        const entriesById = new Map(this.entries.map(entry=>[entry.entry_id, entry]));

        function renderRef(ref: {bounding_group_id: number, entry_id: number}): any {
            const e = entriesById.get(ref.entry_id)
                ?? panic('unable to find entry with id', ref.entry_id);
            const r = e.subentry.flatMap(s=>s.document_reference)
                .find(r=>ref.bounding_group_id === r.bounding_group_id)
                ?? panic('unable to find reference', ref.bounding_group_id);
            return [
                renderStandaloneGroup('/', ref.bounding_group_id),
                templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummary(e)),
                ['table', {},
                 ['tbody', {},
                  r.transcription.map(t=>['tr', {}, ['th', {}, 'Transcription:'], ['td', {}, t.transcription]]),
                  r.expanded_transcription.map(t=>['tr', {}, ['th', {}, 'Expanded:'], ['td', {}, t.expanded_transcription]]),
                  r.transliteration.map(t=>['tr', {}, ['th', {}, 'Transliteration:'], ['td', {}, t.transliteration]]),
                  // $markdown fields (dictSchemaJson), as in renderDocumentReference.
                  r.note.map(t=>['tr', {}, ['th', {}, 'Note:'], ['td', {}, markdown.markdownToMarkup(t.note)]]),
                  r.public_note.map(t=>['tr', {}, ['th', {}, 'Public Note:'], ['td', {}, markdown.markdownToMarkup(t.public_note)]]),
                  r.source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Source as entry:'], ['td', {}, t.source_as_entry]]),          
                  r.normalized_source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Normalized source as entry:'], ['td', {}, t.normalized_source_as_entry]]),
                  r.foreign_reference.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Foreign reference:'], ['td', {}, t.foreign_reference]]),
                  
                  
                 ]]
            ];
        }

        const body = [
            ['h1', {}, title],
            entriesInDocRefOrder.map(ref=>['li', {}, renderRef(ref)])
        ];

        return templates.pageTemplate({title, body});
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

    // THE working-orthography resolution (fix-orthographies.md): today the
    // user record's primary_orthography; when the session-level switcher
    // lands it resolves session ?? primary here, and every consumer (variant
    // defaults, the editor's other-lane dimming) follows for free.
    currentWorkingOrthography(): string | undefined {
        return this.currentUserPrimaryOrthography();
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
                 ['h1', {class: 'text-center mb-2'}, 'MMO Editor'],
                 ['p', {class: 'text-center text-muted mb-4'}, `The Mi'gmaq-Mi'kmaq Online dictionary editor`],
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
    const args = Deno.args;
    const command = args[0];
    const ww = getWordWiki();
    switch(command) {
        case 'serve': {
            const port = Number(Deno.env.get('WORDWIKI_PORT') ?? '9000');
            const instanceDir = Deno.cwd();

            // Verify the instance is actually set up (don't silently serve an
            // empty/mis-pointed dir), then take the db write-lock.
            const {errors, warnings} = instanceDir_.checkInstanceStores(instanceDir);
            for(const w of warnings) console.warn(`WARNING: instance store ${w}`);
            if(errors.length > 0) {
                console.error(`wordwiki instance dir '${instanceDir}' is not set up - refusing to start:`);
                for(const e of errors) console.error(`  ${e}`);
                Deno.exit(1);
            }
            instanceDir_.acquireDbLock(instanceDir);

            // Both are idempotent (all IF NOT EXISTS): createAllTables also
            // APPLIES NEW INDEX LINES to an existing db - without it a new
            // index in createAssertionDml never reaches long-lived instances
            // (this bit the fixed valid_to partial indexes once already).
            security.runSystem(() => { ww.ensureNewStyleTables(); createAllTables(); });

            // Announce exactly which instance/db/port we are on (so a glance at
            // the log catches "I thought this was the dev/prod instance").
            console.info(`wordwiki serving:`);
            console.info(`  instance dir : ${instanceDir}`);
            console.info(`  database     : ${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()}  [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`);
            console.info(`  port         : ${port}`);

            // Legacy-template pages don't go through coercePageResult, so the
            // navbar's test-client-link default is set once here instead.
            templates.setDefaultShowTestClientLink(ww.isTestDb);
            ww.startServer({hostname: 'localhost', port,
                            allowSchemaMismatch: args.includes('--allow-schema-mismatch')});
            break;
        }

        // Compare the db against the declared (new-style) table model; with
        // --apply, bring it up to date (additive changes only - see
        // liminal/schema-upgrade.ts; a backup is taken first).  The legacy
        // raw-DML tables (scanned documents, dict, ...) are not covered: they
        // show up as ignorable notes.  Stop the server before --apply.
        case 'upgrade-db': {
            const code = security.runSystem(() =>
                schemaUpgrade.upgradeDbCommand(ww.tables, args.slice(1)));
            Deno.exit(code);
            break;
        }

        // One-time migration: replace the old (never-used) raw-DML user table
        // with the new liminal-style one and seed it from the hardcoded users
        // map in entry-schema.ts.  Refuses if the old table has rows.
        case 'upgrade-users': {
            security.runSystem(() => {
                const userCount = (() => {
                    try { return db().prepare<{n: number}, {}>('SELECT COUNT(*) AS n FROM user').required({}).n; }
                    catch (_e) { return 0; }  // no user table at all
                })();
                const hasNewShape = (() => {
                    try { db().prepare('SELECT permissions FROM user LIMIT 1').all({}); return true; }
                    catch (_e) { return false; }
                })();
                if(userCount > 0 && !hasNewShape)
                    throw new Error(`user table has ${userCount} rows but the OLD schema - migrate manually`);
                if(!hasNewShape) {
                    console.info('dropping old-style empty user table');
                    db().execute('DROP TABLE IF EXISTS user', {});
                }
                ww.ensureNewStyleTables();
                const {inserted, skipped} = user.seedUsersFromEntrySchema(ww.users);
                const pw = user.seedPasswordsFromFile(ww.users, ww.passwordHash,
                    new URL('../user-passwords.json', import.meta.url).pathname);
                console.info(`user table upgraded: ${inserted} users seeded, ${skipped} already present, ` +
                             `${pw.set} passwords seeded (${pw.kept} already set)`);
                console.info('set a password with: wordwiki.ts set-password <username> <password>');
            });
            Deno.exit(0);
            break;
        }

        // Set (or replace) a user's password.  Run with the server stopped
        // (SQLite single writer).
        case 'set-password': {
            const [username, password] = [args[1], args[2]];
            if(!username || !password)
                throw new Error('usage: set-password <username> <password>');
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const u = ww.users.byUsername.first({username})
                    ?? panic(`no user with username '${username}' (run upgrade-users first?)`);
                ww.passwordHash.setPassword(u.user_id, password);
                console.info(`password set for ${u.name} (${username})`);
            });
            Deno.exit(0);
            break;
        }

        // Everything a freshly-pulled PRODUCTION db needs to run as the dev
        // db: upgrade/seed the user table (production still has the old empty
        // one), seed passwords from user-passwords.json, and mark the db
        // 'dev'.  Re-run after every pull until the new version IS production.
        //   ./wordwiki.sh post-pull
        // Stop the server and nothing else.  (wordwiki.sh stops any running
        // server before dispatching ANY command, so by the time we get here
        // the work is done - this command just gives the stop a name for
        // scripts like importWordWikiV1Db.sh.)
        case 'stop':
            console.info('server stopped (if one was running)');
            Deno.exit(0);
            break;

        case 'post-pull': {
            security.runSystem(() => {
                // Same logic as upgrade-users: replace an old-shape (empty)
                // user table, create anything missing, seed from the
                // entry-schema users map (idempotent - existing rows kept).
                const hasNewShape = (() => {
                    try { db().prepare('SELECT permissions FROM user LIMIT 1').all({}); return true; }
                    catch (_e) { return false; }
                })();
                if(!hasNewShape) {
                    const userCount = (() => {
                        try { return db().prepare<{n: number}, {}>('SELECT COUNT(*) AS n FROM user').required({}).n; }
                        catch (_e) { return 0; }
                    })();
                    if(userCount > 0)
                        throw new Error(`user table has ${userCount} rows but the OLD schema - migrate manually`);
                    console.info('dropping old-style empty user table');
                    db().execute('DROP TABLE IF EXISTS user', {});
                }
                ww.ensureNewStyleTables();
                const {inserted, skipped} = user.seedUsersFromEntrySchema(ww.users);
                // Everyone (including the 'test' user) keeps the password
                // from the (never-checked-in) user-passwords.json - fills in
                // only users with no password yet.
                const pw = user.seedPasswordsFromFile(ww.users, ww.passwordHash,
                    new URL('../user-passwords.json', import.meta.url).pathname);
                ww.config.setDbPurpose('dev');
                console.info(`post-pull complete: ${inserted} users seeded (${skipped} already present), ` +
                             `${pw.set} passwords seeded (${pw.kept} already set), db marked 'dev'`);
            });
            Deno.exit(0);
            break;
        }

        // Import the batch re-categorization (see categorization/ and
        // category-import.ts): seed the category table (new scheme + internal
        // + retired ~old-*) and rewrite every entry's category tuples via
        // applyTransaction.  Idempotent - re-run freely after pulls; entries
        // already in the desired state are skipped.  This is the prototype
        // for the eventual production import, so it refuses a production-
        // marked db unless --allow-production is given.
        //   ./wordwiki.sh import-categories [categorization-dir]
        //                  [--username=NAME] [--allow-production]
        case 'import-categories': {
            const dir = args.find((a, i) => i >= 1 && !a.startsWith('--'))
                ?? new URL('../categorization', import.meta.url).pathname;
            // Stamped with the reserved automation identity by default
            // (history UI collapses '~' authors; restore refuses to cross
            // the migration) - --username=NAME for a human-attributed run.
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? '~category-import';
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                user.seedUsersFromEntrySchema(ww.users);   // the system users ride along post-pull
                if(!ww.users.byUsername.first({username}))
                    throw new Error(`--username '${username}' is not in the user table`);
                const schemeText = Deno.readTextFileSync(`${dir}/scheme.md`);
                const assignmentsText = Deno.readTextFileSync(`${dir}/assignments.jsonl`);
                const stats = categoryImport.importCategories(ww, {
                    schemeText, assignmentsText, username,
                    log: (msg) => console.info(msg),
                });
                // The idempotency proof for the migration recipe: a re-run
                // against an already-migrated db must be a pure no-op.
                if(args.includes('--expect-no-changes')) {
                    const changes = stats.rewrite.entriesRewritten
                        + stats.seed.seededNew + stats.seed.seededInternal + stats.seed.seededOld
                        + stats.mute.valuesRenamed;
                    if(changes > 0)
                        throw new Error(`--expect-no-changes: the import made ${changes} changes - ` +
                                        'the previous run did not reach the fixed point');
                    console.info('idempotency confirmed: re-run made no changes');
                }
            });
            Deno.exit(0);
            break;
        }

        // Backfill the twitter-post attribute from the retired legacy Shoebox
        // dump (word-a-day kept being posted there for ~2 years post-retirement;
        // see twitter-post-import.ts).  Matches each legacy lexeme to a current
        // entry by Listuguj spelling and adds a twitter-post to unambiguous
        // matches that lack one; homonyms/unmatched are skipped and logged.
        // Idempotent (re-run adds nothing); refuses production without
        // --allow-production.  Runs BEFORE backfill-publication so the new
        // rows get born-approved.
        //   ./wordwiki.sh import-twitter-posts [legacy-file]
        //                  [--username=NAME] [--allow-production] [--expect-no-changes]
        case 'import-twitter-posts': {
            const file = args.find((a, i) => i >= 1 && !a.startsWith('--'))
                ?? new URL('../legacy-mmo.txt', import.meta.url).pathname;
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? twitterPostImport.TWITTER_POST_IMPORT_USER;
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                user.seedUsersFromEntrySchema(ww.users);   // the ~ import identities ride along
                if(!ww.users.byUsername.first({username}))
                    throw new Error(`--username '${username}' is not in the user table`);
                const legacyText = Deno.readTextFileSync(file);
                const stats = twitterPostImport.importTwitterPosts(ww, legacyText, {
                    username, log: (msg) => console.info(msg),
                });
                // --report-skipped=<file>: (re)write the hand-off list of the
                // homonyms/unmatched a human must place in production, with
                // live links to the production editor.  Regenerated every
                // migrate so the committed skipped-twitter-posts.md tracks the
                // shrinking list.
                const reportPath = args.find(a => a.startsWith('--report-skipped='))
                    ?.slice('--report-skipped='.length);
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, twitterPostImport.renderSkippedReport(stats));
                    console.info(`wrote skipped-post report (${stats.ambiguous + stats.unmatched} entries) to ${reportPath}`);
                }
                if(args.includes('--expect-no-changes')) {
                    if(stats.added > 0)
                        throw new Error(`--expect-no-changes: the import added ${stats.added} twitter-posts`);
                    console.info('idempotency confirmed: re-run made no changes');
                }
            });
            Deno.exit(0);
            break;
        }

        // Read-only post-migration sanity checks (see migration-verify.ts);
        // exit 1 on violated invariants.  [dir] supplies scheme.md for the
        // exact scheme-vs-table check (defaults like import-categories).
        // Idempotent structural repairs of the assertion store (repair-
        // assertions.ts): fixes corruption surfaced by verify-workspace -
        // currently dangling chain heads. A no-op on a clean db, so it rides
        // in the repeatable migration flow (importWordWikiV1Db.sh). Refuses a
        // production db without --allow-production, like the imports.
        case 'repair-assertions': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                const stats = repairAssertions({log: (m) => console.info(m)});
                console.info(`repair-assertions: ${stats.danglingChainHeadsFixed} dangling chain head(s) fixed, ` +
                             `${stats.legacyPublishedPlaceholdersCleared} legacy published placeholder row(s) cleared, ` +
                             `${stats.orphanedChildrenTombstoned} orphaned live child(ren) tombstoned`);
            });
            Deno.exit(0);
            break;
        }

        // Phase 0 of the publication model (publication-backfill.ts): born-approve
        // the existing accepted state - the current live fact of every chain,
        // whatever its entry's status (the cutover blesses the whole offline-
        // approved dictionary) - by mute-in-place (no approval rows). Idempotent;
        // refuses production without --allow-production. --expect-no-changes
        // proves a re-run is a no-op.
        case 'backfill-publication': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                const stats = backfillPublication({log: (m) => console.info(m),
                                                   config: ww.config});
                if(args.includes('--expect-no-changes')) {
                    if(stats.bornApproved > 0)
                        throw new Error(`--expect-no-changes: the backfill born-approved ${stats.bornApproved} facts`);
                    console.info('idempotency confirmed: re-run made no changes');
                }
            });
            Deno.exit(0);
            break;
        }

        // Normalize the legacy shoebox-date attribute values to ISO yyyy-mm-dd
        // (creation-dates.ts): the imported lexemes' creation dates, made
        // machine-readable in place (mute-in-place like the backfill - no new
        // assertion rows; superseded versions keep their original text).
        // Idempotent; refuses production without --allow-production.
        // --expect-no-changes proves a re-run is a no-op.
        case 'normalize-shoebox-dates': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                const stats = normalizeShoeboxDates({log: (m) => console.info(m)});
                if(args.includes('--expect-no-changes')) {
                    if(stats.normalized > 0)
                        throw new Error(`--expect-no-changes: normalized ${stats.normalized} shoebox dates`);
                    console.info('idempotency confirmed: re-run made no changes');
                }
            });
            Deno.exit(0);
            break;
        }

        // Structural validation of the persisted versioned model (read-only):
        // load the whole dict into the workspace and run the invariant sweep
        // (versioned-db-validate.ts). Exit 1 on any problem.
        // The variant (orthography) invariants run too, but in WARN MODE:
        // pre-migration data violates them wholesale, so they are aggregated
        // as warnings and do not affect the exit code until the orthography
        // migration lands (fix-orthographies.md).
        case 'verify-workspace': {
            const {problems, variantWarnings} = security.runSystem(() => {
                ww.ensureNewStyleTables();
                const facts = factViewsFromVersionedDb(ww.workspace);
                return {
                    problems: validateVersionedDb(ww.workspace),
                    variantWarnings: validateVariantInvariants(
                        facts, variantPolicyByTag(ww.dictSchema),
                        orthography.orthographyVocabulary(ww.orthographies)),
                };
            });
            for(const p of problems)
                console.error(`PROBLEM [${p.invariant}] ${p.path}: ${p.detail}`);
            // Aggregate the (numerous, expected) variant warnings per
            // invariant+tag, with a few sample paths each.
            const groups = new Map<string, {n: number, samples: string[]}>();
            for(const w of variantWarnings) {
                const tag = w.path.split('/').pop()?.split(':')[0] ?? '?';
                const key = `${w.invariant} on ${entry.relationDisplayName(tag)}`;
                const g = groups.get(key) ?? {n: 0, samples: []};
                g.n++;
                if(g.samples.length < 3) g.samples.push(w.path);
                groups.set(key, g);
            }
            for(const [key, g] of groups)
                console.warn(`WARNING [${key}] ×${g.n} - e.g. ${g.samples.join(', ')}`);
            console.info(`verify-workspace: ${problems.length} problem(s), ` +
                         `${variantWarnings.length} variant warning(s) (warn mode)`);
            Deno.exit(problems.length === 0 ? 0 : 1);
            break;
        }

        // Scan current variant (orthography) values against the schema's $
        // flags (fix-orthographies.md "Data scan") - read-only, reported via
        // the findings API.  The $notVariant drop-gate PASS is a precondition
        // the orthography migration re-checks at run time; the dirt findings
        // (blank backfill workload, off-vocabulary values, ...) do not fail
        // the scan.  Exit 0 iff the gate passes.
        //   ./wordwiki.sh scan-variants [--report import-report/scan-variants.md]
        case 'scan-variants': {
            const reportIx = args.indexOf('--report');
            const reportPath = reportIx >= 0 ? args[reportIx + 1] : undefined;
            const gatePassed = security.runSystem(() => {
                ww.ensureNewStyleTables();
                const sourceDb = `${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()} [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`;
                const report = new FindingsReport('Variant (orthography) scan', {sourceDb});
                const result = scanVariants(report, ww.dictSchema,
                    orthography.orthographyVocabulary(ww.orthographies));
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, report.toMarkdown());
                    console.info(`wrote ${reportPath}`);
                }
                console.info(`scan-variants: ${report.findingCount} finding(s); ` +
                             `drop gate ${result.gatePassed ? 'PASS' : 'FAIL'}`);
                return result.gatePassed;
            });
            Deno.exit(gatePassed ? 0 : 1);
            break;
        }

        // THE variant (orthography) data migration - fix-orthographies.md
        // "Migration mechanics".  Mute-in-place on current rows, idempotent,
        // preconditions re-checked at run time (flagged schema, drop gate,
        // mapping coverage - see variant-migrate.ts, incl. the per-tag blank
        // backfill + value-fix DECISION TABLES).  Hand-triage rows are left
        // for the live cleanup report (wordwiki.variants.cleanupReport()).
        //   ./wordwiki.sh migrate-variants [--report path.md]
        //   ./wordwiki.sh migrate-variants --expect-no-changes    # idempotency proof
        //   ./wordwiki.sh migrate-variants --dry-run --report r.md  # REVIEW: report
        //       every case (decision evidence, value fixes enumerated, backfill
        //       samples) without writing; with --expect-no-changes it is a
        //       read-only "is this db fully migrated?" probe
        case 'migrate-variants': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const dryRun = args.includes('--dry-run');
                if(!dryRun && ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                const reportIx = args.indexOf('--report');
                const reportPath = reportIx >= 0 ? args[reportIx + 1] : undefined;
                const sourceDb = `${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()} [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`;
                const report = new FindingsReport(
                    `Variant (orthography) migration${dryRun ? ' — DRY RUN' : ''}`, {sourceDb});
                const stats = migrateVariants(report, ww.dictSchema,
                                              orthography.orthographyVocabulary(ww.orthographies),
                                              {dryRun});
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, report.toMarkdown());
                    console.info(`wrote ${reportPath}`);
                }
                if(args.includes('--expect-no-changes')) {
                    if(stats.changed > 0)
                        throw new Error(`--expect-no-changes: ${dryRun ? 'would change' : 'changed'} ` +
                                        `${stats.changed} variant row(s)`);
                    console.info(dryRun ? 'read-only probe: the db is fully migrated'
                                        : 'idempotency confirmed: re-run made no changes');
                }
                console.info(`migrate-variants: ${stats.changed} row(s) ${dryRun ? 'WOULD change (dry run)' : 'changed'} ` +
                             `(${Object.entries(stats.byAction).map(([a, n]) => `${a} ${n}`).join(', ') || 'nothing to do'})`);
            });
            Deno.exit(0);
            break;
        }

        // The STATUS REMODEL data migration (fix-orthographies.md "Status",
        // status-migrate.ts): publish gates from Completed statuses, the
        // lifecycle renames, sta variant blanking, and lifecycle synthesis
        // for no-status entries.  ONCE PER DB (config marker), dry-runnable.
        // Runs BEFORE migrate-variants in the pipeline (it reads sta variants
        // for the gate orthography, then blanks them).
        //   ./wordwiki.sh migrate-status [--dry-run] [--report path.md] [--expect-no-changes]
        case 'migrate-status': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const dryRun = args.includes('--dry-run');
                if(!dryRun && ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                const reportIx = args.indexOf('--report');
                const reportPath = reportIx >= 0 ? args[reportIx + 1] : undefined;
                const sourceDb = `${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()} [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`;
                const report = new FindingsReport(
                    `Status remodel migration${dryRun ? ' — DRY RUN' : ''}`, {sourceDb});
                const stats = migrateStatus(report, {dryRun, config: ww.config});
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, report.toMarkdown());
                    console.info(`wrote ${reportPath}`);
                }
                if(args.includes('--expect-no-changes')) {
                    if(stats.changed > 0)
                        throw new Error(`--expect-no-changes: ${dryRun ? 'would change' : 'changed'} ` +
                                        `${stats.changed} row(s)`);
                    console.info(dryRun ? 'read-only probe: the status remodel is done on this db'
                                        : 'idempotency confirmed: re-run made no changes');
                }
                console.info(`migrate-status: ${stats.changed} change(s) ` +
                             `(${Object.entries(stats.byAction).map(([a, n]) => `${a} ${n}`).join(', ') || 'nothing to do'})`);
            });
            Deno.exit(0);
            break;
        }

        case 'verify-migration': {
            const dir = args.find((a, i) => i >= 1 && !a.startsWith('--'))
                ?? new URL('../categorization', import.meta.url).pathname;
            const schemeText = (() => {
                try { return Deno.readTextFileSync(`${dir}/scheme.md`); }
                catch (_e) { return undefined; }
            })();
            const ok = security.runSystem(() => {
                ww.ensureNewStyleTables();
                const report = migrationVerify.verifyMigration(ww, {schemeText});
                for(const m of report.info)     console.info(`  info: ${m}`);
                for(const m of report.warnings) console.info(`WARNING: ${m}`);
                for(const m of report.failures) console.error(`FAILURE: ${m}`);
                console.info(`verify-migration: ${report.failures.length} failures, ` +
                             `${report.warnings.length} warnings`);
                return report.failures.length === 0;
            });
            Deno.exit(ok ? 0 : 1);
            break;
        }

        // Publish from the CLI - the whole site, or just the named targets
        // for quick turnaround while iterating on templates.  Targets are
        // site-relative paths ("the URL you want rebuilt" - see
        // parsePublishTarget in publish.ts for the grammar); errors and
        // warnings go to stdout and a non-zero exit means errors.
        // Publishing only READS the db, so wordwiki.sh leaves the dev
        // server running for this command.
        //   ./wordwiki.sh publish                                 # everything
        //   ./wordwiki.sh publish entries/samqwan categories/water
        //   ./wordwiki.sh publish --root=/tmp/staging categories    # other tree
        case 'publish': {
            const targets = args.slice(1).filter(a => !a.startsWith('--'));
            const root = args.find(a => a.startsWith('--root='))?.slice('--root='.length) || '.';
            const exitCode = await security.runSystem(async () => {
                const status = new publish.PublishStatus();
                status.start();
                const pub = new publish.Publish(status, ww, ww.publishedEntries, root);
                if(root !== '.')
                    await Deno.mkdir(root, {recursive: true});
                try {
                    if(targets.length === 0)
                        await pub.publish();
                    else
                        await pub.publishTargets(targets);
                } catch(e) {
                    status.errors.push(String(e instanceof Error ? (e.stack ?? e.message) : e));
                }
                status.end();
                for(const w of status.warnings)
                    console.info(`WARNING: ${publish.publishMessageText(w)}`);
                for(const err of status.errors)
                    console.error(`ERROR: ${publish.publishMessageText(err)}`);
                const secs = Math.round(((status.endTime ?? 0) - (status.startTime ?? 0)) / 1000);
                console.info(`publish${targets.length ? ` of ${targets.join(', ')}` : ''} ` +
                             `completed in ${secs}s: ` +
                             `${status.errors.length} errors, ${status.warnings.length} warnings`);
                return status.errors.length > 0 ? 1 : 0;
            });
            Deno.exit(exitCode);
            break;
        }

        // Import the lexical form (part of speech) vocabulary (see
        // lexical-form-import.ts): seed the curated table, normalize the
        // UNAMBIGUOUS legacy values in the data ('vii ' -> vii, 'particle'
        // -> PTCL) via applyTransaction, and report the remaining un-tabled
        // values as the team's curation worklist.  Idempotent; guarded like
        // import-categories.
        //   ./wordwiki.sh import-lexical-forms [--username=NAME] [--allow-production]
        case 'import-lexical-forms':
        case 'seed-lexical-forms': {   // older name kept as an alias
            // Default stamp = the automation identity (see import-categories).
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? '~lexical-form-import';
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                user.seedUsersFromEntrySchema(ww.users);   // the system users ride along post-pull
                if(!ww.users.byUsername.first({username}))
                    throw new Error(`--username '${username}' is not in the user table`);
                const stats = lexicalFormImport.importLexicalForms(
                    ww, {username, log: (msg) => console.info(msg)});
                if(args.includes('--expect-no-changes')) {
                    const changes = stats.seeded.inserted + stats.subentriesNormalized;
                    if(changes > 0)
                        throw new Error(`--expect-no-changes: the import made ${changes} changes - ` +
                                        'the previous run did not reach the fixed point');
                    console.info('idempotency confirmed: re-run made no changes');
                }
            });
            Deno.exit(0);
            break;
        }

        // Mark the database's purpose (production databases refuse destructive
        // test/dev operations and get Secure cookies).
        case 'set-db-purpose': {
            const purpose = args[1];
            if(purpose !== 'production' && purpose !== 'dev' && purpose !== 'test')
                throw new Error('usage: set-db-purpose production|dev|test');
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                ww.config.setDbPurpose(purpose);
                console.info(`db_purpose set to '${purpose}'`);
            });
            Deno.exit(0);
            break;
        }

        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
