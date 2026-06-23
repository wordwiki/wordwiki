// shortName: a volunteer's name for compact contexts (sign-up/check-in lists,
// menus, the picker, provenance mentions) - the curated short_name when set, else
// the first word of the full name.
//
// It lives in its own dependency-free module (not volunteer.ts) so that
// volunteer-activity.ts - which deliberately imports only liminal, to stay free
// of an import cycle while being usable from any table file - can build picker
// labels with it.  volunteer.ts re-exports it, so existing
// `import {shortName} from "./volunteer.ts"` callers are unaffected.

export interface NamedVolunteer { short_name?: string | null; name: string; }

export function shortName(v: NamedVolunteer): string {
    const s = v.short_name?.trim();
    return s ? s : (v.name?.split(/\s+/)[0] ?? '');
}

// The conventional joined-name columns a query carries alongside a row that
// references a volunteer (commitment/check-in/timesheet/group-member), and the
// compact display name over them.  Selecting `volunteer.name AS volunteer_name,
// volunteer.short_name AS volunteer_short_name` lets a render site call
// memberShortName(row) directly.
export interface MemberName { volunteer_name: string; volunteer_short_name?: string | null; }
export function memberShortName(c: MemberName): string {
    return shortName({name: c.volunteer_name, short_name: c.volunteer_short_name});
}
