/**
 *
 *
 *
 */
// 3ba8d02b16fd2a01c1a8ba1a1f036d7ce386ed953696fa57331c2ac48a80b255
// 64 byte hex string
// Sample content id:
// pdm/3b/3ba8d02b16fd2a01c1a8ba1a1f036d7ce386ed953696fa57331c2ac48a80b255.jpg
// - pdm is the content store.
// - 3b is the first octet of the sha - is a bit lousy that is is repeated,
//   but makes these directly usable paths.
// - .jpg is the file type.   This is sometimes redundant (we know though other
//   means the type of an id) - but having it here allows for the file
//   to be directly served by a web server etc.

import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";
import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";
import { writeAll } from "https://deno.land/std@0.195.0/streams/write_all.ts";

/**
 * Parsed form of a contentId.
 *
 * Use formatContentId()/parseContentId() to convert to/from the string representation.
 */
export interface ContentId {
    contentStore: string;
    hash: string;
    extension: string|undefined;
}

/**
 * Add a file to a content store.
 *
 */
export async function addFile(contentStorePath: string,
                              srcFilePath: string): Promise<string> {
    
    // --- Extract optional extension from srcFilePath
    const extension = posix.extname(srcFilePath).replace(/^\./, '') || undefined;
    
    // --- Extract content store parent and name from contentStorePath
    const contentStoreParent = posix.dirname(contentStorePath);
    const contentStore = posix.basename(contentStorePath);

    // --- Compute hash of src file
    const hash = await digestFileUsingExternalCmd(srcFilePath);

    // --- Compute content id and path
    const parsedContentId = { contentStore, hash, extension };
    const contentId = formatContentId(parsedContentId);
    const contentPath = posix.join(contentStoreParent, contentId);
    
    if(await fs.exists(contentPath)) {
        // --- File is already in store, confirm file size as a sanity check.
        const storedFileStat = await Deno.stat(contentPath);
        const newFileStat = await Deno.stat(srcFilePath);
        if(storedFileStat.size !== newFileStat.size)
            throw new Error(`internal error: ${srcFilePath} is already interned in content store ${contentStorePath} - as ${contentPath} but has a different size`);
        //console.info('confirmed that existing content', srcFilePath, 'stored as', contentPath, 'is correct');
    } else {
        // --- Make content parent dir if it does not exist
        await fs.ensureDir(posix.dirname(contentPath));
        
        // --- Add file to content store (using copy, then move to make atomic)
        const tmpTargetName = contentPath+'.~';
        if(await fs.exists(tmpTargetName)) {
            await Deno.remove(tmpTargetName);
            if(await fs.exists(tmpTargetName))
                throw new Error(`failed to erase existing tmp target name ${tmpTargetName}`);
        }
        await fs.copy(srcFilePath, tmpTargetName, {overwrite: true}); //, preserveTimestamps: true});
        await fs.move(tmpTargetName, contentPath);
        console.info('added content', srcFilePath, 'as', contentPath);
    }

    
    return Promise.resolve(contentId);
}

function contentStorePlay() {
    //addFile('dogs', 'content.ts');
}

contentStorePlay();

/**
 *
 */
