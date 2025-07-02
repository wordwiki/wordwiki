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
