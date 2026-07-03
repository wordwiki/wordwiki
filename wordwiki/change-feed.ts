// deno-lint-ignore-file no-explicit-any
/**
 * The global change feed (publication-model.md): every human change to the
 * dictionary, newest first, so a reviewer can scroll back as far as they have
 * seen before.  The feed is a STABLE chronological record - settling a change
 * updates its status badge, never its position (the receipts principle at
 * global scale: a pending-only queue would reflow under the reviewer and
 * destroy their positional memory).
 *
 * Events are CLUMPED: consecutive changes to one lexeme by one editor, each
 * within 30 minutes of the previous, form one titled block (the natural shape
 * of an edit session - especially the common new-word case).  A change to the
 * same lexeme by anyone else closes the clump; the editor's work on OTHER
 * lexemes in between does not.
 *
 * The page is a PURE FUNCTION of one {}-literal route argument (feedQuery, a
 * FieldSet): wordwiki.changes({from_time, to_time, max_rows,
 * restrict_to_user}) - so every view is bookmarkable, refreshable and
 * shareable, including scroll-back depth.  The filters (from/to/user) define
 * the query; max_rows is the depth knob: "Show older" is the SAME view with
 * max_rows bumped, swapped in place (htmx into #content) with the URL
 * updated via hx-replace-url - no full page re-render, no scroll jump
 * (valid_from is append-only, so the deeper page's shared prefix re-renders
 * identically), and Back leaves the page rather than un-scrolling.  Filter
 * changes go through the auto-generated dialog (the FieldSet's own fields)
 * and applyFilter's navigate action - a REAL navigation, so Back walks
 * filter history.  A visit with no to_time redirects to the canonical URL
 * with it stamped at the db's top tx timestamp - to_time doubles as the
 * review-sitting anchor carried into the entry links, so every lexeme opened
 * from the feed shows receipts for everything settled this sitting.
 *
 * Approving happens IN the lexeme (review mode has the diff context and the
 * two-person gate); the feed is for finding work.  Entry links open a new
 * tab - pages are served no-store (Back re-requests, losing appended slices
 * and scroll), so the feed tab must never navigate away.  Returning to it
 * fires an htmx reload of just the clumps that were clicked into.
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
import {isAutomatedUsername} from './user.ts';
import {classifyFact, latestContentVersion} from './versioned-model.ts';
import {renderChangeGroup, type ChangeEvent, type ChangeGroup} from './change-list.ts';
import type {WordWiki} from './wordwiki.ts';

// All feed routes live under /ww/ (see lexeme-editor.ts R).
const F = '/ww/wordwiki.feed';

// The SQL predicate for "this row is a human CHANGE" (vs the born-published
// standing corpus): it supersedes a prior version (edit / approve / revert /
// comment), is a still-pending creation, or is a deletion tombstone.  A
// published original creation that is none of these is bulk-import/backfill
// content, which must not appear in a recent-changes feed.
const CHANGE_ROW =
    `(replaces_assertion_id IS NOT NULL OR published_from IS NULL OR valid_to = valid_from)`;

// ---------------------------------------------------------------------------
// --- The page query ----------------------------------------------------------
// ---------------------------------------------------------------------------

// How many events one "page" of depth aims to show (whole clumps, so a page
// runs over) - both the max_rows default and the Show-older increment.
export const FEED_PAGE_ROWS = 50;

// The user filter: offered as the known-editor dropdown, but the VALUE is a
// free username - change_by_username is free text, and historic rows carry
// identities outside today's editor map, which must stay filterable (by URL).
class UserField extends EnumField {
    override fromLiteral(v: any): any {
        if(typeof v !== 'string')
            throw new Error(`${this.name}: expected a username string`);
        return v;
    }
}
const feedUsers: Record<string, string> = Object.fromEntries(
    Object.entries(entrySchema.users)
        .filter(([u, _]) => !isAutomatedUsername(u) && u !== '___'));

/** The feed's page-query schema: the page is a pure function of this one
 *  {}-literal route argument, and the filter dialog is generated from these
 *  same fields (one schema mechanism - see FieldSet). */
