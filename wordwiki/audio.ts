// deno-lint-ignore-file no-unused-vars
//import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as content from "../liminal/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../liminal/strings.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, ScannedPage, ScannedPageOpt} from './scanned-document.ts';
import * as config from "./config.ts";
import * as server from '../liminal/http-server.ts';
import {route, authenticated} from '../liminal/security.ts';
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
export function renderAudio(recording: string|null|undefined, label: string, hoverText: string|undefined=undefined, rootPath: string=''): any {
    // A missing recording must never break the page: render a calm marker
    // instead.  (The publisher separately reports these as WARNINGS - it is
    // the final validation pass - see Publish.warnMissingRecordings.)
    if(recording == null || recording === '')
        return ['i', {class: 'text-muted'}, label, ' (recording missing)'];
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
            // Degrade, don't break the page: a raw Error object is not valid
            // markup (it used to kill the whole page render).
            return ['i', {class: 'text-muted'},
                    label, ' (recording unavailable: ',
                    String((ex as Error)?.message ?? ex), ')'];
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
    // The delivery chain: source (as-given, archival) -> trimmed (full-fidelity
    // WAV with leading/trailing silence + edge clicks removed) -> mp3 (lossy).
    // Each hop is its own content-addressed derived artifact, so the trim is
    // preserved at full fidelity independently of the mp3 encoder, and changing
    // the trim params (which ride in the closure) yields a NEW artifact instead
    // of a stale cache hit.  The mp3 derives from the TRIMMED wav, not the source.
    const trimmedPath = await getTrimmedRecordingPath(audioPath);
    return 'derived/'+
        await content.getDerived(`derived/compressed-audio`,
                                 {compressAudioCmd},
                                 ['compressAudioCmd', trimmedPath], 'mp3');
}

// --- Silence/click trimming (derived store #1) ------------------------------

/**
 * Trim parameters.  These ride INSIDE the getDerived closure (see
 * getTrimmedRecordingPath), so they are part of the content hash: change a
 * value and you get a brand-new trimmed artifact rather than a stale cache hit,
 * and every prior variant stays on disk under its own hash (nothing is lost -
 * archival-safe, and you can A/B settings).  Tuned against the hand-trimmed
 * corpus by wordwiki/audio-trim-audit.ts (an already-tight clip should lose ~0).
 */
export interface TrimParams {
    threshold: string;     // SoX silence threshold, fraction of full scale, e.g. '0.3%'
    minDuration: number;   // seconds of sound above threshold that count as onset (ignores brief clicks)
    fade: number;          // seconds of linear edge fade to kill the start/end click (0 = none)
}

export const RECORDING_TRIM_PARAMS: TrimParams = {
    threshold: '0.1%',
    minDuration: 0.1,
    fade: 0.01,
};

/**
 * The SoX argument vector for the silence trim: strip leading silence, then
 * trailing silence via the reverse/reverse sandwich.  This is the ONLY
 * length-changing part of the transform, so the audit (audio-trim-audit.ts)
 * uses exactly these args to measure how much each clip loses.  The edge fade is
 * a SEPARATE pass (see trimAudioCmd): `fade` cannot compute a fade-out length
 * when it sits downstream of `silence` in a single chain.
 */
export function soxTrimArgs(sourceAudioPath: string, targetAudioPath: string, params: TrimParams): string[] {
    const dur = String(params.minDuration), thr = params.threshold;
    return [
        sourceAudioPath, targetAudioPath,
        'silence', '1', dur, thr,
        'reverse', 'silence', '1', dur, thr, 'reverse',
    ];
}

/**
 * Derived-store command: produce the trimmed WAV from the source WAV.  Pass 1 is
 * the silence trim; pass 2 (when fade > 0) ramps the edges to kill the start/end
 * click - run separately because the fade-out length is unknown downstream of
 * `silence`.  SAFETY: never lose audio - if SoX fails or yields an empty
 * (header-only) file (e.g. a pathological all-silence input), fall back to
 * copying the source verbatim, so the trimmed artifact is at worst the original.
 */
async function trimAudioCmd(targetAudioPath: string, sourceAudioPath: string, params: TrimParams) {
    if(!await fileExists(sourceAudioPath))
        throw new Error(`expected source audio '${sourceAudioPath}' to exist`);

    const fade = !!(params.fade && params.fade > 0);
    const trimTarget = fade ? targetAudioPath + '.pre-fade.wav' : targetAudioPath;

    let { code, stderr } = await new Deno.Command(
        config.soxPath, { args: soxTrimArgs(sourceAudioPath, trimTarget, params) }).output();
    let ok = code === 0;
    if(ok) { try { ok = (await Deno.stat(trimTarget)).size > 44; } catch { ok = false; } }

    if(ok && fade) {
        const r = await new Deno.Command(config.soxPath, {
            args: [trimTarget, targetAudioPath, 'fade', 't', String(params.fade), '0', String(params.fade)],
        }).output();
        code = r.code; stderr = r.stderr;
        ok = code === 0;
        if(ok) { try { ok = (await Deno.stat(targetAudioPath)).size > 44; } catch { ok = false; } }
        try { await Deno.remove(trimTarget); } catch { /* ignore */ }
    }

    if(!ok) {
        console.warn(`audio trim fell back to the source for ${sourceAudioPath} ` +
                     `(sox code ${code}): ${new TextDecoder().decode(stderr)}`);
        await Deno.copyFile(sourceAudioPath, targetAudioPath);
    }
}

/**
 * The trimmed (full-fidelity) WAV for a source recording - derived store #1.
 * On-demand and content-addressed; the params are part of the hash.
 */
export async function getTrimmedRecordingPath(audioPath: string,
                                              params: TrimParams = RECORDING_TRIM_PARAMS): Promise<string> {
    return 'derived/'+
        await content.getDerived(`derived/trimmed-audio`,
                                 {trimAudioCmd},
                                 ['trimAudioCmd', audioPath, params], 'wav');
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

/**
 * The audio URL routes, namespaced under `wordwiki.audio` so the strict route
 * interpreter's member @route gate covers them (they used to be bare top-level
 * scope functions, which routeterp does NOT gate - see render-page-editor.ts
 * PageRoutes for the full rationale).  Thin delegators to the module functions.
 *
 *  - uploadRecording is `authenticated` + mutates (POST-only): any logged-in
 *    contributor records audio while editing a lexeme; it writes to the
 *    content store, so it is a mutation.
 *  - forwardToCompressedRecording is `authenticated` view (a 302 to the
 *    compressed file); currently unreferenced but kept reachable-and-gated.
 */
export class AudioRoutes {
    @route(authenticated, {mutates: true}) uploadRecording(...a: Parameters<typeof uploadRecording>) { return uploadRecording(...a); }
    @route(authenticated) forwardToCompressedRecording(...a: Parameters<typeof forwardToCompressedRecording>) { return forwardToCompressedRecording(...a); }
}
