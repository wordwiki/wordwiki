import { Temporal } from 'temporal-polyfill'

// Re-export Temporal types for easier usage
export type PlainDate = Temporal.PlainDate;
export type PlainDateTime = Temporal.PlainDateTime;
export type PlainTime = Temporal.PlainTime;

/**
 * SQLite date/time format constants
 * SQLite expects dates in ISO 8601 format:
 * - Date: YYYY-MM-DD
 * - DateTime: YYYY-MM-DD HH:MM:SS
 */

// Type aliases for clarity
export type SQLiteDateString = string;      // Format: YYYY-MM-DD
export type SQLiteDateTimeString = string;  // Format: YYYY-MM-DD HH:MM:SS

// The row-level aliases used in record interfaces (re-exported by db.ts).
// THE MODEL: rows carry dates/datetimes as these strings - SQL-native,
// lexicographically sortable, JSON/markup/form-safe, diffable in before-*
// snapshots.  Convert to Temporal at the edge where you COMPUTE (add days,
// compare ranges), and convert straight back; never store the object in a row.
export type sqldate = SQLiteDateString;
export type sqldatetime = SQLiteDateTimeString;

// ============================================================================
// ORG TIMEZONE, LOCALE AND CLOCK
// ============================================================================
//
// SINGLE-VENUE MODEL (a durable assumption): everything in the system is
// wall-clock time at the org's one venue, stored zoneless.  "Volunteer night
// starts at 7 PM" stays 7 PM across DST transitions - which zoneless
// PlainDateTime gives us and UTC instants would not.
//
// The org timezone exists for exactly ONE purpose: computing "now"/"today"
// correctly no matter what zone the server happens to run in.  Never use
// `new Date()` / `Temporal.Now.*ISO()` (system zone!) for org-time "now" -
// use orgNow()/orgToday() below.

let orgTimeZone: string | undefined = undefined;  // undefined -> system zone
let orgLocale = 'en-US';

/** Set once at app startup (e.g. 'America/Toronto' in rabid's constructor). */
export function setOrgTimeZone(tz: string): void { orgTimeZone = tz; }
export function setOrgLocale(locale: string): void { orgLocale = locale; }
export function getOrgLocale(): string { return orgLocale; }

// Test seam: freeze the clock ("render the upcoming-events page as if today
// were a Tuesday in March").  Accepts a PlainDateTime or a sqlite-style
// 'YYYY-MM-DD HH:MM:SS' string; pass null to unfreeze.
let fixedNow: PlainDateTime | null = null;
export function setFixedNow(dt: PlainDateTime | string | null): void {
    fixedNow = typeof dt === 'string'
        ? Temporal.PlainDateTime.from(dt.replace(' ', 'T'))
        : dt;
}

/** The current wall-clock datetime at the org's venue. */
export function orgNow(): PlainDateTime {
    if (fixedNow) return fixedNow;
    return orgTimeZone
        ? Temporal.Now.plainDateTimeISO(orgTimeZone)
        : Temporal.Now.plainDateTimeISO();
}

/** The current date at the org's venue. */
export function orgToday(): PlainDate {
    return orgNow().toPlainDate();
}

// Strict format checks for the parse edge.  Temporal's ISO parsing is far
// more lenient than our storage contract: it accepts datetime strings where
// a date is expected, basic-format '20250723', and - worst - silently DROPS
// a utc offset ('2025-07-23 14:30:00+05:00' parses as wall time 14:30).
// Rows must carry exactly the canonical forms (that is what makes them
// lexicographically sortable and SQL-comparable), so reads reject anything
// else rather than letting non-canonical strings hide in the db.  Seconds
// are optional on read (datetime-local form values omit them); Temporal
// normalizes them to :00.
const SQLITE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const SQLITE_TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * Convert a SQLite date string (YYYY-MM-DD) to a Temporal.PlainDate
 *
 * @param sqliteDate - Date string in format YYYY-MM-DD
 * @returns Temporal.PlainDate object
 * @throws Error if the date string is invalid
 */
export function sqliteDateToTemporal(sqliteDate: SQLiteDateString): PlainDate {
    if (!SQLITE_DATE_RE.test(sqliteDate))
        throw new Error(`Invalid SQLite date string: ${sqliteDate}. Expected format: YYYY-MM-DD`);
    try {
        // The regex checks the shape; Temporal checks the calendar (Feb 30 etc).
        return Temporal.PlainDate.from(sqliteDate);
    } catch (error) {
        throw new Error(`Invalid SQLite date string: ${sqliteDate}. Expected format: YYYY-MM-DD`,
                        { cause: error });
    }
}

export function sqliteDateToTemporalOrNull(sqliteDate: SQLiteDateString | null | undefined): PlainDate | null {
    return sqliteDate ? sqliteDateToTemporal(sqliteDate) : null;
}

/**
 * Convert a Temporal.PlainDate to a SQLite date string (YYYY-MM-DD)
 * 
 * @param date - Temporal.PlainDate object
 * @returns Date string in format YYYY-MM-DD
 */
export function temporalToSqliteDate(date: PlainDate): SQLiteDateString {
    // toString() on PlainDate returns YYYY-MM-DD format
    return date.toString();
}