export const feedQuery = new FieldSet('feed_query', [
    new TimestampField('from_time', {nullable: true, prompt: 'From'}),
    new TimestampField('to_time', {nullable: true, prompt: 'To'}),
    new UserField('restrict_to_user', feedUsers, {nullable: true, prompt: 'Only changes by'}),
    new IntegerField('max_rows', {nullable: true, default: FEED_PAGE_ROWS, prompt: 'Max rows'}),
]);

export interface FeedQuery extends Tuple {
    from_time: number|null;
    to_time: number|null;
    restrict_to_user: string|null;
    max_rows: number;
}

// ---------------------------------------------------------------------------
// --- Clumping (pure - the unit the feed renders and pages by) ---------------
// ---------------------------------------------------------------------------

/** One human change, as the light row the feed query returns (the full
 *  assertion chain is only hydrated per rendered clump). */
export interface FeedEvent {
    valid_from: number;
    id: number;          // the fact id
    entry_id: number;    // id1 - the containing entry
    username: string;    // change_by_username, '' when unstamped
}

/** An edit session: one editor's consecutive changes to one lexeme. */
export interface FeedClump {
    entry_id: number;
    username: string;
    events: FeedEvent[];   // oldest first
    from: number;          // valid_from of the oldest event
    to: number;            // valid_from of the newest event
}

/** The clump gap, compared on the WALL-TIME component of the timestamps
 *  (they are hybrid logical clocks: ordering is total and monotonic, the
 *  embedded wall time is best-effort - under a stalled-clock anomaly gaps
 *  read as ~0 and clumps merge rather than split, the benign direction). */
export const CLUMP_GAP_SECONDS = 30 * 60;

/** Clump feed events (any order in, see FeedClump).  A clump extends while
 *  the SAME editor's next change to the SAME lexeme comes within
 *  CLUMP_GAP_SECONDS of their previous one; any other editor's change to
 *  that lexeme closes it (their event starts its own clump).  Clumps are
 *  returned newest-activity-first; events within a clump oldest-first. */
export function clumpFeedEvents(events: FeedEvent[]): FeedClump[] {
    const asc = [...events].sort((a, b) => a.valid_from - b.valid_from);
    const open = new Map<number, FeedClump>();   // entry_id -> growing clump
    const done: FeedClump[] = [];
    for(const e of asc) {
        const o = open.get(e.entry_id);
        const gap = o ? timestamp.extractTimeFromTimestamp(e.valid_from)
                      - timestamp.extractTimeFromTimestamp(o.to) : 0;
        if(o && o.username === e.username && gap <= CLUMP_GAP_SECONDS) {
            o.events.push(e);
            o.to = e.valid_from;
        } else {
            if(o) done.push(o);
            open.set(e.entry_id, {entry_id: e.entry_id, username: e.username,
                                  events: [e], from: e.valid_from, to: e.valid_from});
        }
    }
    done.push(...open.values());
    return done.sort((a, b) => b.to - a.to);
}

/** Cut one page out of the clumped window: keep whole clumps, newest first,
 *  until ~targetEvents, then close the page at a timestamp C such that the
 *  page shows EXACTLY the events with valid_from >= C (so nextBefore = C-1
 *  covers everything else - no event can fall between pages).  Because clump
 *  timespans interleave, C is a fixpoint: any clump with activity above C is
 *  kept whole, which may push C lower.  `fetchedAll` = the window reached the
 *  beginning of the record (no more rows below it).
 *
 *  A clump can still straddle the FETCH horizon (a session longer than the
 *  fetched window); its older remainder then appears on the next page under a
 *  repeated header - accepted, rare, and self-healing. */
