/**
 * Random random number utility functions.
 *
 * All of these draw from Math.random (not seedable, not crypto-strength) -
 * use liminal/nanoid.ts for ids, and a local seeded generator in tests
 * that need reproducibility.
 */
import * as utils from './utils.ts';

/**
 * Generates a random integer between min and max (inclusive), uniformly.
 */
export function randomInt (min: number, max: number): number {
  // Validate: non-integer or reversed bounds silently produced garbage
  // (randomInt(5, 0) returned values in 1..5, randomInt of NaN gave NaN).
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max)
    throw new Error(`randomInt bounds must be integers with min <= max (got ${min}, ${max})`);
  return Math.floor (Math.random() * (max - min + 1) + min);
}

/**
 * Generates a random boolean.
 */
export function randomBool (): boolean {
  return Math.random () >= 0.5;
}

/**
 * Simple weighted random number generator.
 *
 * Given a list of die specs (face counts), picks a random die and rolls it.
 *
 * For example:
 *
 * rollRandomDie ([10, 100, 1000])
 *
 * will return 0-9 1/3 of the time, 0-99 1/3 of the time and 0-999 1/3 of the time.
 *
 * We often want this kind of distribution when doing random testing.
 */
export function rollRandomDie (dieSpecs: number[]): number {
  // - 1: a die spec is a FACE COUNT (same semantics as randomSequenceGenerator's
  // faces), so spec 10 rolls 0..9 - not 0..10 as the historical version did.
  return randomInt (0, dieSpecs [randomInt (0, dieSpecs.length-1)] - 1);
}

/**
 * Generates a sequence of `length` integers, each between 0 ... faces-1.
 * The larger faces is, the fewer dups you will have.  If you want no dups
 * use randomSequenceGeneratorNoDups.
 *
 * As a special case, if faces is 0, then a sequence with no duplicates
 * is returned.
 */
export function randomSequenceGenerator (length: number, faces: number): number[] {
  if (faces === 0)
    return randomSequenceGeneratorNoDups (length);
  const vals: number[] = [];
  for (let i=0; i<length; i++)
    vals.push (randomInt (0, faces-1));
  return vals;
}

/**
 * Generate a sequence of random numbers with no duplicates (a uniform
 * random permutation of 0 ... length-1).
 */
export function randomSequenceGeneratorNoDups (length: number): number[] {
  return shuffle (utils.range (0, length));
}

/**
 * Does an in-place uniform random shuffle of a supplied array (Fisher-Yates).
 *
 * (The historical version swapped every position with a peer drawn from the
 * WHOLE array, which is measurably biased: n^n swap sequences cannot map
 * evenly onto n! permutations - for [0,1,2] some orders came up 18.6% of
 * the time and others 14.7%, vs the uniform 16.7%.)
 */
export function shuffle<T> (vals: T[]): T[] {
  for (let i=0; i<vals.length-1; i++) {
    const peer = randomInt (i, vals.length-1);
    const tmp = vals[i];
    vals[i] = vals[peer];
    vals[peer] = tmp;
  }
  return vals;
}