export async function getDerived(contentStorePath: string,
                          fns: {[fnName: string]: Function},
                          closure: any[],
                          extension: string):Promise<string> {

    // --- Extract content store parent and name from contentStorePath
    const contentStoreParent = posix.dirname(contentStorePath);
    const contentStore = posix.basename(contentStorePath);

    // --- Serialize closure to JSON and compute hash
    const closureJson = JSON.stringify(closure, undefined, '  ');
    const hash = await digestString(closureJson);

    // --- Compute filename for closure output
    const outputContentId = formatContentId({contentStore, hash, extension});
    const outputContentPath = posix.join(contentStoreParent, outputContentId);
    
    if(!await fs.exists(outputContentPath)) {

        // --- Lookup function for closure
        const fnName = closure[0]??'';
        if(!(typeof fnName === 'string' || !fnName))
           throw new Error('closure passed to getDerived is missing function name');
        const fn = fns[fnName];
        if(!fn)
            throw new Error('unable to find function ${fnName} for closure in getDerived');

        // TODO: allow returning a temp filename, which will then get moved into
        //       place.
        // Might be nice if could also recieve a tmp filename (based on content) -
        //  seems a nicer protocol.

        // --- Make content parent dir if it does not exist
        await fs.ensureDir(posix.dirname(outputContentPath));

        // --- Make a tmp target name in the same dir for atomic update
        const tmpTargetName = outputContentPath.replace('.'+extension, '_tmp.'+extension);
        if(await fs.exists(tmpTargetName)) {
            await Deno.remove(tmpTargetName, { recursive: true });
            if(await fs.exists(tmpTargetName))
                throw new Error(`failed to erase existing tmp target name ${tmpTargetName}`);
        }
        
        // --- Run closure functin with args
        const rawOutput = await Promise.resolve(fn.apply(null, [tmpTargetName, ...closure.slice(1)]));
        
        // --- If closure did not write to tmp output file directly, it can return
        //     output as a string or Uint8Array and we will write it.
        if(!await fs.exists(tmpTargetName)) {
            let output: Uint8Array;
            switch(true) {
                case rawOutput instanceof Uint8Array:
                    output = rawOutput;
                    break;
                case typeof rawOutput === 'string':
                    output = new TextEncoder().encode(rawOutput);
                    break;
                default:
                    throw new Error(`Unexpected output from fn ${fnName}`);
            }
        
            // --- Add file to content store (using move to make atomic)
            const file = await Deno.open(tmpTargetName, {write: true, create: true});
            try {
                await writeAll(file, output);
            } finally {
                file.close();
            }
        }

        // --- Use a move to install the output
        await fs.move(tmpTargetName, outputContentPath);
    }
    
    return Promise.resolve(outputContentId);
}

// /**
//  *
//  */
// export function getDerivedPath(contentStorePath: string,
//                                fns: {[fnName: string]: Function},
//                                closure: any[],
//                                extension: string):string {

//     // --- Extract content store parent and name from contentStorePath
//     const contentStoreParent = posix.dirname(contentStorePath);
//     const contentStore = posix.basename(contentStorePath);

//     // --- Serialize closure to JSON and compute hash
//     const closureJson = JSON.stringify(closure, undefined, '  ');
//     const hash = await digestString(closureJson);

//     // --- Compute filename for closure output
//     const outputContentId = formatContentId({contentStore, hash, extension});
//     const outputContentPath = posix.join(contentStoreParent, outputContentId);

//     return outputContentId;
// }

async function addAsync(target: string, a: number, b: number): Promise<String> {
    return String(a+b);
}

async function getDerivedPlay() {
    const fns = {
        //add: (a: number, b:number) => (a+b).toString(),
        add: addAsync, //(a: number, b:number) => (a+b).toString(),
    };
    const key = await getDerived('derived', fns, ['add', 2, 2], 'txt');
    console.info('KEY', key);
    
}


/**
 * Parse a contentId path into its constituent parts.
 */
export function parseContentId(contentId: string): ContentId {
    const segments = /^([a-zA-Z0-9_-]+)\/([0-9a-f][0-9a-f][0-9a-f])\/([0-9a-f]+)(?:[.]([a-zA-Z0-9_]+))?$/.exec(contentId);
    if(!segments)
        throw new Error(`malformed content id '${contentId}'`);
    const [, contentStore, hashPrefix, hash, extension] = segments;
    if(hash.length !== 64)
        throw new Error(`malformed content id '${contentId}' - hash is incorrect length`);
    if(!hash.startsWith(hashPrefix))
        throw new Error(`malformed content id '${contentId}' - hash does not start with hash prefix`);
    return { contentStore, hash, extension };
}

/**
 * Verifys that a content id path is well formed.
 *
 * Throws an exception if it is not.
 */
