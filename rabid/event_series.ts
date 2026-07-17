// Recurring events / event series - see repo-root recurring-events.md.
//
// This file starts with the PURE, db-free core: the controlled vocabularies and
// the occurrence-date computation.  Everything downstream (materialization,
// reconcile, the schedule block) builds on `occurrenceDates`, so it is worth
// keeping small and exhaustively tested.

import { Temporal } from 'temporal-polyfill';
import * as date from '../liminal/date.ts';
import { Table, PrimaryKeyField, StringField, EnumField, BooleanField, DateField, TimeField,
         ForeignKeyField, liveReloadableProps, type Tuple } from '../liminal/table.ts';
import { VolunteerForeignKeyField } from './volunteer-activity.ts';
import { event_kind_enum, type Event } from './event.ts';
import * as security from '../liminal/security.ts';
import { route, routeMutation, authenticated } from '../liminal/security.ts';
import { db } from '../liminal/db.ts';
import { block } from '../liminal/strings.ts';
import { path } from '../liminal/serializable.ts';
import * as action from '../liminal/action.ts';
import * as templates from './templates.ts';
import { h, type Markup } from '../liminal/markup.ts';
import * as dirty from '../liminal/dirty.ts';
import { rabid } from './rabid.ts';

const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

// A human summary of a series' recurrence ("Every Saturday · 10:00–15:00 · Victoria Park").
export function seriesSummary(s: EventSeries): string {
    if(s.frequency === 'none') return 'One-off template';
    const wd = s.weekday ? weekday_enum[s.weekday] : '?';
    const when = s.frequency === 'monthly'
        ? `${week_of_month_enum[s.week_of_month ?? 'first'] ?? '?'} ${wd} monthly`
        : `Every ${wd}`;
    const time = s.start_time_of_day
        ? ` · ${s.start_time_of_day}${s.end_time_of_day ? '–' + s.end_time_of_day : ''}` : '';
    const loc = s.location_description ? ` · ${s.location_description}` : '';
    const win = s.effective_start
        ? ` · ${s.effective_start}${s.effective_end ? ' to ' + s.effective_end : ' onward'}` : '';
    return when + time + loc + win;
}

// 'HH:MM' -> a friendly 12-hour time ('10:00' -> '10:00 AM').
function fmt12(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    const ap = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

// --- Controlled vocabularies (string enums, so they use the standard EnumField
//     picker + auto-form; see recurring-events.md) --------------------------------

export const frequency_enum: Record<string, string> = {
    none: 'One-off (template)', weekly: 'Weekly', monthly: 'Monthly',
};
export const weekday_enum: Record<string, string> = {
    monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
    friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};
export const week_of_month_enum: Record<string, string> = {
    first: 'First', second: 'Second', third: 'Third', fourth: 'Fourth', last: 'Last',
};

// weekday key -> Temporal dayOfWeek (Mon=1 .. Sun=7).
const WEEKDAY_DOW: Record<string, number> = {
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};
// week_of_month key -> the nth occurrence (1..4); 'last' is handled separately.
const WEEK_OF_MONTH_NTH: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4,
};

// --- The recurrence rule (the subset of an event_series that drives dates) -------

export interface RecurrenceRule {
    frequency: string;              // frequency_enum
    weekday?: string | null;        // weekday_enum (weekly + monthly)
    week_of_month?: string | null;  // week_of_month_enum (monthly only)
    effective_start: string;        // sqlite date (inclusive)
    effective_end?: string | null;  // sqlite date (inclusive); null = open-ended
}

// --- Occurrence-date computation -------------------------------------------------

const cmp = Temporal.PlainDate.compare;
const maxDate = (a: date.PlainDate, b: date.PlainDate) => (cmp(a, b) >= 0 ? a : b);
const minDate = (a: date.PlainDate, b: date.PlainDate) => (cmp(a, b) <= 0 ? a : b);

// The nth (1..4) `dow` of a month.  nth<=4 always exists.
function nthWeekdayOfMonth(year: number, month: number, nth: number, dow: number): date.PlainDate {
    const first = Temporal.PlainDate.from({year, month, day: 1});
    const delta = (dow - first.dayOfWeek + 7) % 7;      // days to the first `dow`
    return first.add({days: delta + (nth - 1) * 7});
}

