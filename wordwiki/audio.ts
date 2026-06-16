// deno-lint-ignore-file no-unused-vars
//import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as content from "../liminal/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../liminal/strings.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, ScannedPage, ScannedPageOpt} from './scanned-document.ts';
import * as config from "./config.ts";
import * as templates from './templates.ts';
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
export function renderAudio(recording: string|null|undefined, label: string, hoverText: string|undefined=undefined, rootPath: string='', className: string|undefined=undefined): any {
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
                    {onclick: `event.preventDefault(); event.stopPropagation(); playAudio('${audioUrl}');`,
                     href: audioUrl,
                     ...(className ? {class: className} : {}),
                     ...(hoverText ? {title: hoverText} : {})},
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

    // THROWAWAY (delete with renderTrimTuningPage + TRIM_TUNING_CLIPS once the
    // language staff have chosen a trim threshold): /ww/wordwiki.audio.trimTuningPage()
    @route(authenticated) trimTuningPage() { return renderTrimTuningPage(); }
}

// ===========================================================================
// THROWAWAY: audio-trim threshold listening test.  A one-off decision fixture
// so a fluent speaker can pick the most aggressive trim threshold that does not
// cut the spoken word.  Two sections: the words MOST affected by an aggressive
// trim (worst cases), and a RANDOM sample (typical case).  Clip lists + their
// headwords are looked up once and hard-coded; each variant is generated on
// demand via the normal derived store (getTrimmedRecordingPath) and cached.
//
// HOW TO REBUILD / make a variant (new words, thresholds, etc.): see the recipe
// in wordwiki/audio-trim-tuning.md.  DELETE this whole block + the trimTuningPage
// route on AudioRoutes once the language staff settle the threshold.
// ===========================================================================
// The candidate thresholds to A/B, plus the fixed rest of the trim params.
// To compare a DIFFERENT axis (e.g. minDuration), change these / the cell loop.
const TRIM_TUNING_THRESHOLDS = ['0.03%', '0.05%', '0.1%', '0.2%', '0.3%'];
const TRIM_TUNING_MIN_DURATION = 0.1;
const TRIM_TUNING_FADE = 0.01;

interface TuningClip { word: string; entryId: number; src: string; }
interface TuningSection { heading: string; blurb: string; clips: TuningClip[]; }

