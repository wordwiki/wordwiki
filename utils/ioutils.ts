//let fsPromises = require ('fsPromises');  // importing 'fs/promises' the ES6 way in typescript is borked today.
//import * as fsPromises from 'fsPromises';
//const fs = require('fs');
//const fsPromises = fs.promises;

//const { resolve } = require('path');
//const { readdir } = require('fs').promises;

//import {TextEncoder} from 'text-encoding';
import * as utils from './utils.ts';

/**
 * Async sleep.
 */
export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rewrites a utf-8 encoded file if the contents have changed.
 */
export async function writeUTF8FileIfContentsChanged (filename: string, updatedUtf8Contents: string): Promise<boolean> {
  const updatedContents = new TextEncoder ().encode (updatedUtf8Contents);
  return writeFileIfContentsChanged (filename, updatedContents);
}

/**
 * Rewrites a file if the contents have changed.
 *
 * The usual reason to use this is if you don't want the file
 * timestamp changed if the contents of the file have not changed
 * (thereby triggering further downstream build processes).
 *
 * If the contents have not changed, the size will not have changed as
 * well.  So we first stat the file.  This means that the I/O costs
 * for this function are:
 *
 * - Unchanged file: stat + read
 * - Changed file with same size: stat + read + write
 * - Changed file with different size: stat + write
 */
export async function writeFileIfContentsChanged (filename: string, updatedContents: Uint8Array): Promise<boolean> {
  // --- If the file already exists, has the same size, and has the same contents, no
  //     need to rewrite (which also means that timestamp will not be updated - the
  //     main point behind using this).
  // --- Most of the time, changes also change the file size, so the size
  //     check means we will avoid the extra read most of the time.
  let stat = null;
  try {
    stat = await Deno.stat (filename);
  } catch (e) {
    // If we can't stat the file - we want to go ahead with the
    // write semantics (and write error messages) - so we ignore this
    // error.
  }
  if (stat != null) {
    if (stat.size == updatedContents.length) {
      const currentContents = await Deno.readFile (filename);
      if (utils.isEqualsUint8Array (currentContents, updatedContents))
        return false;
    }
  }

  // --- Write the faile
  await Deno.writeFile (filename, updatedContents);

  return true;
}
