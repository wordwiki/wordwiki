// deno-lint-ignore-file no-explicit-any
/**
 * Recently changed WORDS: a backwards feed of lexemes, one row per word,
 * clumped by week - in one of two MODES (the Options dialog / the two
 * Reports-menu presets):
 *
 *   'pending' - Words needing review: only words with UNAPPROVED changes,
 *      ordered by the newest unapproved change (approval events don't count,
 *      and neither do comments).  The reviewer's front door for word-at-a-
 *      time approval (meta-editor-changes-mode.md): walk the list top to
 *      bottom, tap a word to open its VIEW-CHANGES page (baseline→current
 *      annotations in context), Approve all, come back.  A reviewer working
 *      this list never has to touch the complex per-assertion feed.
 *
 *   'all' - Recently changed words: every word with recent human activity,
 *      ordered by its newest change of ANY kind (approvals included) - the
 *      what-has-been-happening-by-word view.
 *
 * Same page-query model as the feed: the page is a pure function of ONE
 * {}-literal route argument; an un-anchored visit redirects with to_time
 * stamped at the db's top tx timestamp, so the anchor rides in the URL and
 * refresh/back show the same list.
 */
import {Markup} from '../liminal/markup.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as server from '../liminal/http-server.ts';
import {db} from '../liminal/db.ts';
import {route, authenticated} from '../liminal/security.ts';
import * as action from '../liminal/action.ts';
import {FieldSet, IntegerField, EnumField, TimestampField, type Tuple} from '../liminal/table.ts';
import * as templates from './templates.ts';
import * as entrySchema from './entry-schema.ts';
import {CHANGE_ROW} from './change-feed.ts';
import type {WordWiki} from './wordwiki.ts';

const WORDS_PAGE_ROWS = 500;

export const MODE_PENDING = 'pending';
export const MODE_ALL = 'all';
const wordModes: Record<string, string> = {
    [MODE_PENDING]: 'Words with unapproved changes (the review queue)',
    [MODE_ALL]: 'All changed words (approvals count too)',
};

export const recentWordsQuery = new FieldSet('recent_words_query', [
    new EnumField('mode', wordModes, {nullable: true, default: MODE_PENDING, prompt: 'Show'}),
    new TimestampField('to_time', {nullable: true, prompt: 'To'}),
    new IntegerField('max_rows', {nullable: true, default: WORDS_PAGE_ROWS, prompt: 'Max words'}),
]);

export interface RecentWordsQuery extends Tuple {
    mode: string;
    to_time: number|null;
    max_rows: number;
}

interface WordRow {
    entry_id: number;
    last_change: number;
    username: string;
    pending: number;
}

interface WeekGroup {
    label: string;
    rows: WordRow[];
}

export class RecentWords {

    constructor(public app: WordWiki) {
    }