// Each section is its own table.  Regenerate the clip lists with the recipe in
// wordwiki/audio-trim-tuning.md (run audio-trim-audit.ts, resolve headwords via
// the documented SQL, paste here).
const TRIM_TUNING_SECTIONS: TuningSection[] = [
    {
        heading: 'Most affected words',
        blurb: 'The recordings the trimmer changes the MOST — the worst cases, where an ' +
               'aggressive threshold cuts a loud word onset (largest removed-region peak at 0.3%). ' +
               'Listen for a clipped start or end.',
        clips: [
            { word: "pgesign",         entryId: 110794, src: "content/Recordings/be7/be76a88665f953900fc643bc774b39ce84323a09bbc6ff48b188518a1938cf1a.wav" },
            { word: "ugtlu'sue'sgwul", entryId: 146566, src: "content/Recordings/844/844f5705fcf42e416517d075e2535b913bb6427e5585e60d7b7636f814f4a5ca.wav" },
            { word: "apso'qonigatat",  entryId:  11046, src: "content/Recordings/828/8286372e0c8dd3103ce16c2346f07449821d2436643661a72896c116c80ed703.wav" },
            { word: "tgupoq",          entryId: 141302, src: "content/Recordings/dac/dac203160f6499b9da6d1b66e6b777b9abf9d38835fdd9e8f4dd266da9c440ac.wav" },
            { word: "pgesign'ji'j",    entryId: 110812, src: "content/Recordings/f17/f178009f90a6cfef29bc46e2ef131768883e226ef16505c1b5c6e1e598079973.wav" },
            { word: "ugpitn",          entryId: 145227, src: "content/Recordings/487/48775f6dd52522ab1df57e17dce45b4d47b1ae9ef07490825fee4c5cd0ded688.wav" },
            { word: "pqwanm",          entryId: 117408, src: "content/Recordings/ba4/ba41082338f4e2a05e286e6308504b14d0c80eaeaabcce2f1ad79ad7e55e7020.wav" },
            { word: "toqwaqji'jit",    entryId: 143189, src: "content/Recordings/954/954436ce2de6ca78d31536d1ad7fa8ff878b9d57d6a0fc5ad2133f4b00ae18ae.wav" },
            { word: "egs'pugua'latl",  entryId:  16387, src: "content/Recordings/e78/e78cd6b6088e5b117b0700f9e8a64550743f81334dcaf396941333bb3032676a.wav" },
            { word: "pugsigna'qewit",  entryId: 118207, src: "content/Recordings/41d/41d1e372af8cf766a9e4d347aee2f8da645ffdb9c48c6ee625b61d8842a5e1c4.wav" },
            { word: "ugji'g'j",        entryId: 144627, src: "content/Recordings/b1f/b1f9c49370e5d4da90413a805a19a68f91b9b2e98e7a011be59eef5c7662c17e.wav" },
            { word: "ugju'sn",         entryId: 145048, src: "content/Recordings/645/645deaec909fbbf05a3a6a82077af26e1b694184970c390ed6e6b8e4a6cf88a6.wav" },
            { word: "tg'snugowa'j",    entryId: 141203, src: "content/Recordings/afd/afd17d87455d46096f87b902631b44335464c898cc1a846e8a50d1864cec48e1.wav" },
        ],
    },
    {
        heading: 'Random sample (typical words)',
        blurb: 'A random spread of ordinary recordings (NOT cherry-picked), to hear what the trim ' +
               'does to a typical word — usually it removes only a few ms of silence and leaves the word intact.',
        clips: [
            { word: "tewatalg", entryId: 140496, src: "content/Recordings/426/426a9ca17b318e69137b2a4789545efbd29f17dde6733782040cb43e558fa3ef.wav" },
            { word: "g'p'ta'q", entryId: 51957, src: "content/Recordings/ddd/dddad7de62c5d5999c30f7de6fe00c21a22121ce3c0ccb5c73312781b3911081.wav" },
            { word: "oqwatg", entryId: 99076, src: "content/Recordings/291/29169e88d999acf3f7e519268f7a3a5f5c94368ede3320e6f69cfe02e8a3e57f.wav" },
            { word: "amalo'qoman", entryId: 8864595002172445, src: "content/Recordings/bf5/bf59f2e22a197f8e919dcd3ba63a9b9648fe0069a002ba955b848accfb4a29c5.wav" },
            { word: "giwajo'tg", entryId: 49120, src: "content/Recordings/449/449866892f2dbbcb7bb6061d9d752249c775a6681044a6ef2cd7b30529b14de1.wav" },
            { word: "wijgwe'jua'sit", entryId: 164386, src: "content/Recordings/a50/a50b5b3f2d917ea1f4f76ab56c057fd0d26ddd4f3548d5629040809cbf5f991e.wav" },
            { word: "welpesug", entryId: 158189, src: "content/Recordings/f4c/f4c0318ff3721c5c6385e751a52ac064fd480ef125ba7b2de8bed2bb78023f06.wav" },
            { word: "pemiwisqi'pit", entryId: 106767, src: "content/Recordings/e5a/e5a0a7a47d493e6999d69391d0e3b6ec3654a8ed850dcc85c7ac5cbff5817d98.wav" },
            { word: "jinqamistaqanei", entryId: 59101, src: "content/Recordings/c29/c29d7a8f04a2f9ae412d47e2e524284b7986b5720a157c19dd0f4da5408abc15.wav" },
            { word: "sign", entryId: 127717, src: "content/Recordings/5af/5af0c54dfd94f1a804785ecacf7722694feea202af355d0987c3739ef9a707ee.wav" },
            { word: "nutuatl", entryId: 98078, src: "content/Recordings/e13/e1393cd29182c45922c86b4cf91dee0234ca8ee1dceb745dffe1ced2907b0726.wav" },
            { word: "wigumgewigu's", entryId: 163990, src: "content/Recordings/ad1/ad15339d8bd4272d59aee52d459647169b58de0b5663f330d41ae7bae4c10211.wav" },
            { word: "gsusgwate'gn", entryId: 52357, src: "content/Recordings/72a/72a5a2eadf336053610ff7c79e29cff5b9b2d1e9160e3b472ab8cf73503f1875.wav" },
            { word: "petgimatl", entryId: 110016, src: "content/Recordings/d5d/d5dd7cfa9f90ab22fae5aab43d34168df25196ea99abe4dfcb794b5312d77fb2.wav" },
            { word: "welo'tmuet", entryId: 158133, src: "content/Recordings/2cf/2cfae9b0e15ccfbfd592ab45a0548cd67c75e162c8643dc215c088e5785f2368.wav" },
            { word: "lluigneg_te'sisga'q", entryId: 61642, src: "content/Recordings/90b/90b86543ab16b31acd00b0e880e028d627d4bd1e10c926d7072f65be90e61614.wav" },
            { word: "gutapigwatg", entryId: 53247, src: "content/Recordings/b51/b51b5d98b5304793af3fc5cc7ef5c48ce17e9828355d423de1702e5d27a823ff.wav" },
            { word: "ugjipenugowa'j", entryId: 144837, src: "content/Recordings/854/85465a6bcc4222bb2e1ac9a1cc51afee31dcba198913a9eb3f3fda58e723825e.wav" },
            { word: "petteppit", entryId: 110328, src: "content/Recordings/f85/f85fcee70fd4e12ca34c0b271fafeee64bf6e75af42eca9bb68dc90688ac797d.wav" },
            { word: "tmletji'j", entryId: 142176, src: "content/Recordings/a30/a3037107d10d0229025b772907d44371e63d522573d56d4f41e5b70b8e70bf48.wav" },
            { word: "gisilugwet", entryId: 47803, src: "content/Recordings/36a/36a45c63e07107ae28b82fd8979ce214c5c75abd6dd1163f6d6c7612635f1d18.wav" },
            { word: "maltewiet", entryId: 64607, src: "content/Recordings/f05/f05b004acb3612239a4ec7e5d0d6b0f3f862039f6bf0a9f830869edaf848124f.wav" },
            { word: "naqa'toq", entryId: 83821, src: "content/Recordings/e32/e321a736ff48301b0107d879f5c374924ed596232b00bcec4f8764129e8481fc.wav" },
            { word: "loqwistaqan", entryId: 62416, src: "content/Recordings/647/64726693f820b56b683e44d81eadedef7d3adad11d2f58aeb9fa879c1d15ffe7.wav" },
            { word: "piwiaq", entryId: 115440, src: "content/Recordings/dd1/dd106832d2827468fc56ddaf68f8fda6bc9105736b763ccfa81fad6a545338c2.wav" },
            { word: "si'n'g", entryId: 128491, src: "content/Recordings/b01/b01cf8322f3216c4d8729b9cce1e6e1b139ab93c0235b962c92267e4530ec6ef.wav" },
            { word: "nujinutmaqaniget", entryId: 95784, src: "content/Recordings/76e/76ec3b5b5c3a8d81df694a21102fcd03653f14e9529a1d651bb5d45699943ef1.wav" },
            { word: "gesigawamgwitg", entryId: 664154227002367, src: "content/Recordings/6c4/6c42d6d4d10475904a148107c98d4fccdc962665fb50700204c1520d8a3b00a7.wav" },
            { word: "pept'sgna'sit", entryId: 108165, src: "content/Recordings/19c/19c9c7e89203f3acca2d2d3408d72901bdf68a93b811ae1aaa2979f8aa92cf17.wav" },
            { word: "nassi'g'g", entryId: 84884, src: "content/Recordings/049/049e478c920a95c83b330e8dfbec4a6ee135aa94022eeba3e1c9b2815c474bde.wav" },
            { word: "telima't", entryId: 135346, src: "content/Recordings/0cc/0cc86ed216c50c86cf69dcb824c48bd50536aee4002e46a974cf9760405e0837.wav" },
            { word: "gejimoqteg", entryId: 36854, src: "content/Recordings/699/69967d1a847b3d003ae0e5958da42008cb4d18ce36cd62e4f32f27ba75956013.wav" },
            { word: "welm'toq", entryId: 157785, src: "content/Recordings/5b1/5b15918df0e7739645d1b1282734386d68fd1dc54dbabf2d21eb089b8a0d82b0.wav" },
            { word: "menipqwa'toq", entryId: 72333, src: "content/Recordings/900/90002ed9a10cb9694feec1291845e11f130c29fc33454e1fe9dd3e0a7a9035b4.wav" },
            { word: "natawinsgu'mat", entryId: 85705, src: "content/Recordings/579/579fa671a3d7d6033f8bfcf9b3d8a2a35e75fb0317bf13376fa55c8602c44bfe.wav" },
            { word: "gesipiemgewei", entryId: 41181, src: "content/Recordings/a57/a573593b13e1510bc357a0c1c0f6120211257b30771b1c10b9c3a135ceaa320b.wav" },
            { word: "gisitoq", entryId: 47976, src: "content/Recordings/9c4/9c408106a432aee1c9516bbd9524fee0203698691862665e33d3818a612d709d.wav" },
            { word: "pipugwaqan", entryId: 112979, src: "content/Recordings/ea2/ea261896c3297db7d399664428d3b0563fbc68a41f1141b3ae217cb9861b256b.wav" },
            { word: "sasqapsgeg", entryId: 7571210283990525, src: "content/Recordings/030/0307662eb0ac74c0b260a8ab25fe0522c3ee9c36278988c5e8b7e7aae57fd589.wav" },
            { word: "jajigteg", entryId: 56315, src: "content/Recordings/e82/e82f19207797a8e44acf93b5611d3b55b0917259ab36e5ee63b2f927d88f04cb.wav" },
            { word: "istu'pit", entryId: 55946, src: "content/Recordings/6b6/6b666e12d947ca97a3bb6fdb4a324c4f98ead21c0b5518f358e1e6f7a15b5d0b.wav" },
            { word: "tapunnajig", entryId: 133286, src: "content/Recordings/84c/84c32d1ce820ebcd5eb6813efb56319e5166c5a576d8859fc6b2391c105e765f.wav" },
            { word: "ejgwqan", entryId: 16981, src: "content/Recordings/f43/f43d57ca2182a71cf45e289f9bf3a311d7a6efe54da7bb6902f5a1f693249aec.wav" },
            { word: "metaqateg", entryId: 74287, src: "content/Recordings/91f/91f57290fb910cc736b2b7d7e6d9d99cbe300a69f646fd974d6b59b124127c85.wav" },
            { word: "getu'pgising", entryId: 44167, src: "content/Recordings/22e/22eb23e76462bd1672f0a6302938c44cebc1f3e28ea102ed25eb94489cd192b9.wav" },
            { word: "elita'sualatl", entryId: 20404, src: "content/Recordings/dd3/dd3d2db3e0f7e4eda5ba9c366c416bf74f481a9b83ed7c850606b505375f79e9.wav" },
            { word: "tagali'ji'j", entryId: 132050, src: "content/Recordings/8ec/8ec98758de75affb120a3155bcbf3661cecdeeccebc5239750de5a4fab558165.wav" },
            { word: "tagali'j", entryId: 132027, src: "content/Recordings/d8c/d8ca7e6eef99a2730d7340153909fd996815161c1887c242007ae023bd4c79dd.wav" },
            { word: "wije'wet", entryId: 164308, src: "content/Recordings/a72/a72505e31d29c7831ec24cd6673a8e74ed3b88d0cf5d339d80f44090274796fd.wav" },
            { word: "nipi'l", entryId: 91543, src: "content/Recordings/f7c/f7cf9d4387e3f2ad3b714309a47610bc24ab474770c779829444adce0b20a976.wav" },
            { word: "toqju'pilg", entryId: 142636, src: "content/Recordings/e92/e9205887f626a2bbc22e3d6cbd12ffaf31b100d057d0b6f9c2b6e65a9a39c7a1.wav" },
            { word: "megwa'toq", entryId: 70428, src: "content/Recordings/ee0/ee01b75391792baa01274aca43dd50176eb9618ab476a856b5a73a49399e09bb.wav" },
            { word: "elpilatl", entryId: 21068, src: "content/Recordings/428/42817e7e909a2c2e922a8ec16dee6aba071d4cf8d1858713892be51ec42e1267.wav" },
            { word: "saqsigwemgewei", entryId: 123602, src: "content/Recordings/288/28836320bcdd6b760959969af23b8deaaf40dd812daeb4d26f8bdae907b98c01.wav" },
            { word: "jilapsg'te'g", entryId: 58360, src: "content/Recordings/e82/e82d004203af2f279d4dc5e18c67e0f4a6dbabab9c1a7759ab7959cea4d2e961.wav" },
            { word: "mesnatl", entryId: 73487, src: "content/Recordings/32e/32e998f089ac8bda9bda5a1cc656b3ba222c71db6b8ae937880a08d498f1a045.wav" },
            { word: "i'nes", entryId: 55694, src: "content/Recordings/af1/af1199500fdcd61602fd9486950d36b7089e179389a4b25699e48df4e26099da.wav" },
            { word: "emtesgatalg", entryId: 23263, src: "content/Recordings/579/57910f4d870015bf42b0a37b2b7c28d27bd8c7c329f3fff14debc0c41a8d21bb.wav" },
            { word: "se'sa'latl", entryId: 125487, src: "content/Recordings/939/939af03e9354f2c695134fec34b3e77908c70a80f782ecc3f17d3d813f978811.wav" },
            { word: "pqawi'ganmit", entryId: 8793471143522623, src: "content/Recordings/985/985c8171789f2e5696671e24ee85c62aa290ce3811ac3ddc8d05d636fd0df340.wav" },
            { word: "minua'toq", entryId: 77926, src: "content/Recordings/686/686c1d5e5295d4bc22f9c2a1906c0a34906ed723220734b66b3f277c4ca69f86.wav" },
            { word: "Mi'gmewei", entryId: 76086, src: "content/Recordings/bd1/bd171eb0083dcc414f223dbb267be263cb7cbc46d15a31046da213ab017e9065.wav" },
            { word: "elegetas'g", entryId: 19015, src: "content/Recordings/5a1/5a1b276420d3fe48f5d6ffd4ccc8ada58448ef9264be8abf69eabee7180848a8.wav" },
            { word: "si'gasit", entryId: 127613, src: "content/Recordings/bb3/bb362f0c746cd1f3d057a0eca03c6968d6a43a03785507b0e0cb3110309e2165.wav" },
            { word: "getmoqtegl", entryId: 43886, src: "content/Recordings/c84/c8496cdd4f5eb390ad2e2ed2f971efc03db707ef104be2b3c1ea521a05a0e6c9.wav" },
            { word: "piltuamatl", entryId: 112332, src: "content/Recordings/747/7477a98e0312c2ab537ecf450745de73df74fa7b4b408300230c3e0df08325a1.wav" },
            { word: "ilaji'gewsit", entryId: 54399, src: "content/Recordings/13d/13da91b301b5b778fcc2e45428db827dd54b37cd34fdb04959f54cc45c64b97d.wav" },
            { word: "gewjatpewjit", entryId: 44430, src: "content/Recordings/8d8/8d85046651e50d1c81042a9bfa9fa4851477d6f00a61376a236b0c14bda5caf5.wav" },
            { word: "ewnasgwiet", entryId: 31285, src: "content/Recordings/930/93095291c1305e6a6d4d94ea25b37b89d0d847035e064cf546411166f1fde132.wav" },
            { word: "sa'se'wa's'g", entryId: 123778, src: "content/Recordings/e87/e877a558db7c6990ae06bd902f1435db1925475e03bafe97da87226e3268c5fa.wav" },
            { word: "pisgwi'putoq", entryId: 113688, src: "content/Recordings/ffa/ffafcd06aca261ca8071f07561007bad160fb65dda90837ec3de94163a4fe46f.wav" },
            { word: "naqsinijgit", entryId: 83911, src: "content/Recordings/e06/e065f8ceb37cbccd9142709112b0d2fd9a47da4b489368b325f6c6a617509d5b.wav" },
            { word: "gewguatl", entryId: 44336, src: "content/Recordings/f0d/f0d4ffaf7d3c4c7b88789ae9b0bcdcff00f43a7eaf4302698d27f31024317845.wav" },
            { word: "atam", entryId: 2168182068541242, src: "content/Recordings/a0c/a0c557c9c3a28060e2e38bcf0d5a348d9c1fe7644129f8e46801050d67509a96.wav" },
            { word: "gesistaqnewet", entryId: 41565, src: "content/Recordings/868/868ab713d9949ca0ffb12f420e4120b47d4bcb69668e339ab921edd9ae069754.wav" },
            { word: "tempuesu", entryId: 275107276889711, src: "content/Recordings/c50/c50b0f57abef2e9727c10fe1c9599ee184a74c9ee8ea0183248a98ac0c76e56b.wav" },
            { word: "poqtawlalatl", entryId: 116795, src: "content/Recordings/62a/62a1ae430610fc88cdfdb91f6023af36861f66ddfeb4fd6949da9c747d2beaf3.wav" },
            { word: "gaqg'g", entryId: 33346, src: "content/Recordings/731/731f1f562d93c93ebe420c29f94efc12b4eb02ce375df6e54aac8e323f542fd2.wav" },
            { word: "waqaiew", entryId: 150843, src: "content/Recordings/971/971fc8d9d528f35ffb3a6aeab7115883ad6fd1966ec542339e4dc778367b58d8.wav" },
            { word: "elaqalsewatl", entryId: 18240, src: "content/Recordings/648/648d03c118e47646e1ff802b27af79be6ed44f83915c62e8b24be0f7939df12c.wav" },
            { word: "mawitqo'tmu'tijig", entryId: 68515, src: "content/Recordings/385/3857947ddfb783a2709cc0d26a008ed478efe0deb67979e04a0ba1f55f653ca4.wav" },
            { word: "wejigs'gutesg'g", entryId: 154786, src: "content/Recordings/1aa/1aa3a53cae253fe77a0835918fc64524362f4bffb9d26e3c1120646fe2840d5b.wav" },
            { word: "paspit", entryId: 102175, src: "content/Recordings/e43/e4365e96c84e6539345e355f39f8a34c2c7fe5b5b761004d29ec1521f6f83aa2.wav" },
            { word: "papuaqane'j", entryId: 304369049271425, src: "content/Recordings/bf9/bf92e173e4e907f2b1aaf437b19d630a1b4b27308d86ed46604434b64d5ff478.wav" },
            { word: "metewe'g", entryId: 74581, src: "content/Recordings/dea/dea85c91adecd679572399363f29477725af7803ad2c1edccca60d01f7761018.wav" },
            { word: "pajijiglu'sit", entryId: 99286, src: "content/Recordings/cf9/cf9e9aa1e2a02a7045b6d200e6e7bf89df4c8d83efcbbea6e7cb2222236b8114.wav" },
            { word: "poqjineweg", entryId: 116382, src: "content/Recordings/05b/05bfee2509cf16b6a82d62a111a8f7780117080ba8ee62cd077485061d486dac.wav" },
            { word: "tm'tqe'gnn", entryId: 142311, src: "content/Recordings/cf4/cf4c796d7510c08580421aed19dae3904d8a27b116afb4ce866f263c94d8f84e.wav" },
            { word: "pmetug", entryId: 115909, src: "content/Recordings/c2b/c2bcbdff81b96dd9f425974d9c80666704d3d51ac9bc5769cca5f73bffbc6021.wav" },
            { word: "wegla", entryId: 153128, src: "content/Recordings/711/71151e00969c9b83309bf3222dc54f8f648ab98547c9fed34252db4f8037748a.wav" },
            { word: "usgunamu'g", entryId: 3852361942030805, src: "content/Recordings/0e6/0e64223cc4a33d039bbd21c5ecfd4292c011cde8626586c0863262c239b0964d.wav" },
            { word: "wipit", entryId: 165349, src: "content/Recordings/ca1/ca12dc478deecb1f31c895cc9f5fdc58827a800ba25f4429ceb37b917c7a05f0.wav" },
            { word: "i'nes", entryId: 55694, src: "content/Recordings/dd5/dd5c18de86a376a9a0978534b7166b7bca130ed69371632e0ceb2c1cf9baabe0.wav" },
            { word: "ti'ls", entryId: 141542, src: "content/Recordings/05c/05cbb6e9c363bd673bef9191326be48b7b34c46605ac3f95039463f2ea559937.wav" },
            { word: "gwatej", entryId: 53410, src: "content/Recordings/b16/b1673624bbe2e269e10160234c83cbb572a509fa93206aadbc66f8cb51e778a5.wav" },
            { word: "ugjijaqamiju'et", entryId: 144744, src: "content/Recordings/c9b/c9bf66fd47888061a1c3c41726195b1c5d3bef24813089f85f2ac69abd1d1682.wav" },
            { word: "welipot", entryId: 157187, src: "content/Recordings/cb5/cb5bd7b6c05090d8185589509f5643590977412bfab8e324ea8b44fcfb4c534f.wav" },
            { word: "ugplaqan", entryId: 145298, src: "content/Recordings/c66/c662baa2ff0535ffcfa593d7bf4bb523087c23aa638d74febf802d767379abeb.wav" },
            { word: "nugjaqsatl", entryId: 93818, src: "content/Recordings/24c/24ce50891fd8b86f33c3095faf38cc4c17174d7545a72a9a105e10088f4b4a42.wav" },
            { word: "tia'mu'j", entryId: 141469, src: "content/Recordings/d30/d300ae19c753a4ffe23c7677cf3a2e317ab717a314aef686e7cced31e4aab983.wav" },
        ],
    },
];

