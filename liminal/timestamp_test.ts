// Hybrid logical clock timestamps: time*RADIX + counter where RADIX is
// 2^20-1 (see timestamp.ts - the radix is baked into persisted data, so
// several constants here are frozen).  The load-bearing invariants tested:
// the encoding round-trips, timestamps order as (time, counter) pairs,
// nextTime is strictly monotonic even against a wrong/future clock, and
// the persisted-data constants never drift.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import * as timestamp from "./timestamp.ts";

const RADIX = 0x0FFFFF;  // 2^20-1: the (frozen) encoding radix

test("persisted-data constants are frozen (a change would corrupt existing dbs)", () => {
    // These values appear in stored timestamps (mmo db: 166k+ rows carry the
    // BEGINNING_OF_TIME sentinel; all real stamps are radix-2^20-1 encoded).
    assertEquals(timestamp.BEGINNING_OF_TIME, 1577836800000);
    assertEquals(timestamp.END_OF_TIME, Number.MAX_SAFE_INTEGER);
    assertEquals(timestamp.makeTimestamp(123456, 789), 123456 * 0x0FFFFF + 789);
});

test("makeTimestamp/extract round-trip both components", () => {
    for (const [time, counter] of [[0, 0], [0, 1], [1, 0], [123456, 789],
                                   [1, RADIX - 1], [timestamp.RAPTURE_TIME, 0]]) {
        const t = timestamp.makeTimestamp(time, counter);
        assertEquals(timestamp.extractTimeFromTimestamp(t), time, `time of (${time},${counter})`);
        assertEquals(timestamp.extractCounterFromTimestamp(t), counter, `counter of (${time},${counter})`);
    }
    // Regression: extractCounter used '& RADIX' which is not the inverse of
    // the radix encoding - makeTimestamp(1, 0) decoded to counter 1048575.
    assertEquals(timestamp.extractCounterFromTimestamp(timestamp.makeTimestamp(1, 0)), 0);
});

test("makeTimestamp rejects invalid components", () => {
    assertThrows(() => timestamp.makeTimestamp(-1, 0), Error, "time");
    assertThrows(() => timestamp.makeTimestamp(1.5, 0), Error, "time");
    assertThrows(() => timestamp.makeTimestamp(1 / RADIX, 0), Error, "time");  // time*RADIX integral but time isn't
    assertThrows(() => timestamp.makeTimestamp(0, -1), Error, "counter");
    assertThrows(() => timestamp.makeTimestamp(0, 0.5), Error, "counter");
    assertThrows(() => timestamp.makeTimestamp(0, RADIX), Error, "counter");  // counter must be < radix
    // Combined overflow: time*RADIX alone is safe but +counter is not.
    const maxTime = Math.floor(Number.MAX_SAFE_INTEGER / RADIX);
    assertThrows(() => timestamp.makeTimestamp(maxTime, RADIX - 1), Error, "out of range");
});

test("timestamps order as (time, counter) pairs; rollover crosses seconds correctly", () => {
    assert(timestamp.makeTimestamp(100, 5) < timestamp.makeTimestamp(100, 6));
    assert(timestamp.makeTimestamp(100, RADIX - 1) < timestamp.makeTimestamp(101, 0));
    assert(timestamp.makeTimestamp(100, RADIX - 1) < timestamp.makeTimestamp(200, 0));
    // A raw +1 on a second's last counter value lands on the next second.
    const next = timestamp.makeTimestamp(100, RADIX - 1) + 1;
    assertEquals(timestamp.extractTimeFromTimestamp(next), 101);
    assertEquals(timestamp.extractCounterFromTimestamp(next), 0);
});

test("nextTime is strictly monotonic, even faster than the clock", () => {
    let t = timestamp.BEGINNING_OF_TIME;
    for (let i = 0; i < 10_000; i++) {
        const n = timestamp.nextTime(t);
        assert(n > t, `nextTime must increase (${n} after ${t})`);
        t = n;
    }
});

test("nextTime embeds the current time when the clock is ahead of the last stamp", () => {
    const before = timestamp.currentSystemTimeInLocalEpoch();
    const t = timestamp.nextTime(timestamp.BEGINNING_OF_TIME);
    const after = timestamp.currentSystemTimeInLocalEpoch();
    const time = timestamp.extractTimeFromTimestamp(t);
    assert(before <= time && time <= after, `embedded time ${time} not in [${before}, ${after}]`);
    assertEquals(timestamp.extractCounterFromTimestamp(t), 0);
});