    @route(authenticated)
    page(q?: Record<string, any>): templates.Page | server.Response {
        const query = recentWordsQuery.normalize(q) as RecentWordsQuery;
        if(query.to_time == null) {
            query.to_time = this.app.lastAllocatedTxTimestamp;
            return server.forwardResponse(
                `/ww/wordwiki.recentlyChangedWords(${recentWordsQuery.literal(query)})`);
        }
        const rows = this.fetchWords(query);
        const pending = query.mode !== MODE_ALL;
        const title = pending ? 'Words needing review' : 'Recently changed words';
        const body = ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-1 flex-wrap'},
             ['h2', {class: 'mb-0 me-2'}, title],
             action.actionButton('Options…',
                 {kind: 'modal',
                  dialogUrl: `/ww/wordwiki.recentWords.filterDialog(${recentWordsQuery.literal(query)})`},
                 'btn btn-sm btn-outline-secondary')],
            ['div', {class: 'text-muted small mb-3'},
             pending
                 ? 'Each word with unapproved changes, ordered by its newest one '
                   + '(approvals and comments don\u2019t count). Tap a word to see what '
                   + 'changed, in context.'
                 : 'Each word once, ordered by its newest change of any kind. '
                   + 'Tap a word to see it in context.'],
            rows.length === 0
                ? ['div', {class: 'text-muted'},
                   pending ? 'Nothing needs review.' : 'No changed words.']
                : this.weekGroups(rows).map(g => this.renderWeek(g))];
        return templates.page(title, body);
    }

    /** The options dialog: the query's OWN fields, auto-generated (the
     *  FieldSet is both the URL codec and the dialog schema - the feed's
     *  pattern). */
    @route(authenticated)
    filterDialog(q?: Record<string, any>): Markup {
        const query = recentWordsQuery.normalize(q);
        return [
            ['script', {}, 'setTimeout(showModalEditor)'],
            action.renderParamForm(recentWordsQuery.fields, query, {
                title: 'Report options',
                submitLabel: 'Apply',
                dispatch: {id: 'edit-form',
                           onsubmit: 'event.preventDefault(); tx`wordwiki.recentWords.applyFilter(${getFormJSON(event.target)})`'},
            })];
    }

    /** Apply the dialog's state: navigate to its canonical URL (a real
     *  navigation, so Back walks option history). */
    @route(authenticated)
    applyFilter(form: Record<string, any>): any {
        const query = recentWordsQuery.parseFormValues(form);
        return {action: 'navigate',
                url: `/ww/wordwiki.recentlyChangedWords(${recentWordsQuery.literal(query)})`};
    }

    // --- Rendering -----------------------------------------------------------

    private renderWeek(g: WeekGroup): Markup {
        return ['div', {class: 'mb-3'},
            ['div', {class: 'fw-bold text-muted small text-uppercase mb-1'}, g.label],
            ['div', {class: 'list-group lm-list'},
             g.rows.map(r => this.renderRow(r))]];
    }

    /** One word, one row: the whole row navigates to the word's VIEW-CHANGES
     *  page (the word-at-a-time approval flow).  A word whose projection is
     *  gone (its own deletion was the recent change) still lists - review
     *  mode is where a whole-word deletion gets decided. */
    private renderRow(r: WordRow): Markup {
        const e = this.app.entriesById.get(r.entry_id);
        const word = e ? entrySchema.renderEntrySpellingsSummary(e) : `(deleted word ${r.entry_id})`;
        const gloss = e ? e.subentry.flatMap(se => se.gloss.map(gl => gl.gloss)).join(' / ') : '';
        const who = r.username ? (entrySchema.users[r.username] ?? r.username) : '';
        return ['a', {...templates.pageLinkProps(
                          `/ww/wordwiki.lexeme.metaEditPage(${r.entry_id},true)`),
                      class: 'list-group-item list-group-item-action d-flex align-items-center gap-2'},
            ['span', {},
             ['b', {}, word],
             gloss ? ['span', {class: 'text-muted'}, ' : ' + gloss] : ''],
            r.pending > 0
                ? ['span', {class: 'badge text-bg-warning'},
                   `${r.pending} pending`]
                : '',
            ['span', {class: 'ms-auto text-muted small text-nowrap'},
             timestamp.formatTimestampCompact(r.last_change), who ? ` · ${who}` : '']];
    }

    // --- Clumping ------------------------------------------------------------

    /** Group the (already newest-first) rows by the week of their newest
     *  change - weeks start Monday, labelled by that date. */
    private weekGroups(rows: WordRow[]): WeekGroup[] {
        const groups: WeekGroup[] = [];
        let currentKey = '';
        for(const r of rows) {
            const monday = mondayOf(r.last_change);
            const key = monday.toDateString();
            if(key !== currentKey) {
                currentKey = key;
                groups.push({label: 'Week of ' + WEEK_LABEL.format(monday), rows: []});
            }
            groups[groups.length-1].rows.push(r);
        }
        return groups;
    }

    // --- Queries -------------------------------------------------------------

    /** One row per WORD, newest first, per the query's MODE (both exclude
     *  the imported base set and '~' automated identities; SQLite's
     *  bare-column-with-MAX picks the username off the newest row):
     *
     *  'all': the newest human change of ANY kind (the change feed's
     *  CHANGE_ROW - approvals, reverts and comments count as activity).
     *
     *  'pending': the newest UNAPPROVED content change (published_from IS
     *  NULL; approval events and comments never count), then the SQL
     *  CANDIDATES are exact-filtered by the changes view's own count -
     *  a stale approved-deletion tombstone can look pending to the SQL, and
     *  the count (computed for the badge anyway) drops it.  The filter can
     *  leave the page short of max_rows; the honest fix (a bigger SQL
     *  window) hasn't been needed. */
    private fetchWords(query: RecentWordsQuery): WordRow[] {
        const pendingMode = query.mode !== MODE_ALL;
        const changeCondition = pendingMode
            ? `published_from IS NULL
               AND (change_action IS NULL OR change_action NOT IN ('approved', 'comment'))`
            : CHANGE_ROW;
        const rows = db().all<{entry_id: number, last_change: number,
                               username: string|null}, any>(
            `SELECT id1 AS entry_id, MAX(valid_from) AS last_change,
                    change_by_username AS username
             FROM dict
             WHERE valid_from <= :to_time AND valid_from > ${timestamp.BEGINNING_OF_TIME}
               AND id1 IS NOT NULL
               AND ${changeCondition}
               AND (change_by_username IS NULL OR change_by_username NOT LIKE '~%')
             GROUP BY id1
             ORDER BY last_change DESC
             LIMIT ${query.max_rows ?? WORDS_PAGE_ROWS}`,
            {to_time: query.to_time});
        // The badge is the changes view's OWN count (pendingChangeCount walks
        // the word's in-memory tuple tree), computed only for the listed
        // rows - exact agreement with the page each row opens, and no
        // whole-table SQL.
        const out = rows.map(r => ({entry_id: r.entry_id, last_change: r.last_change,
                                    username: r.username ?? '',
                                    pending: this.pendingCountOf(r.entry_id)}));
        return pendingMode ? out.filter(r => r.pending > 0) : out;
    }

    private pendingCountOf(entry_id: number): number {
        try { return this.app.lexeme.pendingChangeCount(entry_id); }
        catch { return 0; }   // a fully-deleted word has no tuple to walk
    }
}

// --- Week arithmetic (wall-time component of the HLC, like every display) ----

const WEEK_LABEL = new Intl.DateTimeFormat('en-CA', {month: 'long', day: 'numeric', year: 'numeric'});

function mondayOf(t: number): Date {
    const d = new Date(timestamp.extractTimeFromTimestamp(t)*1000 + timestamp.LOCAL_EPOCH_START);
    const dow = (d.getDay() + 6) % 7;               // Mon=0 .. Sun=6
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
}
