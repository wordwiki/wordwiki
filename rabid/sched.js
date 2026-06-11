/**
 * CLI program for computing staff RRBR staff schedule.
 *
 * Entirely vibe coded with claude code.
 */

const ani = 'Ani';
const gabe = 'Gaberiel';
const nick = 'Nicholas';
const csj2 = 'Csj2';

const pub = 'public';
const volunteer = 'volunteer';
const event = 'event';
const shop = 'shop';

const all = [ani, gabe, nick]

// Day constants (0-6, Sunday to Saturday)
const sun = 0;
const mon = 1;
const tue = 2;
const wed = 3;
const thu = 4;
const fri = 5;
const sat = 6;

// Time constants (24-hour format)
const t12am = 0;
const t1am = 1;
const t2am = 2;
const t3am = 3;
const t4am = 4;
const t5am = 5;
const t6am = 6;
const t7am = 7;
const t8am = 8;
const t9am = 9;
const t9_30am = 9.5;
const t10am = 10;
const t10_30am = 10.5; // 10:30am
const t11am = 11;
const t12pm = 12;
const t1pm = 13;
const t2pm = 14;
const t3pm = 15;
const t4pm = 16;
const t5pm = 17;
const t6pm = 18;
const t7pm = 19;
const t8pm = 20;
const t9pm = 21;
const t9_30pm = 21.5;
const t10pm = 22;
const t11pm = 23;

const schedule = [

    { kind: pub, day: tue, start: t2pm, end: t9pm, staff: all },
    { kind: pub, day: thu, start: t2pm, end: t9pm, staff: all },
    { kind: pub, day: fri, start: t2pm, end: t9pm, staff: all },
    { kind: pub, day: sat, start: t9_30am, end: t4pm, staff: all },

    { kind: pub, day: tue, start: t10am, end: t2pm, staff: [ani, zach] },
    { kind: pub, day: fri, start: t10am, end: t2pm, staff: [ani, csj1] },
    
    // Volunteer Hours
    { kind: volunteer, day: tue, start: t6pm, end: t9pm, staff: [csj2] },
    { kind: volunteer, day: thu, start: t6pm, end: t9pm, staff: [csj2] },
    { kind: volunteer, day: thu, start: t10am, end: t2pm, staff: [csj2] },
    //{ kind: volunteer, day: thu, start: t5pm, end: t9pm, staff: [abdullah] },

    // Event Hours - wed daytime may move depending on partners
    //{ kind: event, day: wed, start: t11am, end: t3pm, staff: [abdullah, zach] },
    { kind: event, day: wed, start: t5pm, end: t9pm, staff: [all] },
    //{ kind: event, day: wed, start: t1pm, end: t4pm, staff: [csj1, zach] },

    // Shop Hours - these can be moved whenever
    //{ kind: shop, day: mon, start: t1pm, end: t3pm, staff: [ani] },
    //{ kind: shop, day: tue, start: t1pm, end: t3pm, staff: [ani] },
    //{ kind: shop, day: sat, start: t9_30am, end: t12pm, staff: [ani] },
    
];

// const schedule = schedule_ani_fri;


/**
 * Get all events and total hours for a staff member
 * @param {Array} schedule - The schedule array
 * @param {string} staffId - The staff ID to search for
 * @returns {Object} Object containing events array and total hours
 */
function getStaffSchedule(schedule, staffId) {
    const staffEvents = schedule.filter(event => 
        event.staff && event.staff.includes(staffId)
    );
    
    const totalHours = staffEvents.reduce((total, event) => 
        total + getHours(event.start, event.end), 0);
    
    return {
        events: staffEvents,
        totalHours: totalHours
    };
}

/**
 * Get all unique staff IDs from a schedule
 * @param {Array} schedule - The schedule array
 * @returns {Array} Array of unique staff IDs
 */
function getAllStaffIds(schedule) {
    const staffIds = new Set();
    
    schedule.forEach(event => {
        if (event.staff && Array.isArray(event.staff)) {
            event.staff.forEach(id => staffIds.add(id));
        }
    });
    
    return Array.from(staffIds);
}

/**
 * Format a numeric hour to am/pm format
 * @param {number} hour - Hour in 24-hour format (0-23), can include fractional hours
 * @returns {string} Time in am/pm format
 */
