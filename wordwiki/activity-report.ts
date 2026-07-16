// deno-lint-ignore-file no-explicit-any
/**
 * The monthly activity report: one compact row per month - by default ALL
 * months back to the earliest recorded creation (the report is cheap even at
 * full depth; `months` limits it when set) - counting what HAPPENED that
 * month: changes made (and the DISTINCT lexemes they touched - one word's
 * entry is many facts, so Changed lexemes is the human scale of the raw
 * Changes count), new lexemes created, approvals and rejections
 * performed.  The COUNTS are the links to their evidence: a Changes count
 * opens the feed windowed to that month, a New lexemes count opens the
 * created-lexemes micro page (createdPage).  Counts are ACTIONS IN the month, not
 * the eventual fate of the month's changes: a March edit rejected in May
 * counts as a March change and a May rejection.  This keeps every row a
 * single-pass aggregate that never shifts retroactively, and every number
 * links to its evidence: the month name opens the change feed windowed to
 * exactly that month, so the feed's CHANGE_ROW predicate and this report's
 * fetch must stay the same (they are - the predicate is imported).
 *
 * EXCEPT the New published column (leading, because it is the headline
 * number), which is a different axis: PUBLISHED lexemes by their CREATION
 * DATE (creation-dates.ts) - the ent fact's valid_from for lexemes created
 * in wordwiki (the ent tag is never edited, so this is exact), and the
 * shoebox-date attribute for the batch-imported corpus (whose ent rows all
 * sit at the one BEGINNING_OF_TIME import instant).  Only the public pool
 * counts (publishedEntries - the dictionary is full of slug/draft entries),
 * so an old month's number grows as its drafts get finished.  A deep window (months up to 400) thus
 * shows the dictionary's whole construction history back to 2000.  Caveat
 * that follows from the axis change: a pre-import month's feed link shows no
 * events - the creation happened in the legacy system, not here.
 *
 * Below the table, one succinct line per editor totals their window activity,
 * linking to the user-filtered feed and to their own monthly breakdown - which
 * is just this same page with restrict_to_user set: like the feed, the page
 * is a pure function of one {}-literal route argument (activityQuery, a
 * FieldSet), so filters, bookmarks and the auto-generated dialog all ride the
 * same mechanism.  Unlike the feed there is no to_time anchor stamp: the
 * report is a live dashboard ("the last 12 months" should drift with today);
 * reproducibility lives in the month LINKS, which are absolute ranges.
 *
 * The render is three light indexed fetches (plans pinned in
 * activity-report_test.ts): the change window, the ent creation rows, and the
 * shoebox-date attributes - bucketed by (month, user) in JS.  The month
 * boundaries have to be computed here anyway to build the feed links, and
 * sharing them between the counts and the links guarantees a month's change
 * numbers are exactly the feed page they open.
 *
 * Comments (change_action = 'comment') are tallied but not shown: they are
 * discussion, not content changes, and don't yet earn a column.
 */
import {Markup} from '../liminal/markup.ts';
import * as timestamp from '../liminal/timestamp.ts';
import {db} from '../liminal/db.ts';
import {route, authenticated} from '../liminal/security.ts';
import * as action from '../liminal/action.ts';
import {FieldSet, IntegerField, type Tuple} from '../liminal/table.ts';
import * as templates from './templates.ts';
import * as entrySchema from './entry-schema.ts';
import {COMMENT} from './versioned-model.ts';
import {parseShoeboxDate, SHOEBOX_DATE_ATTR} from './creation-dates.ts';
import {CHANGE_ROW, UserField, feedUsers, userLabel, feedQuery} from './change-feed.ts';
import type {WordWiki} from './wordwiki.ts';

// All report routes live under /ww/ (see lexeme-editor.ts R).
const R = '/ww/wordwiki.activityReport';

const ACTIVITY_MAX_MONTHS = 400;   // sanity cap; deep enough for the 2000+ record

/** The report's page-query schema (see FieldSet: one mechanism is the URL
 *  codec and the filter dialog).  months blank = no limit = the whole
 *  record, back to the earliest creation or change. */
