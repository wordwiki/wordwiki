// "Active within N days" volunteers, and the volunteer picker that uses it.
//
// We have a long tail of (mostly inactive) volunteers, which makes a flat
// volunteer picker hard to use.  "Active within N days" = a volunteer who has a
// timesheet entry that STARTED, or an event check-in whose event OCCURRED, on or
// after the cutoff.
//
// The mechanism is parameterized by the window so several windows share one
// (memoized) prepared query - 30 days drives the picker and the volunteer list;
// 60/120 are available for other situations via activeVolunteerIdsWithin(60|120)
// with no extra SQL.
//
// This module imports only liminal (no rabid table modules), so the picker field
// can be used from any table file without an import cycle.

import {db} from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import {ForeignKeyField, type FieldOptions} from "../liminal/table.ts";

// The (Sun-agnostic) cutoff datetime for "within `days` days": now minus N days.
export function cutoffSince(days: number): string {
    return date.temporalToSqliteDateTime(date.orgNow().subtract({days}));
}

// The ONE active-set query, as a reusable fragment (used standalone below, and
// as an IN (...) subquery by the picker).  :since is the only parameter, so the
// same statement serves every window.  Trusted constant - safe to interpolate.
//
// Written to be INDEX-DRIVEN, not a linear scan (these tables grow for years):
//   1. timesheet by start_time              -> timesheet_entry_by_start_time
//   2. check-ins on a recent EVENT (the common case: no arrival override) -
//      drive off recent events, join their check-ins
//                                            -> event_by_start_time + event_checkin_unique
//   3. check-ins with an explicit recent arrival OVERRIDE (rare)
//                                            -> event_checkin_by_start_time (partial)
// Parts 2+3 split on (ec.start_time IS NULL) so together they reproduce exactly
// COALESCE(ec.start_time, e.start_time) >= :since, while each side can use an index.
export const ACTIVE_VOLUNTEER_IDS_SINCE = `
    SELECT volunteer_id FROM timesheet_entry WHERE start_time >= :since
    UNION
    SELECT ec.volunteer_id FROM event e JOIN event_checkin ec USING (event_id)
           WHERE ec.start_time IS NULL AND e.start_time >= :since
    UNION
    SELECT volunteer_id FROM event_checkin WHERE start_time >= :since`;

// The set of volunteer ids active within `days` days.  Used to split the
// volunteer list into two sections, and (in future) for 60/120-day situations.
export function activeVolunteerIdsWithin(days: number): Set<number> {
    const rows = db().all<{volunteer_id: number}, {since: string}>(
        ACTIVE_VOLUNTEER_IDS_SINCE, {since: cutoffSince(days)});
    return new Set(rows.map(r => r.volunteer_id));
}

// The recently-active volunteers as {id, name}, alpha by name.  Same active-set
// definition as activeVolunteerIdsWithin, but carries names so callers can build
// quick-add menu items ("Sign up Barry", "Check in Barry") on the event page.
export function activeVolunteersWithin(days: number): Array<{volunteer_id: number, name: string}> {
    return db().all<{volunteer_id: number, name: string}, {since: string}>(`
        SELECT volunteer_id, name FROM volunteer
         WHERE deleted = 0 AND volunteer_id IN (${ACTIVE_VOLUNTEER_IDS_SINCE})
         ORDER BY name`,
        {since: cutoffSince(days)});
}

// The window the picker surfaces, and the marker that flags where the active
// block ends.  The marker is PICKER-ONLY: it is appended to an option label in
// the dropdown, never to loadLabel (the selected-option display) or render()
// (summaries), so a volunteer's name elsewhere is unaffected.
const PICKER_DAYS = 30;
const PICKER_MARKER = ` (Active ${PICKER_DAYS} Days)`;

// A volunteer foreign-key picker that lists recently-active volunteers first
// (alpha), then the rest (alpha), with a marker on the last active option so the
// boundary is obvious.  Ordering happens in SQL so the active ones survive the
// option LIMIT (a flat alpha sort would push them past the cap on a long roster).
export class VolunteerForeignKeyField extends ForeignKeyField {
    constructor(name: string, options: FieldOptions = {}) {
        super(name, 'volunteer', 'volunteer_id', options, 'name');
    }

    override loadOptions(q: string = '', limit: number = 1000): Array<{id: any, label: any}> {
        const rows = db().all<{id: number, label: string, active: number},
                              {q: string, since: string, limit: number}>(`
            SELECT volunteer_id AS id, name AS label,
                   CASE WHEN volunteer_id IN (${ACTIVE_VOLUNTEER_IDS_SINCE})
                        THEN 1 ELSE 0 END AS active
              FROM volunteer
              WHERE deleted = 0
                AND (:q = '' OR (' ' || name) LIKE '% ' || :q || '%')
              ORDER BY active DESC, name
              LIMIT :limit`,
            {q, since: cutoffSince(PICKER_DAYS), limit});

        const out = rows.map(r => ({id: r.id, label: r.label}));
        // Mark the last active option, but only when inactive options follow it -
        // the marker is a separator, pointless when everything shown is active.
        const lastActive = rows.reduce((idx, r, i) => r.active ? i : idx, -1);
        if(lastActive >= 0 && rows.some(r => !r.active))
            out[lastActive] = {id: out[lastActive].id, label: out[lastActive].label + PICKER_MARKER};
        return out;
    }
}
