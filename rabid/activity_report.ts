import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableRenderer, TableView, reloadableItemProps, editButtonProps, PublicViewable } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';
import {
    sqliteDateToTemporal,
    dateTimeToString,
    temporalToSqliteDate,
    extractDateFromDateTime,
    dateToString,
    orgToday,
    type PlainDate,
    type PlainDateTime,
    type SQLiteDateString
} from '../liminal/date.ts'

import { Volunteer } from "./volunteer.ts";
import { Temporal } from 'temporal-polyfill';
import { h } from "../liminal/markup.ts";


/**
 * Track which volunteers are "active" on each day within a date range, where a volunteer 
 * is considered "active" if they have volunteered within the last 31 days.
 *
 * Algorithm:
 * 1. Prepare the scan range: Start scanning 31 days before the requested startDate 
 *    (to properly identify volunteers who were active on startDate based on earlier activity).
 * 
 * 2. Load all reference data into in-memory maps to avoid repeated queries:
 *    - All volunteers → Map<volunteer_id, Volunteer>
 *    - All events between scanStartDate and endDate → Map<event_id, Event>
 *    - All timesheet entries with activity in the scan range → Map<SQLiteDateString, Array<TimesheetEntry>>
 *      (includes entries with start_time in range OR entries linked to events in range)
 * 
 * 3. Day-by-day scan from scanStartDate to endDate:
 *    - For each day, update lastActiveDateByVolunteerId with any volunteers who had timesheet entries
 *    - Calculate which volunteers are "active" on this day (those whose last activity was within 31 days)
 *    - Only record results for days >= startDate (the pre-scan period is just for context)
 * 
 * 4. Return a map of date → active volunteers for each day in the requested range
 * 
 * By maintaining a running record of each volunteer's last activity date, 
 * we can efficiently determine on any given day which volunteers have been active within 
 * the 31-day window without repeatedly querying the database.
 *
 * Note that this corresponds reasonably with RRBR's definition of an 'member' as someone
 * who as volunteered at least 40 hours in the past 12 months.  12 months * 3 hours (average
 * volunteer duration) = 36 hours.  (of course bunching will mean that you will end up
 * having to volunteer more than 12 times to be considered active every day of the year).
 */