export function temporalToSqliteDateOrUndefined(date: PlainDate | null | undefined): SQLiteDateString | undefined {
    return date ? temporalToSqliteDate(date) : undefined;
}

/**
 * Convert a SQLite datetime string (YYYY-MM-DD HH:MM:SS) to a Temporal.PlainDateTime
 * 
 * Note about timezones: PlainDateTime represents a "wall clock" time without timezone.
 * This matches SQLite's datetime storage, which also lacks timezone information.
 * If you need timezone-aware operations, you'll need to explicitly convert to
 * ZonedDateTime with a specific timezone.
 * 
 * @param sqliteDateTime - DateTime string in format YYYY-MM-DD HH:MM:SS
 * @returns Temporal.PlainDateTime object
 * @throws Error if the datetime string is invalid
 */
export function sqliteDateTimeToTemporal(sqliteDateTime: SQLiteDateTimeString): PlainDateTime {
    if (!SQLITE_DATETIME_RE.test(sqliteDateTime))
        throw new Error(`Invalid SQLite datetime string: ${sqliteDateTime}. Expected format: YYYY-MM-DD HH:MM:SS`);
    try {
        // SQLite uses space separator, but Temporal expects 'T'
        const isoDateTime = sqliteDateTime.replace(' ', 'T');
        return Temporal.PlainDateTime.from(isoDateTime);
    } catch (error) {
        throw new Error(`Invalid SQLite datetime string: ${sqliteDateTime}. Expected format: YYYY-MM-DD HH:MM:SS`,
                        { cause: error });
    }
}

export function sqliteDateTimeToTemporalOrNull(sqliteDateTime: SQLiteDateTimeString | null | undefined): PlainDateTime | null {
    return sqliteDateTime ? sqliteDateTimeToTemporal(sqliteDateTime) : null;
}

/**
 * Convert a Temporal.PlainDateTime to a SQLite datetime string (YYYY-MM-DD HH:MM:SS)
 * 
 * @param dateTime - Temporal.PlainDateTime object
 * @returns DateTime string in format YYYY-MM-DD HH:MM:SS
 */
export function temporalToSqliteDateTime(dateTime: PlainDateTime): SQLiteDateTimeString {
    // Get ISO string and replace 'T' with space, remove fractional seconds
    const isoString = dateTime.toString();
    return isoString.replace('T', ' ').split('.')[0];
}

export function temporalToSqliteDateTimeOrUndefined(dateTime: PlainDateTime | null | undefined): SQLiteDateTimeString | undefined {
    return dateTime ? temporalToSqliteDateTime(dateTime) : undefined;
}

/**
 * Get current date (at the org's venue - see orgToday) as SQLite date string
 */
export function currentSqliteDate(): SQLiteDateString {
    return temporalToSqliteDate(orgToday());
}

/**
 * Get current datetime (at the org's venue - see orgNow) as SQLite datetime string
 */
export function currentSqliteDateTime(): SQLiteDateTimeString {
    return temporalToSqliteDateTime(orgNow());
}

/**
 * Extract the date portion from a SQLite datetime string
 * 
 * @param sqliteDateTime - DateTime string in format YYYY-MM-DD HH:MM:SS
 * @returns Date string in format YYYY-MM-DD
 * 
 * @example
 * extractDateFromDateTime('2025-07-23 14:30:00') // returns '2025-07-23'
 */
export function extractDateFromDateTime(sqliteDateTime: SQLiteDateTimeString): SQLiteDateString {
    return sqliteDateTime.split(' ')[0] as SQLiteDateString;
}

/**
 * Parse a time-only string (HH:MM:SS) to Temporal.PlainTime
 * Useful for columns that store only time without date
 */
export function sqliteTimeToTemporal(sqliteTime: string): PlainTime {
    if (!SQLITE_TIME_RE.test(sqliteTime))
        throw new Error(`Invalid SQLite time string: ${sqliteTime}. Expected format: HH:MM:SS`);
    try {
        return Temporal.PlainTime.from(sqliteTime);
    } catch (error) {
        throw new Error(`Invalid SQLite time string: ${sqliteTime}. Expected format: HH:MM:SS`,
                        { cause: error });
    }
}

export function sqliteTimeToTemporalOrNull(sqliteTime: string | null | undefined): PlainTime | null {
    return sqliteTime ? sqliteTimeToTemporal(sqliteTime) : null;
}

/**
 * Convert Temporal.PlainTime to SQLite time string (HH:MM:SS)
 */
export function temporalToSqliteTime(time: PlainTime): string {
    // toString() returns HH:MM:SS.sss format, we want just HH:MM:SS
    return time.toString().split('.')[0];
}

export function temporalToSqliteTimeOrUndefined(time: PlainTime | null | undefined): string | undefined {
    return time ? temporalToSqliteTime(time) : undefined;
}

// ============================================================================
// HUMAN-READABLE FORMATTING FUNCTIONS
// ============================================================================