// The LAST `dow` of a month.
function lastWeekdayOfMonth(year: number, month: number, dow: number): date.PlainDate {
    const last = Temporal.PlainDate.from({year, month, day: 1})
        .with({day: Temporal.PlainDate.from({year, month, day: 1}).daysInMonth});
    const delta = (last.dayOfWeek - dow + 7) % 7;       // days back to the last `dow`
    return last.subtract({days: delta});
}

/**
 * The dates a rule occurs on within [from, to] (inclusive), clamped to the rule's
 * own effective window.  Pure and db-free; skips (holiday exceptions) are applied
 * by the caller, not here.  A `frequency: 'none'` rule (a manual prototype) never
 * occurs.  Returns sqlite date strings in ascending order.
 */
export function occurrenceDates(rule: RecurrenceRule, from: string, to: string): string[] {
    if(rule.frequency === 'none' || !rule.effective_start) return [];
    const dow = rule.weekday ? WEEKDAY_DOW[rule.weekday] : undefined;
    if(dow === undefined) return [];   // weekly/monthly both need a weekday

    // Clamp the query range to the rule's window.
    let start = maxDate(date.sqliteDateToTemporal(from), date.sqliteDateToTemporal(rule.effective_start));
    const endBound = rule.effective_end ? date.sqliteDateToTemporal(rule.effective_end) : null;
    const end = endBound ? minDate(date.sqliteDateToTemporal(to), endBound) : date.sqliteDateToTemporal(to);
    if(cmp(start, end) > 0) return [];

    const out: string[] = [];
    if(rule.frequency === 'weekly') {
        // Advance to the first matching weekday, then step by 7.
        start = start.add({days: (dow - start.dayOfWeek + 7) % 7});
        for(let d = start; cmp(d, end) <= 0; d = d.add({days: 7}))
            out.push(date.temporalToSqliteDate(d));
        return out;
    }

    if(rule.frequency === 'monthly') {
        // Walk each month from start's month to end's month; take its nth/last `dow`.
        let ym = Temporal.PlainYearMonth.from({year: start.year, month: start.month});
        const endYm = Temporal.PlainYearMonth.from({year: end.year, month: end.month});
        for(; Temporal.PlainYearMonth.compare(ym, endYm) <= 0; ym = ym.add({months: 1})) {
            const occ = rule.week_of_month === 'last'
                ? lastWeekdayOfMonth(ym.year, ym.month, dow)
                : nthWeekdayOfMonth(ym.year, ym.month, WEEK_OF_MONTH_NTH[rule.week_of_month ?? 'first'] ?? 1, dow);
            if(cmp(occ, start) >= 0 && cmp(occ, end) <= 0)
                out.push(date.temporalToSqliteDate(occ));
        }
        return out;
    }

    return [];
}


// --- Schema: event_series + event_series_skip -----------------------------------

// The recurrence rule / prototype.  Mirrors the event PROTOTYPE fields (the subset
// an occurrence inherits); instance-only richness (cash, sign-ups, check-ins,
// service/sale rows) lives on the materialized events.  See recurring-events.md.
export interface EventSeries {
    event_series_id: number;
    description: string;
    event_kind: string;
    location_description: string;
    location_url: string;
    is_remote_event: number;
    volunteer_only: number;
    host_id?: number;
    start_time_of_day?: string;
    end_time_of_day?: string;
    setup_time_of_day?: string;
    shop_load_time_of_day?: string;
    frequency: string;
    weekday?: string;
    week_of_month?: string;
    effective_start?: string;
    effective_end?: string;
}
export type EventSeriesOpt = Partial<EventSeries>;