export type ActiveVolunteersByDay = Map<SQLiteDateString, Array<Volunteer>>;
export function activeVolunteersByDay(startDate: PlainDate, endDate: PlainDate): ActiveVolunteersByDay {

    const scanStartDate: PlainDate = startDate.subtract({ days: 31 });
    
    // --- Load all volunteer records into a Map<volunteer_id, Volunteer>.
    const volunteers = db().prepare<Volunteer, {}>(block`
        SELECT * FROM volunteer`).all({});
    const volunteerMap = new Map(
        volunteers.map(volunteer => [volunteer.volunteer_id, volunteer])
    );
    
    const scanStartDateStr = temporalToSqliteDate(scanStartDate);
    const endDateStr = temporalToSqliteDate(endDate);

    // --- Volunteer activity comes from two sources, unioned:
    //   1. explicit timesheet entries (always have a real start_time), and
    //   2. event check-ins (dated by the check-in's own start_time, falling back
    //      to the event's start_time - the common case where the check-in just
    //      inherits the event's time).
    // We only need (volunteer_id, date) pairs from each.
    type Activity = {volunteer_id: number, activity_date: SQLiteDateString};
    const timesheetActivity = db().prepare<Activity, {start_date: string, end_date: string}>(block`
        SELECT volunteer_id, DATE(start_time) AS activity_date
        FROM timesheet_entry
        WHERE start_time >= :start_date
          AND start_time <= :end_date || ' 23:59:59'`).all({
            start_date: scanStartDateStr, end_date: endDateStr});

    const checkinActivity = db().prepare<Activity, {start_date: string, end_date: string}>(block`
        SELECT c.volunteer_id, DATE(COALESCE(c.start_time, e.start_time)) AS activity_date
        FROM event_checkin c JOIN event e USING (event_id)
        WHERE COALESCE(c.start_time, e.start_time) >= :start_date
          AND COALESCE(c.start_time, e.start_time) <= :end_date || ' 23:59:59'`).all({
            start_date: scanStartDateStr, end_date: endDateStr});

    // Group volunteer ids by activity date.
    const volunteerIdsByDate = new Map<SQLiteDateString, number[]>();
    for (const {volunteer_id, activity_date} of [...timesheetActivity, ...checkinActivity]) {
        if (!activity_date) continue;
        let ids = volunteerIdsByDate.get(activity_date);
        if (!ids) { ids = []; volunteerIdsByDate.set(activity_date, ids); }
        ids.push(volunteer_id);
    }
    
    // --- Walk forward day by day from scanStartDate to endDate
    const lastActiveDateByVolunteerId = new Map<number, PlainDate>();
    const activeVolunteersByDay = new Map<SQLiteDateString, Array<Volunteer>>();
    
    let currentDate = scanStartDate;
    while (Temporal.PlainDate.compare(currentDate, endDate) <= 0) {
        const currentDateStr = temporalToSqliteDate(currentDate);
        
        // Update last active date for volunteers with activity on this day
        const todaysIds = volunteerIdsByDate.get(currentDateStr) || [];
        for (const volunteer_id of todaysIds) {
            lastActiveDateByVolunteerId.set(volunteer_id, currentDate);
        }
        
        // Calculate active volunteers (those with activity within 31 days)
        const activeVolunteers: Array<Volunteer> = [];
        const cutoffDate = currentDate.subtract({ days: 30 });
        
        for (const [volunteerId, lastActiveDate] of lastActiveDateByVolunteerId) {
            if (Temporal.PlainDate.compare(lastActiveDate, cutoffDate) >= 0) {
                const volunteer = volunteerMap.get(volunteerId);
                if (volunteer && !volunteer.inactive) {
                    activeVolunteers.push(volunteer);
                }
            }
        }
        
        // Only record results for days >= startDate
        if (Temporal.PlainDate.compare(currentDate, startDate) >= 0) {
            activeVolunteersByDay.set(currentDateStr, activeVolunteers);
        }
        
        // Move to next day
        currentDate = currentDate.add({ days: 1 });
    }
    
    return activeVolunteersByDay;
}

/**
 * We define the number of active volunteers per month as the average of the
 * number active volunteers per day for each day of the month.
 *
 * The much simpler definition would be just the number of volunteers who
 * volunteered during that particular month, but we want to use a consistent
 * definition and the simpler 'volunteers that volunteered during that month'
 * definition has some problematic artifacts for occasional volunteers.
 *
 * Rather than passing in the date range, we extract it from the
 * activeVolunteersByDay.  Note that the activeVolunteersByDay is in order
 * by date (and Map in JS is order preserving).
 */
export function activeVolunteersByMonth(activeVolunteersByDay: ActiveVolunteersByDay): Map<SQLiteDateString, number> {
    // Group daily counts by month
    const monthlyData = new Map<string, { dailyCounts: number[], dates: Set<string> }>();
    
    for (const [dateStr, volunteers] of activeVolunteersByDay) {
        // Extract year-month from date (e.g., "2025-07-23" → "2025-07")
        const yearMonth = dateStr.substring(0, 7);
        
        if (!monthlyData.has(yearMonth)) {
            monthlyData.set(yearMonth, { dailyCounts: [], dates: new Set() });
        }
        
        const monthData = monthlyData.get(yearMonth)!;
        monthData.dailyCounts.push(volunteers.length);
        monthData.dates.add(dateStr);
    }
    
    // Calculate averages for each month
    const monthlyAverages = new Map<SQLiteDateString, number>();
    
    for (const [yearMonth, data] of monthlyData) {
        const sum = data.dailyCounts.reduce((a, b) => a + b, 0);
        const average = sum / data.dailyCounts.length;
        monthlyAverages.set(yearMonth as SQLiteDateString, average);
    }
    
    return monthlyAverages;
}


export function activeVolunteersByMonthReport(startDate: PlainDate, endDate: PlainDate): Markup {
    // By month show average number of active volunteers + all volunteers active at some point in that month (with number of days/hours active per volunteer).
    // TODO: Implement report generation
    return ['div', {}, 'Report not yet implemented'];
}

