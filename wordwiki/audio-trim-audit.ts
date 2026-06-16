#!/usr/bin/env -S deno run --allow-all
/**
 * Audit the silence/click trim (audio.ts soxTrimArgs / RECORDING_TRIM_PARAMS)
 * against the existing, HAND-TRIMMED recording corpus.
 *
 * The idea (dz's): the corpus was already tightly trimmed by hand, so it holds
 * (essentially) no leading/trailing silence.  Running the auto-trim over it is
 * therefore a near-oracle regression check - a correctly tuned trim should
 * remove ~0 from each clip.  A clip where the auto-trim removes a meaningful
 * amount is one where it cut audio a human deliberately KEPT (i.e. it ate a soft
 * onset/offset, not silence).  Those are the exceptions to audit / a signal that
 * the threshold is too aggressive.
 *
 * Output: the distribution of removed-duration, summary percentiles, and the
 * top-N offenders with a head/tail split and the peak amplitude of the removed
 * regions (a loud removed region == real audio was cut).
 *
 *   deno run --allow-all wordwiki/audio-trim-audit.ts [options]
 *
 *     --dir <path>          recordings dir (default ~/mmo/content/Recordings)
 *     --sample <n>          audit ~n files, strided across the corpus (default 1000; 0 = all)
 *     --threshold <pct>     SoX silence threshold, e.g. 0.1% (default: RECORDING_TRIM_PARAMS)
 *     --min-duration <s>    onset duration (default: RECORDING_TRIM_PARAMS)
 *     --concurrency <n>     parallel sox workers (default 12)
 *     --top <n>             how many offenders to detail (default 25)
 *     --csv <path>          also write per-file rows to CSV
 *
 * The KEY safety signal is the peak amplitude of the REMOVED region: ~0 means we
 * cut silence (good); near full-scale means we cut speech (bad).  Clips are
 * ranked by that peak, since a short-but-loud cut (a clipped plosive) is the real
 * danger and a duration ranking would miss it.
 */
import { RECORDING_TRIM_PARAMS, type TrimParams } from "./audio.ts";
import * as config from "./config.ts";

// ---- tiny arg parser -------------------------------------------------------
function arg(name: string, dflt?: string): string | undefined {
    const i = Deno.args.indexOf('--' + name);
    return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : dflt;
}
const HOME = Deno.env.get('HOME') ?? '.';
const DIR = arg('dir', `${HOME}/mmo/content/Recordings`)!;
const SAMPLE = parseInt(arg('sample', '1000')!, 10);
const CONCURRENCY = parseInt(arg('concurrency', '12')!, 10);
const TOP = parseInt(arg('top', '25')!, 10);
const CSV = arg('csv');
const params: TrimParams = {
    threshold: arg('threshold', RECORDING_TRIM_PARAMS.threshold)!,
    minDuration: parseFloat(arg('min-duration', String(RECORDING_TRIM_PARAMS.minDuration))!),
    fade: 0,   // irrelevant to the audit: soxTrimArgs is silence-only (length-changing)
};

// ---- sox/soxi helpers ------------------------------------------------------
const dec = new TextDecoder();

async function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
    const { code, stdout, stderr } = await new Deno.Command(cmd, { args }).output();
    return { code, out: dec.decode(stdout), err: dec.decode(stderr) };
}

async function duration(path: string): Promise<number> {
    const { code, out } = await run(config.soxiPath, ['-D', path]);
    if(code !== 0) throw new Error(`soxi failed on ${path}`);
    return parseFloat(out.trim());
}

// Peak (max) amplitude of a sub-region, via `sox ... stat` (parsed from stderr).
async function regionPeak(path: string, region: 'head' | 'tail', seconds: number): Promise<number> {
    if(seconds <= 0) return 0;
    const pre = region === 'tail' ? ['reverse'] : [];
    const { err } = await run(config.soxPath, [path, '-n', ...pre, 'trim', '0', seconds.toFixed(3), 'stat']);
    const m = /Maximum amplitude:\s*([0-9.eE+-]+)/.exec(err);
    return m ? Math.abs(parseFloat(m[1])) : NaN;
}