export function cutFeedSlice(clumps: FeedClump[], targetEvents: number,
                             fetchedAll: boolean):
        {kept: FeedClump[], nextBefore: number|undefined} {
    if(clumps.length === 0)
        return {kept: [], nextBefore: undefined};
    let n = 0, cutIdx = 0;
    for(let i = 0; i < clumps.length; i++) {
        n += clumps[i].events.length;
        cutIdx = i + 1;
        if(n >= targetEvents) break;
    }
    let C = Math.min(...clumps.slice(0, cutIdx).map(c => c.from));
    for(;;) {
        const nc = Math.min(...clumps.filter(c => c.to >= C).map(c => c.from));
        if(nc >= C) break;
        C = nc;
    }
    const kept = clumps.filter(c => c.to >= C);
    const anyBelow = !fetchedAll || clumps.length > kept.length;
    return {kept, nextBefore: anyBelow ? C - 1 : undefined};
}

/** A user's display name (mirrors the lexeme editor's userLabel). */
function userLabel(username: string): string {
    return username ? (entrySchema.users[username] ?? username) : 'unknown';
}

// Marks the clumps a reviewer clicked into, and reloads JUST those fragments
// when they return to the feed tab (entry links open in a new tab, so the
// feed's DOM - appended slices, scroll - survives untouched).
const FEED_RELOAD_SCRIPT = `
(function(){
    var opened = [];
    document.addEventListener('click', function(ev){
        var a = ev.target instanceof Element ? ev.target.closest('a.lm-feed-entry-link') : null;
        if(!a) return;
        var clump = a.closest('.lm-feed-clump');
        if(clump) opened.push(clump);
    });
    window.addEventListener('focus', function(){
        opened.forEach(function(el){ if(el.isConnected) htmx.trigger(el, 'reload'); });
        opened = [];
    });
})();
`;

// ---------------------------------------------------------------------------
// --- The feed ----------------------------------------------------------------
// ---------------------------------------------------------------------------

// How many rows past max_rows the window fetch reads, so the cut can complete
// clumps and know whether more exists below.
const FEED_FETCH_SLACK = 350;

export class ChangeFeed {

    constructor(public app: WordWiki) {
    }