export class EventSeriesTable extends Table<EventSeries> {
    constructor() {
        super('event_series', [
            new PrimaryKeyField('event_series_id', {}),
            new StringField('description', {prompt: 'Name'}),
            new EnumField('event_kind', event_kind_enum, {}),
            new StringField('location_description', {default: ''}),
            new StringField('location_url', {default: ''}),
            new BooleanField('is_remote_event', {default: 0}),
            new BooleanField('volunteer_only', {default: 0}),
            new VolunteerForeignKeyField('host_id', {nullable: true, indexed: true, prompt: 'Default host'}),
            new TimeField('start_time_of_day', {nullable: true, prompt: 'Start time'}),
            new TimeField('end_time_of_day', {nullable: true, prompt: 'End time'}),
            new TimeField('setup_time_of_day', {nullable: true, prompt: 'Setup time'}),
            new TimeField('shop_load_time_of_day', {nullable: true, prompt: 'Shop-load time'}),
            new EnumField('frequency', frequency_enum, {default: 'weekly'}),
            // Weekday: for weekly + monthly.  Week-of-month: monthly only.  Progressive
            // disclosure hides the ones the frequency doesn't use.
            new EnumField('weekday', weekday_enum,
                {nullable: true, showWhen: {field: 'frequency', in: ['weekly', 'monthly']}}),
            new EnumField('week_of_month', week_of_month_enum,
                {nullable: true, showWhen: {field: 'frequency', in: ['monthly']}}),
            new DateField('effective_start',
                {nullable: true, prompt: 'Starts', showWhen: {field: 'frequency', in: ['weekly', 'monthly']}}),
            new DateField('effective_end',
                {nullable: true, prompt: 'Ends (blank = ongoing)', showWhen: {field: 'frequency', in: ['weekly', 'monthly']}}),
        ]);
    }

    // All series, most-recently-created first (the admin list).
    @path
    get listAll() {
        return this.prepare<EventSeries, Tuple>(block`
/**/   SELECT ${this.allFields} FROM event_series ORDER BY event_series_id DESC`);
    }

    // --- Materialization (the create path) ---------------------------------------

    // The event tuple an occurrence on `day` inherits from this series' prototype.
    private toEventValues(s: EventSeries, day: string): Partial<Event> {
        const at = (t?: string) => (t ? `${day} ${t}:00` : undefined);
        return {
            event_kind: s.event_kind, description: s.description,
            location_description: s.location_description ?? '', location_url: s.location_url ?? '',
            is_remote_event: s.is_remote_event ?? 0, volunteer_only: s.volunteer_only ?? 0,
            host_id: s.host_id ?? undefined,
            shop_load_time: at(s.shop_load_time_of_day), setup_time: at(s.setup_time_of_day),
            start_time: at(s.start_time_of_day), end_time: at(s.end_time_of_day),
            is_catch_all: 0, total_cash_collected: 0, notes: '', series_id: s.event_series_id,
        };
    }

    /**
     * Create any MISSING event instances for a series within [from, to] - the
     * occurrence dates, minus skips, minus already-materialized dates.  Idempotent
     * and race-safe (the (series, occurrence-day) unique index closes the residual
     * check-then-insert race).  Never modifies or deletes.  Returns the count
     * created.  Also the bulk-import path: call over a PAST window.
     */
    materialize(series_id: number, from: string, to: string): number {
        return security.runSystem(() => {
            const s = this.getById(series_id);
            if(s.frequency === 'none' || !s.start_time_of_day) return 0;
            const rule: RecurrenceRule = {
                frequency: s.frequency, weekday: s.weekday, week_of_month: s.week_of_month,
                effective_start: s.effective_start ?? '', effective_end: s.effective_end,
            };
            const dates = occurrenceDates(rule, from, to);
            if(dates.length === 0) return 0;
            const skips = rabid.event_series_skip.skipDates(series_id);
            const existing = new Set(db().prepare<{d: string}, {sid: number, from: string, to: string}>(
                'SELECT date(start_time) AS d FROM event WHERE series_id = :sid AND date(start_time) BETWEEN :from AND :to')
                .all({sid: series_id, from, to}).map(r => r.d));
            let created = 0;
            for(const day of dates) {
                if(skips.has(day) || existing.has(day)) continue;
                try { rabid.event.insert(this.toEventValues(s, day)); created++; }
                catch { /* a concurrent run won the (series, day) unique race - fine */ }
            }
            return created;
        });
    }

    private ruleOf(s: EventSeries): RecurrenceRule {
        return {
            frequency: s.frequency, weekday: s.weekday, week_of_month: s.week_of_month,
            effective_start: s.effective_start ?? '', effective_end: s.effective_end,
        };
    }

