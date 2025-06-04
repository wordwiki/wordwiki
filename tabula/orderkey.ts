/**
 * A mechanism to generate an initial list of ordered keys and then
 * a mechanism to generate a new key that will sort between a supplied
 * pair of keys.
 *
 * This is used to represent explicitly ordered data in a relational
 * database (where tuples are inherently unordered).
 *
 * Doing this using an order key is much more multi-transaction friendly and cheaper
 * than just using item numbers.
 *
 * Some trouble is taken to keep the keys short, but if you repeatedly insert
 * in one interval (for example at the top or bottom), the keys will grow by
 * a character for every few inserts.
 * 
 * A periodic renumber (using initial()) can be used to recover from this.
 *
 * Example of the user inserting definitions for the word 'cat' in specific orders:
 *
 * 0.5  : 'a strong tackle used to hoist an anchor to the cathead of a ship'
 * 0.2  : 'a carnivorous mammal (Felis catus) long domesticated as a pet...'
 * 0.3  : 'a player or devotee of jazz'
 * 0.25 : 'any of a family (Felidae) of carnivorous usually solitary and nocturnal...'
 *
 * With the final sort order being:
 *
 * 0.2  : 'a carnivorous mammal (Felis catus) long domesticated as a pet...'
 * 0.25 : 'any of a family (Felidae) of carnivorous usually solitary and nocturnal...'
 * 0.3  : 'a player or devotee of jazz'
 * 0.5  : 'a strong tackle used to hoist an anchor to the cathead of a ship'
 */
import Big from './big.mjs';

/**
 * Collator used to compare order keys.
 */
export const orderKeyCollator = Intl.Collator('en');

/**
 * Compare two order keys.
 *
 * Supports null/undefined order keys with null/undefined sorting last.
 */
export function compareOrderKeys(a: string|undefined|null, b: string|undefined|null): number {
    if(a == undefined) return 1;
    if(b == undefined) return -1;
    return orderKeyCollator.compare(a, b);
}

export const new_range_start_key = new Big('0.5');
export const begin_key = new Big('0.1');
export const end_key = new Big('0.9');

export const new_range_start_string = new_range_start_key.toString();
export const begin_string = begin_key.toString();
export const end_string = end_key.toString();

/**
 *
 * TODO: make this more sophisticated (initial spread could be more compact)
 */
export function initial(size: number): string[] {
    const digits = size.toString().length;
    const keys: string[] = [];
    for(let i=0; i<size; i++)
        keys.push(new Big('0.5'+i.toString().padStart(digits, '0')).toString());
    return keys;
}

/**
 *
 *
 */
export function between(a_key?: string, b_key?: string): string {

    if(a_key === undefined && b_key === undefined)
        return new_range_start_string;
    
    if(a_key === undefined)
        a_key = begin_string;
    if(b_key === undefined)
        b_key = end_string;
    
    Big.strict = true;
    const a:any = new Big(a_key);
    const b:any = new Big(b_key);

    // --- Expect both order keys to be positive numbers between 0.1 and 0.9 (inclusive)
    if(a.lt(begin_key) || a.s !== 1 || a.e !== -1)
        throw new Error(`internal error: order key in incorrect form: ${a}`);
    if(b.gt(end_key) || b.s !== 1 || b.e !== -1)
        throw new Error(`internal error: order key in incorrect form: ${b}`);
    if(a.gte(b))
        throw new Error(`internal error: lower order key >= bigger order key: ${a} >= ${b}`);

    // --- Calculate mid point between two order keys.  (We use times(0.5) rather
    //     than div(2) to avoid the auto rounding done by div).
    const mid = a.plus(b.minus(a).times(new Big('0.5')));
    if(mid.s !== 1 || mid.e !== -1 || !(mid.gt(a) && mid.lt(b)))
        throw new Error(`internal error: unexpected result of mid key calc: ${mid} ${a} ${b}`);
      
    // --- Play with rounding to find some more points near the middle that
    //     might have fewer digits.
    const candidates = [mid,
                        mid.round(mid.c.length-1, Big.roundDown),
                        mid.round(mid.c.length-1, Big.roundHalfUp),
                        mid.round(mid.c.length-1, Big.roundHalfEven),
                        mid.round(mid.c.length-1, Big.roundUp)]
                           .filter(m=>m.gt(a) && m.lt(b));

    // --- Filter to candidates with fewest digits
    const fewestDigits = Math.min(...candidates.map(m=>m.c.length));
    const candidatesWithFewestDigits = candidates.filter(m=>m.c.length===fewestDigits);

    // --- Pick fewest-digits candidate closest to actual middle.
    return candidatesWithFewestDigits.toSorted(
        (x:any, y:any)=>mid.minus(x).abs().cmp(mid.minus(y).abs()))[0].toString();
}

function many_splits_play(count:number): string {
    let a = '0.1';
    let b = '0.2';
    for(let i=0; i<count; i++) {
        a = between(a,b);
        //console.info(i, a.length, a);
    }
    return a;
}

function prepend_play() {
    let v = '0.2';
    for(let i=0; i<100; i++) {
        v = between('0.1',v);
        console.info(i, v.length, v);
    }
}

function main() {
    let a:any = new Big(0.456);
    let b:any = new Big(0.4578);
    console.info(a, b);
    console.info(a.plus(b.minus(a).div(2)));
    console.info(a.plus(b.minus(a).times(0.5)));

    console.info(between(a.toString(),b.toString()));

    console.time('many_splits_play');
    console.info(many_splits_play(1001));
    console.timeEnd('many_splits_play');
    prepend_play();

    console.info('initial(1)', initial(1).join(','));
    console.info('initial(10)', initial(10).join(','));
    console.info('initial(1000)', initial(1000).join(','));
}

if (import.meta.main)
    main();