export const activityQuery = new FieldSet('activity_query', [
    new IntegerField('months', {nullable: true, prompt: 'Months (blank = all)'}),
    new UserField('restrict_to_user', feedUsers, {nullable: true, prompt: 'Only changes by'}),
]);

export interface ActivityQuery extends Tuple {
    months: number|null;
    restrict_to_user: string|null;
}

// ---------------------------------------------------------------------------
// --- Bucketing (pure) --------------------------------------------------------
// ---------------------------------------------------------------------------

/** One human change, as the light row the window fetch returns - just enough
 *  columns to classify the action taken at that moment (no chain-walking).
 *  ty + replaced_username exist to recognize a born-approved relation's
 *  mechanical self-approval (tallied as NOTHING - see tallyRow). */
export interface ActivityRow {
    valid_from: number;
    entry_id: number;    // id1 - the containing lexeme
    change_action: string|null;
    username: string;    // change_by_username, '' when unstamped
    ty?: string;         // the fact's relation tag
    replaced_username?: string|null;   // author of the version this row supersedes
}

/** What happened in one month (or one month for one editor).  newLexemes is
 *  the creation-date axis (see the module comment), tallied separately from
 *  the change rows.  changedLexemes carries the actual entry-id set, not a
 *  count, so folds (year totals, per-editor window totals) stay DISTINCT
 *  rather than summing per-month distincts.  comments are tallied but not
 *  currently rendered. */
export interface ActivityStats {
    changes: number;      // content changes: creations + edits + deletions
    changedLexemes: Set<number>;   // distinct lexemes those changes touched
    newLexemes: number;   // lexemes CREATED this month (by creation date)
    approved: number;     // review actions performed this month
    rejected: number;
    comments: number;
}

export function emptyStats(): ActivityStats {
    return {changes: 0, changedLexemes: new Set(), newLexemes: 0,
            approved: 0, rejected: 0, comments: 0};
}

export function addStats(into: ActivityStats, s: ActivityStats): void {
    into.changes += s.changes; into.newLexemes += s.newLexemes;
    into.approved += s.approved; into.rejected += s.rejected;
    into.comments += s.comments;
    for(const id of s.changedLexemes) into.changedLexemes.add(id);
}

/** Classify one row by the action it RECORDS and tally it.  Every CHANGE_ROW
 *  row lands in exactly one tally (approved / rejected / comment / change),
 *  so a month's tallies partition its feed events.  Only content changes
 *  mark their lexeme changed (an approval settles a lexeme, it doesn't
 *  change it).  The one exception to the partition: a BORN-APPROVED
 *  relation's mechanical self-approval (the log/tag quick ops - schema
 *  $view.bornApproved, recognized by same-author-as-superseded) tallies as
 *  NOTHING, matching the feed, which folds its line into the change it
 *  approved (a post is one change, not one change plus one approval). */
export function tallyRow(s: ActivityStats, r: ActivityRow): void {
    switch(r.change_action) {
        case 'approved':
            if(!(r.ty !== undefined && entrySchema.bornApprovedTags().has(r.ty)
                 && r.username !== '' && r.username === r.replaced_username))
                s.approved++;
            break;
        case 'reverted': s.rejected++; break;
        case COMMENT:    s.comments++; break;
        default:         s.changes++; s.changedLexemes.add(r.entry_id);
    }
}

/** One lexeme's creation, resolved to a calendar date (local time).
 *  year/month/day are 0 for an UNDATED lexeme: an import with no
 *  shoebox-date (a handful) - its ent row's valid_from is the import
 *  instant, not a creation date. */
export interface EntryCreation {
    entry_id: number;
    year: number;
    month: number;       // 1-12, 0 when undated
    day: number;
    username: string;    // the ent creation row's editor, '' when unstamped
}

/** Resolve a lexeme's creation date: the shoebox-date attribute when
 *  present (the legacy construction date - the imported corpus's ent rows
 *  all sit at the BEGINNING_OF_TIME import instant), else the ent creation
 *  row's valid_from.  Undefined for an imported lexeme with no
 *  shoebox-date. */