/**
 * Convert a Temporal.PlainDateTime to a human-readable string
 * Default format: "Jan 23, 2025 2:30 PM"
 * 
 * @param dateTime - The Temporal.PlainDateTime to format (or null)
 * @param nullValue - What to return if dateTime is null (default: "")
 * @returns Formatted string
 */
export function dateTimeToString(dateTime: PlainDateTime | null, nullValue: string = "",
                                 options?: Intl.DateTimeFormatOptions): string {
    if (!dateTime) return nullValue;

    return dateTime.toLocaleString(orgLocale, options ?? {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

/**
 * Convert a SQLite datetime string to a human-readable string
 * 
 * @param sqliteDateTime - DateTime string in format YYYY-MM-DD HH:MM:SS
 * @param nullValue - What to return if sqliteDateTime is null/undefined (default: "")
 * @returns Formatted string
 */
export function sqliteDateTimeToString(sqliteDateTime: SQLiteDateTimeString | null | undefined, nullValue: string = "",
                                       options?: Intl.DateTimeFormatOptions): string {
    const temporal = sqliteDateTimeToTemporalOrNull(sqliteDateTime);
    return dateTimeToString(temporal, nullValue, options);
}

/**
 * Format just the DATE part of a SQLite datetime string ("Jan 23, 2025") -
 * for views that show a datetime column at day granularity.
 */
export function sqliteDateTimeToDateString(sqliteDateTime: SQLiteDateTimeString | null | undefined, nullValue: string = ""): string {
    const temporal = sqliteDateTimeToTemporalOrNull(sqliteDateTime);
    return temporal ? dateToString(temporal.toPlainDate()) : nullValue;
}

/**
 * Format just the TIME part of a SQLite datetime string ("2:30 PM") - for
 * "7:00 PM - 9:30 PM" style ranges where repeating the date is noise.
 */
export function sqliteDateTimeToTimeString(sqliteDateTime: SQLiteDateTimeString | null | undefined, nullValue: string = ""): string {
    const temporal = sqliteDateTimeToTemporalOrNull(sqliteDateTime);
    return temporal ? timeToString(temporal.toPlainTime()) : nullValue;
}

/**
 * Convert a Temporal.PlainDate to a human-readable string
 * Default format: "Jan 23, 2025"
 * 
 * @param date - The Temporal.PlainDate to format (or null)
 * @param nullValue - What to return if date is null (default: "")
 * @returns Formatted string
 */
export function dateToString(date: PlainDate | null, nullValue: string = "",
                             options?: Intl.DateTimeFormatOptions): string {
    if (!date) return nullValue;

    return date.toLocaleString(orgLocale, options ?? {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

/**
 * Convert a SQLite date string to a human-readable string
 * 
 * @param sqliteDate - Date string in format YYYY-MM-DD
 * @param nullValue - What to return if sqliteDate is null/undefined (default: "")
 * @returns Formatted string
 */
export function sqliteDateToString(sqliteDate: SQLiteDateString | null | undefined, nullValue: string = "",
                                   options?: Intl.DateTimeFormatOptions): string {
    const temporal = sqliteDateToTemporalOrNull(sqliteDate);
    return dateToString(temporal, nullValue, options);
}

/**
 * Convert a Temporal.PlainTime to a human-readable string
 * Default format: "2:30 PM"
 * 
 * @param time - The Temporal.PlainTime to format (or null)
 * @param nullValue - What to return if time is null (default: "")
 * @returns Formatted string
 */
export function timeToString(time: PlainTime | null, nullValue: string = ""): string {
    if (!time) return nullValue;

    return time.toLocaleString(orgLocale, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

/**
 * Convert a SQLite time string to a human-readable string
 * 
 * @param sqliteTime - Time string in format HH:MM:SS
 * @param nullValue - What to return if sqliteTime is null/undefined (default: "")
 * @returns Formatted string
 */
export function sqliteTimeToString(sqliteTime: string | null | undefined, nullValue: string = ""): string {
    const temporal = sqliteTimeToTemporalOrNull(sqliteTime);
    return timeToString(temporal, nullValue);
}

// ============================================================================
// TIMEZONE CONSIDERATIONS - Important notes about working without timezones
// ============================================================================

/**
 * Working with timezone-less dates and times
 * 
 * 1. **What you're storing**: Both SQLite datetime and Temporal.PlainDateTime 
 *    represent "wall clock" time - what you'd see on a clock on the wall,
 *    without any timezone context.
 * 
 * 2. **When this works well**:
 *    - Local-only applications where all users are in the same timezone
 *    - Recording historical events where the "local time" is what matters
 *    - Scheduling that's meant to be interpreted in the viewer's local time
 * 
 * 3. **Potential issues**:
 *    - Ambiguity during DST transitions (2:30 AM might occur twice)
 *    - Can't correctly order events that happened in different timezones
 *    - Can't calculate accurate durations across DST boundaries
 *    - Data becomes ambiguous if users are in different timezones
 * 
 * 4. **Best practices**:
 *    - Document what timezone your times represent (e.g., "All times in EST")
 *    - Consider storing UTC times and converting for display
 *    - If you need timezone awareness later, you can convert:
 *      ```typescript
 *      const zoned = plainDateTime.toZonedDateTime('America/New_York');
 *      ```
 */