// One-sided trim duration (leading-only or trailing-only), to split head vs tail.
async function oneSidedTrimmedDuration(path: string, p: TrimParams, side: 'head' | 'tail'): Promise<number> {
    const tmp = await Deno.makeTempFile({ suffix: '.wav' });
    const dur = String(p.minDuration), thr = p.threshold;
    const a = side === 'head'
        ? [path, tmp, 'silence', '1', dur, thr]
        : [path, tmp, 'reverse', 'silence', '1', dur, thr, 'reverse'];
    try {
        const { code } = await run(config.soxPath, a);
        if(code !== 0) return NaN;
        return await duration(tmp);
    } finally {
        try { await Deno.remove(tmp); } catch { /* ignore */ }
    }
}

// ---- concurrency pool ------------------------------------------------------
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    let done = 0;
    const total = items.length;
    async function worker() {
        while(true) {
            const i = next++;
            if(i >= items.length) return;
            try { out[i] = await fn(items[i], i); } catch (e) { out[i] = e as R; }
            if(++done % 100 === 0 || done === total)
                Deno.stderr.writeSync(new TextEncoder().encode(`\r  measured ${done}/${total}`));
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    Deno.stderr.writeSync(new TextEncoder().encode('\n'));
    return out;
}

// ---- main ------------------------------------------------------------------
interface Row {
    path: string; durSrc: number;
    removedHead: number; removedTail: number; removed: number;
    headPeak: number; tailPeak: number; peak: number;
    error?: string;
}

function fmtMs(s: number): string { return (s * 1000).toFixed(0) + 'ms'; }
function dB(amp: number): string { return amp > 0 ? (20 * Math.log10(amp)).toFixed(0) + 'dB' : '-inf'; }

const allWavs: string[] = [];
for await (const e of Deno.readDir(DIR)) {
    if(e.isDirectory) {
        for await (const f of Deno.readDir(`${DIR}/${e.name}`))
            if(f.isFile && f.name.endsWith('.wav')) allWavs.push(`${DIR}/${e.name}/${f.name}`);
    } else if(e.isFile && e.name.endsWith('.wav')) {
        allWavs.push(`${DIR}/${e.name}`);
    }
}
allWavs.sort();

let files = allWavs;
if(SAMPLE > 0 && SAMPLE < allWavs.length) {
    const stride = allWavs.length / SAMPLE;
    files = Array.from({ length: SAMPLE }, (_, i) => allWavs[Math.floor(i * stride)]);
}

console.log(`Audio trim audit`);
console.log(`  corpus:      ${DIR}  (${allWavs.length} wavs; auditing ${files.length})`);
console.log(`  params:      threshold=${params.threshold} minDuration=${params.minDuration}s fade=${params.fade}s`);
console.log(`  oracle:      hand-trimmed clips should lose ~0; large removal == ate kept audio\n`);

const rows: Row[] = await pool(files, CONCURRENCY, async (path): Promise<Row> => {
    try {
        const durSrc = await duration(path);
        const dh = await oneSidedTrimmedDuration(path, params, 'head');
        const dt = await oneSidedTrimmedDuration(path, params, 'tail');
        const removedHead = Number.isFinite(dh) ? Math.max(0, durSrc - dh) : 0;
        const removedTail = Number.isFinite(dt) ? Math.max(0, durSrc - dt) : 0;
        const headPeak = removedHead > 0 ? await regionPeak(path, 'head', removedHead) : 0;
        const tailPeak = removedTail > 0 ? await regionPeak(path, 'tail', removedTail) : 0;
        return {
            path, durSrc, removedHead, removedTail, removed: removedHead + removedTail,
            headPeak: headPeak || 0, tailPeak: tailPeak || 0, peak: Math.max(headPeak || 0, tailPeak || 0),
        };
    } catch (e) {
        return { path, durSrc: NaN, removedHead: NaN, removedTail: NaN, removed: NaN,
                 headPeak: NaN, tailPeak: NaN, peak: NaN, error: String((e as Error).message ?? e) };
    }
});

const ok = rows.filter(r => !r.error && Number.isFinite(r.removed));
const errs = rows.filter(r => r.error);

function histogram(label: string, values: number[], buckets: [string, (v: number) => boolean][]) {
    console.log(`\n${label} (n=${values.length}):`);
    for(const [name, pred] of buckets) {
        const c = values.filter(pred).length;
        const p = values.length ? (100 * c / values.length) : 0;
        console.log(`  ${name} ${String(c).padStart(6)}  ${p.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(p / 2))}`);
    }
}
const percentiles = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b);
    const at = (p: number) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
    return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) || 0 };
};

