/**
 * A hybrid logical clock implementation.
 *
 * Hands out monotonically increasing time stamps.  These time stamps
 * are closely related to wall clock time. (they differ from wall clock time
 * only when one allocates more than ~1 million stamps in a second, or when
 * you are approaching the end times).
 */

/**
 * 2^53-1 == JS Maxint
 *
 * A timestamp is time*COUNTER_MASK + counter, where time is seconds since
 * our local epoch start and counter is events within that second.
 *
 * NOTE: this is positional encoding in radix 2^20-1 (COUNTER_MASK), NOT
 * 33/20 bit fields - the radix is baked into all persisted timestamps so
 * must never change.  This gives ~272 years of time range with ~1 million
 * events per second.
 * - if we run out of events in a second, we just start using the next second.
 * - as we approach the end of time, the time portion freezes at RAPTURE_TIME
 *   and we rely on the within-second counting alone (see below).
 */

// We use a newer epoch start than the default "January 1, 1970,
// 00:00:00 UTC" so we can go longer before we run out of time range
// (and so that future people can adjust the epoch if this happens).
// Units: milliseconds since the JS epoch.
export const LOCAL_EPOCH_START = +new Date(Date.UTC(2020, 0, 1));

// When the time portion reaches this (seconds since local epoch start -
// about year 2292), it stops moving forward and further timestamps come
// from the counter-overflow mechanism alone.  The remaining headroom below
// Number.MAX_SAFE_INTEGER gives us about 10^12 further events after the
// rapture before nextTime() throws.
export const RAPTURE_TIME = 2**33 - 1024*1024;

// The counter portion of a timestamp counts events within one second
// (~1 million per second).  (If there are more than ~1 million events in
// a second, we just advance to the next second).  This is the RADIX of
// the timestamp encoding (see note above), so despite the name it is not
// usable as a bitmask.
const COUNTER_MASK = 0x0FFFFF;

// BEGINNING_OF_TIME is a sentinel that sorts below all timestamps this
// module generates.  (The value is the local epoch start in milliseconds -
// decoded as a timestamp it actually means Jan 18 2020 - but it is only
// ever used as a sentinel, and it is persisted in existing databases, so
// the value is frozen.)
export const BEGINNING_OF_TIME = LOCAL_EPOCH_START;
export const END_OF_TIME = Number.MAX_SAFE_INTEGER;

/**
 * Given an existing timestamp, return a higher timestamp.
 *
 * If possible, the timestamp will contain the current time.
 *
 * The timestamp will not have the correct current time if the lastTimestamp
 * is in the future (ie. we can only go forward).
 *
 * If there are more than one million timestamps requested in one second,
 * then we will start stealing timestamps from the next second.
 *
 * When we get close to the end of days (hundreds of years in the future),
 * we will stop advancing the time portion of the timestamp, and rely only
 * on the rollover mechanism.  This will give us an extra billion updates
 * after the rapture.
 *
 * The purpose of this mechanism is to have a smallish always increasing
 * timestamp that is used to order transactions, while having a (usually
 * correct) system time embedded in it to make it user intelligible.
 */
export function nextTime(lastTimestamp: number): number {
    const currentSystemTimeInLocalEpoch = currentSystemTimeInLocalEpochOrRaptureTime();
    const lastTimestampTime = extractTimeFromTimestamp(lastTimestamp);
    if(currentSystemTimeInLocalEpoch > lastTimestampTime) {
        return makeTimestamp(currentSystemTimeInLocalEpoch, 0);
    } else {
        const nextTimestamp = lastTimestamp+1;
        if(!Number.isSafeInteger(nextTimestamp))
            throw new Error('internal error: THE END DAYS ARE HERE!');
        return nextTimestamp;
    }
}

/**
 * Extract the time portion of a timestamp.
 */
export function extractTimeFromTimestamp(timestamp: number): number {
    // JS shift operators are 32 bit - so we have to use divide.
    return Math.floor(timestamp/COUNTER_MASK);
}

