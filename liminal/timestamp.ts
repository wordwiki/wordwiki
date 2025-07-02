/**
 * A hybrid logical clock implementation.
 *
 * Hands out monotonically increasing time stamps.  These time stamps
 * are closely related to wall clock time. (the differ from wall clock time
 * only when one allocates more than 1 million stamps in a second, or when you
 * are approaching the end times).
 */

/**
 * 2^53-1 == JS Maxint
 * We allocate 33 bits for the time since local epoch start in seconds ~= 270 years.
 * We allocate the remaining 20 bits to updates per second ~= 1 million updates per second.
 * - if we run out of updates in a second, we will just start using the next second.
 * - as we approach the end of time, we switch to a fixed clock time ...
 */

// We use a newer epoch start than the default "January 1, 1970,
// 00:00:00 UTC" so we can go longer before we run out of time bits
// (and so that future people can adjust the epoch if this happens)
export const LOCAL_EPOCH_START = +new Date(Date.UTC(2020, 0, 1));

// When we hit the epoch end, the time portion of the timestamp stops
// moving forward (except as driven by counter overflow).  This will
// give us 1 billion further events after we hit the end of the epoch.
export const RAPTURE_TIME = (LOCAL_EPOCH_START + 2**33) - (1024*1024);

// Bottom 20 bits of a timestamp is the counter portion.  (1 million
// events per second).  (If there is more than 1 million events in a
// second, we will just advance to the next second).
const COUNTER_MASK = 0x0FFFFF;

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
    console.info({currentSystemTimeInLocalEpoch, lastTimestamp, lastTimestampTime});
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
    return timestamp & COUNTER_MASK;
}

/**
 * Combine a time (in seconds since the start of our locally defined epoch) and a
 * counter (max size 2^20) into a timestamp.
 */
export function makeTimestamp(time: number, counter: number): number {
    if(time < 0 || !Number.isSafeInteger(time*COUNTER_MASK))
        throw new Error(`internal error: invalid time component of timestamp ${time}`);
    if(counter < 0 || !Number.isSafeInteger(counter) || counter >= COUNTER_MASK)
        throw new Error(`internal error: invalid counter component of timestamp ${counter}`);
    // We are doing this with multiply and add (instead of <<< and |)
    // because the JS bit operators are 32 bit only.
    return time*COUNTER_MASK + counter;
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
