// deno-lint-ignore-file no-explicit-any
/**
 * pm-li ERROR TAXONOMY generator (the reading-session material; workbench
 * §8.5 step 1 + phonology-reference.md §4.2).  For each holdout MISS
 * (machine Listuguj != gold rtl) it computes the aligned diff, tags the
 * phenomena present (length / uvular / glide-vowel / suffix / residual),
 * shows the FIRED RULES (explainPmToLi — so the expert sees WHY the machine
 * produced its form), and proposes a bucket.  Emits a mailable review page
 * + a machine-data JSON.
 *
 * LIVE-TUNABLE (dz 2026-07-31, the expert is low-energy short-term):
 *   - the machine produces a PRELIMINARY taxonomy with ZERO expert input
 *     (the phenomenon sizing already answers "which lever is biggest");
 *   - human verdicts live in a SEPARATE file (pm-li-taxonomy-verdicts.json),
 *     keyed by a CONTENT-KEYED id (hash of source+gold).  The generator
 *     READS and MERGES them, never overwrites.  So partial feedback now +
 *     more in a few months both just re-bind; and re-running after ANY rule
 *     change regenerates the cards while PRESERVING the verdicts by id.
 *
 * Run (from repo root):  deno run --allow-read --allow-write \
 *   mikmaq/pm-li-taxonomy.ts [corpus.json]
 * Re-run after any pm-li rule change to rebind the taxonomy.
 */
import { transliteratePmToLi, explainPmToLi } from './pacifique-transliterate.ts';
import { splitPairs } from '../wordwiki/transliterate-harness.ts';
import { normalizeCorpusPair } from '../wordwiki/transliterate-pair.ts';