function formatHourAmPm(hour) {
    // Handle special cases
    if (hour === 0) return '12am';
    if (hour === 12) return '12pm';
    
    // Extract the hour and minutes
    const hourPart = Math.floor(hour);
    const minutePart = Math.round((hour - hourPart) * 60);
    
    // Determine if it's am or pm
    const period = hourPart < 12 ? 'am' : 'pm';
    
    // Convert to 12-hour format
    const hourIn12 = hourPart < 12 ? hourPart : hourPart - 12;
    
    // Format the time
    if (minutePart === 0) {
        return `${hourIn12}${period}`;
    } else {
        return `${hourIn12}:${minutePart.toString().padStart(2, '0')}${period}`;
    }
}

/**
 * Format a time range using am/pm notation
 * @param {number} start - Start hour in 24-hour format
 * @param {number} end - End hour in 24-hour format
 * @returns {string} Formatted time range
 */
function formatTimeRange(start, end) {
    return `${formatHourAmPm(start)}-${formatHourAmPm(end)}`;
}

/**
 * Format numeric day to day name
 * @param {number} day - Day value (0-6, Sunday to Saturday)
 * @returns {string} Day name
 */
function formatDay(day) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[day];
}

/**
 * Calculate hours between start and end times
 * @param {number} start - Start hour in 24-hour format
 * @param {number} end - End hour in 24-hour format
 * @returns {number} Number of hours
 */
function getHours(start, end) {
    return end - start;
}

/**
 * Format schedule in a human-readable ASCII format
 * @param {Array} schedule - The complete schedule or a filtered subset
 * @param {string} [title] - Optional title for the formatted output
 * @returns {string} Formatted schedule as a string
 */
function formatSchedule(schedule, name = 'Schedule') {

    // Calculate overall total hours
    const totalHours = schedule.reduce((total, event) =>
        total + getHours(event.start, event.end), 0);
    const totalStaffHours = schedule.reduce((total, event) =>
        total + getHours(event.start, event.end) * (event.staff ? event.staff.length : 0), 0);

    let title = name + ` (${totalHours} operating hours, ${totalStaffHours} staffed hours)\n`;
    
    let output = `${title}\n${'='.repeat(title.length)}\n\n`;

    // Group events by kind, then by day
    const eventsByKind = {};
    
    schedule.forEach(event => {
        if (!eventsByKind[event.kind]) {
            eventsByKind[event.kind] = {};
        }
        
        if (!eventsByKind[event.kind][event.day]) {
            eventsByKind[event.kind][event.day] = [];
        }
        
        eventsByKind[event.kind][event.day].push(event);
    });
    
    // Format each kind of event
    Object.keys(eventsByKind).forEach(kind => {
        // Flatten all events for this kind to calculate total hours
        const allKindEvents = [];
        Object.values(eventsByKind[kind]).forEach(dayEvents => {
            allKindEvents.push(...dayEvents);
        });

        // Calculate total hours for this kind
        const kindTotalHours = allKindEvents.reduce((total, event) =>
            total + getHours(event.start, event.end), 0);
        const kindStaffHours = allKindEvents.reduce((total, event) =>
            total + getHours(event.start, event.end) * (event.staff ? event.staff.length : 0), 0);

        const title = `${kind.toUpperCase()} - ${kindTotalHours} operating hours, ${kindStaffHours} staffed hours`;
        output += `${title}\n${'-'.repeat(title.length)}\n`;
        
        // Sort days of the week in chronological order
        const sortedDays = Object.keys(eventsByKind[kind])
            .map(day => parseInt(day, 10))
            .sort((a, b) => a - b);
        
        // For each day, list events
        sortedDays.forEach(day => {
            output += `  ${formatDay(day)}:\n`;
            
            eventsByKind[kind][day].forEach(event => {
                const staffList = event.staff ? event.staff.join(', ') : 'No staff assigned';
                const hours = `${getHours(event.start, event.end)} hours`;
                const timeRange = formatTimeRange(event.start, event.end);
                
                output += `    ${timeRange} (${hours}) -- Staff: ${staffList}\n`;
            });
        });

        output += '\n';
    });
    
    return output;
}

/**
 * Check if a staff member has a 2-day weekend
 * @param {Array} schedule - The complete schedule
 * @param {string} staffId - The staff ID to check
 * @returns {boolean} - True if the staff has a 2-day weekend
 */
