// Recurring events / event series - see repo-root recurring-events.md.
//
// This file starts with the PURE, db-free core: the controlled vocabularies and
// the occurrence-date computation.  Everything downstream (materialization,
// reconcile, the schedule block) builds on `occurrenceDates`, so it is worth
// keeping small and exhaustively tested.

import { Temporal } from 'temporal-polyfill';
import * as date from '../liminal/date.ts';
import { Table, PrimaryKeyField, StringField, EnumField, BooleanField, DateField, TimeField,
         ForeignKeyField, type Tuple } from '../liminal/table.ts';
import { VolunteerForeignKeyField } from './volunteer-activity.ts';
import { event_kind_enum, type Event } from './event.ts';
import * as security from '../liminal/security.ts';
import { db } from '../liminal/db.ts';
import { block } from '../liminal/strings.ts';
import { path } from '../liminal/serializable.ts';
import { rabid } from './rabid.ts';

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

    /**
     * Materialize every active recurring series from today out to the horizon
     * (default ~5 weeks).  The self-maintaining entry point (called on startup + a
     * once-a-day guard - see the trigger).  Returns total instances created.
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