function fnv8(s: string): string {
    let h = 2166136261;
    for(const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// --- aligned char diff (Levenshtein backtrace) -------------------------------
type Edit = {op: '=' | 'sub' | 'ins' | 'del', a: string, b: string, i: number};
function align(a: string, b: string): Edit[] {
    const n = a.length, m = b.length;
    const d: number[][] = Array.from({length: n+1}, () => new Array(m+1).fill(0));
    for(let i=0;i<=n;i++) d[i][0]=i;
    for(let j=0;j<=m;j++) d[0][j]=j;
    for(let i=1;i<=n;i++) for(let j=1;j<=m;j++)
        d[i][j] = a[i-1]===b[j-1] ? d[i-1][j-1]
            : 1+Math.min(d[i-1][j-1], d[i-1][j], d[i][j-1]);
    const ops: Edit[] = [];
    let i=n, j=m;
    while(i>0||j>0) {
        if(i>0&&j>0&&a[i-1]===b[j-1]&&d[i][j]===d[i-1][j-1]) { ops.push({op:'=',a:a[i-1],b:b[j-1],i:i-1}); i--; j--; }
        else if(i>0&&j>0&&d[i][j]===d[i-1][j-1]+1) { ops.push({op:'sub',a:a[i-1],b:b[j-1],i:i-1}); i--; j--; }
        else if(i>0&&d[i][j]===d[i-1][j]+1) { ops.push({op:'del',a:a[i-1],b:'',i:i-1}); i--; }
        else { ops.push({op:'ins',a:'',b:b[j-1],i}); j--; }
    }
    return ops.reverse();
}

// --- phenomenon tagging (multi-label; each tag = a known phenomenon → a
// LEVER from phonology-reference.md §4.  'data' = tokenization noise (not
// phonology — a corpus-cleaning signal); 'residual' = genuinely unexplained.
const VOWEL = new Set(['a','e','i','o','u']);
const GLIDEV = new Set(['o','u','w']);          // the glide/back-vowel complex
function tagPhenomena(machine: string, gold: string): {tags: string[], residual: boolean} {
    const ops = align(machine, gold).filter(o => o.op !== '=');
    const tags = new Set<string>();
    let residual = false;
    const n = Math.max(machine.length, gold.length);
    for(const o of ops) {
        const ch = o.a || o.b;
        const near = o.i >= n - 3;
        if(o.a === "'" || o.b === "'") { tags.add('length'); continue; }   // apostrophe = length/schwa
        if(/[^a-z]/i.test(ch)) { tags.add('data'); continue; }             // space, /, punct = extraction noise
        if(o.op === 'sub') {
            if((o.a==='g'&&o.b==='q')||(o.a==='q'&&o.b==='g')) { tags.add('uvular'); continue; }
            if((o.a==='t'&&o.b==='j')||(o.a==='j'&&o.b==='t')) { tags.add('palatal'); continue; }
            if(GLIDEV.has(o.a)&&GLIDEV.has(o.b)) { tags.add('glide'); continue; }
            if(VOWEL.has(o.a)&&VOWEL.has(o.b)) { tags.add('vowel-quality'); continue; }
        } else {   // ins / del
            if(GLIDEV.has(ch)) { tags.add('glide'); continue; }
            if(VOWEL.has(ch)) { tags.add('epenthesis'); continue; }         // e/i/a ins-del = schwa/epenthesis
            if('gq'.includes(ch)) { tags.add('uvular'); continue; }
        }
        if(near) { tags.add('suffix'); continue; }                         // consonant change in final region
        tags.add('residual'); residual = true;
    }
    return {tags: [...tags], residual};
}

// which levers each phenomenon feeds (phonology-reference.md §4.1)
const PHONETIC = new Set(['length','uvular','glide','vowel-quality','epenthesis']);  // levers 1/3
const MORPH = new Set(['palatal','suffix']);                                          // lever 2

/** The PRIMARY bucket + which lever + whether the expert is CRITICAL.
 *  Expert is critical for morph-suspects (is the gold regularized?) and
 *  residuals (rule failure or gold issue?); NOT for the phonetic/data ones. */
function bucketOf(tags: string[], residual: boolean): {bucket: string, lever: string, expertCritical: boolean} {
    const has = (t: string) => tags.includes(t);
    if(residual)
        return {bucket: 'residual', lever: '? (rule failure or gold issue — EXPERT)', expertCritical: true};
    if(tags.length === 1 && has('data'))
        return {bucket: 'data-noise', lever: '0 (fix the corpus extractor)', expertCritical: false};
    if([...tags].some(t => MORPH.has(t)))
        return {bucket: 'morph-suspect', lever: '2 (gold regularized? — EXPERT)', expertCritical: true};
    if(tags.length === 1 && has('length'))
        return {bucket: 'length-only', lever: '1 (match: ignore length)', expertCritical: false};
    if([...tags].every(t => PHONETIC.has(t) || t === 'data'))
        return {bucket: 'phonological', lever: '1/3 (permissiveness + uvular/glide/schwa score)', expertCritical: false};
    return {bucket: 'residual', lever: '? — EXPERT', expertCritical: true};
}

// --- render ------------------------------------------------------------------
function diffHtml(machine: string, gold: string): string {
    // highlight machine chars that differ from gold's alignment
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let mh = '', gh = '';
    for(const o of align(machine, gold)) {
        if(o.op === '=') { mh += esc(o.a); gh += esc(o.b); }
        else if(o.op === 'sub') { mh += `<b>${esc(o.a)}</b>`; gh += `<b>${esc(o.b)}</b>`; }
        else if(o.op === 'del') { mh += `<b>${esc(o.a)}</b>`; }
        else { gh += `<b>${esc(o.b)}</b>`; }
    }
    return `<span class="mm">${mh}</span> <span class="arrow">vs gold</span> <span class="gold">${gh}</span>`;
}

const TAG_COLOR: Record<string,string> = {
    length: '#b58900', uvular: '#268bd2', glide: '#2aa198',
    'vowel-quality': '#859900', epenthesis: '#6c71c4', palatal: '#cb4b16',
    suffix: '#d33682', data: '#93a1a1', 'gloss-leak': '#586e75', residual: '#dc322f',
};

/** Conservative gloss-leak detector: the corpus extractor (pdmRefCorpus)
 *  rejects accented-French sources + a few English target words, but misses
 *  unaccented French (en jurant) and English glosses w/o those words
 *  (swearing/cussing).  These are CORPUS NOISE, not rule failures - pull
 *  them out of the expert set.  (The real fix is in the extractor; this
 *  keeps the reading honest meanwhile.) */
const FRENCH = /\b(en|le|la|les|de|du|des|un|une|dans|avec|pour|sur|qui|que|il|elle|est|se|son|sa)\b/i;
const ENGLISH = /\b(the|of|and|to|or|is|his|her|s?he|him|it|in|on|with|for|from|one|who|that|this|swearing|cussing)\b/i;
function glossLeak(source: string, gold: string): boolean {
    return FRENCH.test(source) || ENGLISH.test(gold) || /\//.test(gold);
}

function main() {
    const args = [...Deno.args];
    const corpusPath = args[0] ?? 'transliteration-pairs-pm-li.json';
    const raw = JSON.parse(Deno.readTextFileSync(corpusPath)).map(normalizeCorpusPair);
    const hold = splitPairs(raw, 'holdout').pairs;

    // Existing human verdicts (persisted; the generator MERGES, never overwrites).
    const verdictPath = new URL('./pm-li-taxonomy-verdicts.json', import.meta.url).pathname;
    let verdicts: Record<string, any> = {};
    try { verdicts = JSON.parse(Deno.readTextFileSync(verdictPath)); } catch { /* none yet */ }

    const cards: any[] = [];
    let hits = 0;
    const phenomCount: Record<string, number> = Object.fromEntries(Object.keys(TAG_COLOR).map(k => [k, 0]));
    const bucketCount: Record<string, number> = {};
    for(const p of hold) {
        const machine = transliteratePmToLi(p.source);
        if(machine === p.target) { hits++; continue; }
        let {tags, residual} = tagPhenomena(machine, p.target);
        let {bucket, lever, expertCritical} = bucketOf(tags, residual);
        if(glossLeak(p.source, p.target)) {   // corpus noise, not a rule failure
            tags = ['gloss-leak', ...tags.filter(t => t !== 'residual')];
            bucket = 'gloss-leak'; lever = '0 (corpus: drop — fix pdmRefCorpus)'; expertCritical = false;
        }
        for(const t of tags) phenomCount[t] = (phenomCount[t] ?? 0) + 1;
        bucketCount[bucket] = (bucketCount[bucket] ?? 0) + 1;
        const id = fnv8(p.source + '\x01' + p.target);
        const fired = explainPmToLi(p.source).steps.map(s => s.label);
        cards.push({id, source: p.source, gold: p.target, machine, tags, bucket, lever,
                    expertCritical, fired, verdict: verdicts[id] ?? null});
    }
    // Expert-critical first (where their input is UNIQUELY needed), then the rest.
    cards.sort((a, b) => (b.expertCritical?1:0) - (a.expertCritical?1:0));

    // machine-data JSON (regenerated freely; the verdicts file is the human layer)
    const dataPath = new URL('./pm-li-taxonomy-data.json', import.meta.url).pathname;
    Deno.writeTextFileSync(dataPath, JSON.stringify(cards, null, 1));

    // console sizing (the preliminary taxonomy — no expert needed)
    console.log(`pm-li holdout: ${hold.length} pairs, ${hits} hits, ${cards.length} misses`);
    console.log('\nPHENOMENA present (multi-label; a miss can carry several):');
    for(const [k,v] of Object.entries(phenomCount))
        console.log(`  ${k.padEnd(12)} in ${v} misses`);
    console.log('\nPRIMARY bucket → lever:');
    for(const [k,v] of Object.entries(bucketCount).sort((a,b)=>b[1]-a[1]))
        console.log(`  ${k.padEnd(14)} ${v}`);
    const critical = cards.filter(c => c.expertCritical).length;
    console.log(`\nEXPERT-CRITICAL misses (need the gold reading): ${critical} of ${cards.length}`);

    // review page
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const legend = Object.entries(TAG_COLOR).map(([t,c]) =>
        `<span class="tag" style="background:${c}">${t}</span>`).join(' ');
    const cardHtml = cards.map(c => {
        const tags = c.tags.map((t:string) => `<span class="tag" style="background:${TAG_COLOR[t]}">${t}</span>`).join(' ');
        const q = c.bucket === 'morph-suspect'
            ? `Is the gold a REGULARIZED citation form (not a faithful transcription of the Pacifique)?  ☐ yes (lever 2)  ☐ no — machine is wrong`
            : c.bucket === 'residual'
            ? `Machine wrong &amp; gold faithful?  correct Listuguj form: ______________   ☐ or gold is regularized`
            : `(machine-handled — confirm only if you disagree)`;
        const v = c.verdict ? `<div class="verdict">recorded: ${esc(JSON.stringify(c.verdict))}</div>` : '';
        return `<div class="card ${c.expertCritical?'crit':''}">
  <div class="src">${esc(c.source)}</div>
  <div class="diff">${diffHtml(c.machine, c.gold)}</div>
  <div class="tags">${tags} <span class="lever">→ lever ${esc(c.lever)}</span></div>
  <div class="rules">rules fired: ${c.fired.length ? esc(c.fired.join(' · ')) : '(none)'}</div>
  <div class="q">${q}</div>${v}
</div>`;
    }).join('\n');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>pm-li error taxonomy — reading session</title>
<style>
 body{font-family:system-ui,sans-serif;margin:2em auto;max-width:920px;color:#222;line-height:1.5}
 h1{font-size:1.5em} .note{background:#f5f0e0;padding:1em 1.2em;border-radius:8px;color:#444}
 .tag{color:#fff;padding:1px 7px;border-radius:10px;font-size:.72em;white-space:nowrap}
 .sizing{margin:1.2em 0;font-size:.95em} .sizing td{padding:2px 14px 2px 0}
 .card{border:1px solid #e0dccc;border-radius:8px;padding:.9em 1.1em;margin:.7em 0;background:#fff}
 .card.crit{border-color:#d33682;background:#fdf6f9}
 .src{font-size:1.3em;font-weight:600;color:#586e75}
 .diff{margin:.3em 0;font-size:1.15em} .mm b{color:#dc322f} .gold b{color:#268bd2}
 .mm,.gold{font-weight:500} .arrow{color:#999;font-size:.8em;margin:0 .4em}
 .tags{margin:.4em 0} .lever{color:#666;font-size:.85em}
 .rules{color:#777;font-size:.82em;font-style:italic} .q{margin-top:.5em;font-size:.92em;color:#333}
 .verdict{margin-top:.3em;font-size:.8em;color:#2aa198}
</style></head><body>
<h1>Pacifique → Listuguj — error reading session (preliminary, machine-bucketed)</h1>
<div class="note">
<p><b>What this is.</b> The ${cards.length} holdout words where the automatic Pacifique→Listuguj
rules disagree with the hand gold.  The machine has already grouped them by the KIND of
difference; your job is only to <b>confirm or correct</b>, and only where marked
<span class="tag" style="background:#d33682">expert</span>.</p>
<p><b>You can stop anytime.</b> Unreviewed words keep the machine's guess.  Anything you mark is
saved by word and survives when we improve the rules and regenerate this list — partial now, more
later, both count.  The two questions that need you: (1) is a gold form a tidy
<i>citation/dictionary</i> spelling rather than a faithful transcription of what Pacifique wrote?
(2) where the machine looks simply wrong, what's the right Listuguj form?</p>
</div>
<div class="sizing"><b>Preliminary sizing</b> (machine, no input needed):<table>
<tr><td>phenomenon</td>${Object.entries(phenomCount).map(([k,v])=>`<td><span class="tag" style="background:${TAG_COLOR[k]}">${k}</span> ${v}</td>`).join('')}</tr>
</table><table>
${Object.entries(bucketCount).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
</table>${critical} of ${cards.length} need the gold reading.</div>
<p>Legend: ${legend}</p>
${cardHtml}
</body></html>`;
    const htmlPath = new URL('../resources/pm-li-taxonomy.html', import.meta.url).pathname;
    Deno.writeTextFileSync(htmlPath, html);
    console.log(`\nwrote ${htmlPath}`);
    console.log(`wrote ${dataPath} (machine data)`);
    console.log(`verdicts (human, merged, never overwritten): ${verdictPath}`);
}

if(import.meta.main) main();
