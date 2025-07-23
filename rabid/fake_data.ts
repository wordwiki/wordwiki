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
import * as event from './event.ts';
import * as service from './service.ts';
import * as sale from './sale.ts';
import {Rabid} from './rabid.ts';
import { faker } from "@faker-js/faker";

// --------------------------------------------------------------------------------
// --- Volunteer -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

function createFakeVolunteerData(rabid: Rabid) {
    // Generate 100 fake volunteers
    for (let i = 0; i < 100; i++) {
        const firstName = faker.person.firstName();
        const lastName = faker.person.lastName();
        const fullName = `${firstName} ${lastName}`;
        
        // Random join date within past 3 years
        const joinDate = faker.date.past({ years: 3 });
        const isInactive = faker.datatype.boolean({ probability: 0.15 });
        const hasExitFeedback = isInactive && faker.datatype.boolean({ probability: 0.4 });
        
        rabid.volunteer.insert({
            join_date: faker.helpers.maybe(() => 
                joinDate.toISOString().replace('T', ' ').slice(0, 19), 
                { probability: 0.9 }), // 10% have unknown join date
            name: fullName,
            email: faker.internet.email({ firstName, lastName }).toLowerCase(),
            phone: faker.phone.number({ style: 'national' }),
            skills: faker.helpers.arrayElement([
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
            emergency_contact_name: faker.helpers.maybe(() => {
                return `${faker.person.firstName()} ${faker.person.lastName()}`;
            }, { probability: 0.7 }) || '',
            emergency_contact_phone: faker.helpers.maybe(() => {
                return faker.phone.number({ style: 'national' });
            }, { probability: 0.7 }) || '',
            permissions: faker.helpers.arrayElement(['', 'basic', 'admin', 'coordinator']),
            inactive: isInactive ? 1 : 0,
            marked_inactive_date: isInactive ? 
                faker.date.between({ from: joinDate, to: new Date() }).toISOString().replace('T', ' ').slice(0, 19) : 
                undefined,
            exit_feedback_requested: hasExitFeedback ? 1 : 0,
            exit_reason: hasExitFeedback ? 
                faker.helpers.arrayElement(['moved', 'no-time', 'other']) : 
                undefined,
            exit_feedback: hasExitFeedback ? 
                faker.helpers.arrayElement([
                    'Moving to another city',
                    'Work schedule changed',
                    'Family commitments increased',
                    'Health issues',
                    'Found volunteering elsewhere',
                    'No longer interested',
                    ''
                ]) : 
                undefined,
            deleted: faker.datatype.boolean({ probability: 0.05 }) ? 1 : 0,
        });
    }
}

// --------------------------------------------------------------------------------
// --- Event ----------------------------------------------------------------------
// --------------------------------------------------------------------------------

function createFakeEventData(rabid: Rabid) {
    {
        // Generate events for every Saturday from May 1st to mid-October 2025
        const startDate = new Date('2025-05-01');
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
                total_cash_collected: 0,
                notes: ''
            });

            // Advance to next Saturday
            currentDate.setDate(currentDate.getDate() + 7);
        }

        {
            // Generate events for every Wednesday from May 1st to mid-October 2025
            const startDate = new Date('2025-05-07');
            const endDate = new Date('2025-10-15');

            // Find the first Wednesday on or after May 1st
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
                    total_cash_collected: faker.helpers.rangeToNumber({ min: 0, max: 500 }),
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


function createFakeEventCommitments(rabid: Rabid) {
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
        const rand = Math.random();
        let participationRate: number;
        
        if (rand < 0.1) {
            // Super volunteers - attend almost everything
            participationRate = 0.8 + Math.random() * 0.2;
        } else if (rand < 0.3) {
            // Regular volunteers
            participationRate = 0.4 + Math.random() * 0.4;
        } else if (rand < 0.7) {
            // Occasional volunteers
            participationRate = 0.1 + Math.random() * 0.3;
        } else {
            // Rare volunteers
            participationRate = Math.random() * 0.1;
        }
        
        volunteerParticipationRates.set(volunteer.volunteer_id, participationRate);
    });
    
    // For each event, create commitments based on volunteer participation rates
    // Target average of 6 volunteers per event with variation
    for(const event of events) {
        // Vary the number of volunteers per event (3-10, centered around 6)
        const targetVolunteers = Math.round(faker.helpers.rangeToNumber({ min: 3, max: 10 }));
        let commitmentCount = 0;
        
        // First, let super volunteers sign up based on their participation rate
        const shuffledVolunteers = [...volunteers].sort(() => Math.random() - 0.5);
        
        for(const volunteer of shuffledVolunteers) {
            const participationRate = volunteerParticipationRates.get(volunteer.volunteer_id)!;
            
            // Higher participation rate volunteers get priority
            if (Math.random() < participationRate) {
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

function createFakeTimesheetEntries(rabid: Rabid) {
    const currentDate = new Date();
    const events = rabid.event.allEvents.all();
    const volunteers = rabid.volunteer.allVolunteersByName.all();
    
    // Get past events
    const pastEvents = events.filter(event => {
        return event.start_time && new Date(event.start_time) < currentDate;
    });
    
    console.info(`Creating timesheet entries for ${pastEvents.length} past events`);
    
    // Track which volunteers have already created timesheet entries for walk-ins
    const walkInVolunteers = new Set<number>();
    
    for (const event of pastEvents) {
        // Get commitments for this event
        const commitments = rabid.event_commitment.commitmentsForEvent.all({ 
            event_id: event.event_id 
        });
        
        // Convert 90% of commitments to timesheet entries
        for (const commitment of commitments) {
            if (Math.random() < 0.9) {
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
                    start_time: startTimeStr,
                    end_time: endTimeStr,
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
                    is_paid_time: 0  // Assuming volunteers are unpaid
                });
            }
        }
        
        // Add a few walk-in volunteers (not committed but showed up)
        const walkInCount = faker.helpers.rangeToNumber({ min: 0, max: 3 });
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
                        start_time: startTimeStr,
                        end_time: endTimeStr,
                        notes: 'Walk-in volunteer - ' + faker.helpers.arrayElement([
                            'Helped where needed',
                            'Assisted with repairs',
                            'Helped with cleanup',
                            'General assistance'
                        ]),
                        km_driven_for_reimbursement: 0,
                        is_paid_time: 0
                    });
                }
            }
        }
    }
    
    // Get summary statistics
    const allTimesheetEntries = rabid.timesheet_entry.all();
    console.info(`Total timesheet entries created: ${allTimesheetEntries.length}`);
}

// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------
// --------------------------------------------------------------------------------

function createAllTables() {
}

function createFakeData(rabid: Rabid) {
    createFakeVolunteerData(rabid);
    createFakeEventData(rabid);
    createFakeEventCommitments(rabid);
    createFakeTimesheetEntries(rabid);
}

function destroyAllAndFillWithFakeData(rabid: Rabid) {
    console.info("*** DESTROYING ALL AND FILLING WITH FAKE DATA ***");
    Db.deleteDb(defaultDbPath);
    //schema.createAllTables();

    rabid.tables.forEach(table=>{
        console.info(`--- creating ${table.name}`);
        db().executeStatements(table.createDMLString());
    });

    createFakeData(rabid);

    console.info(rabid.volunteer.allVolunteersByName.all());
}

function main(args: string[]) {
    const cmd = args[0];
    switch(cmd) {
        case 'destroy_all_and_fill_with_fake_data':
            destroyAllAndFillWithFakeData(new Rabid());
            break;
        default:
            console.info('BAD COMMAND!');
            break;
    }
}

if (import.meta.main)
    main(Deno.args);