/**
 * Extract the counter portion of a timestamp.
 */
export function extractCounterFromTimestamp(timestamp: number): number {
    // % not & : the encoding radix is 2^20-1, not 2^20, so a bitwise AND
    // is not the inverse of makeTimestamp (for example makeTimestamp(1, 0)
    // & COUNTER_MASK is 1048575, not 0).
    return timestamp % COUNTER_MASK;
}

/**
 * Combine a time (in seconds since the start of our locally defined epoch) and a
 * counter (max size 2^20) into a timestamp.
 */
export function makeTimestamp(time: number, counter: number): number {
    if(time < 0 || !Number.isSafeInteger(time))
        throw new Error(`internal error: invalid time component of timestamp ${time}`);
    if(counter < 0 || !Number.isSafeInteger(counter) || counter >= COUNTER_MASK)
        throw new Error(`internal error: invalid counter component of timestamp ${counter}`);
    // We are doing this with multiply and add (instead of << and |)
    // because the JS bit operators are 32 bit only.
    const timestamp = time*COUNTER_MASK + counter;
    if(!Number.isSafeInteger(timestamp))
        throw new Error(`internal error: timestamp out of range: time ${time}, counter ${counter}`);
    return timestamp;
}

/**
 * Returns current system time as seconds (UTC) since start our
 * locally defined epoch.
 */
export function currentSystemTimeInLocalEpoch(): number {
    return Math.floor((+new Date()-LOCAL_EPOCH_START)/1000);
}

/**
 * Returns current system time as seconds (UTC) since start our
 * locally defined epoch.  Time freezes when we hit the rapture time.
 * (which will allow us another 1 billion events using the multi-
 * event per second overflow mechanism before the real end times).
 */
export function currentSystemTimeInLocalEpochOrRaptureTime(): number {
    return Math.min(currentSystemTimeInLocalEpoch(), RAPTURE_TIME);
}

// export function formatTimestampAsLocalTime(t: number) {
//     const jsDate = new Date(extractTimeFromTimestamp(t)*1000 + LOCAL_EPOCH_START);
//     const counter = extractCounterFromTimestamp(t);
//     return jsDate.`${jsDate.getFullYear()}-${jsDate.getMonth()+1)}-${jsDate.getDate()}
// }

// TODO probably don't wire en-CA here
const shortLocalTimeFormat = new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'short',
    timeStyle: 'medium',
});

export function formatTimestampAsLocalTime(t: number): string {
    switch(t) {
        case BEGINNING_OF_TIME: return ''; //'←';
        case END_OF_TIME: return ''; //'→';
        default: {
            const jsDate = new Date(extractTimeFromTimestamp(t)*1000 + LOCAL_EPOCH_START);
            return shortLocalTimeFormat.format(jsDate);
        }
    }
}

// A compact, regular date for event-log rows: "yy-MM-dd" (e.g. 26-06-14).
// Empty at the sentinels.  Date only - the log is already in time order, so the
// clock time would just add noise; same-day events read in sequence.
export function formatTimestampCompact(t: number): string {
    if(t === BEGINNING_OF_TIME || t === END_OF_TIME) return '';
    const d = new Date(extractTimeFromTimestamp(t)*1000 + LOCAL_EPOCH_START);
    const yy = String(d.getFullYear() % 100).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

export function formatTimestampAsUTCTime(t: number): string {
    switch(t) {
        case BEGINNING_OF_TIME: return 'BEGINNING_OF_TIME';
        case END_OF_TIME: return 'END_OF_TIME';
        default: {
            const jsDate = new Date(extractTimeFromTimestamp(t)*1000 + LOCAL_EPOCH_START);
            const counter = extractCounterFromTimestamp(t);
            // TODO this is an ugly representation, is in UTC, has millis that will always
            //      0 FIX FIX
            return `${jsDate.toISOString()}-${counter}`;
        }
    }
}
