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
    const skillS = s('volunteer.skills');
    const statusS = s('volunteer.status');     // join / inactive / exit
    const roleS = s('volunteer.role');         // permissions
    const acctS = s('volunteer.account');      // whether a password is set

    // Rocky uses fixed values so the canonical admin login is stable across runs.
    const rockyJoin = '2023-01-07 10:00:00';   // last_change_time (a datetime)
    const rockyId = rabid.volunteer.insert({
        join_date: '2023-01-07',               // join_date is a DateField

        name: 'Rocky Raccoon',
        email: 'rocky@redraccoon.org',
        email_visible_to_all_volunteers: 1,  // Rocky shares their email
        phone: '(555) 010-0010',
        phone_number_visible_to_all_volunteers: 1,  // Rocky shares their phone
        skills: 'event planning, fundraising, social media',
        emergency_contact_name: 'The Beatles',
        emergency_contact_phone: '(555) 010-0011',
        // 'testing' lets the canonical dev login drive the browser-test harness
        // (the test-client page + evalInBrowser); see liminal/browser-agent.ts.
        permissions: 'admin,testing',
        inactive: 0,
        marked_inactive_date: undefined,
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

    // Canonical fixed logins for the other role tiers, so role-dependent UI
    // (e.g. which rows present an edit affordance) can be checked by hand
    // without hunting for credentials:
    //   hazel@redraccoon.org / hzl   - host
    //   vinnie@redraccoon.org / vnny - regular volunteer (no roles)
    seedFixedLogin(rabid, 'Hazel Host', 'hazel@redraccoon.org', 'hzl', 'host');
    seedFixedLogin(rabid, 'Vinnie Volunteer', 'vinnie@redraccoon.org', 'vnny', undefined);

    for(let i = 0; i < count; i++) {
        const firstName = idS.person.firstName();
        const lastName = idS.person.lastName();
        const joinDate = statusS.date.past({ years: 3 });
        const isInactive = statusS.datatype.boolean({ probability: 0.15 });
        const hasExitFeedback = isInactive && statusS.datatype.boolean({ probability: 0.4 });

        const newVolunteerId = rabid.volunteer.insert({
            join_date: statusS.helpers.maybe(() => isoDate(joinDate), { probability: 0.9 }), // 10% unknown
            name: `${firstName} ${lastName}`,
            email: idS.internet.email({ firstName, lastName }).toLowerCase(),
            email_visible_to_all_volunteers: contactS.datatype.boolean({ probability: 0.85 }) ? 1 : 0, // opt-out
            phone: contactS.phone.number({ style: 'national' }),
            phone_number_visible_to_all_volunteers: contactS.datatype.boolean({ probability: 0.3 }) ? 1 : 0, // opt-in
            skills: skillS.helpers.arrayElement([
                'bike repair',
                'electronics repair',
                'sewing',
                'carpentry',
                'event planning',
                'fundraising',
                'social media',
                'teaching',
                'welding',
                'small appliance repair',
                'bike repair, electronics',
                'event planning, social media',
                'carpentry, welding',
                ''
            ]),
            emergency_contact_name: contactS.helpers.maybe(
                () => `${contactS.person.firstName()} ${contactS.person.lastName()}`, { probability: 0.7 }) || '',
            emergency_contact_phone: contactS.helpers.maybe(
                () => contactS.phone.number({ style: 'national' }), { probability: 0.7 }) || '',
            // Roles the security model understands: most volunteers have none,
            // some are hosts (extra visibility), a few are admins.
            permissions: roleS.helpers.arrayElement(['', '', '', '', '', '', '', 'host', 'host', 'admin']),
            inactive: isInactive ? 1 : 0,
            marked_inactive_date: isInactive
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
            deleted: statusS.datatype.boolean({ probability: 0.05 }) ? 1 : 0,
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

// One fixed, role-tiered login (see the canonical-logins block in
// seedVolunteers).  Fixed values, not faker streams, so the credentials and
// records are stable across runs.
function seedFixedLogin(rabid: Rabid, name: string, email: string, pw: string,
                        permissions: string|undefined): number {
    const join = '2023-02-01 10:00:00';        // last_change_time (a datetime)
    const id = rabid.volunteer.insert({
        join_date: '2023-02-01',               // join_date is a DateField
        name,
        email,
        email_visible_to_all_volunteers: 1,
        phone: undefined,
        phone_number_visible_to_all_volunteers: 0,
        skills: '',
        emergency_contact_name: '',
        emergency_contact_phone: '',
        permissions,
        inactive: 0,
        marked_inactive_date: undefined,
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
        const endDate = new Date('2025-10-15');

        // Find the first Saturday on or after May 1st
        const firstSaturday = new Date(startDate);
        while (firstSaturday.getDay() !== 6) {
            firstSaturday.setDate(firstSaturday.getDate() + 1);
        }

        // Generate events for each Saturday
        const currentDate = new Date(firstSaturday);
        while (currentDate <= endDate) {
            const dateStr = currentDate.toISOString().split('T')[0];

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
                location_description: 'Victoria Park - Behind 79 Joseph Street',
                location_url: '',
                is_remote_event: 0,
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
            // Generate events
            const startDate = new Date('2022-05-07');
            const endDate = new Date('2025-10-15');

            // Find the first Wednesday on or after the start date
            const firstWednesday = new Date(startDate);
            while (firstWednesday.getDay() !== 6) {
                firstWednesday.setDate(firstWednesday.getDate() + 1);
            }

            // Generate events for each Wednesday
            const currentDate = new Date(firstWednesday);
            while (currentDate <= endDate) {
                const dateStr = currentDate.toISOString().split('T')[0];
                
                // Main event details similar to createFakeWednesdayEvent
                const startHour = faker.helpers.arrayElement([17, 18, 19]);
                const duration = faker.helpers.arrayElement([2, 3, 4]);
                const startTime = `${dateStr} ${startHour.toString().padStart(2, '0')}:00:00`;
                const endTime = `${dateStr} ${(startHour + duration).toString().padStart(2, '0')}:00:00`;
                const setupTime = `${dateStr} ${(startHour - 1).toString().padStart(2, '0')}:30:00`;

                // Vary the event details slightly
                const locations = [
                    { desc: "Behind 79 Joseph Street", url: "" },
                    { desc: "Victoria Park - Main Pavilion", url: "https://maps.google.com/?q=Victoria+Park+Kitchener" },
                    { desc: "Victoria Park - Near the Lake", url: "" },
                    { desc: "Downtown Kitchener - City Hall", url: "https://maps.google.com/?q=Kitchener+City+Hall" }
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
                    is_remote_event: location.desc.includes("Downtown") ? 1 : 0,
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
    
    console.info('Event count', events.length);
    if(volunteers.length < 2)
        throw new Error('Must be at least 2 volunteers');
    if(events.length < 2)
        throw new Error('Must be at least 2 events');
    
    // Assign each volunteer a participation rate
    const volunteerParticipationRates = new Map<number, number>();
    
    volunteers.forEach(volunteer => {
        // Create a distribution where:
        // ~10% volunteer for almost every event (80-100% participation)
        // ~20% are regular volunteers (40-80% participation)
        // ~40% are occasional volunteers (10-40% participation)
        // ~30% rarely or never volunteer (0-10% participation)
        const bucket = rand();
        let participationRate: number;

        if (bucket < 0.1) {
            // Super volunteers - attend almost everything
            participationRate = 0.8 + rand() * 0.2;
        } else if (bucket < 0.3) {
            // Regular volunteers
            participationRate = 0.4 + rand() * 0.4;
        } else if (bucket < 0.7) {
            // Occasional volunteers
            participationRate = 0.1 + rand() * 0.3;
        } else {
            // Rare volunteers
            participationRate = rand() * 0.1;
        }
        
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
        let commitmentCount = 0;
        
        // First, let super volunteers sign up based on their participation rate
        const shuffledVolunteers = [...volunteers].sort(() => rand() - 0.5);
        
        for(const volunteer of shuffledVolunteers) {
            const participationRate = volunteerParticipationRates.get(volunteer.volunteer_id)!;
            
            // Higher participation rate volunteers get priority
            if (rand() < participationRate) {
                rabid.event_commitment.insert({
                    event_id: event.event_id,
                    volunteer_id: volunteer.volunteer_id,
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
                commitmentCount++;
                
                // Stop if we've reached our target
                if (commitmentCount >= targetVolunteers) {
                    break;
                }
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

export function seedTimesheets(rabid: Rabid, opts: { baseSeed?: number } = {}) {
    faker.seed(((opts.baseSeed ?? 1) ^ hashSeed('timesheets')) >>> 0);
    rand = mulberry32(((opts.baseSeed ?? 1) ^ hashSeed('timesheets.rand')) >>> 0);
    const currentDate = new Date();
    const events = rabid.event.allEvents.all();
    const volunteers = rabid.volunteer.allVolunteersByName.all();
    
    // Categorize events by time
    const pastEvents = events.filter(event => {
        return event.end_time && new Date(event.end_time) < currentDate;
    });
    
    const ongoingEvents = events.filter(event => {
        return event.start_time && event.end_time && 
               new Date(event.start_time) <= currentDate && 
               new Date(event.end_time) >= currentDate;
    });
    
    const futureEvents = events.filter(event => {
        return event.start_time && new Date(event.start_time) > currentDate;
    });
    
    console.info(`Creating timesheet entries for ${pastEvents.length} past events, ${ongoingEvents.length} ongoing events, ${futureEvents.length} future events`);
    
    // Track which volunteers have already created timesheet entries for walk-ins
    const walkInVolunteers = new Set<number>();
    
    for (const event of pastEvents) {
        // Get commitments for this event
        const commitments = rabid.event_commitment.commitmentsForEvent.all({ 
            event_id: event.event_id 
        });
        
        // Convert 90% of commitments to timesheet entries
        for (const commitment of commitments) {
            if (rand() < 0.9) {
                // Parse event times
                const eventStart = new Date(event.start_time!);
                const eventEnd = new Date(event.end_time!);
                
                // Volunteer might arrive late or leave early
                const arrivalVariance = faker.helpers.rangeToNumber({ min: -15, max: 30 }); // -15 to +30 minutes
                const departureVariance = faker.helpers.rangeToNumber({ min: -60, max: 15 }); // -60 to +15 minutes
                
                const volunteerStart = new Date(eventStart.getTime() + arrivalVariance * 60000);
                const volunteerEnd = new Date(eventEnd.getTime() + departureVariance * 60000);
                
                // Format times
                const startTimeStr = volunteerStart.toISOString().replace('T', ' ').slice(0, 19);
                const endTimeStr = volunteerEnd.toISOString().replace('T', ' ').slice(0, 19);
                
                rabid.timesheet_entry.insert({
                    volunteer_id: commitment.volunteer_id,
                    event_id: event.event_id,
                    start_time: startTimeStr,
                    end_time: endTimeStr,
                    start_time_is_approximate: 0, // Exact time since volunteer showed up
                    end_time_is_approximate: 0,   // Exact time since event is over
                    end_time_is_provisional: 0,   // Not provisional since event is complete
                    notes: faker.helpers.maybe(() => 
                        faker.helpers.arrayElement([
                            'Helped with electronics repair',
                            'Greeted visitors and managed queue',
                            'Repaired bicycles',
                            'Taught sewing repairs',
                            'General repairs and assistance',
                            'Setup and breakdown',
                            'Organized tools and supplies',
                            ''
                        ]), { probability: 0.7 }) || '',
                    km_driven_for_reimbursement: commitment.will_drive_supplies ? 
                        faker.helpers.rangeToNumber({ min: 5, max: 50 }) : 0,
                    km_driven_processed: 0,       // Not yet processed
                    is_paid_time: 0,              // Assuming volunteers are unpaid
                    paid_time_processed: 0,       // Not yet processed
                    entry_creation_time: faker.date.between({ 
                        from: eventEnd, 
                        to: new Date(eventEnd.getTime() + 7 * 24 * 60 * 60 * 1000) 
                    }).toISOString().replace('T', ' ').slice(0, 19)
                });
            }
        }
        
        // Add walk-in volunteers based on event type and season
        // Weekend events get more walk-ins
        const eventDate = new Date(event.start_time!);
        const dayOfWeek = eventDate.getDay();
        const month = eventDate.getMonth();
        
        let maxWalkIns = dayOfWeek === 6 ? 3 : 1; // More walk-ins on Saturdays
        
        // Apply same seasonal variation to walk-ins
        if (month === 11 || month === 0 || month === 1) {
            // Winter - fewer walk-ins
            maxWalkIns = Math.max(0, maxWalkIns - 1);
        } else if (month >= 5 && month <= 7) {
            // Summer - more walk-ins
            maxWalkIns = maxWalkIns + 1;
        }
        
        const walkInCount = faker.helpers.rangeToNumber({ min: 0, max: maxWalkIns });
        for (let i = 0; i < walkInCount; i++) {
            // Pick a random volunteer who hasn't committed to this event
            const committedVolunteerIds = new Set(commitments.map(c => c.volunteer_id));
            const availableVolunteers = volunteers.filter(v => 
                !committedVolunteerIds.has(v.volunteer_id) && 
                !walkInVolunteers.has(v.volunteer_id)
            );
            
            if (availableVolunteers.length > 0) {
                const walkInVolunteer = faker.helpers.arrayElement(availableVolunteers);
                walkInVolunteers.add(walkInVolunteer.volunteer_id);
                
                // Walk-ins typically arrive later and might leave earlier
                const eventStart = new Date(event.start_time!);
                const eventEnd = new Date(event.end_time!);
                
                const arrivalVariance = faker.helpers.rangeToNumber({ min: 30, max: 120 }); // 30-120 minutes late
                const departureVariance = faker.helpers.rangeToNumber({ min: -120, max: 0 }); // up to 2 hours early
                
                const volunteerStart = new Date(eventStart.getTime() + arrivalVariance * 60000);
                const volunteerEnd = new Date(eventEnd.getTime() + departureVariance * 60000);
                
                // Make sure they actually attended for some time
                if (volunteerEnd > volunteerStart) {
                    const startTimeStr = volunteerStart.toISOString().replace('T', ' ').slice(0, 19);
                    const endTimeStr = volunteerEnd.toISOString().replace('T', ' ').slice(0, 19);
                    
                    rabid.timesheet_entry.insert({
                        volunteer_id: walkInVolunteer.volunteer_id,
                        event_id: event.event_id,
                        start_time: startTimeStr,
                        end_time: endTimeStr,
                        start_time_is_approximate: 1, // Approximate since walk-in
                        end_time_is_approximate: 1,   // Approximate since walk-in
                        end_time_is_provisional: 0,   // Not provisional since event is complete
                        notes: 'Walk-in volunteer - ' + faker.helpers.arrayElement([
                            'Helped where needed',
                            'Assisted with repairs',
                            'Helped with cleanup',
                            'General assistance'
                        ]),
                        km_driven_for_reimbursement: 0,
                        km_driven_processed: 0,
                        is_paid_time: 0,
                        paid_time_processed: 0,
                        entry_creation_time: faker.date.between({ 
                            from: volunteerEnd, 
                            to: new Date(volunteerEnd.getTime() + 7 * 24 * 60 * 60 * 1000) 
                        }).toISOString().replace('T', ' ').slice(0, 19)
                    });
                }
            }
        }
    }
    
    // Process ongoing events - volunteers are checking in during the event
    for (const event of ongoingEvents) {
        const commitments = rabid.event_commitment.commitmentsForEvent.all({ 
            event_id: event.event_id 
        });
        
        // For ongoing events, about 60-80% of committed volunteers have checked in
        for (const commitment of commitments) {
            if (rand() < 0.7) {
                const eventStart = new Date(event.start_time!);
                const eventEnd = new Date(event.end_time!);
                const now = currentDate;
                
                // Volunteer checked in sometime between event start and now
                const checkInTime = faker.date.between({ from: eventStart, to: now });
                
                // Format times
                const startTimeStr = checkInTime.toISOString().replace('T', ' ').slice(0, 19);
                const endTimeStr = eventEnd.toISOString().replace('T', ' ').slice(0, 19);
                
                rabid.timesheet_entry.insert({
                    volunteer_id: commitment.volunteer_id,
                    event_id: event.event_id,
                    start_time: startTimeStr,
                    end_time: endTimeStr,
                    start_time_is_approximate: 0, // Exact check-in time
                    end_time_is_approximate: 0,   // Using event end time
                    end_time_is_provisional: 1,   // Still provisional - volunteer can check out
                    notes: faker.helpers.arrayElement([
                        'Currently helping with repairs',
                        'Working at greeting table',
                        'Assisting with bike repairs',
                        ''
                    ]),
                    km_driven_for_reimbursement: commitment.will_drive_supplies ? 
                        faker.helpers.rangeToNumber({ min: 5, max: 50 }) : 0,
                    km_driven_processed: 0,
                    is_paid_time: 0,
                    paid_time_processed: 0,
                    entry_creation_time: checkInTime.toISOString().replace('T', ' ').slice(0, 19)
                });
            }
        }
    }
    
    // Process future events - some volunteers might be checked in early (for setup)
    for (const event of futureEvents) {
        const eventStart = new Date(event.start_time!);
        const setupTime = event.setup_time ? new Date(event.setup_time) : new Date(eventStart.getTime() - 60 * 60000); // 1 hour before
        
        // Only process near-future events (within 2 hours)
        if (eventStart.getTime() - currentDate.getTime() < 2 * 60 * 60 * 1000) {
            const commitments = rabid.event_commitment.commitmentsForEvent.all({ 
                event_id: event.event_id 
            });
            
            // About 10-20% of volunteers check in early for setup
            for (const commitment of commitments) {
                if (rand() < 0.15) {
                    const eventEnd = new Date(event.end_time!);
                    
                    // Use setup time or event start time
                    const startTimeStr = (event.setup_time || event.start_time)!;
                    const endTimeStr = event.end_time!;
                    
                    rabid.timesheet_entry.insert({
                        volunteer_id: commitment.volunteer_id,
                        event_id: event.event_id,
                        start_time: startTimeStr,
                        end_time: endTimeStr,
                        start_time_is_approximate: 1, // Using event times, not actual check-in
                        end_time_is_approximate: 1,   // Booked for whole event
                        end_time_is_provisional: 0,   // Not provisional since event hasn't started
                        notes: 'Early check-in for setup',
                        km_driven_for_reimbursement: commitment.will_drive_supplies ? 
                            faker.helpers.rangeToNumber({ min: 5, max: 50 }) : 0,
                        km_driven_processed: 0,
                        is_paid_time: 0,
                        paid_time_processed: 0,
                        entry_creation_time: currentDate.toISOString().replace('T', ' ').slice(0, 19)
                    });
                }
            }
        }
    }
    
    // Add some non-event timesheet entries (volunteers doing work outside of events)
    const activeVolunteers = volunteers.filter(v => !v.inactive && !v.deleted);
    const numNonEventEntries = Math.floor(activeVolunteers.length * 0.05); // 5% of active volunteers
    
    for (let i = 0; i < numNonEventEntries; i++) {
        const volunteer = faker.helpers.arrayElement(activeVolunteers);
        const daysAgo = faker.helpers.rangeToNumber({ min: 1, max: 30 });
        const workDate = new Date(currentDate.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        
        // Random work duration between 1-4 hours
        const duration = faker.helpers.rangeToNumber({ min: 1, max: 4 }) * 60 * 60 * 1000;
        const startTime = new Date(workDate.setHours(faker.helpers.rangeToNumber({ min: 9, max: 18 }), 0, 0, 0));
        const endTime = new Date(startTime.getTime() + duration);
        
        rabid.timesheet_entry.insert({
            volunteer_id: volunteer.volunteer_id,
            event_id: undefined, // No event associated
            start_time: startTime.toISOString().replace('T', ' ').slice(0, 19),
            end_time: endTime.toISOString().replace('T', ' ').slice(0, 19),
            start_time_is_approximate: 0,
            end_time_is_approximate: 0,
            end_time_is_provisional: 0,
            notes: faker.helpers.arrayElement([
                'Shop maintenance and organization',
                'Tool inventory and sorting',
                'Preparing materials for next event',
                'Admin work - updating volunteer database',
                'Picking up donated supplies',
                'Meeting with community partners'
            ]),
            km_driven_for_reimbursement: faker.datatype.boolean({ probability: 0.3 }) ? 
                faker.helpers.rangeToNumber({ min: 10, max: 100 }) : 0,
            km_driven_processed: 0,
            is_paid_time: faker.datatype.boolean({ probability: 0.1 }) ? 1 : 0, // 10% might be paid
            paid_time_processed: 0,
            entry_creation_time: faker.date.between({ 
                from: endTime, 
                to: new Date(endTime.getTime() + 2 * 24 * 60 * 60 * 1000) // Within 2 days
            }).toISOString().replace('T', ' ').slice(0, 19)
        });
    }
    
    // Get summary statistics
    const allTimesheetEntries = rabid.timesheet_entry.all();
    const provisionalEntries = allTimesheetEntries.filter(e => e.end_time_is_provisional);
    const approximateEntries = allTimesheetEntries.filter(e => e.start_time_is_approximate || e.end_time_is_approximate);
    const nonEventEntries = allTimesheetEntries.filter(e => !e.event_id);
    
    console.info(`Total timesheet entries created: ${allTimesheetEntries.length}`);
    console.info(`  - Provisional (ongoing): ${provisionalEntries.length}`);
    console.info(`  - Approximate times: ${approximateEntries.length}`);
    console.info(`  - Non-event entries: ${nonEventEntries.length}`);
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
        .filter(v => !v.inactive && !v.deleted);
    const byEmail = (email: string) => volunteers.find(v => v.email === email);

    const committees: Array<{name: string, description: string, members: number[]}> = [
        {name: 'Logistics Committee',
         description: 'Event logistics: supplies, transport, setup crews.',
         members: [byEmail('hazel@redraccoon.org')?.volunteer_id,
                   ...volunteers.filter((_, i) => i % 11 === 3).slice(0, 4).map(v => v.volunteer_id)]
             .filter((id): id is number => id !== undefined)},
        {name: 'Outreach Committee',
         description: 'Community partnerships, social media, and event promotion.',
         members: volunteers.filter((_, i) => i % 13 === 5).slice(0, 3).map(v => v.volunteer_id)},
    ];

    for(const c of committees) {
        const committee_id = rabid.committee.insert({
            name: c.name, description: c.description, notes: '', deleted: 0});
        const {group_id} = rabid.committee.getById(committee_id);
        for(const volunteer_id of new Set(c.members))
            rabid.group_member.insert({group_id, volunteer_id});
    }
    console.info(`${committees.length} committees created`);
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
    timesheets: boolean;
    baseSeed: number;
}

export type ScenarioName = 'minimal' | 'dev' | 'full' | 'activityReport';

export const SCENARIOS: Record<ScenarioName, Scenario> = {
    // tiny + fast, for a quick poke
    minimal:        { volunteers: 8,  events: true, commitments: true, timesheets: false, baseSeed: 1 },
    // the everyday dataset: people, events, who's coming - but NOT the bulk timesheets
    dev:            { volunteers: 99, events: true, commitments: true, timesheets: false, baseSeed: 1 },
    // everything, incl. the bulk timesheet entries the activity report needs
    full:           { volunteers: 99, events: true, commitments: true, timesheets: true,  baseSeed: 1 },
    activityReport: { volunteers: 99, events: true, commitments: true, timesheets: true,  baseSeed: 1 },
};

// Run the builders for a scenario (order matters: later builders read earlier data).
export function seedScenario(rabid: Rabid, scenario: Scenario): void {
    seedVolunteers(rabid, { count: scenario.volunteers, baseSeed: scenario.baseSeed });
    seedCommittees(rabid);
    if(scenario.events)      seedEvents(rabid, { baseSeed: scenario.baseSeed });
    if(scenario.commitments) seedEventCommitments(rabid, { baseSeed: scenario.baseSeed });
    if(scenario.timesheets)  seedTimesheets(rabid, { baseSeed: scenario.baseSeed });
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
            const scenario = SCENARIOS[name];
            if(!scenario) {
                console.info(`unknown scenario '${name}'; known: ${Object.keys(SCENARIOS).join(', ')}`);
                break;
            }
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
