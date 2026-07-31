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
const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
/** `a` rendered with the chars that differ from `b` marked; an `ins` (b has
 *  a char a lacks) leaves a thin gap caret so a missing letter is visible. */
function markDiff(a: string, b: string): string {
    let out = '';
    for(const o of align(a, b)) {
        if(o.op === '=') out += esc(o.a);
        else if(o.op === 'sub') out += `<mark>${esc(o.a)}</mark>`;
        else if(o.op === 'del') out += `<mark>${esc(o.a)}</mark>`;   // a has an extra char
        else out += `<i class="gap"></i>`;                          // b has a char a lacks
    }
    return out;
}

// Phenomenon chip hues — kept semantic (each a distinct lever family) but
// pulled toward muted, ink-compatible tones so ten chips don't shout.
const TAG_COLOR: Record<string,string> = {
    length: '#9a7b2e', uvular: '#2f6f97', glide: '#2f8f86',
    'vowel-quality': '#6f8a3c', epenthesis: '#6a6aa8', palatal: '#b0662f',
    suffix: '#b0537a', data: '#8b9296', 'gloss-leak': '#5a6b72', residual: '#c0453a',
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

// Output goes to resources/generated/ (a GITIGNORED dir of pipeline-built
// artifacts shipped to staging by updateStaging.sh rsync, NOT committed -
// dz 2026-07-31: committing regenerated HTML churns git + conflicts).
// Paths are import.meta.url-relative so they resolve the same whatever the
// cwd (the CLI runs from mmo/, this script from repo root).
const GEN_DIR = new URL('../resources/generated/', import.meta.url).pathname;
const HTML_PATH = GEN_DIR + 'pm-li-taxonomy.html';
const DATA_PATH = GEN_DIR + 'pm-li-taxonomy-data.json';
// The human verdict layer STAYS committed (small, no churn) beside this file.
const VERDICT_PATH = new URL('./pm-li-taxonomy-verdicts.json', import.meta.url).pathname;

export interface TaxonomyStats {
    holdout: number; hits: number; misses: number; critical: number;
    phenomCount: Record<string, number>; bucketCount: Record<string, number>;
    htmlPath: string;
}

/** Build the review page + machine-data JSON from an oracle (pairs from the
 *  db via the pm-li extractCorpus, or a scratch json in dev).  Returns
 *  sizing stats for the caller to log/report.  Writes into resources/
 *  generated/ (created if absent). */
export function buildPmLiTaxonomy(rawPairs: unknown[]): TaxonomyStats {
    Deno.mkdirSync(GEN_DIR, {recursive: true});
    const hold = splitPairs((rawPairs as any[]).map(normalizeCorpusPair), 'holdout').pairs;

    // Existing human verdicts (persisted; MERGED by id, never overwritten).
    let verdicts: Record<string, any> = {};
    try { verdicts = JSON.parse(Deno.readTextFileSync(VERDICT_PATH)); } catch { /* none yet */ }

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
    Deno.writeTextFileSync(DATA_PATH, JSON.stringify(cards, null, 1));
    const critical = cards.filter(c => c.expertCritical).length;

    // review page
    const chip = (t: string, n?: number) =>
        `<span class="tag" style="background:${TAG_COLOR[t] ?? 'var(--muted)'}">${t}</span>`
        + (n !== undefined ? `<span class="count">${n}</span>` : '');
    const cardHtml = cards.map(c => {
        const tags = c.tags.map((t:string) => chip(t)).join(' ');
        const q = c.bucket === 'morph-suspect'
            ? `Is the gold a tidy <i>citation / dictionary</i> spelling rather than a faithful transcription of what Pacifique wrote?  &nbsp;☐&nbsp;yes, regularized &nbsp;·&nbsp; ☐&nbsp;no, the auto form is wrong`
            : `The auto form looks wrong.  Correct Listuguj: <span class="blank"></span> &nbsp;·&nbsp; ☐&nbsp;or the gold is a regularized citation form`;
        const v = c.verdict ? `<div class="verdict">✓ recorded: ${esc(JSON.stringify(c.verdict))}</div>` : '';
        return `<article class="card ${c.expertCritical?'crit':''}">
  <div class="form src"><span class="eyebrow">Pacifique</span><span class="val word">${esc(c.source)}</span></div>
  <div class="form auto"><span class="eyebrow">auto</span><span class="val word">${markDiff(c.machine, c.gold)}</span></div>
  <div class="form gold"><span class="eyebrow">Listuguj</span><span class="val word">${markDiff(c.gold, c.machine)}</span></div>
  <div class="meta">${tags}<span class="lever">lever ${esc(c.lever)}</span></div>
  <div class="rules">rules: ${c.fired.length ? esc(c.fired.join(' · ')) : '—'}</div>
  ${c.expertCritical ? `<div class="q">${q}</div>` : ''}${v}
</article>`;
    }).join('\n');

    const TOK_LIGHT = `--paper:#f7f5ef;--card:#fffef9;--ink:#26282d;--muted:#6d7178;--line:#e5e0d5;--accent:#2c6e9b;--pacifique:#8a6a3c;--crit:#b0537a;--crit-bg:#fbf3f6`;
    const TOK_DARK  = `--paper:#181a1e;--card:#20232a;--ink:#e7e5de;--muted:#9aa0a8;--line:#31353d;--accent:#6ab0e0;--pacifique:#c99f5f;--crit:#d07aa0;--crit-bg:#251a20`;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pacifique → Listuguj spelling review</title>
<style>
 :root{${TOK_LIGHT}}
 @media (prefers-color-scheme:dark){:root{${TOK_DARK}}}
 :root[data-theme="dark"]{${TOK_DARK}} :root[data-theme="light"]{${TOK_LIGHT}}
 *{box-sizing:border-box} html{-webkit-text-size-adjust:100%}
 body{margin:0;background:var(--paper);color:var(--ink);line-height:1.55;
   font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
 .wrap{max-width:820px;margin:0 auto;padding:2.6rem 1.3rem 5rem}
 .word{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
 h1{font-size:1.55rem;font-weight:600;letter-spacing:-.01em;text-wrap:balance;margin:0 0 .35rem}
 .lead{color:var(--muted);font-size:.95rem;margin:0 0 1.7rem;max-width:60ch}
 .note{background:var(--card);border:1px solid var(--line);border-radius:12px;
   padding:1.05rem 1.3rem;margin:0 0 1.5rem;font-size:.92rem;max-width:64ch}
 .note p{margin:.45rem 0} .note p:first-child{margin-top:0} .note p:last-child{margin-bottom:0}
 .sizing{display:flex;flex-wrap:wrap;gap:.45rem;margin:0 0 .5rem;align-items:center}
 .tag{color:#fff;padding:.08rem .52rem;border-radius:999px;font-size:.68rem;font-weight:600;
   letter-spacing:.02em;white-space:nowrap;display:inline-block}
 .count{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.78rem;margin:0 .5rem 0 .18rem}
 .buckets{font-size:.86rem;color:var(--muted);font-variant-numeric:tabular-nums;margin:.2rem 0 2rem}
 .buckets b{color:var(--ink)} .buckets .sep{opacity:.4;margin:0 .5rem}
 .card{background:var(--card);border:1px solid var(--line);border-radius:12px;
   padding:1rem 1.2rem;margin:.65rem 0}
 .card.crit{border-color:var(--crit)}
 .form{display:flex;align-items:baseline;gap:.75rem;margin:.1rem 0}
 .eyebrow{flex:0 0 4.6rem;font-size:.64rem;text-transform:uppercase;letter-spacing:.09em;
   color:var(--muted);font-weight:700;text-align:right}
 .form .val{font-size:1.3rem;line-height:1.3}
 .form.src .val{color:var(--pacifique)} .form.gold .val{color:var(--accent)}
 mark{background:none;font-weight:700} .form.auto mark{color:var(--crit)} .form.gold mark{color:var(--accent)}
 .gap{display:inline-block;width:.34em;border-bottom:2px solid currentColor;opacity:.35;
   margin:0 .03em;vertical-align:.16em}
 .meta{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;margin-top:.65rem}
 .lever{color:var(--muted);font-size:.76rem;margin-left:.15rem}
 .rules{color:var(--muted);font-size:.77rem;font-style:italic;margin-top:.4rem}
 .q{margin-top:.75rem;padding:.6rem .75rem;border-left:3px solid var(--crit);border-radius:0 7px 7px 0;
   background:color-mix(in srgb,var(--crit) 8%,transparent);font-size:.86rem}
 .blank{border-bottom:1px solid var(--muted);display:inline-block;min-width:8rem;height:1em}
 .verdict{margin-top:.45rem;font-size:.78rem;color:var(--accent)}
</style></head><body><div class="wrap">
<h1>Pacifique → Listuguj — spelling reading</h1>
<p class="lead">${cards.length} words where the automatic Pacifique-to-Listuguj spelling disagrees with the hand gold, grouped by the kind of difference. A first pass by the computer — your eyes only where marked.</p>
<div class="note">
<p><b>What to do.</b> Look at the cards outlined in <span style="color:var(--crit);font-weight:600">pink</span> — those are the ${critical} where the computer isn't sure. For each, one small question: is the gold a tidy dictionary form, or is the automatic guess simply wrong? The other cards the computer already handled.</p>
<p><b>Stop whenever.</b> Anything you mark is saved by word and stays put when we improve the rules and rebuild this list — a few now and more later both count.</p>
</div>
<div class="sizing">${Object.entries(phenomCount).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([k,v])=>chip(k,v)).join('')}</div>
<div class="buckets">${Object.entries(bucketCount).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<b>${v}</b> ${k}`).join('<span class="sep">·</span>')}<span class="sep">·</span><b>${critical}</b> need the gold reading</div>
${cardHtml}
</div></body></html>`;
    Deno.writeTextFileSync(HTML_PATH, html);
    return {holdout: hold.length, hits, misses: cards.length, critical, phenomCount, bucketCount, htmlPath: HTML_PATH};
}

// Standalone DEV entry: read a scratch corpus json (the CLI subcommand
// build-pm-li-taxonomy is the pipeline path - it reads the db).
function main() {
    const corpusPath = Deno.args[0] ?? 'transliteration-pairs-pm-li.json';
    const s = buildPmLiTaxonomy(JSON.parse(Deno.readTextFileSync(corpusPath)));
    console.log(`pm-li holdout: ${s.holdout} pairs, ${s.hits} hits, ${s.misses} misses`);
    for(const [k,v] of Object.entries(s.phenomCount).filter(([,v]) => v > 0).sort((a,b)=>b[1]-a[1]))
        console.log(`  ${k.padEnd(13)} ${v}`);
    console.log(`${s.critical} expert-critical → wrote ${s.htmlPath}`);
}

if(import.meta.main) main();
