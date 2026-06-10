/**
 * Utilities for working with session tokens and salted passwords.
 *
 */
import { hash as bcrypt_hash } from "jsr:@blackberry/bcrypt@0.17.0";

export function generateSalt(): string {
    // Create a buffer of exactly 12 bytes (will be 16 bytes when base64 encoded)
    const buffer = new Uint8Array(12);
    crypto.getRandomValues(buffer);
    
    // Convert to base64 (the result will be 16 characters long)
    const salt = btoa(String.fromCharCode(...buffer));
    
    return salt;
}

export function hashPassword(password: string, salt: string): string {
    const textEncoder = new TextEncoder();
    return bcrypt_hash(textEncoder.encode(password), textEncoder.encode(salt));
}

/**
 * Generate a 32 byte base64 encoded session token.
 *
 * Note: base64 text can be used as a cookie value without further encoding.
 */
export function generateSessionToken(): string {
    // Create 24 byte random number (will be 32 bytes when base64 encoded)
    const buffer = new Uint8Array(24);
    crypto.getRandomValues(buffer);
    return btoa(String.fromCharCode(...buffer));
}

/**
 * Generate a URL-SAFE random token (base64url, no padding) - for tokens that
 * travel in URLs, e.g. password-reset links.  (generateSessionToken's plain
 * base64 contains '+'/'/' which do not survive a URL unescaped.)
 */
export function generateUrlToken(): string {
    const buffer = new Uint8Array(24);
    crypto.getRandomValues(buffer);
    return btoa(String.fromCharCode(...buffer))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * SHA-256 of a token, hex encoded - for storing single-use tokens AT REST:
 * the db row holds only the hash, so a leaked db cannot be used to redeem
 * outstanding tokens.  (A plain fast hash is right here - unlike passwords,
 * these tokens are full-entropy random strings, so brute force is hopeless.)
 */
export async function sha256Hex(s: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string equality - for comparing secrets (password hashes,
 * tokens) without leaking the position of the first mismatch through timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
    const ea = new TextEncoder().encode(a);
    const eb = new TextEncoder().encode(b);
    if (ea.length !== eb.length) return false;
    let diff = 0;
    for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
    return diff === 0;
}
