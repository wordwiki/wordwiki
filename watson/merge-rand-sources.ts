// deno-lint-ignore-file no-explicit-any
/**
 * PRE-IMPORT MERGE of Watson's three RAND files into ONE SFM file
 * (rand-final-merge-design.md, revised: merge BEFORE import - the
 * single-source pipeline then runs unchanged, and the merge result is
 * itself SFM: inspectable, diffable, Watson-readable).
 *
 * The account (verified by rand-final-merge-survey.py): processed entries
 * MOVED out of the queue into Ng (g-system headwords, both lanes) and
 * were COPIED to Lk (k-system promoted); the copies have DRIFTED.
 *
 * The merged shape:
 *  - FINALS first (the polished entries): each Ng record passes through
 *    (it already carries both lanes: \lx g-system + \lsf k-system) with
 *    `\zpt final`; where its paired Lk copy DISAGREES on a content field,
 *    one `\zdv marker: <Lk reading>` per differing marker rides along -
 *    the fork's drift becomes in-band, browsable data.
 *  - Lk-ONLY records (no Ng pair even mark-insensitively): emitted with
 *    an empty \lx and the k-spelling in \lsf, `\zpt final-lk-only` (the
 *    cross-lane headword fallback renders these).
 *  - Then the QUEUE records, untouched, `\zpt queue`.
 *
 * Pairing: Ng.\lsf == Lk.\lx exactly, then MARK-INSENSITIVELY (lowercase;
 * strip ' ` ’ hyphens spaces - the orthography survey's normalization).
 * Deterministic: a pure function of the three committed files.
 *
 *   deno run --allow-read --allow-write watson/merge-rand-sources.ts
 *
 * Writes rand-merged.sfm + rand-merged-report.md beside the sources.
 */
import * as sfm from '../wordwiki/sfm.ts';

const HERE = new URL('.', import.meta.url).pathname;
const load = (f: string) => sfm.readDatabase(
    sfm.decodeSfmBytes(Deno.readFileSync(HERE + f), 'utf-8'), 'lx');

const queue = load('Rand Mig Eng Dictt 29097');
const ng = load('Ng20726');
const lk = load('Lk20726');

type Rec = sfm.SfmRecord;
const field = (r: Rec, n: string): string|undefined =>
    r.fields.find(f => f.name === n && f.content !== '')?.content;
const fieldsOf = (r: Rec, n: string): string[] =>
    r.fields.filter(f => f.name === n && f.content !== '').map(f => f.content);
const skel = (t: string): string => t.toLowerCase().replace(/[''`’\-\s’]/g, '');

// --- Pair Lk records to Ng records (exact key, then mark-insensitive) --------
const ngByLsf = new Map<string, Rec>();
const ngBySkel = new Map<string, Rec>();
for(const r of ng.records) {
    const k = field(r, 'lsf');
    if(k === undefined) continue;
    if(!ngByLsf.has(k)) ngByLsf.set(k, r);
    if(!ngBySkel.has(skel(k))) ngBySkel.set(skel(k), r);
}
const lkFor = new Map<Rec, Rec>();      // ng record -> its lk copy
const lkOnly: Rec[] = [];
let exactPairs = 0, skelPairs = 0;
for(const r of lk.records) {
    const k = field(r, 'lx');
    if(k === undefined) { lkOnly.push(r); continue; }
    const m = ngByLsf.get(k) ?? ngBySkel.get(skel(k));
    if(m === undefined) { lkOnly.push(r); continue; }
    if(ngByLsf.get(k) === m) exactPairs++; else skelPairs++;
    if(!lkFor.has(m)) lkFor.set(m, r);
}

// --- Divergence: content-field lists that differ between the pair ------------
const CONTENT = ['ps', 'pn', 'ge', 'de', 'xv', 'xe', 'so', 'nt'];
const divergences = new Map<Rec, string[]>();   // ng record -> zdv lines
for(const [ngRec, lkRec] of lkFor) {
    const notes: string[] = [];
    for(const m of CONTENT) {
        const a = fieldsOf(ngRec, m), b = fieldsOf(lkRec, m);
        if(JSON.stringify(a) !== JSON.stringify(b))
            notes.push(`${m}: ${b.length === 0 ? '(absent in Lk)' : b.join(' | ')}`);
    }
    if(notes.length > 0) divergences.set(ngRec, notes);
}

// --- Emit ---------------------------------------------------------------------
const out: string[] = ['\\_sh v3.0  400  MDF 4.0 (merged by merge-rand-sources.ts)', ''];
const emit = (fields: Array<{name: string, content: string}>, extra: string[]) => {
    for(const f of fields)
        out.push(f.content === '' ? `\\${f.name}` : `\\${f.name} ${f.content}`);
    for(const e of extra) out.push(e);
    out.push('');
};
let nFinal = 0, nLkOnly = 0, nQueue = 0, nZdv = 0;
for(const r of ng.records) {
    const zdv = (divergences.get(r) ?? []).map(n => `\\zdv ${n.replaceAll('\n', ' ')}`);
    const unpaired = lkFor.has(r) ? [] :
        (field(r, 'lsf') !== undefined ? ['\\zdv unpaired: no matching Lk record'] : []);
    nZdv += zdv.length;
    emit(r.fields, [...zdv, ...unpaired, '\\zpt final']);
    nFinal++;
}
for(const r of lkOnly) {
    // k-system spelling into the \lsf lane; the record opens with an
    // EMPTY \lx (the cross-lane headword fallback presents these).
    const rest = r.fields.filter(f => f.name !== 'lx' && f.name !== 'lsf');
    emit([{name: 'lx', content: ''},
          {name: 'lsf', content: field(r, 'lx') ?? ''},
          ...rest], ['\\zpt final-lk-only']);
    nLkOnly++;
}
for(const r of queue.records) {
    emit(r.fields, ['\\zpt queue']);
    nQueue++;
}
Deno.writeTextFileSync(HERE + 'rand-merged.sfm', out.join('\n'));

// --- The report ----------------------------------------------------------------
const report = [
    `# rand-merged.sfm — merge report`,
    ``,
    `Generated by merge-rand-sources.ts from the 2026-07 Watson drop.`,
    ``,
    `- final (Ng base): ${nFinal}  (paired to Lk: ${lkFor.size} = ${exactPairs} exact + ${skelPairs} mark-insensitive)`,
    `- final-lk-only (no Ng pair): ${nLkOnly}`,
    `- queue: ${nQueue}`,
    `- TOTAL records: ${nFinal + nLkOnly + nQueue}`,
    `- diverged pairs (\\zdv notes ride the records): ${divergences.size} entries, ${nZdv} field notes`,
    `- arithmetic: 33,276 original − ${nQueue} queue − ${nFinal} final = ${33276 - nQueue - nFinal} in neither (Watson question 6)`,
    ``,
    `## Diverged entries (first 40; the full set is in-band as \\zdv)`,
    ...[...divergences.entries()].slice(0, 40).map(([r, notes]) =>
        `- **${field(r, 'lx') ?? field(r, 'lsf')}**: ${notes.join('; ')}`),
].join('\n') + '\n';
Deno.writeTextFileSync(HERE + 'rand-merged-report.md', report);
console.log(`final ${nFinal} (paired ${lkFor.size}: ${exactPairs}+${skelPairs} skel), ` +
            `lk-only ${nLkOnly}, queue ${nQueue}, diverged ${divergences.size} (${nZdv} zdv)`);
