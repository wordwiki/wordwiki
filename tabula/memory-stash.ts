/**
 * A in-memory store for values associated with a user session.
 *
 * - When a never before seen value is inserted in a stash, a 52 char randomly generated alphabetic nanoId is returned.
 * - If the same value is subsequently inserted, the same id is returned.
 * - The value can be looked up by this id.
 * - The last access (or insertion) time of values is tracked, the purgeOlderThan()
 *   can be called to purge all values older than the supplied time.
 * - Maybe: Rate limiting can be configured (keys/sec + keys/min) to make it harder to use this
 *   to DOS a server by using all memory.
 *
 * It is encouraged to use a separate stash instance per user session - so we can drop
 * and entire user stash on logout and so that 'session token
 * stealing' style attacks can't work.
 */
import newId from './nanoid.ts';

export class Stash {
    contents_by_key: Map<string, any>;
    keys_by_contents: Map<any, string>;
    lastAccessTime: Map<string, number>;

    constructor() {
        this.contents_by_key = new Map();
        this.keys_by_contents = new Map();
        this.lastAccessTime = new Map();
    }

    insert(value: any): string {
        // --- If this value has already been inserted, return same key, but update last access time.
        const existingKey = this.keys_by_contents.get(value);
        if (existingKey) {
            this.lastAccessTime.set(existingKey, Date.now());
            return existingKey;
        }

        // --- If this is a new value, allocate a new key, and insert into contents_by_key and keys_by_contents
        const newKey = newId();
        const now = Date.now();
        
        this.contents_by_key.set(newKey, value);
        this.keys_by_contents.set(value, newKey);
        this.lastAccessTime.set(newKey, now);
        
        return newKey;
    }


    get(key: string): any|undefined {
        // --- If key is present, return value and update last access time.
        const value = this.contents_by_key.get(key);
        if (value !== undefined) {
            this.lastAccessTime.set(key, Date.now());
        }
        return value;
    }

    purge(olderThan: number) {
        const keysToDelete: string[] = [];
        
        // Find keys that are older than the threshold
        for (const [key, lastAccess] of this.lastAccessTime.entries()) {
            if (lastAccess < olderThan) {
                keysToDelete.push(key);
            }
        }
        
        // Remove entries from all maps
        for (const key of keysToDelete) {
            const value = this.contents_by_key.get(key);
            if (value !== undefined) {
                this.contents_by_key.delete(key);
                this.keys_by_contents.delete(value);
                this.lastAccessTime.delete(key);
            }
        }
    }
}
