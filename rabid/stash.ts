/**
 * stash.ts
 *
 * 
 */




export class Stash {
    currentStashFile: Deno.FsFile;
    currentStashFileSize: number;

    constructor(public stashDirPath: string) {
        
    }
    
    /**
     * 
     */
    async stash(data: Uint8Array): string {
        throw new Error('not implemented yet');
    }

    async get(stash_key: string): Uint8Array {
        throw new Error('not implenteed yet');
    }    
}




