// deno-lint-ignore-file no-explicit-any
/**
 * The misc EDITOR REPORTS, reachable as wordwiki.reports.* - the read-only
 * report pages that accreted on the app class (categories directory, TODO,
 * twitter post status, the word-a-day picker, entries-by-PDM-page, the
 * import report).  Moved here in the WordWiki decomposition; the special-
 * purpose report modules (spelling-duplicates, variant-scan,
 * auto-transliterate, activity-report, recent-words, change-feed) predate
 * this one and keep their own namespaces.
 *
 * The constructor takes the NARROW ReportsApp interface, not the whole app:
 * a report can only reach the store, the site views, the category table and
 * the PDM page counts - which is everything a read-only report should need.
 * WordWiki satisfies it structurally.
 */

import * as markup from '../liminal/markup.ts';
import {db} from "../liminal/db.ts";
import {block} from '../liminal/strings.ts';
import {panic} from '../liminal/utils.ts';
import {route, authenticated} from '../liminal/security.ts';
import * as markdown from '../liminal/markdown.ts';
import * as templates from './templates.ts';
import * as entry from './entry-schema.ts';
import * as category from './category.ts';
import * as findings from './findings.ts';
import {selectScannedDocumentByFriendlyId, selectScannedPageByPageNumber} from './scanned-document.ts';
import {renderStandaloneGroup} from './render-page-editor.ts';
import type {DictionaryStore} from './dictionary-store.ts';
import type {SiteView} from './site-view.ts';

/** What a read-only editor report may reach.  WordWiki satisfies this
 *  structurally; keeping the parameter NARROW is what stops the next report
 *  from quietly growing a dependency on the whole app. */
export interface ReportsApp {
    readonly store: DictionaryStore;
    site(orthography?: string): SiteView;
    workingSite(): SiteView;
    readonly categories: category.CategoryTable;
    readonly entryCountByPage: Array<[number, number]>;
}

/** Is this entry already posted as a word-a-day (twitter/bluesky)?  The
 *  poster stamps the twitter-post attribute with a date; for the picker
 *  any non-empty value counts (same semantics as the twitter report:
 *  any subentry's attribute marks the whole word). */
export function isTwitterPosted(e: entry.Entry): boolean {
    return e.subentry.some(s =>
        s.attr.some(a => a.attr === 'twitter-post' && String(a.value ?? '').trim() !== ''));
}

export class EditorReports {

    constructor(public app: ReportsApp) {}