    // An instance is "committed" (never auto-deleted) if anyone signed up / checked
    // in, or service/sales were logged, or cash was recorded.
    private eventHasActivity(event_id: number): boolean {
        const row = db().prepare<{n: number}, {id: number}>(block`
/**/   SELECT (
/**/            EXISTS(SELECT 1 FROM event_commitment WHERE event_id = :id)
/**/         OR EXISTS(SELECT 1 FROM event_checkin    WHERE event_id = :id)
/**/         OR EXISTS(SELECT 1 FROM service          WHERE event_id = :id)
/**/         OR EXISTS(SELECT 1 FROM sale             WHERE event_id = :id)
/**/         OR EXISTS(SELECT 1 FROM event WHERE event_id = :id AND total_cash_collected > 0)
/**/          ) AS n`).first({id: event_id});
        return !!(row && row.n);
    }

    /**
     * Bring a series' FUTURE into line with its (possibly edited) rule: create
     * missing occurrences forward, and delete future instances that no longer match
     * (rule changed, window shortened, or now skipped) - but ONLY those with no
     * activity, and NEVER anything today-or-past.  Forward-only: it never MODIFIES
     * an existing instance (a rule change applies going forward).  See recurring-
     * events.md - this create/delete-only-never-modify line is load-bearing.
     */
    reconcile(series_id: number, horizonDays = 35): {created: number, deleted: number} {
        return security.runSystem(() => {
            const s = this.getById(series_id);
            const today = date.temporalToSqliteDate(date.orgToday());
            const horizon = date.temporalToSqliteDate(date.orgToday().add({days: horizonDays}));
            const created = this.materialize(series_id, today, horizon);

            const rule = this.ruleOf(s);
            const skips = rabid.event_series_skip.skipDates(series_id);
            let deleted = 0;
            const future = db().prepare<{event_id: number, d: string}, {sid: number, today: string}>(
                'SELECT event_id, date(start_time) AS d FROM event WHERE series_id = :sid AND date(start_time) > :today')
                .all({sid: series_id, today});
            for(const {event_id, d} of future) {
                const stillValid = !skips.has(d) && occurrenceDates(rule, d, d).length > 0;
                if(!stillValid && !this.eventHasActivity(event_id)) { rabid.event.delete(event_id); deleted++; }
            }
            return {created, deleted};
        });
    }

    /**
     * Materialize every active recurring series from today out to the horizon
     * (default ~5 weeks).  The self-maintaining entry point.  Returns total created.
     */
    ensureMaterialized(horizonDays = 35): number {
        return security.runSystem(() => {
            const today = date.temporalToSqliteDate(date.orgToday());
            const horizon = date.temporalToSqliteDate(date.orgToday().add({days: horizonDays}));
            let total = 0;
            for(const s of this.activeRecurring.all({today}))
                total += this.materialize(s.event_series_id, today, horizon);
            return total;
        });
    }

    // Once-a-day guard: run ensureMaterialized at most once per org day (memoized on
    // this singleton - the @path getter returns the same stamped instance).  Called
    // from the events page, so the first view after startup, and the first view of
    // each new day, self-maintain; every other request is a cheap string compare.
    // Deliberately NOT a write on every read (recurring-events.md decision 4).
    private lastMaterializedDay: string | undefined = undefined;
    maybeMaterialize(): void {
        const today = date.temporalToSqliteDate(date.orgToday());
        if(this.lastMaterializedDay === today) return;
        this.lastMaterializedDay = today;
        try { this.ensureMaterialized(); }
        catch(e) { console.warn('event series materialize failed:', e); }
    }

