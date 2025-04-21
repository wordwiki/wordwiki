// deno-lint-ignore-file no-unused-vars
//import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import {unwrap} from "../server/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../server/db.ts";
import * as content from "../server/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../server/strings.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, ScannedPage, ScannedPageOpt} from './schema.ts';
import * as config from "./config.ts";
import * as server from '../server/http-server.ts';
import {
    encodeBase64,
    decodeBase64,
} from "https://deno.land/std@0.224.0/encoding/base64.ts";

export async function uploadRecording(args: {recordingBytesAsBase64: string}): Promise<{audioPath: string}> {
    const recordingBytesAsBase64 = args.recordingBytesAsBase64;
    if(typeof recordingBytesAsBase64 !== 'string')
        throw new Error('missing/malformed recordingBytesAsBase64 in uploadRecording RPC');
    if(recordingBytesAsBase64.length === 0)
        throw new Error('recording bytes is empty in uploadRecording RPC');
    const recordingBytes = decodeBase64(recordingBytesAsBase64);

    // TODO: more work on this verififcation (+ we want to switch to a
    //       lossless compressed format anyway - so do later)
    //       (+ we will spat on the encode step anyway).
    //       (+ we want to enforce audio settings - which will require more fancy)
    if(recordingBytes[0] !== 'R'.charCodeAt(0) ||
        recordingBytes[1] !== 'I'.charCodeAt(0) ||
        recordingBytes[2] !== 'F'.charCodeAt(0) ||
        recordingBytes[3] !== 'F'.charCodeAt(0))
        throw new Error('expected uploaded recording to be a .wav file');
    
    // Write the audio to disk
    // TODO having embedded content/Recordings here is BAD
    const audio_ref = 'content/'+
        await content.addFileAsData('content/Recordings', recordingBytes, 'wav');

    console.info('new audio_ref is', audio_ref);
    
    return {audioPath: audio_ref};
}

/**
 * Given a source audio path, creates the compressed version if it does not
 * yet exist, then does a 302 redirect to the compressed version.
 */
 export async function forwardToCompressedRecording(srcRecordingPath: string): Promise<server.Response> {
    const compressedAudioPath = await getCompressedRecordingPath(srcRecordingPath);  // REMOVE_FOR_WEB
    console.info('compressedAudioPath', compressedAudioPath);
    return server.forwardResponse('/'+compressedAudioPath);
}


/**
 *
 */
export function renderAudio(recording: string, label: string, hoverText: string|undefined=undefined, rootPath: string=''): any {
    return (async ()=>{
        //console.info('in render audio', recording, label);
        try {
            let audioUrl = '';
            audioUrl = await getCompressedRecordingPath(recording);  // REMOVE_FOR_WEB
            audioUrl = rootPath+audioUrl;
            return ['a',
                    {onclick: `event.preventDefault(); event.stopPropagation(); playAudio('${audioUrl}');`, href: audioUrl},
                    label]
        } catch(ex) {
            // DO better here TODO
            return ['b', {}, 'Failed to load recording: ', ex];
        }
    })();
}

/**
 *
 */
export async function getCompressedRecordingPath(audioPath: string): Promise<string> {
    // XXX todo add safe check of audioPath (must be relative, no .., also
    //     for this APIs peers.
    // XXX may insist in in content/ or derived/
    return 'derived/'+
        await content.getDerived(`derived/compressed-audio`,
                                 {compressAudioCmd},
                                 ['compressAudioCmd', audioPath], 'mp3');
}

/**
 * Content store function to get the size of an image.
 */
async function compressAudioCmd(targetAudioPath: string, sourceAudioPath: string) {
    if(!await fileExists(sourceAudioPath))
        throw new Error(`expected source audio '${sourceAudioPath}' to exist`);

    const { code, stdout, stderr } = await new Deno.Command(
        config.lameEncPath, {
            args: [
                '-V', '7', '-S', sourceAudioPath, targetAudioPath
            ],
        }).output();

    if(code !== 0)
        throw new Error(`failed to convert ${sourceAudioPath} to mp3: ${new TextDecoder().decode(stderr)}`);
}

/**
 * The conversion system is happy to convert audio on demand - but this
 * means that a user is waiting for lame to run while rendering a page.
 *
 * It is nice to periodically prewarm the cache to reduce these pauses (and
 * this potentially unplanned load, for example if we get crawled by a crawler
 * that is downloading audio).
 */
// async function preConvertAllCurrentDictionaryAudio() {
//     const wordRecordings = schema.selectCurrentAssertionsByType('dict').
//         all('rec');
// }
/**
 *
 */
async function preCompressDictionaryAudio() {


}

export const routes = ()=> ({
    uploadRecording,
    forwardToCompressedRecording,
});