// Duration of a WAV (seconds) read straight from the header - NO soxi spawn, so
// a 100-row page (600+ cells) stays fast to render even once the variants are
// cached.  Walks RIFF chunks for fmt (byteRate) + data (size); dur = data/byteRate.
// Server cwd is the data dir, so content-store-relative paths resolve directly.
async function wavDurationSeconds(path: string): Promise<number> {
    let f: Deno.FsFile;
    try { f = await Deno.open(path, { read: true }); } catch { return 0; }
    try {
        const head = new Uint8Array(8192);
        const n = await f.read(head) ?? 0;
        if(n < 44) return 0;
        const dv = new DataView(head.buffer, 0, n);
        let off = 12, byteRate = 0, dataSize = 0;
        while(off + 8 <= n) {
            const id = String.fromCharCode(head[off], head[off + 1], head[off + 2], head[off + 3]);
            const size = dv.getUint32(off + 4, true);
            if(id === 'fmt ' && off + 16 <= n) byteRate = dv.getUint32(off + 16, true);
            else if(id === 'data') { dataSize = size; break; }
            off += 8 + size + (size & 1);
        }
        return byteRate > 0 ? dataSize / byteRate : 0;
    } finally { f.close(); }
}

// Run an async fn over items at a fixed concurrency, so generating hundreds of
// trim variants on the first render does not spawn hundreds of sox at once.
async function mapPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
    let i = 0;
    async function worker() { while(i < items.length) await fn(items[i++]); }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// deno-lint-ignore no-explicit-any