export function resolveCreationDate(valid_from: number, shoebox: string|null|undefined):
        {year: number, month: number, day: number} | undefined {
    const iso = parseShoeboxDate(shoebox);
    if(iso !== undefined)
        return {year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)),
                day: Number(iso.slice(8, 10))};
    if(valid_from <= timestamp.BEGINNING_OF_TIME) return undefined;
    const d = new Date(timestamp.extractTimeFromTimestamp(valid_from)*1000
                       + timestamp.LOCAL_EPOCH_START);
    return {year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()};
}

/** One calendar month as a closed timestamp range (local time - the same
 *  reading every timestamp display uses). */
export interface MonthWindow {
    label: string;        // 'June 2026'
    year: number;
    month: number;        // 1-12
    from: number;         // first timestamp of the month
    to: number;           // last timestamp of the month (next month's from - 1)
}

const monthLabelFormat = new Intl.DateTimeFormat('en-CA', {year: 'numeric', month: 'long'});
const monthOnlyFormat = new Intl.DateTimeFormat('en-CA', {month: 'long'});

// A local Date as a timestamp; months at or before the local epoch (2020)
// clamp to 0, which sorts below BEGINNING_OF_TIME - no real row is ever there.
function dateToTimestamp(d: Date): number {
    return timestamp.makeTimestamp(
        Math.max(0, Math.floor((+d - timestamp.LOCAL_EPOCH_START)/1000)), 0);
}

/** The last `months` calendar months, newest (the current, partial month)
 *  first.  Windows are contiguous: each month's `to` is the next month's
 *  `from` - 1, so no event can fall between them. */
export function monthWindows(months: number, nowMs: number): MonthWindow[] {
    const now = new Date(nowMs);
    const out: MonthWindow[] = [];
    for(let k = 0; k < months; k++) {
        const s = new Date(now.getFullYear(), now.getMonth() - k, 1);
        const e = new Date(now.getFullYear(), now.getMonth() - k + 1, 1);
        out.push({label: monthLabelFormat.format(s),
                  year: s.getFullYear(), month: s.getMonth() + 1,
                  from: dateToTimestamp(s), to: dateToTimestamp(e) - 1});
    }
    return out;
}

export interface MonthBucket {
    window: MonthWindow;
    total: ActivityStats;
    byUser: Map<string, ActivityStats>;
}

/** How many months (current month inclusive) reach back to the earliest
 *  change or dated creation - the depth of a no-limit view.  1 when there
 *  is nothing at all. */
export function spanMonths(rows: ActivityRow[], creations: EntryCreation[],
                           nowMs: number): number {
    const now = new Date(nowMs);
    let span = 1;
    for(const c of creations)
        if(c.year > 0)
            span = Math.max(span, (now.getFullYear() - c.year)*12
                                  + (now.getMonth() + 1 - c.month) + 1);
    for(const r of rows) {
        const d = new Date(timestamp.extractTimeFromTimestamp(r.valid_from)*1000
                           + timestamp.LOCAL_EPOCH_START);
        span = Math.max(span, (now.getFullYear() - d.getFullYear())*12
                              + (now.getMonth() - d.getMonth()) + 1);
    }
    return span;
}

/** Bucket the window's rows by (month, user).  `windows` is newest-first as
 *  monthWindows returns; a row is placed by the wall-time component of its
 *  valid_from (best-effort under HLC clock anomalies, like every display of
 *  these timestamps - a "future" row lands in the current month). */
export function bucketActivity(rows: ActivityRow[], windows: MonthWindow[],
                               nowMs: number): MonthBucket[] {
    const now = new Date(nowMs);
    const buckets: MonthBucket[] = windows.map(
        w => ({window: w, total: emptyStats(), byUser: new Map()}));
    for(const r of rows) {
        const d = new Date(timestamp.extractTimeFromTimestamp(r.valid_from)*1000
                           + timestamp.LOCAL_EPOCH_START);
        const k = (now.getFullYear() - d.getFullYear())*12 + (now.getMonth() - d.getMonth());
        if(k >= buckets.length) continue;   // older than the window (boundary jitter)
        const b = buckets[Math.max(k, 0)];
        tallyRow(b.total, r);
        let u = b.byUser.get(r.username);
        if(!u) b.byUser.set(r.username, u = emptyStats());
        tallyRow(u, r);
    }
    return buckets;
}

