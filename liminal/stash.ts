/**
 *
 *
 *
 */
import newId from './nanoid.ts';

/**
 * 
 */
export class Stash {

    /**
     *
     * For each stashed value, we generate a unique 20 character ...
     *
     * Each stashed value is serialized thusly:
     * `[${partitionId},${itemPassword},${JSON.stringify(value)}],\n`
     * Note that JSON.stringify emits no newlines - so each stashed line will be a
     * single line in the file.
     *
     * 
     */
    stash(partitionId: string, value: any): string {
    }
    
    /**
     *
     */
    get(partitionId: string, key: string): string|undefined {
    }
}