export function dailyActivityReport(startDate: PlainDate, endDate: PlainDate): Markup {
    const activeByDay = activeVolunteersByDay(startDate, endDate);
    
    // Build table rows for each day
    const tableRows: Markup[] = [];
    
    // Header row
    tableRows.push(
        [h.tr, {},
            [h.th, {}, 'Date'],
            [h.th, {}, 'Day'],
            [h.th, {}, 'Active Volunteers']
        ]
    );
    
    // Process each day
    let currentDate = startDate;
    while (Temporal.PlainDate.compare(currentDate, endDate) <= 0) {
        const dateStr = temporalToSqliteDate(currentDate);
        const volunteers = activeByDay.get(dateStr) || [];
        
        // Calculate days since last volunteered for each volunteer
        const volunteerDetails: { volunteer: Volunteer, daysSince: number }[] = [];
        
        // Get all timesheet entries for these volunteers to find their last activity
        for (const volunteer of volunteers) {
            // Find the volunteer's most recent activity up to currentDate, across
            // both timesheet entries and event check-ins.
            const recentActivity = db().prepare<{max_date: string | null}, {volunteer_id: number, current_date: string}>(block`
                SELECT MAX(d) AS max_date FROM (
                    SELECT DATE(start_time) AS d
                        FROM timesheet_entry
                        WHERE volunteer_id = :volunteer_id
                          AND DATE(start_time) <= :current_date
                    UNION ALL
                    SELECT DATE(COALESCE(c.start_time, e.start_time)) AS d
                        FROM event_checkin c JOIN event e USING (event_id)
                        WHERE c.volunteer_id = :volunteer_id
                          AND DATE(COALESCE(c.start_time, e.start_time)) <= :current_date
                )`).first({
                    volunteer_id: volunteer.volunteer_id,
                    current_date: dateStr
                });
            
            if (recentActivity?.max_date) {
                const lastActiveDate = sqliteDateToTemporal(recentActivity.max_date);
                const daysSince = currentDate.since(lastActiveDate).days;
                volunteerDetails.push({ volunteer, daysSince });
            } else {
                volunteerDetails.push({ volunteer, daysSince: 999 }); // No activity found
            }
        }
        
        // Sort by days since (most recent first), then by name
        volunteerDetails.sort((a, b) => {
            if (a.daysSince !== b.daysSince) {
                return a.daysSince - b.daysSince;
            }
            return a.volunteer.name.localeCompare(b.volunteer.name);
        });
        
        // Create hover content
        const hoverContent = volunteerDetails.length > 0 
            ? volunteerDetails.map(({ volunteer, daysSince }) => 
                `${volunteer.name} (${daysSince === 0 ? 'today' : daysSince === 999 ? 'no recent activity' : daysSince + ' days ago'})`
              ).join('<br>')
            : 'No active volunteers';
        
        // Format date for display
        const dayOfWeek = currentDate.toLocaleString('en-US', { weekday: 'short' });
        const dateDisplay = currentDate.toLocaleString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
        });
        
        // Create table row
        tableRows.push(
            [h.tr, {},
                [h.td, {}, dateDisplay],
                [h.td, {}, dayOfWeek],
                [h.td, {},
                    [h.span, {
                        'data-bs-toggle': 'popover',
                        'data-bs-trigger': 'hover',
                        'data-bs-content': hoverContent,
                        'data-bs-html': 'true',
                        'data-bs-placement': 'left',
                        style: 'cursor: pointer; text-decoration: underline;'
                    }, volunteers.length.toString()]
                ]
            ]
        );
        
        currentDate = currentDate.add({ days: 1 });
    }
    
    return [h.div, {class: 'daily-activity-report'},
        [h.h2, {}, 'Daily Active Volunteers Report'],
        [h.p, {}, `From ${dateToString(startDate)} to ${dateToString(endDate)}`],
        [h.table, {class: 'table table-striped table-hover'},
            [h.thead, {}, ...tableRows.slice(0, 1)],
            [h.tbody, {}, ...tableRows.slice(1)]
        ],
        [h.script, {}, `
            // Initialize Bootstrap popovers after page loads
            document.addEventListener('DOMContentLoaded', function() {
                if (typeof bootstrap !== 'undefined') {
                    var popoverTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="popover"]'))
                    var popoverList = popoverTriggerList.map(function (popoverTriggerEl) {
                        return new bootstrap.Popover(popoverTriggerEl)
                    })
                }
            });
        `]
    ];
}