/** Add the creations that fall inside the window to their months'
 *  newLexemes tallies (the creation-date axis - see the module comment).
 *  Undated creations (year 0) belong to no month. */
export function bucketCreations(creations: EntryCreation[], buckets: MonthBucket[],
                                nowMs: number): void {
    const now = new Date(nowMs);
    for(const c of creations) {
        if(c.year === 0) continue;
        const k = (now.getFullYear() - c.year)*12 + (now.getMonth() + 1 - c.month);
        if(k >= buckets.length) continue;
        const b = buckets[Math.max(k, 0)];
        b.total.newLexemes++;
        let u = b.byUser.get(c.username);
        if(!u) b.byUser.set(c.username, u = emptyStats());
        u.newLexemes++;
    }
}

/** Fold the buckets' per-user stats into whole-window per-user totals,
 *  most active (by total tallied actions) first. */
export function userTotals(buckets: MonthBucket[]): [string, ActivityStats][] {
    const totals = new Map<string, ActivityStats>();
    for(const b of buckets)
        for(const [user, s] of b.byUser) {
            let t = totals.get(user);
            if(!t) totals.set(user, t = emptyStats());
            addStats(t, s);
        }
    const weight = (s: ActivityStats) =>
        s.changes + s.approved + s.rejected + s.comments;
    return [...totals.entries()].sort((a, b) => weight(b[1]) - weight(a[1]));
}

// ---------------------------------------------------------------------------
// --- The report --------------------------------------------------------------
// ---------------------------------------------------------------------------

export class ActivityReport {

    constructor(public app: WordWiki) {
    }

