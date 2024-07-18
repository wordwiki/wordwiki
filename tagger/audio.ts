// deno-lint-ignore-file no-unused-vars
//import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

//import * as utils from "../utils/utils.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import * as content from "../utils/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../utils/strings.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, ScannedPage, ScannedPageOpt} from './schema.ts';
import * as config from "./config.ts";
import {getImageSize} from "./get-image-size.ts";
import * as server from '../utils/http-server.ts';


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
export function renderAudio(recording: string, label: string): any {
    return (async ()=>{
        try {
            let audioUrl = '';
            audioUrl = await getCompressedRecordingPath(recording);  // REMOVE_FOR_WEB
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
        throw new Error(`expected source audio ${sourceAudioPath} to exist`);

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
    forwardToCompressedRecording,
});
