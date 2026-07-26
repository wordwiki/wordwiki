/**
 * Generate rand-structural.typ from Watson's MDF.typ: same 103 markers
 * (so nothing ever drops on import), with mkrOverThis REWRITTEN to encode
 * the STRUCTURAL INTENT of the RAND transcription - Watson's original
 * chains markers in record-template order (a shoebox data-entry idiom;
 * a 14-level vine), which is entry layout, not meaning.
 *
 * With this .typ, `sfm-import --structure=tree` gets the grouping from
 * sfm's own tree recovery: a repeated \ps pops back to the record and
 * opens a NEW sense group (the group-opener IS the parent - Watson uses
 * no \sn, and a synthesized sn would swallow every sense into one);
 * \xe pairs under its \xv the same way; \lf > \lv > \le keeps its chain.
 * Everything not explicitly placed hangs off \lx (record-level).
 *
 * LINE-BASED rewrite: every byte of the original rides through except the
 * \mkrOverThis lines (replaced/inserted per the override map).
 * ITERABLE: adjust OVERRIDES, re-run this, re-import (deterministic, ~9s).
 *
 *   deno run --allow-read --allow-write watson/make-structural-typ.ts
 */
import * as sfm from '../wordwiki/sfm.ts';

// marker -> structural parent.  THE statement of intent - review here.
const OVERRIDES: Record<string, string> = {
    // Lexeme-level (the vine had these chained through each other).
    lsf: 'lx', ph: 'lx', so: 'lx', nt: 'lx', dt: 'lx', va: 'lx',
    // The SENSE: \ps opens it (repetition = new sense); its fields hang ON it.
    ps: 'lx', pn: 'ps', ge: 'ps', de: 'ps', sd: 'ps',
    // Examples: \xv opens one under the sense; \xe pairs beneath its \xv.
    xv: 'ps', xe: 'xv',
    // The lexical-function triple keeps its chain, anchored to the sense.
    lf: 'ps', lv: 'lf', le: 'lv',
};
const RECORD_MARKER = 'lx';

const HERE = new URL('.', import.meta.url).pathname;
const raw = sfm.decodeSfmBytes(Deno.readFileSync(HERE + 'MDF.typ'), 'windows-1252');

const out: string[] = [];
let current: string | undefined;          // the +mkr record we are inside
let sawOverThis = false;
const parentOf = (marker: string): string | undefined =>
    marker === RECORD_MARKER ? undefined : (OVERRIDES[marker] ?? RECORD_MARKER);

for(const line of raw.split('\n')) {
    const t = line.replace(/\r$/, '');
    const mkr = t.match(/^\\\+mkr (\S+)/);
    if(mkr) { current = mkr[1]; sawOverThis = false; out.push(line); continue; }
    if(current !== undefined && /^\\mkrOverThis /.test(t)) {
        sawOverThis = true;
        const parent = parentOf(current);
        if(parent !== undefined) out.push(`\\mkrOverThis ${parent}\r`);
        // (the record marker gets NO parent line - it is the root)
        continue;
    }
    if(current !== undefined && /^\\-mkr\b/.test(t)) {
        const parent = parentOf(current);
        if(parent !== undefined && !sawOverThis)
            out.push(`\\mkrOverThis ${parent}\r`);
        current = undefined;
    }
    out.push(line);
}

// The MERGE z-markers (SIL's reserved user namespace): provenance and
// divergence notes emitted by merge-rand-sources.ts, record-level.
out.push([
    '',
    '\\+mkr zpt',
    '\\nam Merge partition',
    '\\desc queue | final | final-lk-only - which Watson file this record came from (merge-rand-sources.ts)',
    '\\lng English',
    '\\mkrOverThis lx',
    '\\-mkr',
    '',
    '\\+mkr zdv',
    '\\nam Merge divergence',
    '\\desc A field where the Lk copy disagrees with the Ng base (the fork drifted) - "marker: Lk reading"',
    '\\lng English',
    '\\mkrOverThis lx',
    '\\-mkr',
].join('\n'));

Deno.writeTextFileSync(HERE + 'rand-structural.typ', out.join('\n'));
console.log('wrote rand-structural.typ');
const check = sfm.parseTyp(Deno.readTextFileSync(HERE + 'rand-structural.typ'));
console.log(`markers ${check.nodes.size}, recordMarker ${check.recordMarker}, ` +
            `problems ${check.problems.length}`);
const depth = (n: sfm.SfmSchemaNode): number => n.parent ? depth(n.parent) + 1 : 0;
console.log(`max depth ${Math.max(...[...check.nodes.values()].map(depth))}`);
for(const m of ['ps', 'ge', 'xv', 'xe', 'le', 'lsf'])
    console.log(`  ${m} over ${check.nodes.get(m)?.parentTagName}`);