test("nextTime from a future timestamp counts within it (can only go forward)", () => {
    // e.g. the last stamp came from a machine with a wrong clock.
    const future = timestamp.makeTimestamp(timestamp.currentSystemTimeInLocalEpoch() + 10_000, 5);
    assertEquals(timestamp.nextTime(future), future + 1);
});

test("rapture: time portion freezes but stamps keep increasing; true end of time throws", () => {
    // RAPTURE_TIME is in seconds-since-local-epoch (same units nextTime
    // compares it against) and must itself encode to a valid timestamp.
    // (Regression: it was computed in absolute milliseconds, ~5000x too
    // large, so the freeze could never engage before makeTimestamp threw.)
    assert(timestamp.RAPTURE_TIME > timestamp.currentSystemTimeInLocalEpoch());
    assert(timestamp.RAPTURE_TIME < 2 ** 33);
    const atRapture = timestamp.makeTimestamp(timestamp.RAPTURE_TIME, 0);
    assert(atRapture < timestamp.END_OF_TIME);
    // Post-rapture stamps come from the +1 mechanism.
    assertEquals(timestamp.nextTime(atRapture), atRapture + 1);
    // And at the true end of time we throw rather than go backwards.
    assertThrows(() => timestamp.nextTime(timestamp.END_OF_TIME), Error, "END DAYS");
});

test("formatting: sentinels are special-cased; UTC form carries the counter", () => {
    assertEquals(timestamp.formatTimestampAsUTCTime(timestamp.BEGINNING_OF_TIME), 'BEGINNING_OF_TIME');
    assertEquals(timestamp.formatTimestampAsUTCTime(timestamp.END_OF_TIME), 'END_OF_TIME');
    assertEquals(timestamp.formatTimestampAsLocalTime(timestamp.BEGINNING_OF_TIME), '');
    assertEquals(timestamp.formatTimestampAsLocalTime(timestamp.END_OF_TIME), '');
    // 123 seconds after the local epoch start (2020-01-01T00:02:03Z), event 7.
    assertEquals(timestamp.formatTimestampAsUTCTime(timestamp.makeTimestamp(123, 7)),
                 '2020-01-01T00:02:03.000Z-7');
});

// Deterministic LCG so failures reproduce.
function makeRng(seed: number): (n: number) => number {
    let state = seed;
    return (n: number) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % n;
    };
}

test("random (time, counter) pairs: round-trip and order agreement", () => {
    const rand = makeRng(424242);
    const pairs: [number, number][] = [];
    for (let i = 0; i < 3000; i++)
        pairs.push([rand(2 ** 33 - 2 ** 20), rand(RADIX)]);
    const stamps = pairs.map(([time, counter]) => {
        const t = timestamp.makeTimestamp(time, counter);
        assertEquals(timestamp.extractTimeFromTimestamp(t), time);
        assertEquals(timestamp.extractCounterFromTimestamp(t), counter);
        return t;
    });
    // Numeric order of timestamps == lexicographic order of (time, counter).
    const byStamp = stamps.map((_, i) => i).toSorted((x, y) => stamps[x] - stamps[y]);
    const byPair = stamps.map((_, i) => i).toSorted(
        (x, y) => (pairs[x][0] - pairs[y][0]) || (pairs[x][1] - pairs[y][1]) || (x - y));
    assertEquals(byStamp, byPair);
});

test("random nextTime chains stay strictly monotonic across injected clock skew", () => {
    const rand = makeRng(31337);
    let t = timestamp.BEGINNING_OF_TIME;
    for (let i = 0; i < 3000; i++) {
        // Occasionally jump the chain to a future stamp (a wrong-clock peer).
        if (rand(100) < 5)
            t = timestamp.makeTimestamp(
                timestamp.currentSystemTimeInLocalEpoch() + rand(10_000), rand(RADIX));
        const n = timestamp.nextTime(t);
        assert(n > t, `nextTime must increase (${n} after ${t})`);
        t = n;
    }
});