    @route(authenticated)
    categoriesDirectory(): any {
        const title = `Categories Directory`;

        // Grouped by theme via the category table (the shared grouping:
        // themes in table order - so Internal and Old categories land at the
        // end - names sorted within).  This is the EDITOR report, so internal
        // '~' categories are shown; the public site filters them.  Values
        // with no table row (a pre-import db) trail in their own group.
        // Counts are public entries in the EDITOR'S working orthography.
        const site = this.app.workingSite();
        const counts = site.categoryCounts();
        const tabled = this.app.categories.allByOrder.all({}).filter(c => counts.has(c.slug));
        const tabledSlugs = new Set(tabled.map(c => c.slug));
        const untabled = Array.from(counts.keys())
            .filter(v => !tabledSlugs.has(v))
            .toSorted((a, b) => site.collator.compare(a, b));

        const categoryLink = (value: string, label: string) =>
            ['li', {}, ['a',
                        {href:`/ww/wordwiki.reports.entriesForCategory(${JSON.stringify(value)})`},
                        label, ` (${counts.get(value)} entries)`]];

        const body = [
            ['h1', {}, title],
            // Working in a non-default orthography changes what counts as
            // public here - say so rather than leaving a puzzling near-empty
            // page.  (Invisible in the default case.)
            site.orthography !== entry.PUBLIC_SITE_ORTHOGRAPHY
                ? ['p', {class: 'text-muted'},
                   `Showing entries public in your working orthography (${site.orthography}).`]
                : undefined,
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
    entriesForCategory(category?: string): any {
        category = String(category ?? '');

        const entriesForCategory = this.app.workingSite().entriesForCategory(category);
        const title = ['Entries for category ', category];

        function renderEntryItem(e: entry.Entry): any {
            return [
                templates.lexemeLink(e.entry_id, entry.renderEntryCompactSummary(e), {pencil: false})
            ];
        }

        const body = [
            ['h2', {}, title],

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
    todoReport(restrictToUser: string|null, restrictToTask: string|null): any {
        const userSummary = restrictToUser ? `for user "${entry.users[restrictToUser] ?? restrictToUser}"` : 'for all users';
        const taskSummary = restrictToTask ? `for task "${entry.todos[restrictToTask] ?? restrictToTask}"` : 'for all tasks';
        const title = `TODO report ${userSummary} ${taskSummary}`;

        const userPicker = ['div', {}, ['b', {}, 'Assigned To: '],
                            Object.entries(entry.users).map(([user_id, user_name])=>
                                [['a', {href:`/ww/wordwiki.reports.todoReport(${JSON.stringify(user_id)}, ${JSON.stringify(restrictToTask)})`}, user_id], ' / ']),
                            ['a', {href:`/ww/wordwiki.reports.todoReport(null, ${JSON.stringify(restrictToTask)})`}, 'ALL USERS']];

        const taskPicker = ['div', {}, ['b', {}, 'Task Kind: '],
                            Object.entries(entry.todos).map(([todo_id, todo_name])=>
                                [['a', {href:`/ww/wordwiki.reports.todoReport(${JSON.stringify(restrictToUser)}, ${JSON.stringify(todo_id)})`}, todo_name], ' / ']),
                            ['a', {href:`/ww/wordwiki.reports.todoReport(${JSON.stringify(restrictToUser)}, null)`}, 'ALL TASKS']];

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
        return this.app.store.entries.filter(
            entry=>
                entry.todo.some(todo=>
                    !todo.done &&
                    (restrictToTask == null || todo.todo === restrictToTask) &&
                    (restrictToUser == null || todo.assigned_to === restrictToUser)));
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

        const collator = this.app.site().collator;
        const entriesByTwitterPostStatus =
            this.app.store.entries.toSorted((a: entry.Entry, b: entry.Entry)=> {
                const atwit = getTwitterPostStatusForEntry(a);
                const btwit = getTwitterPostStatusForEntry(b);
                if(atwit == btwit)
                    return 0
                if(atwit == undefined)
                    return 1;
                if(btwit == undefined)
                    return -1;
                return collator.compare(atwit, btwit)
            });

        const title = "Entries by Twitter Post Status";
        const body = [
            ['h2', {}, title],
            ['div', {class: 'mb-2'},
             ['a', {href: '/ww/wordwiki.reports.wordADayPicker()'},
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

    /** The word-a-day picker: the whole category tree with every
     *  not-yet-posted PUBLIC word inline, so the poster (~20 years of
     *  word-a-day, ~3.8k words posted) can browse candidates by theme
     *  instead of hunting.  Runs off the in-memory public-entries model -
     *  the same pool and per-category sorted lists as the other category
     *  reports, so a picked word is always a finished, publicly visible
     *  one.  A word in several categories appears under EACH (a thematic
     *  picker wants that); the header counts distinct words.  Words with no
     *  category land in a final Uncategorized bucket so they stay pickable.
     *  Stamping twitter-post in the editor drops the word on next load. */
    @route(authenticated)
    wordADayPicker(): any {
        const title = 'Word-a-day picker';
        // Deliberately THE PUBLIC SITE's view (not the editor's working
        // orthography): the picker feeds the public word-a-day post, so a
        // pick must be publicly visible ON THE SITE, whoever is browsing.
        const site = this.app.site();
        const unpostedIds = new Set(site.publicEntries
            .filter(e => !isTwitterPosted(e)).map(e => e.entry_id));

        const byCat = new Map<string, entry.Entry[]>();
        for(const [cat, entries] of site.entriesByCategory.entries()) {
            const un = entries.filter(e => unpostedIds.has(e.entry_id));
            if(un.length > 0) byCat.set(cat, un);
        }
        const uncategorized = site.publicEntries
            .filter(e => unpostedIds.has(e.entry_id)
                         && e.subentry.every(s => s.category.length === 0))
            .toSorted((a, b) => site.collator.compare(
                a.spelling[0]?.text ?? '', b.spelling[0]?.text ?? ''));

        // Theme grouping via the category table, like categoriesDirectory;
        // values with no table row trail in their own group.
        const tabled = this.app.categories.allByOrder.all({}).filter(c => byCat.has(c.slug));
        const tabledSlugs = new Set(tabled.map(c => c.slug));
        const untabled = Array.from(byCat.keys())
            .filter(v => !tabledSlugs.has(v))
            .toSorted((a, b) => site.collator.compare(a, b));
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
             ['a', {href: '/ww/wordwiki.reports.entriesByTwitterPostStatus()'},
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
    entriesByPDMPageDirectory(): any {
        const title = `Entries by PDM Page Directory`;

        const entryCountByPage = this.app.entryCountByPage;

        const body = [
            ['h1', {}, title],
            ['ul', {},
             entryCountByPage.map(([page_number, entry_count])=>
                 ['li', {},
                  ['a', {href:`/ww/wordwiki.reports.entriesByPDMPage(${page_number})`},
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

        console.timeEnd('entriesInDocRefOrder');

        console.info('entriesForPageInDocRefOrder', entriesInDocRefOrder);

        const entriesById = new Map(this.app.store.entries.map(entry=>[entry.entry_id, entry]));

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

    // ----- The import report (the findings publish path) ---------------------
    // importWordWikiV1Db.sh writes per-step fragments under
    // <instance>/import-report/ and assembles import-report.md (via a trap,
    // so crashes still report); these routes render them through the page
    // template.  FIXED paths + a whitelisted fragment-name pattern - no
    // path traversal surface.

    @route(authenticated)
    importReport(): templates.Page {
        const fragments = (() => {
            try {
                return findings.sortFragments(
                    [...Deno.readDirSync('import-report')]
                        .filter(e => e.isFile && /^[0-9]+-[a-z0-9-]+\.md$/.test(e.name))
                        .map(e => ({name: e.name}))).map(f => f.name);
            } catch(_e) { return []; }
        })();
        const body: markup.Markup = [
            fragments.length > 0
                ? ['p', {class: 'text-muted small'}, 'Step fragments: ',
                   fragments.map((n, i) => [i > 0 ? ' · ' : '',
                       ['a', {href: `/ww/wordwiki.reports.importReportFragment(${JSON.stringify(n)})`}, n]])]
                : undefined,
            this.renderMdReport('import-report.md',
                'No import report yet - importWordWikiV1Db.sh assembles one on every run ' +
                '(even a failed one).')];
        return templates.page('Import Report', ['div', {class: 'container py-3'}, body]);
    }

    @route(authenticated)
    importReportFragment(name: string): templates.Page {
        if(!/^[0-9]+-[a-z0-9-]+\.md$/.test(name))
            throw new Error(`'${name}' is not an import-report fragment name`);
        return templates.page(`Import Report — ${name}`,
            ['div', {class: 'container py-3'},
             ['p', {class: 'small'}, ['a', {href: '/ww/wordwiki.reports.importReport()'}, '← whole report']],
             this.renderMdReport(`import-report/${name}`, 'No such fragment.')]);
    }

    // A committed/instance markdown file rendered under the page styles.
    // PRIVATE + fixed callers only: never expose a path-taking route.
    private renderMdReport(path: string, missing: string): markup.Markup {
        try {
            return ['div', {class: 'page-content'},
                    markdown.markdownToMarkup(Deno.readTextFileSync(path))];
        } catch(_e) {
            return ['p', {class: 'text-muted'}, missing];
        }
    }
}
