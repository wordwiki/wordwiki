// The date/datetime model: sqlite strings in rows, Temporal at the compute
// edge, org wall-clock "now" (single-venue assumption - see date.ts).
import { Temporal } from 'temporal-polyfill';
import { test } from "./testing/test.ts";
import { assertEquals, assertThrows } from "./testing/assert.ts";
import * as date from "./date.ts";

test("a fixed clock drives orgNow/orgToday/currentSqlite* (the test seam)", () => {
    date.setFixedNow("2026-03-03 21:30:00");
    try {
        assertEquals(date.orgNow().toString(), "2026-03-03T21:30:00");
        assertEquals(date.orgToday().toString(), "2026-03-03");
        assertEquals(date.currentSqliteDateTime(), "2026-03-03 21:30:00");
        assertEquals(date.currentSqliteDate(), "2026-03-03");
    } finally {
        date.setFixedNow(null);
    }
});

test("sqlite <-> temporal round-trips preserve the string forms", () => {
    assertEquals(date.temporalToSqliteDate(date.sqliteDateToTemporal("2026-03-03")), "2026-03-03");
    assertEquals(date.temporalToSqliteDateTime(date.sqliteDateTimeToTemporal("2026-03-03 21:30:05")),
                 "2026-03-03 21:30:05");
    assertEquals(date.extractDateFromDateTime("2026-03-03 21:30:05"), "2026-03-03");
});

test("formatters: date-only strings never shift a day (the old new Date() bug)", () => {
    // new Date('2026-03-03') parses as UTC midnight and renders as Mar 2 in
    // any zone west of UTC; the Temporal path must stay Mar 3.
    assertEquals(date.sqliteDateToString("2026-03-03"), "Mar 3, 2026");
});

test("datetime part formatters", () => {
    assertEquals(date.sqliteDateTimeToDateString("2026-03-03 21:30:00"), "Mar 3, 2026");
    assertEquals(date.sqliteDateTimeToTimeString("2026-03-03 21:30:00"), "9:30 PM");
    assertEquals(date.sqliteDateTimeToTimeString(null, "—"), "—");
});

test("parsers enforce the canonical storage formats (Temporal alone is too lenient)", () => {
    // Temporal.from would happily accept all of these; our storage contract
    // is exact canonical strings, so the parse edge must reject them.
    for (const bad of ["2026-03-03 21:30:00",   // datetime where a date is expected
                       "20260303",              // ISO basic format
                       "2026-3-3",              // unpadded
                       "2026-03-03T21:30:00"])  // T where a date is expected
        assertThrows(() => date.sqliteDateToTemporal(bad), Error, "Invalid SQLite date");

    for (const bad of ["2026-03-03T21:30:00",         // T separator (storage uses space)
                       "2026-03-03 21:30:00+05:00",   // Temporal silently DROPS offsets
                       "2026-03-03 21:30:00Z",
                       "2026-03-03",                  // date where a datetime is expected
                       "2026-03-03 21:30:00.500"])    // fractional seconds not stored
        assertThrows(() => date.sqliteDateTimeToTemporal(bad), Error, "Invalid SQLite datetime");

    for (const bad of ["9:30", "21:30:00.5", "2026-03-03T21:30:00"])
        assertThrows(() => date.sqliteTimeToTemporal(bad), Error, "Invalid SQLite time");
});

test("parsers reject shape-valid but calendar-invalid values", () => {
    assertThrows(() => date.sqliteDateToTemporal("2025-02-30"), Error, "Invalid SQLite date");
    assertThrows(() => date.sqliteDateToTemporal("2025-13-01"), Error, "Invalid SQLite date");
    assertThrows(() => date.sqliteDateTimeToTemporal("2026-03-03 24:00:00"), Error, "Invalid SQLite datetime");
    assertThrows(() => date.sqliteTimeToTemporal("25:00:00"), Error, "Invalid SQLite time");
});

test("deliberate leniency: seconds are optional on read, normalized to :00", () => {
    // datetime-local form values carry minute precision.
    assertEquals(date.temporalToSqliteDateTime(date.sqliteDateTimeToTemporal("2026-03-03 21:30")),
                 "2026-03-03 21:30:00");
    assertEquals(date.temporalToSqliteTime(date.sqliteTimeToTemporal("21:30")), "21:30:00");
});

test("the OrNull/OrUndefined variants pass through missing values (incl. '' from forms)", () => {
    assertEquals(date.sqliteDateToTemporalOrNull(null), null);
    assertEquals(date.sqliteDateToTemporalOrNull(undefined), null);
    assertEquals(date.sqliteDateToTemporalOrNull(""), null);
    assertEquals(date.sqliteDateTimeToTemporalOrNull(""), null);
    assertEquals(date.sqliteTimeToTemporalOrNull(""), null);
    assertEquals(date.temporalToSqliteDateOrUndefined(null), undefined);
    assertEquals(date.temporalToSqliteDateTimeOrUndefined(undefined), undefined);
    assertEquals(date.temporalToSqliteTimeOrUndefined(null), undefined);
    // and the formatters take a nullValue
    assertEquals(date.sqliteDateToString(null, "n/a"), "n/a");
    assertEquals(date.sqliteDateTimeToString(undefined, "n/a"), "n/a");
    assertEquals(date.sqliteTimeToString("", "n/a"), "n/a");
});

test("time round-trip and formatting", () => {
    assertEquals(date.temporalToSqliteTime(date.sqliteTimeToTemporal("21:30:05")), "21:30:05");
    assertEquals(date.sqliteTimeToString("14:30:00"), "2:30 PM");
    assertEquals(date.sqliteTimeToString("00:05:00"), "12:05 AM");
});

test("temporalToSqliteDateTime strips subsecond precision", () => {
    const dt = date.sqliteDateTimeToTemporal("2026-03-03 21:30:05").add({ milliseconds: 500 });
    assertEquals(date.temporalToSqliteDateTime(dt), "2026-03-03 21:30:05");
});

// Deterministic LCG so failures reproduce.
function makeRng(seed: number): (n: number) => number {
    let state = seed;
    return (n: number) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % n;
    };
}

test("random datetimes: round-trip exactly; string sort == chronological sort", () => {
    const rand = makeRng(987654);
    const base = date.sqliteDateTimeToTemporal("1990-01-01 00:00:00");
    const pairs: (readonly [string, date.PlainDateTime])[] = [];
    for (let i = 0; i < 2000; i++) {
        const dt = base.add({ days: rand(80_000), seconds: rand(86_400) });  // ~1990-2209
        const s = date.temporalToSqliteDateTime(dt);
        // Round-trip is exact.
        assertEquals(date.sqliteDateTimeToTemporal(s).toString(), dt.toString());
        assertEquals(date.temporalToSqliteDateTime(date.sqliteDateTimeToTemporal(s)), s);
        // And the date part extracted as a string matches the Temporal date.
        assertEquals(date.extractDateFromDateTime(s), date.temporalToSqliteDate(dt.toPlainDate()));
        pairs.push([s, dt] as const);
    }
    // THE MODEL's claim that rows sort lexicographically: plain string sort
    // of the sqlite strings must equal chronological sort.
    const byString = pairs.map((_, i) => i).toSorted(
        (x, y) => pairs[x][0] < pairs[y][0] ? -1 : pairs[x][0] > pairs[y][0] ? 1 : x - y);
    const byTime = pairs.map((_, i) => i).toSorted(
        (x, y) => Temporal.PlainDateTime.compare(pairs[x][1], pairs[y][1]) || x - y);
    assertEquals(byString, byTime);
});