    // The active recurring series (drive the schedule + materialization): a real
    // frequency, and today within the window.  `:today` is a sqlite date.
    @path
    get activeRecurring() {
        return this.prepare<EventSeries, {today: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event_series
/**/          WHERE frequency <> 'none'
/**/            AND (effective_end IS NULL OR effective_end >= :today)
/**/          ORDER BY event_series_id`);
    }

    // --- Public schedule (rendered from RULES, no materialization) ---------------

    // The next occurrence of a series on/after `today`, minus skips (within a 1-year
    // look-ahead).  Pure - reads only the rule + skips.
    private nextOccurrence(s: EventSeries, today: string): string | undefined {
        const skips = rabid.event_series_skip.skipDates(s.event_series_id);
        const horizon = date.temporalToSqliteDate(date.orgToday().add({days: 366}));
        return occurrenceDates(this.ruleOf(s), today, horizon).find(d => !skips.has(d));
    }

    // The public recurring-events schedule.  Renders the ACTIVE series (the rules),
    // each with its cadence, location, next date, and any upcoming skip - so it is
    // correct with zero dependence on materialized instances.  Used by the
    // `rabid-schedule` site block.
    renderPublicSchedule(): Markup {
        const today = date.temporalToSqliteDate(date.orgToday());
        const series = security.runSystem(() => this.activeRecurring.all({today}));
        if(series.length === 0) return '' as unknown as Markup;
        return [h.div, {class: 'rrbr-schedule'},
            series.map(s => this.scheduleRow(s, today))];
    }

    private scheduleRow(s: EventSeries, today: string): Markup {
        const wd = s.weekday ? weekday_enum[s.weekday] : '';
        const cadence = s.frequency === 'monthly'
            ? `${week_of_month_enum[s.week_of_month ?? 'first'] ?? ''} ${wd} of the month`
            : `${wd}s`;
        const time = s.start_time_of_day
            ? `${fmt12(s.start_time_of_day)}${s.end_time_of_day ? '–' + fmt12(s.end_time_of_day) : ''}` : '';
        const next = this.nextOccurrence(s, today);
        const upcomingSkips = security.runSystem(() =>
            rabid.event_series_skip.forSeries.all({event_series_id: s.event_series_id})
                .filter(sk => sk.skip_date >= today));
        return [h.div, {class: 'rrbr-schedule-row'},
            [h.div, {class: 'rrbr-schedule-name'}, s.description || 'Event'],
            [h.div, {class: 'rrbr-schedule-when'},
             cadence, time ? [h.span, {class: 'rrbr-schedule-time'}, ` · ${time}`] : undefined],
            s.location_description ? [h.div, {class: 'rrbr-schedule-loc'}, s.location_description] : undefined,
            next ? [h.div, {class: 'rrbr-schedule-next'}, `Next: ${date.sqliteDateToString(next)}`] : undefined,
            upcomingSkips.length
                ? [h.ul, {class: 'rrbr-schedule-skips'}, upcomingSkips.map(sk =>
                    [h.li, {}, `No session ${date.sqliteDateToString(sk.skip_date)}${sk.reason ? ` — ${sk.reason}` : ''}`])]
                : undefined];
    }

    // --- Admin UI (host/admin) ---------------------------------------------------

    override defaultFieldEdit: security.Permission = hostOrAdmin;

    private canManage(): boolean {
        const ctx = security.current();
        return !!(ctx?.system || ctx?.roles.has('host') || ctx?.roles.has('admin'));
    }

    // The admin list page (recurring series + one-off templates).
    @route(authenticated)
    renderSeriesPage(): Markup {
        return [h.div, {class: 'container py-3', 'data-testid': 'event-series-page'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-2'},
             [h.h2, {class: 'mb-0'}, 'Event series & templates'],
             this.canManage() ? action.actionButton('New series',
                 {kind: 'modal', dialogUrl: `/${this}.newDialog()`}, 'btn btn-outline-primary btn-sm') : undefined],
            [h.p, {class: 'text-muted small'},
             'Recurring series drive the public schedule and auto-populate the events list; ' +
             'one-off templates are prototypes you clone into a single event.'],
            this.renderSeriesList()];
    }

    // The list body: a live fragment on the table key, so create/delete refresh it.
    @route(authenticated)
    renderSeriesList(): Markup {
        const props = liveReloadableProps([this.tableKey()], `${this}.renderSeriesList()`);
        const list = security.runSystem(() => this.listAll.all({}));
        return [h.div, {...props, class: props.class + ' list-group lm-list'},
            list.length === 0
                ? [h.div, {class: 'text-muted p-2'}, 'No series yet.']
                : list.map(s => this.renderSeriesRow(s.event_series_id))];
    }

    @route(authenticated)
    renderSeriesRow(event_series_id: number): Markup {
        const s = security.runSystem(() => this.getById(event_series_id));
        const id = s.event_series_id;
        const props = this.reloadableItemProps(id, `${this}.renderSeriesRow(${id})`);
        const menu = this.canManage() ? action.actionMenu([
            {label: 'Edit…', mode: {kind: 'modal', dialogUrl: `/${this}.renderForm(${this}.getById(${id}))`}},
            {label: 'Skips…', mode: {kind: 'modal', dialogUrl: `/${this}.renderSkipsDialog(${id})`}},
            s.frequency !== 'none'
                ? {label: 'Reconcile now', mode: {kind: 'immediate', expr: `${this}.reconcileNow(${id})`}}
                : {label: 'Create an event', mode: {kind: 'immediate', expr: `${this}.createEventFrom(${id})`}},
            s.frequency !== 'none'
                ? {label: 'Bulk-create for a range…', mode: {kind: 'modal', dialogUrl: `/${this}.renderBulkCreateDialog(${id})`}}
                : undefined,
            'divider',
            {label: 'Delete series…', mode: {kind: 'confirm',
                message: 'Delete this series? Future un-attended instances are removed; past/attended ones become standalone events.',
                expr: `${this}.deleteSeries(${id})`}},
        ].filter(Boolean) as action.ActionMenuItem[], {ariaLabel: 'Series actions'}) : undefined;
        return [h.div, {...props, class: (props.class ?? '') + ' lm-item d-flex align-items-center gap-2',
                        'data-testid': `event-series-row-${id}`},
            [h.div, {class: 'lm-item-body flex-grow-1'},
             [h.div, {class: 'lm-item-primary'}, s.description || '(unnamed series)',
              s.frequency === 'none' ? [h.span, {class: 'badge text-bg-secondary ms-2'}, 'Template'] : undefined],
             [h.div, {class: 'lm-item-secondary text-muted small'}, seriesSummary(s)]],
            menu];
    }

    @route(hostOrAdmin)
    newDialog(): Markup { return this.renderForm({} as EventSeries); }

    @routeMutation(hostOrAdmin)
    reconcileNow(event_series_id: number): Markup {
        this.reconcile(event_series_id);
        return {action: 'reload', targets: ['.' + this.rowKey(event_series_id)]} as unknown as Markup;
    }

    // Clone a one-off template into a single real event dated today.
    @routeMutation(hostOrAdmin)
    createEventFrom(event_series_id: number): Markup {
        const today = date.temporalToSqliteDate(date.orgToday());
        const id = security.runSystem(() =>
            rabid.event.insert(this.toEventValues(this.getById(event_series_id), today)));
        return {action: 'navigate', url: `/rabid.event.detailPage(${id})`} as unknown as Markup;
    }

    // Bulk-create instances for a past (or any) date range - the user-facing side of
    // materialize; used when importing historical data for a period.
    @route(hostOrAdmin)
    renderBulkCreateDialog(event_series_id: number): Markup {
        return action.renderParamForm(
            [new DateField('from', {prompt: 'From'}), new DateField('to', {prompt: 'To'})], {}, {
                title: 'Bulk-create events for a date range',
                submitLabel: 'Create',
                hidden: {event_series_id},
                dispatch: {onsubmit: `event.preventDefault(); tx\`${this}.bulkCreate(\${getFormJSON(event.target)})\``},
            });
    }

    @routeMutation(hostOrAdmin)
    bulkCreate(args: Record<string, any>): Markup {
        const event_series_id = Number(args?.event_series_id);
        this.materialize(event_series_id, String(args?.from ?? ''), String(args?.to ?? ''));
        return {action: 'reload', targets: ['.' + this.rowKey(event_series_id)]} as unknown as Markup;
    }

    @routeMutation(hostOrAdmin)
    deleteSeries(event_series_id: number): Markup {
        security.runSystem(() => {
            const today = date.temporalToSqliteDate(date.orgToday());
            // Future, un-attended instances go; the rest become standalone events.
            for(const row of db().prepare<{event_id: number}, {sid: number, today: string}>(
                'SELECT event_id FROM event WHERE series_id = :sid AND date(start_time) > :today')
                .all({sid: event_series_id, today}))
                if(!this.eventHasActivity(row.event_id)) rabid.event.delete(row.event_id);
            db().execute('UPDATE event SET series_id = NULL WHERE series_id = ' + Number(event_series_id));
            for(const sk of rabid.event_series_skip.forSeries.all({event_series_id}))
                rabid.event_series_skip.delete(sk.event_series_skip_id);
            this.delete(event_series_id);
        });
        return {action: 'reload', targets: ['.' + this.tableKey()]} as unknown as Markup;
    }

    // --- Skips ------------------------------------------------------------------

    private skipShapeKey(event_series_id: number): string { return `-event_series_skip-${event_series_id}-shape-`; }

    @route(hostOrAdmin)
    renderSkipsDialog(event_series_id: number): Markup {
        const f = rabid.event_series_skip.fieldsByName;
        return [h.div, {class: 'p-2', style: 'min-width: 22rem'},
            [h.h5, {}, 'Skips (holiday exceptions)'],
            [h.p, {class: 'text-muted small'}, 'A skipped date is omitted from the schedule and never materialized.'],
            this.renderSkipsList(event_series_id),
            [h.hr, {}],
            action.renderParamForm([f.skip_date, f.reason], {}, {
                title: 'Add a skip', submitLabel: 'Add', hidden: {event_series_id},
                dispatch: {onsubmit: `event.preventDefault(); tx\`${this}.addSkip(\${getFormJSON(event.target)})\``},
            })];
    }

    @route(hostOrAdmin)
    renderSkipsList(event_series_id: number): Markup {
        const props = liveReloadableProps([this.skipShapeKey(event_series_id)],
            `${this}.renderSkipsList(${event_series_id})`);
        const skips = security.runSystem(() => rabid.event_series_skip.forSeries.all({event_series_id}));
        return [h.div, {...props},
            skips.length === 0
                ? [h.div, {class: 'text-muted small'}, 'No skips.']
                : [h.ul, {class: 'list-unstyled mb-0'}, skips.map(sk =>
                    [h.li, {class: 'd-flex align-items-center gap-2 py-1'},
                     [h.span, {}, sk.skip_date, sk.reason ? [h.span, {class: 'text-muted'}, ` — ${sk.reason}`] : undefined],
                     action.actionButton('×',
                         {kind: 'immediate', expr: `${this}.removeSkip(${sk.event_series_skip_id})`},
                         'btn btn-sm btn-outline-danger py-0', {'aria-label': 'Remove skip'})])]];
    }

    @routeMutation(hostOrAdmin)
    addSkip(args: Record<string, any>): Markup {
        const event_series_id = Number(args?.event_series_id);
        security.runSystem(() => rabid.event_series_skip.insert({
            event_series_id, skip_date: String(args?.skip_date ?? ''), reason: String(args?.reason ?? '').trim(),
        }));
        this.reconcile(event_series_id);   // drop the now-skipped future instance (if un-attended)
        const key = this.skipShapeKey(event_series_id);
        dirty.record([key]);
        return {action: 'reload', targets: ['.' + key]} as unknown as Markup;
    }

    @routeMutation(hostOrAdmin)
    removeSkip(event_series_skip_id: number): Markup {
        const key = security.runSystem(() => {
            const sk = rabid.event_series_skip.getById(event_series_skip_id);
            rabid.event_series_skip.delete(event_series_skip_id);
            return this.skipShapeKey(sk.event_series_id);
        });
        dirty.record([key]);
        return {action: 'reload', targets: ['.' + key]} as unknown as Markup;
    }
}