function hasTwoDayWeekend(schedule, staffId) {
    // Get all events for this staff member
    const staffEvents = schedule.filter(event => 
        event.staff && event.staff.includes(staffId)
    );
    
    // Get all working days for this staff member
    const workingDays = new Set(staffEvents.map(event => event.day));
    
    // Count consecutive non-working days
    for (let startDay = 0; startDay < 7; startDay++) {
        // Check for two consecutive days off
        if (!workingDays.has(startDay) && !workingDays.has((startDay + 1) % 7)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Format a staff member's schedule by day instead of by event kind
 * @param {Array} events - The staff member's events
 * @param {string} staffId - The staff ID
 * @param {Array} fullSchedule - The complete schedule (needed for weekend check)
 * @returns {string} Formatted schedule as a string
 */
function formatStaffScheduleByDay(events, staffId, fullSchedule) {
    // Calculate total hours
    const totalHours = events.reduce((total, event) => 
        total + getHours(event.start, event.end), 0);

    const title = `${staffId}'s Schedule (${totalHours} hours total)\n`;
    
    let output = `${title}\n${'='.repeat(title.length)}\n\n`;
    
    // Check for two-day weekend and add warning if needed
    if (!hasTwoDayWeekend(fullSchedule, staffId)) {
        output += `⚠️ WARNING: ${staffId} does not have a 2-day weekend in this schedule!\n\n`;
    }

    // Group events by day
    const eventsByDay = {};
    
    events.forEach(event => {
        if (!eventsByDay[event.day]) {
            eventsByDay[event.day] = [];
        }
        eventsByDay[event.day].push(event);
    });
    
    // Sort days of the week in chronological order
    const sortedDays = Object.keys(eventsByDay)
        .map(day => parseInt(day, 10))
        .sort((a, b) => a - b);
    
    // For each day, list events
    sortedDays.forEach(day => {
        // Calculate total hours for this day
        const dayTotalHours = eventsByDay[day].reduce((total, event) => 
            total + getHours(event.start, event.end), 0);
            
        const dayTitle = `${formatDay(day)} - Total hours: ${dayTotalHours}`;
        output += `${dayTitle}\n${'-'.repeat(dayTitle.length)}\n`;
        
        // Sort events by start time
        eventsByDay[day].sort((a, b) => a.start - b.start);
        
        eventsByDay[day].forEach(event => {
            const hours = `${getHours(event.start, event.end)} hours`;
            const timeRange = formatTimeRange(event.start, event.end);
            output += `  ${event.kind}: ${timeRange} (${hours})\n`;
        });
        
        output += '\n';
    });
    
    return output;
}

/**
 * Render a comprehensive summary of the schedule including individual staff schedules
 * @param {Array} schedule - The complete schedule
 * @returns {string} Complete formatted summary
 */
function renderScheduleSummary(schedule) {
    let output = '';
    
    // Sanity checks first
    output += sanityCheckSchedule(schedule) + '\n';

    // Staffing analysis
    output += analyzeStaffingBurden(schedule) + '\n\n';

    // First, render the full schedule
    output += formatSchedule(schedule, 'FULL SCHEDULE') + '\n\n';
    
    // Get all staff members
    const staffIds = getAllStaffIds(schedule);
    
    // Render individual schedules for each staff member
    output += 'INDIVIDUAL STAFF SCHEDULES\n';
    output += '==========================\n\n';
    
    staffIds.forEach(staffId => {
        const staffSchedule = getStaffSchedule(schedule, staffId);
        output += formatStaffScheduleByDay(staffSchedule.events, staffId, schedule) + '\n\n';
    });
    
    return output;
}


// --- Staffing analysis configuration ---
const TOTAL_STAFF = 4;
const HOURS_PER_WEEK = 35;
const EVENING_CUTOFF = t5pm;  // hours at or after this count as evening/weekend
const WEEKEND_DAYS = [sat];   // Sunday and Monday are days off (no shifts)

/**
 * Analyze staffing burden: evening/weekend vs daytime, and leftover capacity.
 * Splits shifts that straddle the evening cutoff into two portions.
 */
function analyzeStaffingBurden(schedule) {
    let eveningWeekendStaffHours = 0;
    let daytimeStaffHours = 0;

    // Count staff-slots needed per evening/weekend day
    // e.g. if Tuesday evening needs 3 staff across all shifts, that's 3 occasions
    const staffNeededPerDay = {};  // day -> max staff needed concurrently or total unique slots

    schedule.forEach(event => {
        const staffCount = event.staff ? event.staff.length : 0;
        const isWeekend = WEEKEND_DAYS.includes(event.day);

        if (isWeekend) {
            eveningWeekendStaffHours += getHours(event.start, event.end) * staffCount;
            staffNeededPerDay[event.day] = (staffNeededPerDay[event.day] || 0) + staffCount;
        } else {
            const daytimeEnd = Math.min(event.end, EVENING_CUTOFF);
            const eveningStart = Math.max(event.start, EVENING_CUTOFF);

            if (event.start < EVENING_CUTOFF) {
                daytimeStaffHours += getHours(event.start, daytimeEnd) * staffCount;
            }
            if (event.end > EVENING_CUTOFF) {
                eveningWeekendStaffHours += getHours(eveningStart, event.end) * staffCount;
                staffNeededPerDay[event.day] = (staffNeededPerDay[event.day] || 0) + staffCount;
            }
        }
    });

    // Total staff-occasions (e.g. 3 people working Tuesday evening = 3 occasions)
    const totalOccasions = Object.values(staffNeededPerDay).reduce((a, b) => a + b, 0);

    const totalStaffHours = eveningWeekendStaffHours + daytimeStaffHours;
    const totalCapacity = TOTAL_STAFF * HOURS_PER_WEEK;
    const remainingHours = totalCapacity - totalStaffHours;

    let output = 'STAFFING ANALYSIS\n';
    output += '=================\n\n';
    output += `Staff: ${TOTAL_STAFF} @ ${HOURS_PER_WEEK} hrs/wk = ${totalCapacity} hrs total capacity\n`;
    output += `Total staffed hours needed: ${totalStaffHours}\n`;
    output += `Remaining (admin/shop/flex): ${remainingHours} hrs (${(remainingHours / TOTAL_STAFF).toFixed(1)} per person)\n\n`;

    output += `Evening/weekend staffed hours: ${eveningWeekendStaffHours} hrs (${(eveningWeekendStaffHours / TOTAL_STAFF).toFixed(1)} per person)\n`;
    output += `Daytime weekday staffed hours: ${daytimeStaffHours} hrs (${(daytimeStaffHours / TOTAL_STAFF).toFixed(1)} per person)\n\n`;

    // Per-day breakdown of evening/weekend occasions
    output += `Evening/weekend occasions: ${totalOccasions} staff-slots across ${Object.keys(staffNeededPerDay).length} days (${(totalOccasions / TOTAL_STAFF).toFixed(1)} per person)\n`;
    const sortedDays = Object.keys(staffNeededPerDay).map(Number).sort((a, b) => a - b);
    sortedDays.forEach(day => {
        output += `  ${formatDay(day)}: ${staffNeededPerDay[day]} staff needed\n`;
    });

    return output;
}

/**
 * Sanity-check the schedule and analysis for common errors.
 * Returns a string with warnings/errors, or empty string if all checks pass.
 */
function sanityCheckSchedule(schedule) {
    const errors = [];

    // 1. Basic shift validity
    schedule.forEach((event, i) => {
        if (event.end <= event.start) {
            errors.push(`Shift ${i}: end (${event.end}) <= start (${event.start})`);
        }
        if (!event.staff || event.staff.length === 0) {
            errors.push(`Shift ${i} (${formatDay(event.day)} ${formatTimeRange(event.start, event.end)}): no staff assigned`);
        }
        if (event.day === sun || event.day === mon) {
            errors.push(`Shift ${i}: scheduled on ${formatDay(event.day)} (should be a day off)`);
        }
    });

    // 2. Cross-check: evening+daytime staffed hours == total staffed hours
    const totalStaffHours = schedule.reduce((t, e) =>
        t + getHours(e.start, e.end) * (e.staff ? e.staff.length : 0), 0);
    let checkEvening = 0, checkDaytime = 0;
    schedule.forEach(event => {
        const sc = event.staff ? event.staff.length : 0;
        const isWeekend = WEEKEND_DAYS.includes(event.day);
        if (isWeekend) {
            checkEvening += getHours(event.start, event.end) * sc;
        } else {
            const daytimeEnd = Math.min(event.end, EVENING_CUTOFF);
            const eveningStart = Math.max(event.start, EVENING_CUTOFF);
            if (event.start < EVENING_CUTOFF)
                checkDaytime += getHours(event.start, daytimeEnd) * sc;
            if (event.end > EVENING_CUTOFF)
                checkEvening += getHours(eveningStart, event.end) * sc;
        }
    });
    if (Math.abs((checkEvening + checkDaytime) - totalStaffHours) > 0.01) {
        errors.push(`Hour split mismatch: evening(${checkEvening}) + daytime(${checkDaytime}) = ${checkEvening + checkDaytime}, but total staffed = ${totalStaffHours}`);
    }

    // 3. Peak concurrent staff check — at any moment, are more staff needed than available?
    //    Uses a sweep-line per day across all shifts.
    const shiftsByDay = {};
    schedule.forEach(event => {
        if (!shiftsByDay[event.day]) shiftsByDay[event.day] = [];
        shiftsByDay[event.day].push(event);
    });
    for (const [day, shifts] of Object.entries(shiftsByDay)) {
        // Build timeline events: +staff at start, -staff at end
        const timeline = [];
        shifts.forEach(event => {
            const sc = event.staff ? event.staff.length : 0;
            timeline.push({ time: event.start, delta: +sc });
            timeline.push({ time: event.end, delta: -sc });
        });
        timeline.sort((a, b) => a.time - b.time || a.delta - b.delta);
        let concurrent = 0, peak = 0, peakTime = 0;
        for (const t of timeline) {
            concurrent += t.delta;
            if (concurrent > peak) {
                peak = concurrent;
                peakTime = t.time;
            }
        }
        if (peak > TOTAL_STAFF) {
            errors.push(`${formatDay(Number(day))}: peak concurrent staff = ${peak} at ${formatHourAmPm(peakTime)}, but only ${TOTAL_STAFF} staff available`);
        }
    }

    // 4. Evening/weekend occasion count: on any single day, staff-slots needed should not
    //    exceed TOTAL_STAFF (otherwise not everyone can get that evening off in rotation)
    //    Note: this is a warning, not necessarily an error — it means that day requires
    //    more than one person to give up their evening.
    // (Already covered by peak check above for feasibility)

    // 5. Total staffed hours should not exceed total capacity
    const totalCapacity = TOTAL_STAFF * HOURS_PER_WEEK;
    if (totalStaffHours > totalCapacity) {
        errors.push(`Total staffed hours (${totalStaffHours}) exceeds total capacity (${totalCapacity})`);
    }

    // 6. Check for duplicate shifts (same day, same time range, same kind)
    const seen = new Set();
    schedule.forEach((event, i) => {
        const key = `${event.kind}-${event.day}-${event.start}-${event.end}`;
        if (seen.has(key)) {
            errors.push(`Shift ${i}: possible duplicate — ${event.kind} ${formatDay(event.day)} ${formatTimeRange(event.start, event.end)}`);
        }
        seen.add(key);
    });

    if (errors.length === 0) {
        return 'SANITY CHECKS: all passed ✓\n';
    }
    let output = `SANITY CHECKS: ${errors.length} issue(s) found\n`;
    output += '-'.repeat(40) + '\n';
    errors.forEach(e => output += `  ⚠ ${e}\n`);
    return output + '\n';
}

/**
 * Write each staff schedule to individual files and the full schedule to schedule.txt
 * @param {Array} schedule - The complete schedule
 */
async function writeScheduleFiles(schedule) {
    try {
        // Get all staff members
        const staffIds = getAllStaffIds(schedule);
        
        // Generate the full schedule
        const fullScheduleOutput = formatSchedule(schedule, 'FULL SCHEDULE');
        
        // Write full schedule to schedule.txt
        await Deno.writeTextFile('schedule.txt', fullScheduleOutput);
        console.info('Full schedule written to schedule.txt');
        
        // Generate and write individual staff schedules
        for (const staffId of staffIds) {
            const staffSchedule = getStaffSchedule(schedule, staffId);
            const staffOutput = formatStaffScheduleByDay(staffSchedule.events, staffId, schedule);
            const filename = `${staffId.toLowerCase()}-schedule.txt`;
            
            await Deno.writeTextFile(filename, staffOutput);
            console.info(`${staffId}'s schedule written to ${filename}`);
        }
    } catch (error) {
        console.error('Error writing schedule files:', error);
    }
}

function main(args) {
    // Output to console as before
    console.info(renderScheduleSummary(schedule));
    
    // Also write to files
    writeScheduleFiles(schedule);
}

if (import.meta.main)
    main(Deno.args);