// (1) How much we remove.  On a hand-trimmed corpus this should be small.
histogram('Removed-duration distribution', ok.map(r => r.removed), [
    ['= 0ms        ', s => s === 0],
    ['(0, 10ms]    ', s => s > 0 && s <= 0.010],
    ['(10, 50ms]   ', s => s > 0.010 && s <= 0.050],
    ['(50, 100ms]  ', s => s > 0.050 && s <= 0.100],
    ['(100, 250ms] ', s => s > 0.100 && s <= 0.250],
    ['(250, 500ms] ', s => s > 0.250 && s <= 0.500],
    ['> 500ms      ', s => s > 0.500],
]);
{ const p = percentiles(ok.map(r => r.removed));
  console.log(`  median ${fmtMs(p.p50)}   p90 ${fmtMs(p.p90)}   p99 ${fmtMs(p.p99)}   max ${fmtMs(p.max)}`); }

// (2) THE SAFETY SIGNAL: peak amplitude of what we removed.  Low == silence
// (good); high == we cut speech (bad).  This is the headline.
histogram('Removed-region PEAK amplitude  (≤0.03 ≈ silence; ≥0.1 likely speech)', ok.map(r => r.peak), [
    ['≤ 0.01  (silence)', v => v <= 0.01],
    ['(0.01, 0.03]     ', v => v > 0.01 && v <= 0.03],
    ['(0.03, 0.05]     ', v => v > 0.03 && v <= 0.05],
    ['(0.05, 0.10]     ', v => v > 0.05 && v <= 0.10],
    ['(0.10, 0.20]     ', v => v > 0.10 && v <= 0.20],
    ['(0.20, 0.40]     ', v => v > 0.20 && v <= 0.40],
    ['> 0.40  (LOUD!)  ', v => v > 0.40],
]);
const suspect = ok.filter(r => r.peak > 0.05).length;
console.log(`  ${suspect}/${ok.length} (${(100 * suspect / ok.length).toFixed(1)}%) removed a region peaking above 0.05 (worth a listen)`);

// (3) The audit list: clips most likely to have lost SPEECH, ranked by peak.
const offenders = [...ok].sort((a, b) => b.peak - a.peak).slice(0, TOP);
console.log(`\nTop ${offenders.length} by removed-region PEAK (the "did we cut speech?" list):\n`);
console.log(`   peak  (dB)     end   removed   file`);
for(const r of offenders) {
    const end = r.headPeak >= r.tailPeak ? 'head' : 'tail';
    const endRemoved = end === 'head' ? r.removedHead : r.removedTail;
    console.log(`  ${r.peak.toFixed(2)}  ${dB(r.peak).padStart(6)}    ${end}  ${fmtMs(endRemoved).padStart(7)}   ` +
                `${r.path.replace(DIR + '/', '')}`);
}

if(errs.length) {
    console.log(`\n${errs.length} file(s) errored, e.g.:`);
    for(const r of errs.slice(0, 5)) console.log(`  ${r.path}: ${r.error}`);
}

if(CSV) {
    const header = 'path,durSrc,removedHead,removedTail,removed,headPeak,tailPeak,peak';
    const lines = [header, ...ok.map(r =>
        [r.path, r.durSrc, r.removedHead, r.removedTail, r.removed, r.headPeak, r.tailPeak, r.peak].join(','))];
    await Deno.writeTextFile(CSV, lines.join('\n') + '\n');
    console.log(`\nwrote ${ok.length} rows to ${CSV}`);
}
