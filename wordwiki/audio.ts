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
            { word: "a'jela's'g",      entryId:   538, src: "content/Recordings/8b7/8b7baaaddbad40f58aeedc643ea2f3fca6953e27bd3da2f80189d43529070477.wav" },
            { word: "alasumteget",     entryId:  2375, src: "content/Recordings/9d2/9d209a2984b7254881e9909462d37dbdc49bfc9c282c6bf7f7ab74b7a2e3c96e.wav" },
            { word: "aps'sqate'get",   entryId: 11178, src: "content/Recordings/f57/f57a1f1a35551c34ffe62f00210762dcf76bea99c1cdaa1e0295153e93df6b77.wav" },
            { word: "a'sugwesugwijig", entryId: 14222, src: "content/Recordings/731/73153052fa66f5de9c8a68c14727ae437cfbbd6c2b2f461419276965a66825dd.wav" },
            { word: "eltoq",           entryId: 21926, src: "content/Recordings/e32/e32dbdf6b42747726f257264b4fd49678fb908b0417218d474b08cf6e772e84e.wav" },
            { word: "gaqapijing",      entryId: 33100, src: "content/Recordings/e0b/e0b43c111870ae61b73bc1339b4565e1d92651ae38e359ce8f85f3f7353823d2.wav" },
            { word: "gi's_sa'q",       entryId: 48769, src: "content/Recordings/d95/d95c29ca0540ad3179c09c9c86aeb74e02f021e0636f5800d2a175f46ad5bc4d.wav" },
            { word: "glusgapewit",     entryId: 50694, src: "content/Recordings/ff9/ff9015b9bf0430ebbc9a398f74e4fae6955e84737cb8cc938ac000e0dccfd824.wav" },
        ],
    },
];

// Duration of a WAV (seconds), via soxi.  Server cwd is the data dir, so the
// content-store-relative paths resolve directly.
async function soxiDurationSeconds(path: string): Promise<number> {
    const { stdout } = await new Deno.Command(config.soxiPath, { args: ['-D', path] }).output();
    return parseFloat(new TextDecoder().decode(stdout).trim()) || 0;
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

    // deno-lint-ignore no-explicit-any
    async function renderSection(sec: TuningSection): Promise<any> {
        // deno-lint-ignore no-explicit-any
        const rows: any[] = [];
        for(const c of sec.clips) {
            const durSrc = await soxiDurationSeconds(c.src);
            const trimmed = await Promise.all(TRIM_TUNING_THRESHOLDS.map(async (threshold) => {
                const p = await getTrimmedRecordingPath(
                    c.src, { threshold, minDuration: TRIM_TUNING_MIN_DURATION, fade: TRIM_TUNING_FADE });
                const durTrim = await soxiDurationSeconds(p);
                return ['td', { class: 'text-center',
                                title: `${durSrc.toFixed(2)} s → ${durTrim.toFixed(2)} s` },
                    player('/' + p), caption(removedMs(durSrc, durTrim))];
            }));
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

    // deno-lint-ignore no-explicit-any
    const sections: any[] = [];
    for(const sec of TRIM_TUNING_SECTIONS) sections.push(await renderSection(sec));

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