// A one-off exception ("no repair next Saturday, long weekend") - an annotation on
// the RULE, so the schedule shows it with no dependence on a deleted instance.
export interface EventSeriesSkip {
    event_series_skip_id: number;
    event_series_id: number;
    skip_date: string;
    reason: string;
}
export type EventSeriesSkipOpt = Partial<EventSeriesSkip>;

export class EventSeriesSkipTable extends Table<EventSeriesSkip> {
    constructor() {
        super('event_series_skip', [
            new PrimaryKeyField('event_series_skip_id', {}),
            new ForeignKeyField('event_series_id', 'event_series', 'event_series_id',
                {indexed: true, edit: security.never}),
            new DateField('skip_date', {prompt: 'Skip date'}),
            new StringField('reason', {default: '', prompt: 'Reason'}),
        ]);
    }

    @path
    get forSeries() {
        return this.prepare<EventSeriesSkip, {event_series_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event_series_skip
/**/          WHERE event_series_id = :event_series_id
/**/          ORDER BY skip_date`);
    }

    // The set of skipped dates for a series (materialization + schedule consult this).
    skipDates(event_series_id: number): Set<string> {
        return new Set(security.runSystem(() =>
            this.forSeries.all({event_series_id}).map(s => s.skip_date)));
    }
}
