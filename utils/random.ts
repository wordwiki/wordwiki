import * as utils from './utils.ts';

/**
 * Generates a random integer between min and max (inclusive).
 *
 */
export function randomInt (min: number, max: number) {
  return Math.floor (Math.random() * (max - min + 1) + min);
}

/**
 * Generates a random boolean.
 *
 */
export function randomBool () {
  return Math.random () >= 0.5;
}

/**
 * Simple weighted random number generator.
 * 
 * Given a list of die specs (faces), picks a random die and rolls it.
 *
 * For example:
 *
 * rollRandomDie (10, 100, 1000)
 *
 * will return 0-9 1/3 of the time, 0-99 1/3 of the time and 0-999 1/3 of the time.
 *
 * We often want this kind of distribution when doing random testing.
 */
export function rollRandomDie (dieSpecs: number[]) {
  return randomInt (0, dieSpecs [randomInt (0, dieSpecs.length-1)]);
}

/**
 * Generates a sequence of integers of length between minLength and maxLength.
 * Each number in the sequence is between 0 ... faces-1   The larger faces
 * is, the fewer dups you will have.   If you want no dups use
 * randomSequenceGeneratorNoDups.
 *
 * As a special case, if faces is 0, then a sequence with no duplicates
 * is returned.
 */
export function randomSequenceGenerator (length: number, faces: number): number[] {
  if (faces === 0)
    return randomSequenceGeneratorNoDups (length);
  var vals: number[] = [];
  for (var i=0; i<length; i++)
    vals.push (randomInt (0, faces-1));
  return vals;
}

/**
 * Generate a sequence of random numbes with no duplicates.
 */
export function randomSequenceGeneratorNoDups (length: number): number[] {
  return shuffle (utils.range (0, length));
}

/**
 * Does an in-place random shuffle of a supplied array.
 */
export function shuffle<T> (vals: T[]): T[] {
  for (var i=0; i<vals.length; i++) {
    var peer = randomInt (0, vals.length-1)
    var tmp = vals[i];
    vals[i] = vals[peer];
    vals[peer] = tmp;
  }
  return vals;
}