export function activityReport(): Markup {
    // Get today's date and calculate 2 years back, snapped to month beginning
    const endDate = orgToday();
    const twoYearsAgo = endDate.subtract({ years: 2 });
    const startDate = twoYearsAgo.with({ day: 1 }); // Snap to beginning of month

    const activeVolunteersByDayMap = activeVolunteersByDay(startDate, endDate);
    const activeVolunteersByMonthMap = activeVolunteersByMonth(activeVolunteersByDayMap);

    // Build table rows for each month
    const tableRows: Markup[] = [];
    
    // Header row
    tableRows.push(
        [h.tr, {},
            [h.th, {}, 'Month'],
            [h.th, {}, 'Average Active Volunteers'],
            [h.th, {}, 'All Active Volunteers']
        ]
    );
    
    // Process each month
    for (const [monthStr, avgCount] of activeVolunteersByMonthMap) {
        // Get all unique volunteers who were active during this month
        const volunteersThisMonth = new Set<Volunteer>();
        for (const [dateStr, volunteers] of activeVolunteersByDayMap) {
            if (dateStr.startsWith(monthStr)) {
                volunteers.forEach(v => volunteersThisMonth.add(v));
            }
        }
        
        // Create volunteer list for popover
        const volunteerNames = Array.from(volunteersThisMonth)
            .map(v => v.name)
            .sort()
            .join(', ');
        
        // Format month for display (e.g., "2025-07" → "July 2025")
        const [yearStr, monthNumStr] = monthStr.split('-');
        const monthDate = Temporal.PlainDate.from({
            year: parseInt(yearStr),
            month: parseInt(monthNumStr),
            day: 1
        });
        const monthDisplay = monthDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        
        // Create table row
        tableRows.push(
            [h.tr, {},
                [h.td, {}, monthDisplay],
                [h.td, {}, avgCount.toFixed(1)],
                [h.td, {},
                    [h.span, {
                        'data-bs-toggle': 'popover',
                        'data-bs-trigger': 'hover',
                        'data-bs-content': volunteerNames || 'No active volunteers',
                        'data-bs-html': 'true',
                        style: 'cursor: pointer; text-decoration: underline;'
                    }, volunteersThisMonth.size.toString()]
                ]
            ]
        );
    }
    
    return [h.div, {class: 'activity-report'},
        [h.h2, {}, 'Volunteer Activity Report'],
        [h.p, {}, `From ${dateToString(startDate)} to ${dateToString(endDate)}`],
        [h.table, {class: 'table table-striped'},
            [h.thead, {}, ...tableRows.slice(0, 1)],
            [h.tbody, {}, ...tableRows.slice(1)]
        ],
        [h.script, {}, `
            // Initialize Bootstrap popovers after page loads
            document.addEventListener('DOMContentLoaded', function() {
                if (typeof bootstrap !== 'undefined') {
                    var popoverTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="popover"]'))
                    var popoverList = popoverTriggerList.map(function (popoverTriggerEl) {
                        return new bootstrap.Popover(popoverTriggerEl)
                    })
                }
            });
        `]
    ];
}