    /** The feed page: a pure function of its one query argument.  A visit
     *  with no to_time redirects to the canonical URL with it stamped at the
     *  db's top tx timestamp (see the module comment). */
    @route(authenticated)
    changesPage(q?: Record<string, any>): templates.Page | server.Response {
        const query = feedQuery.normalize(q) as FeedQuery;
        if(query.to_time == null) {
            query.to_time = this.app.lastAllocatedTxTimestamp;
            return server.forwardResponse(
                `/ww/wordwiki.changes(${feedQuery.literal(query)})`);
        }
        const body = ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-3 flex-wrap'},
             ['h2', {class: 'mb-0 me-2'}, 'Recent changes'],
             this.filterSummary(query),
             action.actionButton('Filter…',
                 {kind: 'modal', dialogUrl: `${F}.filterDialog(${feedQuery.literal(query)})`},
                 'btn btn-sm btn-outline-secondary')],
            ['script', {}, FEED_RELOAD_SCRIPT],
            ['div', {class: 'lm-changelist lm-changelist-grouped'},
             this.renderFeed(query)]];
        return templates.page('Recent changes', body);
    }

    // The active filters, stated quietly next to the heading (the dialog is
    // the editor; this is the reminder that a filter is on).
    private filterSummary(query: FeedQuery): Markup {
        const parts: string[] = [];
        if(query.restrict_to_user) parts.push(`by ${userLabel(query.restrict_to_user)}`);
        if(query.from_time) parts.push(`after ${timestamp.formatTimestampAsLocalTime(query.from_time)}`);
        return parts.length > 0
            ? ['span', {class: 'text-muted small'}, parts.join(' · ')] : [];
    }

    /** The filter dialog: the query's OWN fields, auto-generated - the
     *  FieldSet is both the URL codec and the dialog schema.  Submit posts
     *  the complete new state to applyFilter. */
    @route(authenticated)
    filterDialog(q?: Record<string, any>): Markup {
        const query = feedQuery.normalize(q);
        return [
            ['script', {}, 'setTimeout(showModalEditor)'],
            action.renderParamForm(feedQuery.fields, query, {
                title: 'Filter the change feed',
                submitLabel: 'Apply',
                dispatch: {id: 'edit-form',
                           onsubmit: 'event.preventDefault(); tx`wordwiki.feed.applyFilter(${getFormJSON(event.target)})`'},
            })];
    }

    /** Apply the dialog's state: navigate to the canonical URL for it (a real
     *  navigation - filter changes are distinct views, Back walks them).  A
     *  cleared To falls back to changesPage's stamping redirect. */
    @route(authenticated)
    applyFilter(form: Record<string, any>): any {
        const query = feedQuery.parseFormValues(form);
        return {action: 'navigate',
                url: `/ww/wordwiki.changes(${feedQuery.literal(query)})`};
    }

    /** The feed body for one query: the clumps (each its own reloadable
     *  fragment), then the Show-older control - the SAME view with max_rows
     *  bumped, swapped into #content with the URL replaced, so depth is
     *  always in the URL (refresh keeps it) without a page re-render or a
     *  scroll jump. */
    renderFeed(query: FeedQuery): Markup {
        const limit = query.max_rows + FEED_FETCH_SLACK;
        const rows = this.fetchFeedEvents(query, limit);
        const clumps = clumpFeedEvents(rows);
        const {kept, nextBefore} = cutFeedSlice(clumps, query.max_rows, rows.length < limit);
        const anchor = query.to_time ?? 0;
        const moreUrl = nextBefore === undefined ? undefined
            : `/ww/wordwiki.changes(${feedQuery.literal(
                  {...query, max_rows: query.max_rows + FEED_PAGE_ROWS})})`;
        const groups = kept.map(c => this.clumpGroup(c, anchor)).filter(g => g !== null);
        return ['div', {class: 'lm-feed'},
            groups.map(g => renderChangeGroup(g!)),
            ['div', {class: 'lm-feed-more mt-2'},
             moreUrl === undefined
                ? ['div', {class: 'text-muted small'},
                   groups.length === 0 ? 'No changes.'
                   : query.from_time ? 'Start of the selected range.'
                   : 'Beginning of the record.']
                : ['button', {type: 'button', class: 'btn btn-sm btn-outline-secondary',
                              'hx-get': moreUrl, 'hx-target': '#content',
                              'hx-swap': 'innerHTML', 'hx-replace-url': moreUrl},
                   'Show older']]];
    }

    /** One clump as its OWN reloadable fragment (the review-group pattern):
     *  the past is immutable, so a reload re-renders the same events - what
     *  changes is their STATUS (approvals landed while the reviewer was in
     *  the lexeme), refreshed without touching the rest of the feed. */
    @route(authenticated)
    renderFeedClump(entry_id: number, from: number, to: number, anchor: number = 0): Markup {
        const rows = this.fetchEntryEvents(entry_id, from, to);
        return clumpFeedEvents(rows)
            .map(c => this.clumpGroup(c, anchor))
            .filter(g => g !== null)
            .map(g => renderChangeGroup(g!));
    }

    // A clump's ChangeGroup, or null when it carries no actual change events
    // (every in-range row rendered as a baseline - the standing value, no
    // event).  Events are built once here and reused for the badge counts.
    private clumpGroup(c: FeedClump, anchor: number): ChangeGroup | null {
        const events = this.clumpEvents(c);
        if(events.length === 0) return null;
        return {
            attrs: {
                class: `-feed-clump-${c.entry_id}-${c.to}- lm-cl-group lm-feed-clump`,
                'hx-get': `${F}.renderFeedClump(${c.entry_id}, ${c.from}, ${c.to}, ${anchor})`,
                'hx-trigger': 'reload', 'hx-swap': 'outerHTML',
            },
            header: this.clumpHeader(c, anchor),
            events,
            showSubject: true,   // multiple facts per clump: lines carry their field
        };
    }

    // The clump header: the lexeme (headword + glosses) linking into its
    // review mode - in a NEW TAB, anchored at the feed's sitting - then WHEN
    // (this is a chrono feed, so the time reads prominently: relative, in the
    // default color, right after the title; the exact time is its tooltip),
    // the editor (quiet), and the facts' CURRENT status badges.
    private clumpHeader(c: FeedClump, anchor: number): Markup {
        const e = this.app.entriesById.get(c.entry_id);
        const title: Markup = e ? entrySchema.renderEntryCompactSummaryCore(e)
                                : `Entry ${c.entry_id}`;
        return ['div', {class: 'd-flex align-items-center gap-2 flex-wrap'},
                ['a', {class: 'lm-feed-entry-link lm-cl-field',
                       href: `/ww/wordwiki.lexeme.entryPage(${c.entry_id},'review',${anchor})`,
                       target: '_blank'},
                 title],
                ['span', {class: 'lm-feed-when small',
                          title: timestamp.formatTimestampAsLocalTime(c.to)},
                 timestamp.formatTimestampRelative(c.to)],
                ['span', {class: 'text-muted small'}, userLabel(c.username)],
                this.clumpStatusBadges(c)];
    }

    // Per-fact CURRENT classification, folded to badge counts.  A fact's
    // status can move after the clump (approved later, edited again): the
    // badges always show where it stands now.
    private clumpStatusBadges(c: FeedClump): Markup {
        let pending = 0, approved = 0, rejected = 0;
        for(const fact_id of new Set(c.events.map(ev => ev.id))) {
            let versions;
            try {
                versions = this.app.lexemeOps.findTupleInEntry(c.entry_id, fact_id)
                    .tupleVersions.map(v => v.assertion);
            } catch { continue; }   // fact no longer reachable in the workspace
            if(versions.length === 0) continue;
            const s = classifyFact(versions, timestamp.END_OF_TIME).state;
            if(s === 'added' || s === 'edited' || s === 'removed') { pending++; continue; }
            const action = latestContentVersion(versions)?.change_action;
            if(action === 'approved') approved++;
            else if(action === 'reverted') rejected++;
        }
        const badge = (n: number, label: string, cls: string): Markup =>
            n > 0 ? ['span', {class: `badge ${cls}`}, `${n} ${label}`] : [];
        return [badge(pending, 'pending', 'text-bg-warning'),
                badge(approved, 'approved ✓', 'text-bg-success'),
                badge(rejected, 'rejected', 'text-bg-secondary')];
    }

    // The clump's event lines, from the same builder review mode uses (full
    // per-fact chains, imported base set hidden), restricted to the clump's
    // time range.  All in-range events on this entry are the clump's - any
    // other editor's event would have closed it.
    private clumpEvents(c: FeedClump): ChangeEvent[] {
        const events: ChangeEvent[] = [];
        let entryTuple;
        try {
            entryTuple = this.app.lexemeOps.entryTuple(c.entry_id);
        } catch {
            return [];   // entry no longer in the workspace
        }
        entryTuple.forEachVersionedTuple((t: any) => {
            if(t.tupleVersions.length === 0) return;
            if(!t.tupleVersions.some((v: any) =>
                v.assertion.valid_from >= c.from && v.assertion.valid_from <= c.to)) return;
            for(const ev of this.app.lexeme.factChangeEvents(t.schema, t, true, true))
                // In range, and an actual CHANGE: a baseline is the standing
                // accepted value (a state, not an event), so it never belongs
                // in a "recent changes" feed.
                if(ev.when >= c.from && ev.when <= c.to && ev.kind !== 'baseline')
                    events.push(ev);
        });
        events.sort((a, b) => a.when - b.when);
        return events;
    }

    // ------------------------------------------------------------------------
    // --- Queries --------------------------------------------------------------
    // ------------------------------------------------------------------------
    //
    // Both are index ranges (dict_valid_from / dict_by_id_ty1), so cost is
    // proportional to the rows in the requested window - never a table scan
    // (change-feed_test.ts pins the plans).  The imported base set
    // (valid_from = BEGINNING_OF_TIME) and automated '~' identities are
    // excluded in SQL, matching the review UI's isImportedEvent - AND so is
    // the born-published corpus (CHANGE_ROW): a published original creation
    // with no predecessor is the dictionary's STANDING CONTENT (the backfill /
    // bulk import), not recent human activity.  A real change either
    // supersedes a prior version (edit / approve / revert / comment), is a
    // still-pending creation, or is a deletion tombstone.

    /** The window fetch: the newest `limit` human changes matching the query
     *  filters (at or below to_time; at or above from_time when set;
     *  optionally one editor's). */
    private fetchFeedEvents(query: FeedQuery, limit: number): FeedEvent[] {
        const params: Record<string, any> = {to_time: query.to_time};
        if(query.from_time != null) params.from_time = query.from_time;
        if(query.restrict_to_user) params.restrict_to_user = query.restrict_to_user;
        const rows = db().all<{valid_from: number, id: number, entry_id: number,
                               username: string|null}, any>(
            `SELECT valid_from, id, id1 AS entry_id, change_by_username AS username
             FROM dict
             WHERE valid_from <= :to_time AND valid_from > ${timestamp.BEGINNING_OF_TIME}
               ${query.from_time != null ? 'AND valid_from >= :from_time' : ''}
               AND id1 IS NOT NULL
               AND ${CHANGE_ROW}
               AND (change_by_username IS NULL OR change_by_username NOT LIKE '~%')
               ${query.restrict_to_user ? 'AND change_by_username = :restrict_to_user' : ''}
             ORDER BY valid_from DESC
             LIMIT ${limit}`,
            params);
        return rows.map(r => ({...r, username: r.username ?? ''}));
    }

    /** One entry's human changes in a closed range (the clump-reload fetch). */
    private fetchEntryEvents(entry_id: number, from: number, to: number): FeedEvent[] {
        const rows = db().all<{valid_from: number, id: number, entry_id: number,
                               username: string|null}, any>(
            `SELECT valid_from, id, id1 AS entry_id, change_by_username AS username
             FROM dict
             WHERE id1 = :entry_id
               AND valid_from >= :from AND valid_from <= :to
               AND valid_from > ${timestamp.BEGINNING_OF_TIME}
               AND ${CHANGE_ROW}
               AND (change_by_username IS NULL OR change_by_username NOT LIKE '~%')
             ORDER BY valid_from DESC`,
            {entry_id, from, to});
        return rows.map(r => ({...r, username: r.username ?? ''}));
    }
}

/** The two feed queries' SQL shapes, exported so the plan test can pin them
 *  to their indexes with EXPLAIN QUERY PLAN (the same guard as
 *  highestTimestampQueries - a schema change must not degrade the feed to a
 *  table scan). */
export const feedQueryShapes = (tableName: string) => [
    `SELECT valid_from, id, id1, change_by_username FROM ${tableName}
     WHERE valid_from <= 2 AND valid_from > 1
       AND id1 IS NOT NULL
       AND ${CHANGE_ROW}
       AND (change_by_username IS NULL OR change_by_username NOT LIKE '~%')
     ORDER BY valid_from DESC LIMIT 100`,
    `SELECT valid_from, id, id1, change_by_username FROM ${tableName}
     WHERE id1 = 1 AND valid_from >= 1 AND valid_from <= 2
       AND ${CHANGE_ROW}
       AND (change_by_username IS NULL OR change_by_username NOT LIKE '~%')
     ORDER BY valid_from DESC`,
];
