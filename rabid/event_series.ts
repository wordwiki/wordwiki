// Recurring events / event series - see repo-root recurring-events.md.
//
// This file starts with the PURE, db-free core: the controlled vocabularies and
// the occurrence-date computation.  Everything downstream (materialization,
// reconcile, the schedule block) builds on `occurrenceDates`, so it is worth
// keeping small and exhaustively tested.

import { Temporal } from 'temporal-polyfill';
import * as date from '../liminal/date.ts';

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
    if(rule.frequency === 'none') return [];
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
