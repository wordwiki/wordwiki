// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField } from "../liminal/table.ts";
import * as content from "../liminal/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../liminal/strings.ts";
import * as orderkey from '../liminal/orderkey.ts';
import * as timestamp from '../liminal/timestamp.ts';
//import * as schema from './schema.ts';

import * as volunteer from './volunteer.ts';
import * as timesheet from './timesheet.ts';
import * as event from './event.ts';
import * as service from './service.ts';
import * as sale from './sale.ts';
import {Rabid, getRabid} from './rabid.ts';
import { assertSafeToWipe, type DbPurpose } from './config.ts';
import { faker, Faker, en } from "@faker-js/faker";
import * as password from '../liminal/password.ts';

// --------------------------------------------------------------------------------
// --- Deterministic randomness ---------------------------------------------------
// --------------------------------------------------------------------------------
//
// Test data should be stable: the same seed yields the same data, and adding a
// column (or another builder) shouldn't churn unrelated values.  We get that with
// *named* faker streams - each concern draws from its own seeded sequence, so a
// new stream can't perturb an existing one - plus a tiny seeded PRNG for the few
// spots that used rand().

// Small stable string hash (cyrb53-ish) so streams can be named.
function hashSeed(s: string): number {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for(let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return h1 >>> 0;
}

export type Streams = (name: string) => Faker;

// A registry of independent, deterministically-seeded faker streams keyed by name.
export function makeStreams(baseSeed: number): Streams {
    const cache = new Map<string, Faker>();
    return (name: string): Faker => {
        let f = cache.get(name);
        if(!f) {
            f = new Faker({ locale: [en] });
            f.seed((baseSeed ^ hashSeed(name)) >>> 0);
            cache.set(name, f);
        }
        return f;
    };
}

// Tiny deterministic PRNG (mulberry32) for the spots that used rand().
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// Reset at the start of each builder that needs it (commitments / timesheets).
let rand: () => number = mulberry32(1);

// Format a Date's LOCAL calendar date/time as a SQLite string.  We must NOT use
// toISOString() here: it formats in UTC, so in a negative-offset timezone the
// local evening rolls into the next UTC day - which made "Wednesday" events land
// on Thursday (and shifted walk-in arrival times by the UTC offset).  The weekday
// loops and Date arithmetic in seedEvents use local time (getDay/setDate), so the
// stored string must be local too.
const pad2 = (n: number) => String(n).padStart(2, '0');
function localDateStr(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localDateTimeStr(d: Date): string {
    return `${localDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Seeded Fisher-Yates over a copy.  (Not `.sort(() => rand() - 0.5)`: a
// random comparator is measurably biased and engine-dependent - see
// liminal/random.ts shuffle for the uniform algorithm; this is the same
// thing driven by the seeded rand() stream.)
function shuffled<T>(vals: readonly T[]): T[] {
    const out = [...vals];
    for (let i = 0; i < out.length - 1; i++) {
        const peer = i + Math.floor(rand() * (out.length - i));
        [out[i], out[peer]] = [out[peer], out[i]];
    }
    return out;
}

// --------------------------------------------------------------------------------
// --- Activity profiles ----------------------------------------------------------
// --------------------------------------------------------------------------------
//
// A volunteer's *activity profile* is assigned once and then drives ALL of their
// activity together - event commitments, check-ins, and timesheets - so an
// "active" volunteer is active everywhere, not active on one axis and silent on
// another.  (The old generator rolled is_staff, participation rate, and
// timesheets as three independent dice, so the staffer you wanted to inspect
// usually had no events and no recorded hours.)  The point is variation for
// testing the UI and reports: a dense, paid, every-event staffer sitting next to
// a once-a-month volunteer - without making everyone active.
//
// The profile is encoded as a *middle initial* in the name (S/H/R/O - the tier's
// first letter): subtle enough to read as an ordinary name (most volunteers - the
// long tail - have no middle initial at all), but it lets you pick a
// representative user while browsing, and it lets the later builders (which
// re-fetch volunteers from the db) recover each volunteer's profile.

interface ActivityProfile {
    key: 'staff' | 'heavy' | 'regular' | 'occasional';
    initial: string;      // middle initial carried in the name (the tier's first letter)
    count: number;        // how many in a full (~99-volunteer) dataset
    isStaff: boolnum;     // paid staff (snapshotted into check-ins for grant reporting)
    attendRate: number;   // P(commit to / attend any given event)
    weeklyHours: number;  // target recorded timesheet hours per week (0 = ~none)
    paid: boolnum;        // is_paid_time for those timesheet entries (staff are paid)
}

// Ordered most-active first.  Events alone are only ~8h/week (a Sat 5h + a Wed
// evening), so the higher tiers' hours come mostly from timesheets ON TOP of
// attendance: staff ~35h/wk (paid), heavy ~20h, regular ~10h (~2 events/wk),
// occasional 2-10h.
const ACTIVITY_PROFILES: ActivityProfile[] = [
    {key: 'staff',      initial: 'S', count: 3,  isStaff: 1, attendRate: 1.0,  weeklyHours: 27, paid: 1},
    {key: 'heavy',      initial: 'H', count: 1,  isStaff: 0, attendRate: 0.95, weeklyHours: 12, paid: 0},
    {key: 'regular',    initial: 'R', count: 5,  isStaff: 0, attendRate: 0.85, weeklyHours: 2,  paid: 0},
    {key: 'occasional', initial: 'O', count: 10, isStaff: 0, attendRate: 0.35, weeklyHours: 0,  paid: 0},
];
// Everyone past the profiled cohort is the "tail": no middle initial, sparse
// attendance, no timesheets.
const PROFILE_BY_INITIAL = new Map(ACTIVITY_PROFILES.map(p => [p.initial, p]));
const profileByKey = (k: string): ActivityProfile | null =>
    ACTIVITY_PROFILES.find(p => p.key === k) ?? null;

// Recover a volunteer's activity profile from the middle initial in their name
// (null = the unprofiled long tail).  This is the channel the commitment /
// check-in / timesheet builders use to stay consistent with seedVolunteers.
export function activityProfileOf(v: {name: string}): ActivityProfile | null {
    const m = v.name.match(/^\S+\s+([A-Z])\.\s/);
    return m ? (PROFILE_BY_INITIAL.get(m[1]) ?? null) : null;
}

// Compose a name carrying the profile's middle initial (tail volunteers stay plain).
function nameWithProfile(first: string, last: string, p: ActivityProfile | null): string {
    return p ? `${first} ${p.initial}. ${last}` : `${first} ${last}`;
}

// The per-loop-volunteer profile assignment for a dataset of `count` volunteers,
// after the fixed canonical logins have already consumed one slot each.  Profiles
// fill in priority order, then the rest are tail (null).  Small scenarios just
// get a clamped (still varied) prefix.
function profileSlots(count: number, consumed: Record<string, number>): (ActivityProfile | null)[] {
    const slots: (ActivityProfile | null)[] = [];
    for(const p of ACTIVITY_PROFILES) {
        const remaining = Math.max(0, p.count - (consumed[p.key] ?? 0));
        for(let k = 0; k < remaining; k++) slots.push(p);
    }
    while(slots.length < count) slots.push(null);
    return slots.slice(0, count);
}

// --------------------------------------------------------------------------------
// --- Volunteer -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface VolunteerSeedOpts { count?: number; baseSeed?: number; }

const isoDateTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);  // for DateField columns (YYYY-MM-DD)

// Seed Rocky (the canonical admin login) plus `count` more volunteers.  Each
// field is drawn from a per-concern stream (identity / contact / status / role /
// account), so adding a column - or another builder - never shifts the others.
export function seedVolunteers(rabid: Rabid, opts: VolunteerSeedOpts = {}): { rockyId: number } {
    const count = opts.count ?? 99;
    const s = makeStreams(opts.baseSeed ?? 1);
    const idS = s('volunteer.identity');      // name + email (kept correlated)
    const contactS = s('volunteer.contact');  // phone + visibility + emergency contact
    const skillS = s('volunteer.skills_and_interests');
    const statusS = s('volunteer.status');     // join / archived / exit
    const roleS = s('volunteer.role');         // permissions
    const acctS = s('volunteer.account');      // whether a password is set
    const confS = s('volunteer.needs_confirmation'); // community-service hours flag

    // Rocky uses fixed values so the canonical admin login is stable across runs.
    const rockyJoin = '2023-01-07 10:00:00';   // last_change_time (a datetime)
    const rockyId = rabid.volunteer.insert({
        join_date: '2023-01-07',               // join_date is a DateField

        // Rocky is the canonical *staff* exemplar (the 'S' middle initial) - log
        // in as Rocky to see a dense, paid, every-event timesheet.
        name: 'Rocky S. Raccoon',
        email: 'rocky@redraccoon.org',
        email_visible_to_all_volunteers: 1,  // Rocky shares their email
        phone: '(555) 010-0010',
        phone_number_visible_to_all_volunteers: 1,  // Rocky shares their phone
        skills_and_interests: 'Event planning and fundraising; keen to mentor new mechanics',
        emergency_contact_name: 'The Beatles',
        emergency_contact_phone: '(555) 010-0011',
        is_staff: 1,
        // 'testing' lets the canonical dev login drive the browser-test harness
        // (the test-client page + evalInBrowser); see liminal/browser-agent.ts.
        permissions: 'admin,testing',
        archived: 0,
        archived_date: undefined,
        exit_feedback_requested: 0,
        exit_reason: undefined,
        exit_feedback: undefined,
        deleted: 0,
    });
    const rockySalt = password.generateSalt();
    rabid.passwordHash.insert({
        volunteer_id: rockyId,
        password_salt: rockySalt,
        password_hash: password.hashPassword('rcky', rockySalt),
        last_change_time: rockyJoin,
    });

    // Canonical fixed logins for the other role/activity tiers, so role-dependent
    // UI (e.g. which rows present an edit affordance) and the timesheet/check-in
    // views can be checked by hand without hunting for credentials.  Each is also
    // an activity exemplar (middle initial): pick the one whose density you want.
    //   hazel@redraccoon.org / hzl   - host,    regular activity    (Hazel R. Host)
    //   vinnie@redraccoon.org / vnny - no roles, occasional activity (Vinnie O. Volunteer)
    seedFixedLogin(rabid, 'Hazel', 'Host', 'hazel@redraccoon.org', 'hzl', 'host', profileByKey('regular'));
    seedFixedLogin(rabid, 'Vinnie', 'Volunteer', 'vinnie@redraccoon.org', 'vnny', undefined, profileByKey('occasional'));
    //   cody@redraccoon.org / cody   - community-service volunteer (hours need host confirmation)
    seedFixedLogin(rabid, 'Cody', 'Service', 'cody@redraccoon.org', 'cody', undefined,
                   profileByKey('regular'), /*needsConfirmation*/ true);

    // Rocky (staff), Hazel (regular), Vinnie (occasional) have each consumed one
    // slot of their tier; the rest fill in priority order, then tail.
    const slots = profileSlots(count, {staff: 1, regular: 1, occasional: 1});

    for(let i = 0; i < count; i++) {
        const profile = slots[i];
        const firstName = idS.person.firstName();
        const lastName = idS.person.lastName();
        const joinDate = statusS.date.past({ years: 3 });
        // Profiled (active) volunteers are always on-roster+undeleted: an "active
        // staffer" who is also archived/deleted would be contradictory (and the
        // activity builders skip archived/deleted people, so they'd show no
        // data).  The unprofiled long tail keeps the archived/exit/deleted churn.
        // We still draw the rolls (so the tail's stream is unperturbed), then
        // override them for profiled volunteers.
        const isArchivedRoll = statusS.datatype.boolean({ probability: 0.15 });
        const hasExitFeedbackRoll = isArchivedRoll && statusS.datatype.boolean({ probability: 0.4 });
        const isArchived = profile ? false : isArchivedRoll;
        const hasExitFeedback = profile ? false : hasExitFeedbackRoll;

        const newVolunteerId = rabid.volunteer.insert({
            join_date: statusS.helpers.maybe(() => isoDate(joinDate), { probability: 0.9 }), // 10% unknown
            name: nameWithProfile(firstName, lastName, profile),
            email: idS.internet.email({ firstName, lastName }).toLowerCase(),
            email_visible_to_all_volunteers: contactS.datatype.boolean({ probability: 0.85 }) ? 1 : 0, // opt-out
            phone: contactS.phone.number({ style: 'national' }),
            phone_number_visible_to_all_volunteers: contactS.datatype.boolean({ probability: 0.3 }) ? 1 : 0, // opt-in
            skills_and_interests: skillS.helpers.arrayElement([
                'Confident with drivetrains; would love to learn wheel-building',
                'Electronics repair; interested in running a fix-it night',
                'Sewing and upholstery — happy to patch panniers and saddles',
                'Carpentry; keen to help build more repair stands',
                'Event planning and logistics; enjoys wrangling volunteers',
                'Fundraising and grant-writing background',
                'Social media and photography; can shoot donation days',
                'Patient teacher — interested in Learn-to-Ride sessions',
                'Welding and metal fab; can take on frame repairs',
                'Small appliance repair; curious about e-bike batteries',
                'New to bikes but eager to learn; strong with people',
                'Bookkeeping; would like to help the treasurer',
                'Loves kids’ programming and would run a youth build',
                ''
            ]),
            // Staff is now an attribute of the activity profile (the rest are
            // volunteers); event check-ins snapshot this for grant reporting.
            is_staff: profile?.isStaff ?? 0,
            // A small minority of (non-staff) volunteers are doing community
            // service: their hours must be host-confirmed.  Draw always (keeps the
            // stream stable); only non-staff qualify.
            volunteer_hours_need_confirmation:
                (!(profile?.isStaff) && confS.datatype.boolean({ probability: 0.08 })) ? 1 : 0,
            emergency_contact_name: contactS.helpers.maybe(
                () => `${contactS.person.firstName()} ${contactS.person.lastName()}`, { probability: 0.7 }) || '',
            emergency_contact_phone: contactS.helpers.maybe(
                () => contactS.phone.number({ style: 'national' }), { probability: 0.7 }) || '',
            // Roles the security model understands: most volunteers have none,
            // some are hosts (extra visibility), a few are admins.
            permissions: roleS.helpers.arrayElement(['', '', '', '', '', '', '', 'host', 'host', 'admin']),
            archived: isArchived ? 1 : 0,
            archived_date: isArchived
                ? isoDate(statusS.date.between({ from: joinDate, to: new Date() }))
                : undefined,
            exit_feedback_requested: hasExitFeedback ? 1 : 0,
            exit_reason: hasExitFeedback ? statusS.helpers.arrayElement(['moved', 'no-time', 'other']) : undefined,
            exit_feedback: hasExitFeedback
                ? statusS.helpers.arrayElement([
                    'Moving to another city',
                    'Work schedule changed',
                    'Family commitments increased',
                    'Health issues',
                    'Found volunteering elsewhere',
                    'No longer interested',
                    ''
                ])
                : undefined,
            // Always draw (keeps the tail's stream stable), but profiled
            // volunteers are never deleted.
            deleted: (statusS.datatype.boolean({ probability: 0.05 }) && !profile) ? 1 : 0,
        });

        // Only ~10% have a password set (login 'volunteer123'); rest are null.
        const hasPassword = acctS.datatype.boolean({ probability: 0.1 });
        const salt = hasPassword ? password.generateSalt() : undefined;
        const hash = hasPassword && salt ? password.hashPassword('volunteer123', salt) : undefined;
        rabid.passwordHash.insert({
            volunteer_id: newVolunteerId,
            password_salt: salt,
            password_hash: hash,
            last_change_time: isoDateTime(joinDate || new Date()),
        });
    }
    return { rockyId };
}

// Curated short names, the way the org actually does it: a volunteer's short
// name is normally just their first name (left BLANK here so the shortName()
// first-word fallback is exercised), and people add a last initial only to
// disambiguate a shared first name ("David Z" while there was also a "David B").
// So we set short_name ONLY for first-name collisions among active volunteers.
export function seedShortNames(rabid: Rabid) {
    const vols = rabid.volunteer.allVolunteersByName.all().filter(v => !v.deleted);
    const byFirst = new Map<string, typeof vols>();
    for(const v of vols) {
        const first = v.name.split(/\s+/)[0] ?? '';
        if(!byFirst.has(first)) byFirst.set(first, []);
        byFirst.get(first)!.push(v);
    }
    let disambiguated = 0;
    for(const group of byFirst.values()) {
        if(group.length < 2) continue;   // unique first name -> blank (fallback)
        for(const v of group) {
            const parts = v.name.split(/\s+/);
            const first = parts[0] ?? '';
            const lastInitial = (parts[parts.length - 1] ?? '').charAt(0).toUpperCase();
            rabid.volunteer.update(v.volunteer_id,
                {short_name: lastInitial ? `${first} ${lastInitial}` : first});
            disambiguated++;
        }
    }
    console.info(`Short names: ${disambiguated} disambiguated (rest fall back to first name)`);
}

// One fixed, role-tiered login (see the canonical-logins block in
// seedVolunteers).  Fixed values, not faker streams, so the credentials and
// records are stable across runs.  `profile` carries the activity tier (its
// middle initial goes into the name, and is_staff comes from it).
function seedFixedLogin(rabid: Rabid, first: string, last: string, email: string, pw: string,
                        permissions: string|undefined, profile: ActivityProfile|null,
                        needsConfirmation = false): number {
    const join = '2023-02-01 10:00:00';        // last_change_time (a datetime)
    const id = rabid.volunteer.insert({
        join_date: '2023-02-01',               // join_date is a DateField
        name: nameWithProfile(first, last, profile),
        email,
        email_visible_to_all_volunteers: 1,
        phone: undefined,
        phone_number_visible_to_all_volunteers: 0,
        skills_and_interests: '',
        emergency_contact_name: '',
        emergency_contact_phone: '',
        is_staff: profile?.isStaff ?? 0,
        volunteer_hours_need_confirmation: needsConfirmation ? 1 : 0,
        permissions,
        archived: 0,
        archived_date: undefined,
        exit_feedback_requested: 0,
        exit_reason: undefined,
        exit_feedback: undefined,
        deleted: 0,
    });
    const salt = password.generateSalt();
    rabid.passwordHash.insert({
        volunteer_id: id,
        password_salt: salt,
        password_hash: password.hashPassword(pw, salt),
        last_change_time: join,
    });
    return id;
}

// --------------------------------------------------------------------------------
// --- Event ----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export function seedEvents(rabid: Rabid, opts: { baseSeed?: number } = {}) {
    faker.seed(((opts.baseSeed ?? 1) ^ hashSeed('events')) >>> 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Start of today
    
    {
        // Generate events for every Saturday from May 1st 2022 to mid-October 2025
        const startDate = new Date('2022-05-07');
        // Track today (plus ~6 weeks of upcoming events) rather than a fixed past
        // date, so the recent weeks the Time view / timesheets cover actually have
        // events to attend (and "upcoming events" is non-empty).
        const endDate = new Date(today.getTime() + 42 * 24 * 60 * 60 * 1000);

        // Find the first Saturday on or after May 1st
        const firstSaturday = new Date(startDate);
        while (firstSaturday.getDay() !== 6) {
            firstSaturday.setDate(firstSaturday.getDate() + 1);
        }

        // Generate events for each Saturday
        const currentDate = new Date(firstSaturday);
        while (currentDate <= endDate) {
            const dateStr = localDateStr(currentDate);

            const startHour = 10
            const duration = 5
            const startTime = `${dateStr} ${startHour.toString().padStart(2, '0')}:00:00`;
            const endTime = `${dateStr} ${(startHour + duration).toString().padStart(2, '0')}:00:00`;
            const setupTime = `${dateStr} ${(startHour - 1).toString().padStart(2, '0')}:30:00`;

            // Check if event is in the past to determine cash collected
            const eventDate = new Date(startTime);
            const isPastEvent = eventDate < today;
            
            rabid.event.insert({
                event_kind: 'public',
                description: "Saturday in Victoria Park",
                // Off-site (the park) -> remote, so it carries a location.
                location_description: 'Victoria Park - Near the Lake',
                location_url: 'https://maps.google.com/?q=Victoria+Park+Kitchener',
                is_remote_event: 1,
                volunteer_only: 0,
                shop_load_time: undefined,
                setup_time: setupTime,
                start_time: startTime,
                end_time: endTime,
                total_cash_collected: isPastEvent ? faker.helpers.rangeToNumber({ min: 0, max: 300 }) : 0,
                notes: ''
            });

            // Advance to next Saturday
            currentDate.setDate(currentDate.getDate() + 7);
        }

        {
            // Generate midweek (Wednesday) events.
            const startDate = new Date('2022-05-07');
            // Track today (plus ~6 weeks of upcoming events) rather than a fixed
            // past date, so the recent weeks the Time view / timesheets cover
            // actually have events to attend (and "upcoming events" is non-empty).
            const endDate = new Date(today.getTime() + 42 * 24 * 60 * 60 * 1000);

            // Find the first Wednesday (getDay() === 3) on or after the start date.
            const firstWednesday = new Date(startDate);
            while (firstWednesday.getDay() !== 3) {
                firstWednesday.setDate(firstWednesday.getDate() + 1);
            }

            // Generate events for each Wednesday
            const currentDate = new Date(firstWednesday);
            while (currentDate <= endDate) {
                const dateStr = localDateStr(currentDate);

                // Main event details similar to createFakeWednesdayEvent
                const startHour = faker.helpers.arrayElement([17, 18, 19]);
                const duration = faker.helpers.arrayElement([2, 3, 4]);
                const startTime = `${dateStr} ${startHour.toString().padStart(2, '0')}:00:00`;
                const endTime = `${dateStr} ${(startHour + duration).toString().padStart(2, '0')}:00:00`;
                const setupTime = `${dateStr} ${(startHour - 1).toString().padStart(2, '0')}:30:00`;

                // Vary the event details slightly.  An at-shop event carries no
                // location (it's the default home); off-site events are remote
                // and carry a location (which is what the UI surfaces).
                const locations = [
                    { desc: "", url: "", remote: false },   // our shop (no location needed)
                    { desc: "Victoria Park - Main Pavilion", url: "https://maps.google.com/?q=Victoria+Park+Kitchener", remote: true },
                    { desc: "Victoria Park - Near the Lake", url: "", remote: true },
                    { desc: "Downtown Kitchener - City Hall", url: "https://maps.google.com/?q=Kitchener+City+Hall", remote: true }
                ];

                const location = faker.helpers.arrayElement(locations);
                
                // Check if event is in the past to determine cash collected
                const eventDate = new Date(startTime);
                const isPastEvent = eventDate < today;

                rabid.event.insert({
                    event_kind: faker.helpers.weightedArrayElement([
                        { value: 'public', weight: 8 },
                        { value: 'training', weight: 1 },
                        { value: 'shopTime', weight: 1 }
                    ]),
                    description: faker.helpers.arrayElement([
                        "Wednesday in Victoria Park",
                        "Community Repair Cafe",
                        "Fix-It Fair",
                        "Repair Workshop"
                    ]),
                    location_description: location.desc,
                    location_url: location.url,
                    is_remote_event: location.remote ? 1 : 0,
                    volunteer_only: faker.datatype.boolean({ probability: 0.1 }) ? 1 : 0,
                    shop_load_time: faker.helpers.maybe(() => {
                        return `${dateStr} ${(startHour - 1).toString().padStart(2, '0')}:00:00`;
                    }, { probability: 0.3 }),
                    setup_time: setupTime,
                    start_time: startTime,
                    end_time: endTime,
                    total_cash_collected: isPastEvent ? faker.helpers.rangeToNumber({ min: 0, max: 500 }) : 0,
                    notes: faker.helpers.maybe(() => 
                        faker.helpers.arrayElement([
                            'Great turnout!',
                            'Need more volunteers next time',
                            'Ran out of spare parts',
                            'Weather was perfect',
                            ''
                        ]), { probability: 0.4 }) || ''
                });

                // Move to next Wednesday
                currentDate.setDate(currentDate.getDate() + 7);
            }
        }
    }
}


export function seedEventCommitments(rabid: Rabid, opts: { baseSeed?: number } = {}) {
    faker.seed(((opts.baseSeed ?? 1) ^ hashSeed('commitments')) >>> 0);
    rand = mulberry32(((opts.baseSeed ?? 1) ^ hashSeed('commitments.rand')) >>> 0);
    const volunteers = rabid.volunteer.allVolunteersByName.all();
    const events = rabid.event.allEvents.all();
    const staffIds = new Set(volunteers.filter(v => v.is_staff).map(v => v.volunteer_id));

    console.info('Event count', events.length);
    if(volunteers.length < 2)
        throw new Error('Must be at least 2 volunteers');
    if(events.length < 2)
        throw new Error('Must be at least 2 events');
    
    // Participation rate comes from each volunteer's activity profile (recovered
    // from the middle initial in their name - see activityProfileOf), so a
    // volunteer who is "active" here is the same one who is active in the
    // timesheet/check-in builders.  The unprofiled long tail is sparse: mostly
    // near-zero, a minority occasional.
    const volunteerParticipationRates = new Map<number, number>();

    volunteers.forEach(volunteer => {
        const p = activityProfileOf(volunteer);
        const participationRate = p ? p.attendRate : (rand() < 0.4 ? rand() * 0.1 : 0);
        volunteerParticipationRates.set(volunteer.volunteer_id, participationRate);
    });
    
    // For each event, create commitments based on volunteer participation rates
    for(const event of events) {
        // Determine target volunteers based on day of week and season
        const eventDate = new Date(event.start_time!);
        const dayOfWeek = eventDate.getDay();
        const month = eventDate.getMonth();
        
        // Base volunteer counts
        let minVolunteers: number;
        let maxVolunteers: number;
        
        // Saturday events (day 6) get more volunteers
        if (dayOfWeek === 6) {
            minVolunteers = 6;
            maxVolunteers = 12;
        } else {
            // Weekday events
            minVolunteers = 2;
            maxVolunteers = 7;
        }
        
        // Apply seasonal variation
        // Winter months (Dec, Jan, Feb) have 30% fewer volunteers
        // Summer months (Jun, Jul, Aug) have 20% more volunteers
        let seasonalMultiplier = 1.0;
        if (month === 11 || month === 0 || month === 1) {
            // Winter - December, January, February
            seasonalMultiplier = 0.7;
        } else if (month >= 5 && month <= 7) {
            // Summer - June, July, August
            seasonalMultiplier = 1.2;
        }
        
        // Apply seasonal adjustment
        minVolunteers = Math.max(1, Math.round(minVolunteers * seasonalMultiplier));
        maxVolunteers = Math.round(maxVolunteers * seasonalMultiplier);
        
        const targetVolunteers = Math.round(faker.helpers.rangeToNumber({ 
            min: minVolunteers, 
            max: maxVolunteers 
        }));
        const commitFor = (volunteer_id: number) => rabid.event_commitment.insert({
            event_id: event.event_id,
            volunteer_id,
            requested_role: faker.helpers.arrayElement(['', 'repair', 'greeter', 'setup', 'cleanup']),
            notes: faker.helpers.maybe(() =>
                faker.helpers.arrayElement([
                    'Can help with electronics',
                    'Will bring tools',
                    'Available for full shift',
                    'Can only stay 2 hours',
                    ''
                ]), { probability: 0.3 }) || '',
            will_drive_supplies: faker.datatype.boolean({ probability: 0.1 }) ? 1 : 0,
            will_drive_passengers_count: faker.helpers.maybe(() =>
                faker.helpers.rangeToNumber({ min: 1, max: 4 }),
                { probability: 0.1 }) || 0,
        });

        // Staff work every event - sign them up unconditionally (they are extra:
        // the target governs how many *other* volunteers turn out).
        for(const volunteer of volunteers)
            if(staffIds.has(volunteer.volunteer_id))
                commitFor(volunteer.volunteer_id);

        // Then fill up to the target with non-staff, priority by participation rate.
        let commitmentCount = 0;
        const shuffledVolunteers = shuffled(volunteers);
        for(const volunteer of shuffledVolunteers) {
            if(staffIds.has(volunteer.volunteer_id)) continue;   // already committed above
            const participationRate = volunteerParticipationRates.get(volunteer.volunteer_id)!;
            if (rand() < participationRate) {
                commitFor(volunteer.volunteer_id);
                commitmentCount++;
                if (commitmentCount >= targetVolunteers) break;
            }
        }
    }
    
    // Log summary statistics
    const totalCommitments = events.reduce((sum, event) => {
        const eventCommitments = rabid.event_commitment.commitmentsForEvent.all({ event_id: event.event_id });
        return sum + eventCommitments.length;
    }, 0);
    
    console.info(`Total commitments: ${totalCommitments}`);
    console.info(`Average volunteers per event: ${(totalCommitments / events.length).toFixed(1)}`);
    
    // Show distribution for first event as example
    const firstEventCommitments = rabid.event_commitment.commitmentsForEventWithVolunteerName.all({ 
        event_id: events[0].event_id 
    });
    console.info(`\nFirst event has ${firstEventCommitments.length} volunteers:`);
    firstEventCommitments.slice(0, 5).forEach(c => {
        console.info(`  - ${c.volunteer_name}${c.requested_role ? ` (${c.requested_role})` : ''}`);
    });
    if (firstEventCommitments.length > 5) {
        console.info(`  ... and ${firstEventCommitments.length - 5} more`);
    }
}

// Event attendance: who actually showed up.  This is the bulk of volunteer
// activity (volunteers attend events; they rarely fill out timesheets).  We turn
// most commitments on started events into check-ins, plus some walk-ins
// (attended without committing).  was_staff is snapshotted by EventCheckin.insert
// from each volunteer's is_staff, so we don't pass it here.
export function seedEventCheckins(rabid: Rabid, opts: { baseSeed?: number } = {}) {
    faker.seed(((opts.baseSeed ?? 1) ^ hashSeed('checkins')) >>> 0);
    rand = mulberry32(((opts.baseSeed ?? 1) ^ hashSeed('checkins.rand')) >>> 0);
    const currentDate = new Date();
    const events = rabid.event.allEvents.all();
    const volunteers = rabid.volunteer.allVolunteersByName.all();
    const staffIds = new Set(volunteers.filter(v => v.is_staff).map(v => v.volunteer_id));
    // Community-service volunteers (hours need host confirmation), and a host to
    // play the confirmer - so some of their past check-ins come pre-confirmed.
    const needsConfirmIds = new Set(
        volunteers.filter(v => v.volunteer_hours_need_confirmation).map(v => v.volunteer_id));
    const confirmerId = volunteers.find(v => /host|admin/.test(v.permissions ?? ''))?.volunteer_id ?? null;

    // Only events that have started can have check-ins.
    const startedEvents = events.filter(e => e.start_time && new Date(e.start_time) <= currentDate);

    // The volunteer Time view defaults to roughly the last 8 weeks, so bias
    // partial time_volunteered durations toward recent events - otherwise they'd
    // all land in the long tail and the default view would never show one.
    const recentCutoff = new Date(currentDate.getTime() - 8 * 7 * 24 * 60 * 60 * 1000);

    let checkinCount = 0;
    let walkInCount = 0;
    // A walk-in attends at most one event in this dataset (keeps the data legible).
    const walkInVolunteers = new Set<number>();

    for (const event of startedEvents) {
        const isPast = !!(event.end_time && new Date(event.end_time) < currentDate);
        const commitments = rabid.event_commitment.commitmentsForEvent.all({ event_id: event.event_id });

        // Most committed volunteers show up; a bit fewer for a still-ongoing event
        // (not everyone has arrived yet).  Staff work every event, so they always
        // check in.  Check-ins inherit the event's times.
        const showRate = isPast ? 0.9 : 0.7;
        for (const commitment of commitments) {
            const rate = staffIds.has(commitment.volunteer_id) ? 1.0 : showRate;
            if (rand() < rate) {
                // By far the common case is checking into the whole event (no
                // duration).  But occasionally - and only for a past event a host
                // could look back on - record a partial time_volunteered instead,
                // a rounded "they were here ~90 min".  Staff work the whole event,
                // so never for them.  Recent events (in the Time view's default
                // window) get partials more often, so the default view shows some.
                const isRecent = new Date(event.start_time!) >= recentCutoff;
                const partialRate = isRecent ? 0.6 : 0.15;
                const partialMinutes = isPast && !staffIds.has(commitment.volunteer_id) && rand() < partialRate
                    ? faker.helpers.arrayElement([30, 45, 60, 90, 120]) : undefined;
                // A community-service volunteer's past hours are mostly (but not
                // all) host-confirmed - leaving a realistic unconfirmed remainder.
                const confirmedBy = isPast && confirmerId != null
                    && needsConfirmIds.has(commitment.volunteer_id) && rand() < 0.6
                    ? confirmerId : undefined;
                rabid.event_checkin.insert({
                    event_id: event.event_id,
                    volunteer_id: commitment.volunteer_id,
                    notes: '',
                    ...(partialMinutes !== undefined ? {time_volunteered_minutes: partialMinutes} : {}),
                    ...(confirmedBy !== undefined ? {confirmed_by: confirmedBy} : {}),
                });
                checkinCount++;
            }
        }

        // A few walk-ins: attended without committing.  Give them an explicit late
        // arrival (a start_time override) to exercise partial attendance.
        const committedIds = new Set(commitments.map(c => c.volunteer_id));
        const eventDate = new Date(event.start_time!);
        const maxWalkIns = eventDate.getDay() === 6 ? 3 : 1;   // more on Saturdays
        const numWalkIns = faker.helpers.rangeToNumber({ min: 0, max: maxWalkIns });
        for (let i = 0; i < numWalkIns; i++) {
            const available = volunteers.filter(v =>
                !committedIds.has(v.volunteer_id) && !walkInVolunteers.has(v.volunteer_id));
            if (available.length === 0) break;
            const walkIn = faker.helpers.arrayElement(available);
            walkInVolunteers.add(walkIn.volunteer_id);

            // Arrived 30-120 min after the event start (overrides the event time).
            const arrival = new Date(eventDate.getTime() +
                faker.helpers.rangeToNumber({ min: 30, max: 120 }) * 60000);
            rabid.event_checkin.insert({
                event_id: event.event_id,
                volunteer_id: walkIn.volunteer_id,
                start_time: localDateTimeStr(arrival),
                notes: 'Walk-in',
            });
            checkinCount++;
            walkInCount++;
        }
    }

    console.info(`Total event check-ins created: ${checkinCount} (${walkInCount} walk-ins) across ${startedEvents.length} started events`);
}

// Explicit recorded time - volunteers/staff doing work like shop maintenance,
// admin, or supply runs.  Driven by the activity profile (the active tiers log a
// weekly load; the long tail logs nothing), over a bounded recent window of
// `opts.weeks` weeks (default 12).  Crank it up - e.g. `... full 520` - to
// simulate years of data when hunting for slowdowns.
//
// Two kinds of entry per active week:
//   (1) OVERLAP entries that bracket an event the volunteer attended (start 30min
//       before, end 30min after) - so the unified Time view exercises its
//       reconciliation rule: the timesheet is authoritative and the event
//       check-in nests inside it as a non-counted detail.
//   (2) TOP-UP standalone entries (no event) on weekdays, until the week reaches
//       the profile's target hours.
// (Event attendance itself lives in event_checkin - see seedEventCheckins.)
export function seedTimesheets(rabid: Rabid, opts: { baseSeed?: number, weeks?: number } = {}) {
    faker.seed(((opts.baseSeed ?? 1) ^ hashSeed('timesheets')) >>> 0);
    rand = mulberry32(((opts.baseSeed ?? 1) ^ hashSeed('timesheets.rand')) >>> 0);
    const weeks = opts.weeks ?? 12;
    const now = new Date();

    // Week windows aligned Mon..Sun (the Time view groups payroll weeks ending
    // Sunday night).  Week 0 starts on the Monday of the current week; each step
    // goes back 7 days.
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setHours(0, 0, 0, 0);
    startOfThisWeek.setDate(startOfThisWeek.getDate() - ((startOfThisWeek.getDay() + 6) % 7)); // back to Monday

    const volunteers = rabid.volunteer.allVolunteersByName.all()
        .filter(v => !v.archived && !v.deleted);
    const allEvents = rabid.event.allEvents.all()
        .filter(e => e.start_time)
        .map(e => ({start: new Date(e.start_time!),
                    end: e.end_time ? new Date(e.end_time) : null}));

    // Stamp in LOCAL wall-clock (these Dates derive from event start_times, which
    // are stored local) so a staff shift bracketing an event really overlaps it on
    // the stored strings - that's what the Time view's reconciliation nests on.
    const stamp = (d: Date) => localDateTimeStr(d);
    // When the entry was recorded: usually promptly (same day), but a fraction of
    // PAID entries are entered late on purpose, to exercise the late-paid warning.
    const recordedAt = (end: Date, paid: boolnum): string => {
        const lateMs = (paid && rand() < 0.2)
            ? (3 + Math.floor(rand() * 18)) * 24 * 3600_000   // 3-21 days late
            : Math.floor(rand() * 12) * 3600_000;             // 0-12h after end (prompt)
        return stamp(new Date(Math.min(now.getTime(), end.getTime() + lateMs)));
    };
    const note = (paid: boolnum) => faker.helpers.arrayElement(paid ? [
        'Shop supervision and repairs',
        'Coordinating volunteers and intake',
        'Admin: grant reporting and scheduling',
        'Workshop teardown and inventory',
    ] : [
        'Shop maintenance and organization',
        'Tool inventory and sorting',
        'Preparing materials for next event',
        'Picking up donated supplies',
    ]);

    let entryCount = 0;
    let overlapCount = 0;
    for(const v of volunteers) {
        const p = activityProfileOf(v);
        if(!p || p.weeklyHours <= 0) continue;   // only the active tiers log time

        for(let w = 0; w < weeks; w++) {
            const weekStart = new Date(startOfThisWeek);
            weekStart.setDate(weekStart.getDate() - w * 7);
            if(weekStart > now) continue;
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 7);

            const targetMs = p.weeklyHours * (0.8 + rand() * 0.4) * 3600_000;  // +/-20%
            let loggedMs = 0;

            // (1) Overlap pass (paid staff only - they log paid time AROUND
            // events; ordinary volunteers just check in).  Bracket events this
            // week the volunteer attended - this is what exercises the Time view's
            // reconciliation: the timesheet is authoritative and the event
            // check-in nests inside it as a non-counted detail.
            const weekEvents = p.paid
                ? allEvents.filter(e => e.start >= weekStart && e.start < weekEnd && e.start <= now)
                : [];
            for(const ev of weekEvents) {
                if(loggedMs >= targetMs) break;
                if(rand() >= p.attendRate) continue;
                const evEnd = ev.end ?? new Date(ev.start.getTime() + 4 * 3600_000);
                // Sometimes a margin (setup before / teardown after), sometimes the
                // shift matches the event exactly - so both kinds of overlap appear.
                const margin = () => faker.helpers.arrayElement([0, 0, 15, 30, 60]) * 60_000;
                const tsStart = new Date(ev.start.getTime() - margin());
                const tsEnd = new Date(evEnd.getTime() + margin());
                if(tsEnd > now) continue;
                const recorded = recordedAt(tsEnd, p.paid);
                rabid.timesheet_entry.insert({
                    volunteer_id: v.volunteer_id,
                    start_time: stamp(tsStart),
                    end_time: stamp(tsEnd),
                    notes: note(p.paid),
                    km_driven_for_reimbursement: 0,
                    km_driven_processed: 0,
                    is_paid_time: p.paid,
                    paid_time_processed: 0,
                    entry_creation_time: recorded,
                    entry_last_edit_time: recorded,
                });
                loggedMs += tsEnd.getTime() - tsStart.getTime();
                entryCount++; overlapCount++;
            }

            // (2) Top-up pass: standalone weekday entries until we reach the target.
            let guard = 0;
            while(loggedMs < targetMs - 3600_000 && guard++ < 20) {
                const day = new Date(weekStart);
                day.setDate(day.getDate() + faker.helpers.rangeToNumber({min: 0, max: 6}));
                const durHours = Math.min(4, Math.max(2,
                    Math.round((targetMs - loggedMs) / 3600_000)));
                const tsStart = new Date(day);
                tsStart.setHours(faker.helpers.rangeToNumber({min: 9, max: 16}), 0, 0, 0);
                const tsEnd = new Date(tsStart.getTime() + durHours * 3600_000);
                if(tsStart > now) continue;
                if(tsEnd > now) break;
                const recorded = recordedAt(tsEnd, p.paid);
                rabid.timesheet_entry.insert({
                    volunteer_id: v.volunteer_id,
                    start_time: stamp(tsStart),
                    end_time: stamp(tsEnd),
                    notes: note(p.paid),
                    km_driven_for_reimbursement: faker.datatype.boolean({probability: 0.2})
                        ? faker.helpers.rangeToNumber({min: 10, max: 80}) : 0,
                    km_driven_processed: 0,
                    is_paid_time: p.paid,
                    paid_time_processed: 0,
                    entry_creation_time: recorded,
                    entry_last_edit_time: recorded,
                });
                loggedMs += tsEnd.getTime() - tsStart.getTime();
                entryCount++;
            }
        }
    }

    console.info(`Total timesheet entries created: ${entryCount} (${overlapCount} overlap an event) over ${weeks} week(s)`);
}

// Completed tasks CREDITED to the volunteer who did them (done_by) - what the
// Time view's completed-task layer surfaces ("who did what").  Attributed to the
// active tiers (staff most), placed to exercise all three layer paths:
//   - event-nested  : an event-owned task done by someone who attended that event
//                     (its project is event-owned -> shows under that event);
//   - shift-nested  : a personal task done during one of their timesheet shifts;
//   - standalone    : a personal task done off any shift/event (a per-day row).
// Needs check-ins + timesheets to anchor against (run after both).
export function seedCompletedTasks(rabid: Rabid, opts: { baseSeed?: number } = {}) {
    faker.seed(((opts.baseSeed ?? 1) ^ hashSeed('completed_tasks')) >>> 0);
    rand = mulberry32(((opts.baseSeed ?? 1) ^ hashSeed('completed_tasks.rand')) >>> 0);

    // The seeded timesheet/event datetimes are wall-clock strings; parse and
    // FORMAT them in the same (UTC-anchored) space so a done_time computed inside
    // a shift round-trips to a string that really is BETWEEN that shift's
    // start/end.  (Naive new Date(str)/toISOString double-shifts by the server's
    // offset, which pushed done_times outside their windows -> 0 shift-nested.)
    const ms = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');
    const stamp = (m: number) => new Date(m).toISOString().replace('T', ' ').slice(0, 19);
    const nowMs = Date.now();
    const recentCutMs = nowMs - 90 * 24 * 3600_000;

    const titles = [
        'Sort donated parts', 'Fix the repair stand', 'Update the intake sheet',
        'Restock the first-aid kit', 'Confirm volunteers', 'Post event photos',
        'Inventory the tools', 'Clean the workspace', 'Pick up supplies',
        'Greet attendees', 'Set up tables', 'Tear down the booth',
        'Log cash collected', 'Email community partners', 'Label spare parts',
        'Book the pickup truck', 'Refill consumables', 'Test the donated bikes',
    ];
    // How many completions per activity tier (staff do the most; tail none).
    const countByTier: Record<string, number> = {staff: 10, heavy: 7, regular: 4, occasional: 1};

    const completeTask = (project_id: number, title: string, doneMs: number, done_by: number) =>
        rabid.task.insert({project_id, title, status: 'done',
            done_time: stamp(doneMs), done_by, deleted: 0} as any);

    let made = 0, inline = 0;
    const volunteers = rabid.volunteer.allVolunteersByName.all().filter(v => !v.deleted);
    for(const v of volunteers) {
        const profile = activityProfileOf(v);
        const n = profile ? (countByTier[profile.key] ?? 0) : 0;
        if(n === 0) continue;
        const vid = v.volunteer_id;

        const checkins = (rabid.event_checkin.checkinsForVolunteer.all({volunteer_id: vid}) as Array<{
            event_id: number, start_time: string|null,
            event_start_time: string|null, event_end_time: string|null}>)
            .filter(c => {
                const t = c.start_time ?? c.event_start_time;
                return !!t && ms(t) >= recentCutMs && ms(t) <= nowMs;
            });
        const shifts = rabid.timesheet_entry.entriesForVolunteer.all({volunteer_id: vid})
            .filter(t => !!t.end_time && ms(t.start_time) >= recentCutMs);

        for(let i = 0; i < n; i++) {
            const title = faker.helpers.arrayElement(titles);
            const roll = rand();
            // Weight toward the INLINE cases (event 50% / shift 35%) so the chips
            // mostly land next to the hours; standalone (~15%) is the off-shift tail.
            if(roll < 0.5 && checkins.length) {
                // event-nested: an event-owned task done around the event.
                const c = checkins[Math.floor(rand() * checkins.length)];
                const end = c.event_end_time ?? c.event_start_time ?? c.start_time!;
                const doneMs = Math.min(nowMs, ms(end) + Math.floor(rand() * 60) * 60_000);
                completeTask(rabid.project.forOwner('event', c.event_id, null, true)!, title, doneMs, vid);
                made++; inline++;
            } else if(roll < 0.85 && shifts.length) {
                // shift-nested: a personal task done INSIDE a timesheet window.
                const s = shifts[Math.floor(rand() * shifts.length)];
                const a = ms(s.start_time), b = ms(s.end_time!);
                completeTask(rabid.project.forOwner('volunteer', vid, null, true)!, title,
                             a + Math.floor(rand() * (b - a)), vid);
                made++; inline++;
            } else {
                // standalone (orphan): a personal task done off-shift - 05:00 UTC on a
                // recent day, before the daytime shifts, so it stays its own row.
                const dayMid = Math.floor((nowMs - (1 + Math.floor(rand() * 80)) * 24 * 3600_000)
                                          / 86400_000) * 86400_000;
                completeTask(rabid.project.forOwner('volunteer', vid, null, true)!, title,
                             dayMid + 5 * 3600_000, vid);
                made++;
            }
        }
    }
    console.info(`Completed (credited) tasks created: ${made} (${inline} inline on a shift/event)`);
}

// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------

// --------------------------------------------------------------------------------
// --- Committees ------------------------------------------------------------------
// --------------------------------------------------------------------------------

// A few committees with deterministic membership (every Nth active volunteer,
// plus Hazel on Logistics so the canonical host login has a committee to play
// with).  Cheap, so seeded in every scenario.
export function seedCommittees(rabid: Rabid): void {
    const volunteers = rabid.volunteer.allVolunteersByName.all()
        .filter(v => !v.archived && !v.deleted);
    const byEmail = (email: string) => volunteers.find(v => v.email === email);

    const committees: Array<{name: string, description: string, notes?: string, members: number[]}> = [
        {name: 'Logistics Committee',
         description: 'Owns the **physical logistics** of every event:\n\n'
             + '- supplies and the tool inventory\n'
             + '- transport and the pickup truck\n'
             + '- setup and teardown crews\n\n'
             + 'Check with the chair before booking any large vehicle.',
         notes: 'Truck rental account is under Hazel; ask her for the code.',
         members: [byEmail('hazel@redraccoon.org')?.volunteer_id,
                   ...volunteers.filter((_, i) => i % 11 === 3).slice(0, 4).map(v => v.volunteer_id)]
             .filter((id): id is number => id !== undefined)},
        {name: 'Outreach Committee',
         description: 'Grows the shop’s reach in the neighbourhood:\n\n'
             + '- community and school **partnerships**\n'
             + '- social media and the monthly newsletter\n'
             + '- promotion for donation days and repair events',
         members: volunteers.filter((_, i) => i % 13 === 5).slice(0, 3).map(v => v.volunteer_id)},
    ];

    for(const c of committees) {
        const committee_id = rabid.committee.insert({
            name: c.name, description: c.description, notes: c.notes ?? '', deleted: 0});
        const {group_id} = rabid.committee.getById(committee_id);
        for(const volunteer_id of new Set(c.members))
            rabid.group_member.insert({group_id, volunteer_id});
    }
    console.info(`${committees.length} committees created`);
}

// --------------------------------------------------------------------------------
// --- Projects / tasks / subtasks --------------------------------------------------
// --------------------------------------------------------------------------------

// A couple of projects with tasks in assorted states (assignees, due dates,
// a checklist, a done task) so every affordance has something to show.
// Deterministic membership, same style as seedCommittees.  Cheap, so seeded
// in every scenario.
export function seedProjects(rabid: Rabid): void {
    const volunteers = rabid.volunteer.allVolunteersByName.all()
        .filter(v => !v.archived && !v.deleted);
    const byEmail = (email: string) => volunteers.find(v => v.email === email);
    const logistics = rabid.committee.activeCommittees.all({})
        .find(c => c.name === 'Logistics Committee');

    // A per-task EXCLUSIVE override (the exception, not the rule - most tasks
    // inherit their project's assignment), through the real action so the
    // override group is created the same way the UI creates it.
    const assign = (task_id: number, ids: Array<number|undefined>) => {
        rabid.task.overrideAssignees(task_id);
        const group_id = rabid.task.getById(task_id).group_id!;
        for(const volunteer_id of new Set(ids.filter((id): id is number => id !== undefined)))
            rabid.group_member.insert({group_id, volunteer_id});
    };

    const drive = rabid.project.insert({
        name: 'Spring Bike Drive',
        description: 'Collect, refurbish, and distribute donated bikes.', deleted: 0});
    // The drive is the Logistics Committee's project (live membership) -
    // its tasks inherit that assignment unless individually overridden.
    if(logistics)
        rabid.project.assignCommittee({project_id: drive, committee_id: logistics.committee_id});
    const shop = rabid.project.insert({
        name: 'Shop Improvements',
        description: 'Small fixes and upgrades around the shop.', deleted: 0});

    const truck = rabid.task.insert({
        project_id: drive, title: 'Book pickup truck',
        details: 'For collecting donation-day bikes from the three dropoff sites.',
        priority: 'high', due: '2026-06-20', status: 'in-progress', deleted: 0});
    assign(truck, [byEmail('hazel@redraccoon.org')?.volunteer_id]);
    rabid.subtask.insert({task_id: truck, title: 'Get rental quotes', done: 1});
    rabid.subtask.insert({task_id: truck, title: 'Confirm driver', done: 0});
    rabid.subtask.insert({task_id: truck, title: 'Reserve for June 20', done: 0});

    const posters = rabid.task.insert({
        project_id: drive, title: 'Posters for donation day',
        due: '2026-06-15', deleted: 0});
    assign(posters, volunteers.filter((_, i) => i % 17 === 2).slice(0, 2).map(v => v.volunteer_id));

    rabid.task.insert({
        project_id: drive, title: 'Confirm dropoff sites',
        status: 'done', deleted: 0});

    // No override: inherits the project's assignment (the Logistics
    // Committee, live) - the RULE, demonstrated.
    rabid.task.insert({
        project_id: drive, title: 'Donation day staffing',
        due: '2026-06-19', deleted: 0});

    const stand = rabid.task.insert({
        project_id: shop, title: 'Fix wobbly repair stand #3',
        priority: 'low', deleted: 0});
    assign(stand, volunteers.filter((_, i) => i % 19 === 7).slice(0, 1).map(v => v.volunteer_id));

    // Two checklist TEMPLATES (host/admin-managed definitions): instantiated on
    // events to produce their setup/cleanup checklists.  No assignees, no due -
    // structure only (assignment comes from the instance's owner).
    const cleanup = rabid.project.insert({
        name: 'Event Cleanup', is_template: 1, applies_to_table: 'event', owner_role: 'cleanup',
        description: 'Post-event tidy so the shop is ready for the next crew.', deleted: 0});
    const sweep = rabid.task.insert({project_id: cleanup, title: 'Sweep the floors', deleted: 0});
    rabid.subtask.insert({task_id: sweep, title: 'Main floor', done: 0});
    rabid.subtask.insert({task_id: sweep, title: 'Repair bays', done: 0});
    rabid.task.insert({project_id: cleanup, title: 'Empty the bins', deleted: 0});
    rabid.task.insert({project_id: cleanup, title: 'Return tools to the board', deleted: 0});
    rabid.task.insert({project_id: cleanup, title: 'Wipe down the benches', deleted: 0});
    rabid.task.insert({project_id: cleanup, title: 'Lock up', deleted: 0});

    const setup = rabid.project.insert({
        name: 'Event Setup', is_template: 1, applies_to_table: 'event', owner_role: 'setup',
        description: 'Open the shop and get ready before an event.', deleted: 0});
    rabid.task.insert({project_id: setup, title: 'Unlock and lights on', deleted: 0});
    rabid.task.insert({project_id: setup, title: 'Set out loaner tools', deleted: 0});
    rabid.task.insert({project_id: setup, title: 'Check the sign-in sheet', deleted: 0});

    console.info('2 projects + 2 checklist templates created');
}

// Instantiate the Event Cleanup checklist on a couple of recent events (some
// items ticked off, to show mixed state).  Runs after seedEvents.
export function seedEventChecklists(rabid: Rabid): void {
    const cleanupTemplate = rabid.project.templatesForOwnerTable.all({owner_table: 'event'})
        .find(t => t.owner_role === 'cleanup');
    if(!cleanupTemplate) return;
    // The two most-recent events (start_time strings sort lexicographically).
    const recent = rabid.event.allEvents.all()
        .filter(e => !!e.start_time)
        .sort((a, b) => (a.start_time! < b.start_time! ? 1 : -1))
        .slice(0, 2);
    for(const [i, e] of recent.entries()) {
        const project_id = rabid.project.instantiateTemplate(cleanupTemplate.project_id, 'event', e.event_id);
        if(i === 0)   // tick off the first couple on the most recent event
            for(const t of rabid.task.tasksForProject.all({project_id}).slice(0, 2))
                rabid.task.update(t.task_id, {status: 'done'});
    }
    console.info(`event cleanup checklists created on ${recent.length} events`);
}

// --------------------------------------------------------------------------------
// --- Scenarios + composition ----------------------------------------------------
// --------------------------------------------------------------------------------
//
// The builders self-fetch their inputs (events/commitments/timesheets read prior
// data from the db), so composing a dataset is just choosing which slices to run
// and how big.  Timesheets are the expensive slice and only the activity report
// needs them, so most scenarios skip them.

export interface Scenario {
    volunteers: number;
    events: boolean;
    commitments: boolean;
    // Event attendance (the bulk activity).  Needs events + commitments first.
    checkins: boolean;
    // Explicit recorded time (driven by activity profile - see seedTimesheets).
    timesheets: boolean;
    // History window for seeded timesheets, in weeks back from today.  Bump it
    // (or override on the CLI - see main) to simulate years of data.
    timesheetWeeks: number;
    // Tasks marked done by volunteers (done_by) - the Time view's completed-task
    // layer.  Needs checkins + timesheets to anchor against.
    completedTasks: boolean;
    baseSeed: number;
}

export type ScenarioName = 'minimal' | 'dev' | 'full' | 'activityReport';

export const SCENARIOS: Record<ScenarioName, Scenario> = {
    // tiny + fast, for a quick poke
    minimal:        { volunteers: 8,  events: true, commitments: true, checkins: false, timesheets: false, timesheetWeeks: 12, completedTasks: false, baseSeed: 1 },
    // the everyday dataset: people, events, who's coming - but NOT the bulk attendance
    dev:            { volunteers: 99, events: true, commitments: true, checkins: false, timesheets: false, timesheetWeeks: 12, completedTasks: false, baseSeed: 1 },
    // everything, incl. the bulk attendance + timesheets + credited task completions
    full:           { volunteers: 99, events: true, commitments: true, checkins: true,  timesheets: true,  timesheetWeeks: 12, completedTasks: true,  baseSeed: 1 },
    activityReport: { volunteers: 99, events: true, commitments: true, checkins: true,  timesheets: true,  timesheetWeeks: 12, completedTasks: true,  baseSeed: 1 },
};

// A light touch of RECENT activity so the volunteer list's active/inactive
// split ("Active — last 30 days" vs "Other volunteers") is visible in `dev`.
// The full attendance datasets (seedTimesheets/seedEventCheckins) only run in
// `full`/`activityReport`; this gives ~14 volunteers a single timesheet entry in
// the last few weeks so `activeVolunteerIdsWithin(30)` picks them up.
export function seedRecentActivity(rabid: Rabid): void {
    const volunteers = rabid.volunteer.allVolunteersByName.all().filter(v => !v.deleted && !v.archived);
    const rng = makeStreams(7)('recent.activity');
    const pick = rng.helpers.arrayElements(volunteers, Math.min(14, volunteers.length));
    for(const [i, v] of pick.entries()) {
        const d = new Date();
        d.setDate(d.getDate() - (2 + i));   // 2..15 days ago -> within the 30-day window
        const day = d.toISOString().slice(0, 10);
        rabid.timesheet_entry.insert({
            volunteer_id: v.volunteer_id,
            start_time: `${day} 10:00:00`, end_time: `${day} 13:00:00`,
            notes: 'Shop shift', km_driven_for_reimbursement: 0, km_driven_processed: 0,
            is_paid_time: 0, paid_time_processed: 0});
    }
    console.info(`recent activity seeded for ${pick.length} volunteers`);
}

// Run the builders for a scenario (order matters: later builders read earlier data).
export function seedScenario(rabid: Rabid, scenario: Scenario): void {
    seedVolunteers(rabid, { count: scenario.volunteers, baseSeed: scenario.baseSeed });
    seedShortNames(rabid);
    seedCommittees(rabid);
    seedProjects(rabid);
    // Light recent activity so the volunteer-list split shows in scenarios
    // without the full timesheet dataset (dev/minimal).
    if(!scenario.timesheets) seedRecentActivity(rabid);
    if(scenario.events)      seedEvents(rabid, { baseSeed: scenario.baseSeed });
    if(scenario.events)      seedEventChecklists(rabid);
    if(scenario.commitments) seedEventCommitments(rabid, { baseSeed: scenario.baseSeed });
    if(scenario.checkins)    seedEventCheckins(rabid, { baseSeed: scenario.baseSeed });
    if(scenario.timesheets)  seedTimesheets(rabid, { baseSeed: scenario.baseSeed, weeks: scenario.timesheetWeeks });
    if(scenario.completedTasks) seedCompletedTasks(rabid, { baseSeed: scenario.baseSeed });
}

// Create the schema from the table metadata (the on-disk db's schema-of-record).
export function createAllTables(rabid: Rabid): void {
    rabid.tables.forEach(table => {
        console.info(`--- creating ${table.name}`);
        db().executeStatements(table.createDMLString());
    });
}

function destroyAllAndFillWithFakeData(rabid: Rabid, scenario: Scenario): void {
    console.info("*** DESTROYING ALL AND FILLING WITH FAKE DATA ***");
    assertSafeToWipe(defaultDbPath);   // refuses if db_purpose='production'
    Db.deleteDb(defaultDbPath);
    createAllTables(rabid);
    rabid.config.setDbPurpose('dev');  // this is a throwaway dev database
    seedScenario(rabid, scenario);
    console.info(rabid.volunteer.allVolunteersByName.all().length, 'volunteers created');
}

function main(args: string[]) {
    const cmd = args[0];
    switch(cmd) {
        case 'destroy_all_and_fill_with_fake_data': {
            const name = (args[1] ?? 'dev') as ScenarioName;
            const base = SCENARIOS[name];
            if(!base) {
                console.info(`unknown scenario '${name}'; known: ${Object.keys(SCENARIOS).join(', ')}`);
                break;
            }
            // Optional 3rd arg overrides the timesheet history window (weeks back),
            // e.g. `... full 520` for ~10 years of simulated data.
            const weeksOverride = args[2] !== undefined ? Number(args[2]) : undefined;
            if(weeksOverride !== undefined && !Number.isFinite(weeksOverride)) {
                console.info(`bad weeks override '${args[2]}' (expected a number)`);
                break;
            }
            const scenario = weeksOverride !== undefined
                ? {...base, timesheets: true, timesheetWeeks: weeksOverride}
                : base;
            console.info(`scenario '${name}':`, scenario);
            // getRabid (not new Rabid()): it also sets the module-level `rabid`
            // binding that table code (e.g. CommitteeTable.insert) reaches for.
            destroyAllAndFillWithFakeData(getRabid(), scenario);
            break;
        }
        case 'set_db_purpose': {
            const purpose = args[1] as DbPurpose;
            if(!['production', 'dev', 'test'].includes(purpose)) {
                console.info(`usage: set_db_purpose <production|dev|test>`);
                break;
            }
            getRabid().config.setDbPurpose(purpose);
            console.info(`db_purpose set to '${purpose}'`);
            break;
        }
        default:
            console.info('BAD COMMAND!');
            break;
    }
}

if (import.meta.main)
    main(Deno.args);