export function verifyContentId(contentId: string) {
    parseContentId(contentId);
}

/**
 * Formats the constituent parts of a content id into a textual content id path.
 */
export function formatContentId({contentStore, hash, extension}: ContentId): string {
    const contentId = `${contentStore}/${hash.slice(0,3)}/${hash}${extension?'.'+extension:''}`;
    verifyContentId(contentId);
    return contentId;
}


// function contentIdPlay() {
//     console.info(parseContentId('pdm/3ba/3ba8d02b16fd2a01c1a8ba1a1f036d7ce386ed953696fa57331c2ac48a80b255.jpg'));
//     console.info(parseContentId('pdm/3ba/3ba8d02b16fd2a01c1a8ba1a1f036d7ce386ed953696fa57331c2ac48a80b255'));
// }

//contentIdPlay();















/**
 * Computes the sha256 of the supplied string.
 */
async function digestString(message:string): Promise<string> {
    return arrayBufferToHexString(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(message)));
}

/**
 * Renders an ArrayBuffer as a hex string.
 *
 * Note: This implementation is *very* inefficient - but is fine for
 * rendering short strings like hashes.
 */
function arrayBufferToHexString(hashArray: ArrayBuffer): string {
    return Array.from(new Uint8Array(hashArray))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Compute the sha256 of a file using the linux 'sha256sum' command.
 *
 * We have some huge files to sha256 (one source document is 40Gb of
 * files) - so maybe this was worth doing rather than reading into
 * Deno?
 *
 * The reason doing this is useful (rather than reading the file into
 * Deno, then using crypto.subtle.digest) is that this is streaming,
 * so we can sha256 files larger than will fit in memory.
 *
 * Also for our shared hosting version, we don't want to load (potentially)
 * large files into one of the per-user service workers - not sure how good v8 is
 * at returning that whack of memory back to the OS - maybe we just permanently
 * bloat that service worker?
 */
export async function digestFileUsingExternalCmd(path:string): Promise<string> {
    const executable = "sha256sum";
    const args = ["-b", path];
    const command = new Deno.Command(executable, {args});
    const { code, stdout, stderr } = await command.output();

    if(code !== 0)
        throw new Error(`attempt to digest '${path}' using '${executable} ${args.join(' ')}' failed with code ${code} - stderr is: '${new TextDecoder().decode(stderr)}'`);

    const output = new TextDecoder().decode(stdout);
    const sha256 = /^([0-9a-f]+) /.exec(output)?.[1];
    if(!sha256)
        throw new Error(`Failed to parse sha256 out of '${executable} ${args.join(' ')}' output - got output '${output}'`);

    return sha256;
}


// 10,000 files per folder seems to be fine, so with one byte prefix pulled out,
// have 2M files.  Can specify prefix length.
// 3ba8d02b16fd2a01c1a8ba1a1f036d7ce386ed953696fa57331c2ac48a80b255
// recordings/3b/3ba8d02b16fd2a01c1a8ba1a1f036d7ce386ed953696fa57331c2ac48a80b255.wav

// - Note that this version uses the sha256 from the source material.  The transform that
//   is applied is in the name of the store.
// - Note that with the scheme as currently proposed, we will end up with each artifact
//   having its own dir.  We can later do multi-format schemes where we promote as we fill.
// - 
// recordings-as-mp3s/3b/3ba8d02b16fd2a01c1a8ba1a1f036d7ce386ed953696fa57331c2ac48a80b255.mp3

// 1,000 pages * 100 boxes per page = 1 million images from PDM.
// (4000 images per dir).
// ON sample page: approx 50 lines, assuming 2 boxes per line = 100 boxes per page.






// console.info(await digestString('seven'));
// //digestMessage(text).then((digestHex) => console.log(digestHex));

// let s = 'ed1f9948187f9e9c375e55321935ff9423d7606b3ad483994f63b0bc83aeaad6 *content.ts';
// console.info('pow', );



//console.info('DDD', await digestFileUsingExternalCmd("content.ts"));