    /** The report page: a pure function of its one query argument (no anchor
     *  stamp - see the module comment). */
    @route(authenticated)
    activityPage(q?: Record<string, any>): templates.Page {
        const query = activityQuery.normalize(q) as ActivityQuery;
        const body = ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-3 flex-wrap'},
             ['h2', {class: 'mb-0 me-2'}, 'Monthly activity'],
             this.filterSummary(query),
             action.actionButton('Filter…',
                 {kind: 'modal', dialogUrl: `${R}.filterDialog(${activityQuery.literal(query)})`},
                 'btn btn-sm btn-outline-secondary')],
            this.renderReport(query)];
        return templates.page('Monthly activity', body);
    }

    // The active filters, stated quietly next to the heading (feed pattern).
    private filterSummary(query: ActivityQuery): Markup {
        const parts: string[] = [];
        if(query.restrict_to_user) parts.push(`by ${userLabel(query.restrict_to_user)}`);
        if(query.months != null) parts.push(`last ${query.months} months`);
        return parts.length > 0
            ? ['span', {class: 'text-muted small'}, parts.join(' · ')] : [];
    }

    /** The filter dialog: the query's OWN fields, auto-generated. */
    @route(authenticated)
    filterDialog(q?: Record<string, any>): Markup {
        const query = activityQuery.normalize(q);
        return [
            ['script', {}, 'setTimeout(showModalEditor)'],
            action.renderParamForm(activityQuery.fields, query, {
                title: 'Filter the activity report',
                submitLabel: 'Apply',
                dispatch: {id: 'edit-form',
                           onsubmit: 'event.preventDefault(); tx`wordwiki.activityReport.applyFilter(${getFormJSON(event.target)})`'},
            })];
    }

    /** Apply the dialog's state: navigate to its canonical URL (a real
     *  navigation - filter changes are distinct views, Back walks them). */
    @route(authenticated)
    applyFilter(form: Record<string, any>): any {
        const query = activityQuery.parseFormValues(form);
        return {action: 'navigate',
                url: `/ww/wordwiki.activity(${activityQuery.literal(query)})`};
    }

    /** The report body: the months table, the undated-lexemes line (full-depth
     *  views only - a range limit makes "missing" meaningless), then
     *  (unfiltered views only) the per-editor summary lines.  Fetches cover
     *  all users; the user filter is a JS restriction of the same rows (one
     *  query shape, one pinned plan each).  months null = no limit: the
     *  window reaches back to the earliest creation or change. */
    renderReport(query: ActivityQuery): Markup {
        const nowMs = Date.now();
        const curMonthEnd = monthWindows(1, nowMs)[0].to;
        const allRows = this.fetchActivityRows(0, curMonthEnd);
        const allCreations = this.fetchEntryCreations();
        const rows = query.restrict_to_user
            ? allRows.filter(r => r.username === query.restrict_to_user) : allRows;
        const creations = query.restrict_to_user
            ? allCreations.filter(c => c.username === query.restrict_to_user) : allCreations;
        const months = Math.min(ACTIVITY_MAX_MONTHS, query.months != null
            ? Math.max(query.months, 1)
            : spanMonths(rows, creations, nowMs));
        const windows = monthWindows(months, nowMs);
        const buckets = bucketActivity(rows, windows, nowMs);
        bucketCreations(creations, buckets, nowMs);
        const undated = creations.filter(c => c.year === 0).length;
        return ['div', {class: 'lm-activity'},
            this.renderMonthsTable(buckets, query),
            query.months == null && undated > 0
                ? ['div', {class: 'text-muted small mb-2'},
                   ['a', {href: this.createdUrl(0, 0, query.restrict_to_user)},
                    `${undated} published lexeme${undated === 1 ? '' : 's'}`],
                   ' with no creation date']
                : [],
            query.restrict_to_user ? [] : this.renderUserLines(buckets, query, windows),
            this.renderTransliterationQuality(query)];
    }

    /** OBJECTIVE rubber-stamp detection (fix-orthographies.md
     *  "Auto-transliteration"): per approver, how many machine proposals
     *  they approved UNCHANGED vs corrected first.  A diligent reviewer
     *  corrects some share (~5% expected); a 0%-corrector over hundreds of
     *  approvals is statistically visible with no human re-review.  The
     *  transliteration report carries the same split per rules version. */
    private renderTransliterationQuality(query: ActivityQuery): Markup {
        // Facts with a robot-authored version: their post-robot human
        // versions tell the story - an 'approved' version with the SAME text
        // as the proposal = approved unchanged; a text change = corrected.
        const autos = db().all<any, any>(
            `SELECT ty, id, attr1, change_arg FROM dict
             WHERE change_by_username = '~auto-transliterate'`, {});
        if(autos.length === 0) return [];
        const byApprover = new Map<string, {unchanged: number, corrected: number}>();
        const seen = new Set<string>();
        for(const auto of autos) {
            const key = `${auto.ty}:${auto.id}`;
            if(seen.has(key)) continue;
            seen.add(key);
            const versions = db().all<any, any>(
                `SELECT * FROM dict WHERE ty = :ty AND id = :id ORDER BY valid_from, assertion_id`,
                {ty: auto.ty, id: auto.id});
            const approval = versions.find(v => v.change_action === 'approved'
                                                && v.valid_from !== v.valid_to);
            if(!approval?.change_by_username) continue;
            if(query.restrict_to_user && approval.change_by_username !== query.restrict_to_user)
                continue;
            const g = byApprover.get(approval.change_by_username) ?? {unchanged: 0, corrected: 0};
            if(String(approval.attr1 ?? '') === String(auto.attr1 ?? '')) g.unchanged++;
            else g.corrected++;
            byApprover.set(approval.change_by_username, g);
        }
        if(byApprover.size === 0) return [];
        return ['div', {class: 'mt-4'},
            ['h3', {class: 'h6'}, 'Auto-transliteration review quality'],
            ['p', {class: 'text-muted small mb-2'},
             'Machine proposals approved unchanged vs corrected first - a healthy reviewer ',
             'corrects a share of them (the transliterator is not perfect).'],
            ['table', {class: 'table table-sm w-auto align-middle'},
             ['thead', {}, ['tr', {},
              ['th', {}, 'Approver'], ['th', {class: 'text-end'}, 'Approved unchanged'],
              ['th', {class: 'text-end'}, 'Corrected first'],
              ['th', {class: 'text-end'}, 'Correction rate']]],
             ['tbody', {}, [...byApprover.entries()].map(([who, g]) => {
                 const total = g.unchanged + g.corrected;
                 return ['tr', {},
                     ['td', {}, userLabel(who)],
                     ['td', {class: 'text-end'}, String(g.unchanged)],
                     ['td', {class: 'text-end'}, String(g.corrected)],
                     ['td', {class: 'text-end'}, `${Math.round(g.corrected * 100 / total)}%`]];
             })]]];
    }

    // A count cell: zeros read as quiet dashes so the actual activity pops;
    // a non-zero count IS the link to its evidence.
    private static count(n: number, href?: string): Markup {
        return ['td', {class: 'text-end'},
                n <= 0 ? ['span', {class: 'text-muted'}, '–']
                : href ? ['a', {href}, String(n)]
                : String(n)];
    }

    // The months table, grouped by year: each year leads with a bold totals
    // row (its counts link to the year-windowed feed / the year's created
    // page), then its month rows.  A year at the window's edge totals only
    // its rendered months - the table never claims more than it shows.
    private renderMonthsTable(buckets: MonthBucket[], query: ActivityQuery): Markup {
        const th = (label: string) => ['th', {class: 'text-end'}, label];
        const user = query.restrict_to_user;
        const years: MonthBucket[][] = [];
        for(const b of buckets) {
            const g = years[years.length - 1];
            if(g && g[0].window.year === b.window.year) g.push(b);
            else years.push([b]);
        }
        // One tbody per year.  The year-totals row must read as the TOP of
        // its group, not the bottom of the previous one: a blank spacer row
        // opens every group after the first, and the totals row itself is
        // shaded (table-active) as the group's header line.
        return ['table', {class: 'table table-sm w-auto align-middle'},
            ['thead', {},
             ['tr', {}, ['th', {}, 'Month'], th('New published'), th('Changes'),
                        th('Changed lexemes'), th('Approved'), th('Rejected')]],
            years.map((g, i) => {
                const year = g[0].window.year;
                const total = emptyStats();
                for(const b of g) addStats(total, b.total);
                return ['tbody', {},
                    i === 0 ? [] :
                        ['tr', {class: 'lm-activity-spacer'},
                         ['td', {colspan: 6, class: 'border-0 p-0 pt-3'}]],
                    ['tr', {class: 'lm-activity-year table-active fw-bold'},
                     ['td', {}, String(year)],
                     ActivityReport.count(total.newLexemes,
                         this.createdUrl(year, 0, user)),
                     ActivityReport.count(total.changes,
                         this.feedUrl(g[g.length - 1].window.from, g[0].window.to, user)),
                     ActivityReport.count(total.changedLexemes.size),
                     ActivityReport.count(total.approved),
                     ActivityReport.count(total.rejected)],
                    g.map(b => ['tr', {},
                        ['td', {class: 'ps-4'},
                         monthOnlyFormat.format(new Date(year, b.window.month - 1, 1))],
                        ActivityReport.count(b.total.newLexemes,
                            this.createdUrl(year, b.window.month, user)),
                        ActivityReport.count(b.total.changes,
                            this.feedUrl(b.window.from, b.window.to, user)),
                        ActivityReport.count(b.total.changedLexemes.size),
                        ActivityReport.count(b.total.approved),
                        ActivityReport.count(b.total.rejected)])];
            })];
    }

    /** The created-lexemes micro page: every lexeme created in one calendar
     *  month - or, with month 0, in the whole year - by creation date (see
     *  the module comment), oldest first, each linking into its entry.
     *  year/month 0,0 = the undated lexemes (imports with no shoebox-date). */
    @route(authenticated)
    createdPage(year: number, month: number, user: string = ''): templates.Page {
        let list = this.fetchEntryCreations()
            .filter(c => c.year === year && (month === 0 ? true : c.month === month));
        if(user) list = list.filter(c => c.username === user);
        list.sort((a, b) => a.month - b.month || a.day - b.day || a.entry_id - b.entry_id);
        const title = year === 0 ? 'Published lexemes with no creation date'
            : month === 0 ? `Published lexemes created in ${year}`
            : `Published lexemes created in ${monthLabelFormat.format(new Date(year, month - 1, 1))}`;
        const dd = (n: number) => String(n).padStart(2, '0');
        const body = ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-3 flex-wrap'},
             ['h2', {class: 'mb-0 me-2'}, title],
             ['span', {class: 'text-muted small'},
              `${list.length}${user ? ` by ${userLabel(user)}` : ''}`]],
            ['ul', {class: 'list-unstyled'},
             list.map(c => {
                 const e = this.app.entriesById.get(c.entry_id);
                 return ['li', {class: 'mb-1'},
                     ['span', {class: 'text-muted small me-2 font-monospace'},
                      c.year === 0 ? '—' : `${c.year}-${dd(c.month)}-${dd(c.day)}`],
                     templates.lexemeLink(c.entry_id,
                         e ? entrySchema.renderEntryCompactSummaryCore(e) : `Entry ${c.entry_id}`),
                     c.username ? ['span', {class: 'text-muted small ms-2'},
                                   userLabel(c.username)] : []];
             }),
             list.length === 0 ? ['li', {class: 'text-muted'}, 'None.'] : []]];
        return templates.page(title, body);
    }

    // One succinct line per editor: whole-window totals, the name linking to
    // the user-filtered feed (the evidence), and a trailing link to their own
    // monthly breakdown (this page, filtered).
    private renderUserLines(buckets: MonthBucket[], query: ActivityQuery,
                            windows: MonthWindow[]): Markup {
        const totals = userTotals(buckets);
        if(totals.length === 0) return [];
        const n = (c: number, noun: string) => `${c} ${noun}${c === 1 ? '' : 's'}`;
        return ['div', {class: 'mt-2'},
            ['h5', {}, 'By editor'],
            ['ul', {class: 'list-unstyled'},
             totals.map(([user, s]) => {
                 const parts: string[] = [];
                 if(s.changes) parts.push(n(s.changes, 'change'));
                 if(s.changedLexemes.size)
                     parts.push(`on ${n(s.changedLexemes.size, 'lexeme')}`);
                 if(s.newLexemes) parts.push(n(s.newLexemes, 'new published lexeme'));
                 if(s.approved) parts.push(`${s.approved} approved`);
                 if(s.rejected) parts.push(`${s.rejected} rejected`);
                 if(s.comments) parts.push(n(s.comments, 'comment'));
                 // The unstamped pre-2026 history has no username to filter
                 // by (change_by_username IS NULL - the feed's `=` filter
                 // can't reach it), so its line carries no links.
                 return ['li', {class: 'mb-1'},
                     user === ''
                        ? ['span', {}, userLabel(user)]
                        : ['a', {href: this.feedUrl(windows[windows.length-1].from,
                                                    windows[0].to, user)},
                           userLabel(user)],
                     ['span', {class: 'text-muted'}, ` — ${parts.join(' · ')}`],
                     user === '' ? [] :
                        ['a', {class: 'small ms-2',
                               href: `/ww/wordwiki.activity(${activityQuery.literal(
                                   activityQuery.normalize(
                                       {...query, restrict_to_user: user}))})`},
                         'monthly']];
             })]];
    }

    // A change-feed URL for a closed window (optionally one editor's): the
    // report's counts always open as feed pages showing those same rows.
    private feedUrl(from: number, to: number, user: string|null): string {
        const q: Record<string, any> = {from_time: from, to_time: to};
        if(user) q.restrict_to_user = user;
        return `/ww/wordwiki.changes(${feedQuery.literal(feedQuery.normalize(q))})`;
    }

    // The created-lexemes micro page's URL for one month (0,0 = undated).
    private createdUrl(year: number, month: number, user: string|null): string {
        return `${R}.createdPage(${year},${month}${user ? `,${JSON.stringify(user)}` : ''})`;
    }

    /** The window fetch: every human change in the closed range, all users
     *  (see renderReport).  Same predicate as the feed - a count here IS a
     *  feed page's contents. */
    private fetchActivityRows(from: number, to: number): ActivityRow[] {
        // replaced_username: the superseded version's author - a PK lookup
        // per row (assertion_id is the rowid), so it rides the same index
        // range plan.  Only read by tallyRow's born-approved fold.
        const rows = db().all<{valid_from: number, entry_id: number,
                               change_action: string|null, ty: string,
                               username: string|null,
                               replaced_username: string|null}, any>(
            `SELECT valid_from, id1 AS entry_id, change_action, ty,
                    change_by_username AS username,
                    (SELECT p.change_by_username FROM dict p
                     WHERE p.assertion_id = dict.replaces_assertion_id) AS replaced_username
             FROM dict
             WHERE valid_from >= :from AND valid_from <= :to
               AND valid_from > ${timestamp.BEGINNING_OF_TIME}
               AND id1 IS NOT NULL
               AND ${CHANGE_ROW}
               AND (change_by_username IS NULL OR change_by_username NOT LIKE '~%')
             ORDER BY valid_from DESC`,
            {from, to});
        return rows.map(r => ({...r, username: r.username ?? ''}));
    }

    /** Every PUBLISHED lexeme's creation, resolved to its month: the ent
     *  creation rows joined in JS against the current shoebox-date
     *  attributes (earliest per entry when several subentries carry one),
     *  restricted to the public pool (publishedEntries: Completed status +
     *  published facts) - the dictionary is full of slug/draft entries, and
     *  "new lexemes" should mean finished words.  Consequence of gating a
     *  creation-date axis by TODAY's publication state: an old month's
     *  count grows as its drafts get finished.  Both queries ride their
     *  ty-path indexes (plans pinned). */
    private fetchEntryCreations(): EntryCreation[] {
        const publicIds = new Set(this.app.publishedEntries.map((e: any) => e.entry_id));
        const shoebox = new Map<number, string>();
        for(const r of db().all<{id1: number, attr2: string|null}, any>(
            `SELECT id1, attr2 FROM dict
             WHERE ty3 = 'att' AND ty = 'att' AND attr1 = :attr AND valid_to = :eot`,
            {attr: SHOEBOX_DATE_ATTR, eot: timestamp.END_OF_TIME})) {
            const iso = parseShoeboxDate(r.attr2);
            if(iso === undefined) continue;
            const prior = shoebox.get(r.id1);
            if(prior === undefined || iso < prior) shoebox.set(r.id1, iso);
        }
        const out: EntryCreation[] = [];
        for(const r of db().all<{valid_from: number, id1: number, username: string|null}, any>(
            `SELECT valid_from, id1, change_by_username AS username FROM dict
             WHERE ty2 IS NULL AND ty1 = 'ent' AND ty = 'ent'
               AND replaces_assertion_id IS NULL`, {})) {
            if(!publicIds.has(r.id1)) continue;
            const d = resolveCreationDate(r.valid_from, shoebox.get(r.id1))
                ?? {year: 0, month: 0, day: 0};    // undated (see EntryCreation)
            out.push({...d, entry_id: r.id1, username: r.username ?? ''});
        }
        return out;
    }
}

/** The fetches' SQL shapes, exported so the plan test can pin them to their
 *  indexes with EXPLAIN QUERY PLAN (the same guard as feedQueryShapes - a
 *  schema change must not degrade the report to a table scan). */
export const activityQueryShapes = (tableName: string) => [
    `SELECT valid_from, id1, change_action, change_by_username
     FROM ${tableName}
     WHERE valid_from >= 1 AND valid_from <= 2
       AND id1 IS NOT NULL
       AND ${CHANGE_ROW}
       AND (change_by_username IS NULL OR change_by_username NOT LIKE '~%')
     ORDER BY valid_from DESC`,
    `SELECT id1, attr2 FROM ${tableName}
     WHERE ty3 = 'att' AND ty = 'att' AND attr1 = 'shoebox-date' AND valid_to = 1`,
    `SELECT valid_from, id1, change_by_username FROM ${tableName}
     WHERE ty2 IS NULL AND ty1 = 'ent' AND ty = 'ent' AND replaces_assertion_id IS NULL`,
];