async function renderTrimTuningPage(): Promise<templates.Page> {
    const player = (src: string) =>
        ['audio', { controls: 'controls', preload: 'none', src, style: 'width: 150px; height: 34px;' }];
    // A removed-amount readout under each player (the headline number, so the
    // 0.2%->0.3% cliff is visible at a glance) + a hover tooltip with the
    // before/after lengths.  − is a real minus sign (U+2212).
    const caption = (text: string) => ['div', { class: 'small text-muted', style: 'margin-top: 2px;' }, text];
    const removedMs = (durSrc: number, durTrim: number) => {
        const ms = Math.round((durSrc - durTrim) * 1000);
        return ms <= 0 ? '0 ms' : '−' + ms + ' ms';
    };

    // Prewarm every variant at bounded concurrency (the costly first-render step;
    // cached afterwards), then read all durations from the WAV header (no spawns).
    const allClips = TRIM_TUNING_SECTIONS.flatMap(s => s.clips);
    const srcDur = new Map<string, number>();
    await mapPool(allClips, 16, async (c) => { srcDur.set(c.src, await wavDurationSeconds(c.src)); });
    const cellInfo = new Map<string, { path: string, dur: number }>();
    const jobs = allClips.flatMap(c => TRIM_TUNING_THRESHOLDS.map(t => ({ src: c.src, t })));
    await mapPool(jobs, 16, async (j) => {
        const path = await getTrimmedRecordingPath(
            j.src, { threshold: j.t, minDuration: TRIM_TUNING_MIN_DURATION, fade: TRIM_TUNING_FADE });
        cellInfo.set(`${j.src}|${j.t}`, { path, dur: await wavDurationSeconds(path) });
    });

    // deno-lint-ignore no-explicit-any
    function renderSection(sec: TuningSection): any {
        // deno-lint-ignore no-explicit-any
        const rows: any[] = [];
        for(const c of sec.clips) {
            const durSrc = srcDur.get(c.src) ?? 0;
            const trimmed = TRIM_TUNING_THRESHOLDS.map((threshold) => {
                const ci = cellInfo.get(`${c.src}|${threshold}`)!;
                const p = ci.path, durTrim = ci.dur;
                return ['td', { class: 'text-center',
                                title: `${durSrc.toFixed(2)} s → ${durTrim.toFixed(2)} s` },
                    player('/' + p), caption(removedMs(durSrc, durTrim))];
            });
            rows.push(['tr', {},
                ['td', { style: 'white-space: nowrap;' },
                    ['a', { href: `/ww/wordwiki.lexeme.entryPage(${c.entryId})`, target: '_blank' }, ['b', {}, c.word]]],
                ['td', { class: 'text-center', title: 'untrimmed original' },
                    player('/' + c.src), caption(`${durSrc.toFixed(2)} s`)],
                ...trimmed]);
        }
        return ['div', { class: 'mb-5' },
            ['h4', {}, sec.heading],
            ['p', { class: 'text-muted', style: 'max-width: 48rem;' }, sec.blurb],
            ['table', { class: 'table table-sm table-bordered align-middle' },
                ['thead', {},
                    ['tr', {},
                        ['th', {}, 'Word'],
                        ['th', { class: 'text-center' }, 'Original'],
                        ...TRIM_TUNING_THRESHOLDS.map(t => ['th', { class: 'text-center' }, t])]],
                ['tbody', {}, rows]]];
    }

    const sections = TRIM_TUNING_SECTIONS.map(renderSection);

    const body =
        ['div', { class: 'container my-4' },
            ['h3', {}, 'Audio trim — threshold listening test'],
            ['p', { class: 'text-muted', style: 'max-width: 48rem;' },
                'Pick the most aggressive threshold that still plays the ', ['b', {}, 'whole word'],
                ' — no clipped start or end. A higher % trims more silence (and risks cutting the word). ',
                'The number under each player is how much that threshold removed; hover it for the ',
                'before/after length. Originals are never changed — this only sets how new recordings ',
                'are auto-trimmed.'],
            ...sections];

    return templates.page('Audio Trim Tuning', body);
}
