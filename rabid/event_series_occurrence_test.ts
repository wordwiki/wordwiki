// The pure occurrence-date computation (no db): weekly + monthly patterns,
// window clamping, and edge cases.
import { test } from "../liminal/testing/test.ts";
import { assertEquals } from "../liminal/testing/assert.ts";
import { occurrenceDates, type RecurrenceRule } from "./event_series.ts";

const weekly = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
    frequency: 'weekly', weekday: 'saturday', effective_start: '2026-06-01', effective_end: null, ...over,
});
const monthly = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
    frequency: 'monthly', weekday: 'monday', week_of_month: 'first',
    effective_start: '2026-01-01', effective_end: null, ...over,
});

test("weekly: every Saturday in a range", () => {
    // June 2026: Saturdays are 6, 13, 20, 27.
    assertEquals(occurrenceDates(weekly(), '2026-06-01', '2026-06-30'),
        ['2026-06-06', '2026-06-13', '2026-06-20', '2026-06-27']);
});

test("weekly: range boundaries are inclusive; start need not be the weekday", () => {
    // Range starting ON a Saturday includes it; range end on Saturday includes it.
    assertEquals(occurrenceDates(weekly(), '2026-06-06', '2026-06-13'),
        ['2026-06-06', '2026-06-13']);
    // A range with no Saturday.
    assertEquals(occurrenceDates(weekly(), '2026-06-07', '2026-06-12'), []);
});

test("weekly: clamped to the effective window (summer season)", () => {
    const summer = weekly({effective_start: '2026-06-06', effective_end: '2026-08-29'});
    const all = occurrenceDates(summer, '2026-01-01', '2026-12-31');
    assertEquals(all[0], '2026-06-06');            // not before effective_start
    assertEquals(all[all.length - 1], '2026-08-29'); // not after effective_end
    // A query window entirely before the season yields nothing.
    assertEquals(occurrenceDates(summer, '2026-01-01', '2026-05-01'), []);
});

test("monthly: first Monday of each month", () => {
    // First Mondays 2026: Jan 5, Feb 2, Mar 2.
    assertEquals(occurrenceDates(monthly(), '2026-01-01', '2026-03-31'),
        ['2026-01-05', '2026-02-02', '2026-03-02']);
});

test("monthly: last Saturday of the month", () => {
    const r = monthly({weekday: 'saturday', week_of_month: 'last'});
    // Last Saturdays: Jan 31, Feb 28, Mar 28 (2026).
    assertEquals(occurrenceDates(r, '2026-01-01', '2026-03-31'),
        ['2026-01-31', '2026-02-28', '2026-03-28']);
});

test("monthly: fourth Thursday (nth that always exists)", () => {
    const r = monthly({weekday: 'thursday', week_of_month: 'fourth'});
    // 4th Thursdays: Jan 22, Feb 26 (2026).
    assertEquals(occurrenceDates(r, '2026-01-01', '2026-02-28'),
        ['2026-01-22', '2026-02-26']);
});

test("monthly: an occurrence outside the query window is excluded at the edges", () => {
    const r = monthly();  // first Monday
    // Window starts after Jan's first Monday (Jan 5) -> Jan excluded; Feb 2 included.
    assertEquals(occurrenceDates(r, '2026-01-06', '2026-02-28'), ['2026-02-02']);
});

test("frequency 'none' (a manual prototype) never occurs", () => {
    assertEquals(occurrenceDates({frequency: 'none', effective_start: '2026-01-01'} as RecurrenceRule,
        '2026-01-01', '2026-12-31'), []);
});

test("a rule with no weekday yields nothing (guard)", () => {
    assertEquals(occurrenceDates({frequency: 'weekly', effective_start: '2026-01-01'} as RecurrenceRule,
        '2026-01-01', '2026-12-31'), []);
});

test("inverted / empty ranges yield nothing", () => {
    assertEquals(occurrenceDates(weekly(), '2026-06-30', '2026-06-01'), []);
});
