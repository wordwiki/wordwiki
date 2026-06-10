// The date/datetime model: sqlite strings in rows, Temporal at the compute
// edge, org wall-clock "now" (single-venue assumption - see date.ts).
import { test } from "./testing/test.ts";
import { assertEquals } from "./testing/assert.ts";
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
