/**
 * This is an inlining of the portions of the Deno port of nanoid
 * that we are using.
 * 
 * nanoid is a UUID alternative that with the right alphabet is:
 * - more compact than UUID's
 * - URL safe without encoding.
 * - can be used as an identifier without encoding.
 * 
 * Original is here: https://github.com/ianfabs/nanoid
 */

/**
 * Low-level function to change alphabet and ID size.
 *
 * Alphabet must contain 256 symbols or less. Otherwise, the generator
 * will not be secure.
 *
 * @param {string} alphabet The alphabet that will be used to generate IDs.
 * @param {number} size The size(length) of the IDs that will be genereated.
 *
 * @returns A unique ID based on the alphabet provided.
 *
 * @example
 * import { customAlphabet } from "https://deno.land/x/nanoid/customAlphabet.ts";
 * 
 * const alphabet = '0123456789абвгдеё';
 * const nanoid = customAlphabet(alphabet, 5);
 * 
 * console.log(nanoid()); // => "8ё56а"
 *
 */
export const customAlphabet = (alphabet: string, size: number) => customRandom(random, alphabet, size);

export type CustomRandomGenerator = (size: number) => Uint8Array | Uint16Array | Uint32Array;

export const customRandom = (random: CustomRandomGenerator, alphabet: string, size: number) => {
    const mask = (2 << (Math.log(alphabet.length - 1) / Math.LN2)) - 1;
    const step = -~(1.6 * mask * size / alphabet.length);

    return (): string => {
        let id = "";
        while (true) {
            const bytes = random(step);
            let i = step;
            while (i--) {
                // Adding `|| ''` refuses a random byte that exceeds the alphabet size.
                id += alphabet[bytes[i] & mask] || '';
                if (id.length === +size) return id;
            }
        }
    };
}

/**
 * @param bytes The desired length of the Uint8Array to be created.
 */
export type RandomValueFunction = (bytes: number) => Uint8Array;

export const random: RandomValueFunction = bytes => crypto.getRandomValues(new Uint8Array(bytes));

/**
 *
 * https://zelark.github.io/nano-id-cc/
 *
 * Using this 52 char alphabet and a length of 20,
 *
 * At 1000 IDs per hour: ~2 billion years or 20,494T IDs needed, in
 * order to have a 1% probability of at least one collision.
 */
export const newId: ()=>string =
    customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 20);