// Debug function to analyze volunteer activity patterns
export function debugAnalyzeVolunteerActivity(monthStr: string): void {
    console.log(`\n=== Debug Analysis for ${monthStr} ===\n`);
    
    // Parse month to get date range
    const [yearStr, monthNumStr] = monthStr.split('-');
    const year = parseInt(yearStr);
    const month = parseInt(monthNumStr);
    const monthStart = Temporal.PlainDate.from({ year, month, day: 1 });
    const monthEnd = monthStart.add({ months: 1 }).subtract({ days: 1 });
    
    // Get active volunteers by day for a wider range (to ensure we capture the 31-day window)
    const scanStart = monthStart.subtract({ days: 31 });
    const scanEnd = monthEnd.add({ days: 31 });
    
    console.log(`Month range: ${temporalToSqliteDate(monthStart)} to ${temporalToSqliteDate(monthEnd)}`);
    console.log(`Scan range: ${temporalToSqliteDate(scanStart)} to ${temporalToSqliteDate(scanEnd)}\n`);
    
    const activeByDay = activeVolunteersByDay(scanStart, scanEnd);
    
    // Analyze just this month
    const monthData = {
        dailyCounts: [] as number[],
        uniqueVolunteers: new Set<number>(),
        volunteerActivityMap: new Map<number, { name: string, activeDays: string[] }>()
    };
    
    console.log("Day-by-day active volunteer counts:");
    console.log("Date\t\tCount\tVolunteer IDs");
    console.log("-".repeat(60));
    
    let currentDate = monthStart;
    while (Temporal.PlainDate.compare(currentDate, monthEnd) <= 0) {
        const dateStr = temporalToSqliteDate(currentDate);
        const volunteers = activeByDay.get(dateStr) || [];
        
        monthData.dailyCounts.push(volunteers.length);
        
        // Track unique volunteers and their active days
        for (const volunteer of volunteers) {
            monthData.uniqueVolunteers.add(volunteer.volunteer_id);
            
            if (!monthData.volunteerActivityMap.has(volunteer.volunteer_id)) {
                monthData.volunteerActivityMap.set(volunteer.volunteer_id, {
                    name: volunteer.name,
                    activeDays: []
                });
            }
            monthData.volunteerActivityMap.get(volunteer.volunteer_id)!.activeDays.push(dateStr);
        }
        
        // Print daily summary
        const volunteerIds = volunteers.map(v => v.volunteer_id).sort((a, b) => a - b).join(', ');
        console.log(`${dateStr}\t${volunteers.length}\t${volunteerIds.substring(0, 50)}${volunteerIds.length > 50 ? '...' : ''}`);
        
        currentDate = currentDate.add({ days: 1 });
    }
    
    // Calculate statistics
    const avgDaily = monthData.dailyCounts.reduce((a, b) => a + b, 0) / monthData.dailyCounts.length;
    const totalUnique = monthData.uniqueVolunteers.size;
    
    console.log("\n=== Summary Statistics ===");
    console.log(`Average active volunteers per day: ${avgDaily.toFixed(1)}`);
    console.log(`Total unique active volunteers: ${totalUnique}`);
    console.log(`Ratio (avg/total): ${(avgDaily / totalUnique).toFixed(2)}`);
    
    // Analyze volunteer patterns
    console.log("\n=== Volunteer Activity Patterns ===");
    console.log("(Showing volunteers and how many days they were active)");
    
    const activityFrequencies = new Map<number, number>();
    for (const [volunteerId, data] of monthData.volunteerActivityMap) {
        const daysActive = data.activeDays.length;
        activityFrequencies.set(daysActive, (activityFrequencies.get(daysActive) || 0) + 1);
    }
    
    const sortedFrequencies = Array.from(activityFrequencies.entries()).sort((a, b) => b[0] - a[0]);
    console.log("\nDays Active\tNumber of Volunteers");
    console.log("-".repeat(35));
    for (const [days, count] of sortedFrequencies) {
        console.log(`${days}\t\t${count}`);
    }
    
    // Sample a few volunteers to show their pattern
    console.log("\n=== Sample Volunteer Activity ===");
    console.log("(Showing first 5 volunteers and their active days)");
    
    const volunteerEntries = Array.from(monthData.volunteerActivityMap.entries()).slice(0, 5);
    for (const [volunteerId, data] of volunteerEntries) {
        console.log(`\nVolunteer ${volunteerId} (${data.name}):`);
        console.log(`Active on ${data.activeDays.length} days: ${data.activeDays.join(', ')}`);
    }
    
    // Verify our calculation matches
    const byMonth = activeVolunteersByMonth(activeByDay);
    const reportedAvg = byMonth.get(monthStr);
    console.log(`\n=== Verification ===`);
    console.log(`Our calculated average: ${avgDaily.toFixed(1)}`);
    console.log(`activeVolunteersByMonth result: ${reportedAvg?.toFixed(1)}`);
    console.log(`Match: ${Math.abs(avgDaily - (reportedAvg || 0)) < 0.01 ? 'YES' : 'NO'}`);
}

// Add reports for service and sales of various kinds (including free-kids-bikes, adult-learn-to-ride etc)
