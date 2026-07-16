// deno-lint-ignore-file no-explicit-any
/**
 * LLM transcription of PDM bounding groups (dz 2026-07-11): the page-primary
 * flow's reading step.  Built on liminal's scan->extract substrate (layer 1
 * only - extract.ts's cached staged primitive + llm.ts; no jobs/queue/UI).
 *
 * THE RECIPE mirrors the manual workflow's three fields on document_reference:
 *   1. transcribe     - letter-by-letter, abbreviations kept
 *   2. expand         - abbreviations expanded, elided stems restored
 *   3. transliterate  - French -> English, Pacifique -> Listuguj orthography
 *
 * Two mechanisms carried over from the LI->SF transliteration work (dz):
 *   - AMBIGUITY: the model may write [a|b] (or ⁇ for illegible) instead of
 *     being forced to pick; stage 2 resolves markers context permits.  The
 *     eval scores an ambiguous span as right if EITHER alternative matches.
 *   - CONFIDENCE: each stage returns a global 0-100 confidence; the eval
 *     reports confidence vs actual similarity (is it calibrated?).
 *
 * PHASE 1 IS READ-ONLY: the eval CLI (`./wordwiki.sh transcribe-eval`)
 * compares LLM output against the hand transcriptions and never writes to
 * the dict.  Costs: every stage is memoised in the derived store keyed on
 * [image, model, promptVersion, imageBox, stage, priorInput] - bumping one
 * stage's PROMPT_VERSION re-runs that stage (and downstream) only, and
 * re-running a batch is free until something changes.  Actual API usage is
 * tallied per stage via the onUsage hook (cache hits cost nothing).
 */
import { db } from "../liminal/db.ts";
import { block } from "../liminal/strings.ts";
import * as content from "../liminal/content-store.ts";
import * as utils_config from "../liminal/utils-config.ts";
import { loadLlm, LlmUsage } from "../liminal/llm.ts";
import { extractStage, ExtractConfig, ExtractRecipe, ExtractStage,
         ExtractImageSource } from "../liminal/extract.ts";
import { levenshteinDistance } from "../liminal/levenshtein-distance.ts";
import { diffValues } from './diff.ts';
import { renderToStringViaLinkeDOM } from '../liminal/markup.ts';
import { selectBoundingBoxesForGroup, selectScannedPage } from './scanned-document.ts';

// ---------------------------------------------------------------------------------
// --- Group crop (a derived, content-addressed JPEG of the group's region) ---------
// ---------------------------------------------------------------------------------

const CROP_MARGIN = 12;

/** The derived crop of a bounding group's box-union (+margin) from its source
 *  page image.  Returns a content path ('derived/group-crops/...jpg') - being
 *  content-addressed by [page image, rect], it stands in for the pixels in
 *  the extraction cache key (boxes move => different rect => different key). */
export async function groupCropPath(bounding_group_id: number): Promise<string> {
    const boxes = selectBoundingBoxesForGroup().all({bounding_group_id});
    if(boxes.length === 0)
        throw new Error(`bounding group ${bounding_group_id} has no boxes`);
    // Single-page groups are the norm; a multi-page group crops its first
    // page's boxes (same first-page pick as the URL helpers).
    const page_id = boxes.map(b=>b.page_id).toSorted((a,b)=>a-b)[0];
    const pageBoxes = boxes.filter(b=>b.page_id === page_id);
    const page = selectScannedPage().required({page_id});
    const x = Math.max(0, Math.min(...pageBoxes.map(b=>b.x)) - CROP_MARGIN);
    const y = Math.max(0, Math.min(...pageBoxes.map(b=>b.y)) - CROP_MARGIN);
    const right = Math.min(page.width, Math.max(...pageBoxes.map(b=>b.x+b.w)) + CROP_MARGIN);
    const bottom = Math.min(page.height, Math.max(...pageBoxes.map(b=>b.y+b.h)) + CROP_MARGIN);
    const w = Math.max(1, Math.round(right - x)), h = Math.max(1, Math.round(bottom - y));
    return 'derived/' + await content.getDerived(
        'derived/group-crops', {groupCropCmd},
        ['groupCropCmd', page.image_ref, Math.round(x), Math.round(y), w, h], 'jpg');
}

async function groupCropCmd(targetResultPath: string, sourceImagePath: string,
                            x: number, y: number, w: number, h: number) {
    const { code, stderr } = await new Deno.Command(
        utils_config.imageMagickPath, {
            args: [sourceImagePath, '-crop', `${w}x${h}+${x}+${y}`, '+repage',
                   '-quality', '90', `jpg:${targetResultPath}`],
        }).output();
    if(code !== 0)
        throw new Error(`failed to crop ${sourceImagePath}: ${new TextDecoder().decode(stderr)}`);
}

/** ExtractImageSource over the derived crops: photoPath IS a crop path;
 *  containedBytes bounds it to the stage's imageBox via a cached shrink
 *  (never enlarges). */
export const groupCropImageSource: ExtractImageSource = {
    async containedBytes(photoPath: string, boxW: number, boxH: number,
                         rotate: number): Promise<Uint8Array> {
        const contained = 'derived/' + await content.getDerived(
            'derived/group-crops-contained', {containCmd},
            ['containCmd', photoPath, boxW, boxH, rotate], 'jpg');
        return Deno.readFile(contained);
    },
};

async function containCmd(targetResultPath: string, sourceImagePath: string,
                          boxW: number, boxH: number, rotate: number) {
    const { code, stderr } = await new Deno.Command(
        utils_config.imageMagickPath, {
            args: [sourceImagePath,
                   ...(rotate ? ['-rotate', String(rotate)] : []),
                   '-resize', `${boxW}x${boxH}>`,   // shrink-only
                   '-quality', '88', `jpg:${targetResultPath}`],
        }).output();
    if(code !== 0)
        throw new Error(`failed to contain ${sourceImagePath}: ${new TextDecoder().decode(stderr)}`);
}

// ---------------------------------------------------------------------------------
// --- The recipe --------------------------------------------------------------------
// ---------------------------------------------------------------------------------

// Bump a stage's version to re-run it (and everything downstream) on the
// next eval - the ONLY cost of a prompt iteration.
export const PROMPT_VERSION_TRANSCRIBE = 2;   // v2: language-tagged runs (dz)
export const PROMPT_VERSION_EXPAND = 2;       // v2: language-tagged runs (dz)
export const PROMPT_VERSION_TRANSLITERATE = 2; // v2: runs input + corpus-mined correspondences

const AMBIGUITY_RULES = block`
/**/If you are genuinely unsure between readings, DO NOT silently pick one:
/**/write the alternatives in square brackets separated by | (e.g. "pi[l|i]ei"
/**/means the letter could be l or i).  Use ⁇ for a truly illegible character.
/**/Use these sparingly - only where you are actually unsure.`;

const CONFIDENCE_RULES = block`
/**/Also return "confidence": an integer 0-100, your overall confidence that
/**/your text is correct (100 = certain).  Be honest - this number is used to
/**/decide which results need human review.`;

const textStageSchema = (field: string, description: string) => ({
    type: 'object',
    properties: {
        [field]: {type: 'string', description},
        confidence: {type: 'integer', description: 'overall confidence 0-100'},
    },
    required: [field, 'confidence'],
});

// LANGUAGE-TAGGED RUNS (dz 2026-07-11: marking content language early makes
// everything downstream less ambiguous).  Stages 1-2 return the text as an
// ordered list of runs, each tagged mm (Mi'gmaq, Pacifique orthography),
// fr (French) or cit (citations/references/section marks, to be preserved
// verbatim).  Structured in the SCHEMA rather than in-band ({word:fr}-style
// markers) so the tagging can never collide with the text's own brackets
// or the [a|b] ambiguity markers.
export interface TaggedRun { text: string; lang: 'mm' | 'fr' | 'cit'; }

const runsStageSchema = (description: string) => ({
    type: 'object',
    properties: {
        runs: {
            type: 'array', description,
            items: {
                type: 'object',
                properties: {
                    text: {type: 'string', description: 'the run text, verbatim (punctuation attached)'},
                    lang: {type: 'string', enum: ['mm', 'fr', 'cit'],
                           description: "mm = Mi'gmaq (Pacifique orthography), fr = French, cit = citation/reference/other (preserve verbatim)"},
                },
                required: ['text', 'lang'],
            },
        },
        confidence: {type: 'integer', description: 'overall confidence 0-100'},
    },
    required: ['runs', 'confidence'],
});

/** Flatten tagged runs to plain text (the hand data is untagged - scoring
 *  and the final landing are flat). */
export function runsToText(runs: unknown): string {
    if(!Array.isArray(runs)) return '';
    return runs.map(r => String((r as any)?.text ?? '')).join(' ');
}

/** Render runs WITH their tags, for the report / downstream prompts. */
export function runsToTagged(runs: unknown): string {
    if(!Array.isArray(runs)) return '';
    return runs.map(r => `${String((r as any)?.text ?? '')}⟨${String((r as any)?.lang ?? '?')}⟩`).join(' ');
}

function transcribeStage(): ExtractStage {
    return {
        name: 'transcribe', model: '', promptVersion: PROMPT_VERSION_TRANSCRIBE,
        imageBox: 1600,
        schema: runsStageSchema('the letter-by-letter transcription as language-tagged runs, in reading order'),
        prompt: () => block`
/**/You are reading ONE ENTRY cropped from Father Pacifique's handwritten
/**/Mi'gmaq-French dictionary manuscript (early 1900s).  The text mixes
/**/Mi'gmaq words (in Pacifique's own orthography) with French glosses, and
/**/uses heavy abbreviation.
/**/
/**/Transcribe the handwriting LETTER-BY-LETTER, exactly as written:
/**/- Keep every abbreviation, punctuation mark, diacritic (ā, ŏ, ê, ...),
/**/  parenthesis and reference citation (e.g. "(Pi. Met.)", "(Jo. 368)")
/**/  exactly as it appears.
/**/- Do NOT expand abbreviations, translate, or normalize spelling.
/**/- Preserve the reading order; keep the punctuation actually written,
/**/  attached to its run.
/**/- Return the text as an ordered list of RUNS, each tagged with its
/**/  language: "mm" for Mi'gmaq words (Pacifique's orthography), "fr" for
/**/  French, "cit" for citations/references/section marks (e.g.
/**/  "(Pi. Met.)", "(Jo. 368)").  Split runs exactly at language changes.
/**/${AMBIGUITY_RULES}
/**/${CONFIDENCE_RULES}`,
    };
}

function expandStage(): ExtractStage {
    return {
        name: 'expand', model: '', promptVersion: PROMPT_VERSION_EXPAND,
        imageBox: 1600,
        schema: runsStageSchema('the expanded transcription as language-tagged runs, in reading order'),
        prompt: (input: any) => block`
/**/The image is ONE ENTRY from Father Pacifique's handwritten Mi'gmaq-French
/**/dictionary manuscript.  Below is a letter-by-letter transcription of it.
/**/Rewrite the transcription with the abbreviations EXPANDED, changing
/**/nothing else:
/**/- Expand French abbreviations in place (e.g. "milieu d. l. n." ->
/**/  "milieu de la nuit", "p.ê." -> "peut être").
/**/- Pacifique often writes a family of related Mi'gmaq words and elides the
/**/  repeated stem, giving only the changed ending (e.g. "aptepogoei, goet"
/**/  means the second word is "aptepogoet").  Restore the full word for each
/**/  elided form, taking the stem from the neighbouring full words.
/**/- Keep the original spelling/orthography of the Mi'gmaq words; keep
/**/  citations like "(Pi. Met.)" unchanged; do NOT translate.
/**/- The transcription may contain [a|b] ambiguity markers or ⁇ for
/**/  illegible characters.  Consult the image: where the context or the ink
/**/  resolves the ambiguity, write the resolved reading; where it does not,
/**/  keep the marker.
/**/- Keep the language-tagged RUN structure ("mm" Mi'gmaq / "fr" French /
/**/  "cit" citation, in reading order); correct a run's tag if the
/**/  transcription mis-tagged it.
/**/${AMBIGUITY_RULES}
/**/${CONFIDENCE_RULES}
/**/
/**/Transcription (tagged runs):
/**/${runsToTagged(input?.runs)}`,
    };
}

function transliterateStage(): ExtractStage {
    return {
        name: 'transliterate', model: '', promptVersion: PROMPT_VERSION_TRANSLITERATE,
        imageBox: 1600,
        schema: textStageSchema('transliteration',
            'French translated to English; Mi\'gmaq converted to Listuguj orthography'),
        prompt: (input: any) => block`
/**/Below is the expanded transcription of one entry from Father Pacifique's
/**/handwritten Mi'gmaq-French dictionary, as language-tagged runs
/**/(word⟨mm⟩ = Mi'gmaq in Pacifique's orthography, word⟨fr⟩ = French,
/**/word⟨cit⟩ = citation/reference).  Produce the modern working version as
/**/ONE flat text, keeping the order and punctuation:
/**/- ⟨fr⟩ runs: translate the French into English.
/**/- ⟨mm⟩ runs: convert from Pacifique's orthography into the Listuguj
/**/  orthography.  Corpus-attested correspondences (Pacifique -> Listuguj):
/**/    aposgigen -> apusqi'gn;  pitoigatem -> pituigatm;
/**/    agtatpag -> aqtatpa'q;  mosgoatem -> musgwatm;
/**/    mosgŏmg -> musqomg;  aptepogoei -> apt'puguei;
/**/    eoltjeoetji -> ewuljewe'ji;  pepgoitjetegei -> pepguijete'gei;
/**/    nenatoigtjemsit -> nenatuigjemsit;  nāntemigtjemg -> na'ntemigjemg.
/**/  Recurring patterns in those pairs: o before a consonant usually -> u;
/**/  tj -> j; g before t/p often -> q; ā -> a'; oe -> we/ue; word-final
/**/  -em -> -m (vowel dropped); an unstressed initial vowel may take an
/**/  apostrophe (aptepogoei -> apt'puguei).
/**/- ⟨cit⟩ runs: copy VERBATIM, unchanged (citations like "(Pi. Met.)",
/**/  "(Jo. 368)" are references, never translated).
/**/- If the input contains [a|b] ambiguity markers or ⁇, carry the
/**/  uncertainty through (resolve it only if the target orthography makes
/**/  one reading clearly right).
/**/${AMBIGUITY_RULES}
/**/${CONFIDENCE_RULES}
/**/
/**/Expanded transcription (tagged runs):
/**/${runsToTagged(input?.runs)}`,
    };
}

export function pdmRecipe(): ExtractRecipe {
    return [transcribeStage(), expandStage(), transliterateStage()];
}

// ---------------------------------------------------------------------------------
// --- Ambiguity-aware similarity scoring --------------------------------------------
// ---------------------------------------------------------------------------------

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Expand [a|b] markers into concrete candidate strings (cartesian, capped -
 *  beyond the cap the remaining markers keep their first alternative). */
export function ambiguityCandidates(s: string, cap = 64): string[] {
    let candidates = [''];
    const parts = s.split(/(\[[^\][]*\|[^\][]*\])/);
    for(const part of parts) {
        const m = /^\[([^\][]*)\]$/.exec(part);
        const alts = m ? m[1].split('|') : [part];
        const useAlts = candidates.length * alts.length <= cap ? alts : [alts[0]];
        candidates = candidates.flatMap(c => useAlts.map(a => c + a));
    }
    return candidates;
}

/** The candidate (markers resolved) that best matches the gold text - the
 *  diff display diffs THIS against the hand answer, so an honest [a|b]
 *  doesn't paint as an error; the raw marked text is shown alongside. */
export function bestCandidate(llmText: string, handText: string): string {
    const gold = norm(handText);
    let best = norm(llmText), bestSim = -1;
    for(const cand of ambiguityCandidates(norm(llmText))) {
        const d = levenshteinDistance(cand, gold);
        const s = 1 - d / Math.max(cand.length, gold.length, 1);
        if(s > bestSim) { bestSim = s; best = cand; }
    }
    return best;
}

/** Normalized similarity in [0,1]: 1 - lev/maxlen, over NFC/whitespace-
 *  normalized strings; an [a|b] ambiguity scores as its BEST alternative
 *  (honest uncertainty is never penalized vs a lucky guess). */
export function similarity(llmText: string, handText: string): number {
    const gold = norm(handText);
    if(gold === '' && norm(llmText) === '') return 1;
    let best = 0;
    for(const cand of ambiguityCandidates(norm(llmText))) {
        const d = levenshteinDistance(cand, gold);
        const s = 1 - d / Math.max(cand.length, gold.length, 1);
        if(s > best) best = s;
    }
    return best;
}

// ---------------------------------------------------------------------------------
// --- The eval ----------------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface EvalItem {
    ref_id: number;
    bounding_group_id: number;
    hand: {transcription: string, expanded?: string, transliteration?: string};
}

/** The gold sample: refs in `book` (by the group's document) carrying a
 *  non-empty hand transcription, in stable ref-id order (deterministic
 *  sample => maximal cache reuse as the sample grows). */
export function goldSample(book: string, sample: number, offset: number): EvalItem[] {
    const EOT = 9007199254740991;
    const rows = db().all<{ref_id: number, grp: number,
                           tr: string|null, ex: string|null, tl: string|null}, any>(
        block`
/**/   SELECT r.id AS ref_id, r.attr1 AS grp,
/**/          (SELECT t.attr1 FROM dict t WHERE t.ty='rtr' AND t.id3=r.id AND t.valid_to=:eot ORDER BY t.order_key LIMIT 1) tr,
/**/          (SELECT t.attr1 FROM dict t WHERE t.ty='rex' AND t.id3=r.id AND t.valid_to=:eot ORDER BY t.order_key LIMIT 1) ex,
/**/          (SELECT t.attr1 FROM dict t WHERE t.ty='rtl' AND t.id3=r.id AND t.valid_to=:eot ORDER BY t.order_key LIMIT 1) tl
/**/     FROM dict r
/**/     JOIN bounding_group bg ON r.attr1 = bg.bounding_group_id
/**/     JOIN scanned_document d ON bg.document_id = d.document_id
/**/     WHERE r.ty = 'ref' AND r.valid_to = :eot
/**/           AND d.friendly_document_id = :book
/**/     ORDER BY r.id
/**/     LIMIT :lim OFFSET :off`,
        {eot: EOT, book, lim: sample * 4 + offset + 40, off: 0} as any);
    return rows
        .filter(r => (r.tr ?? '').trim() !== '')
        .slice(offset, offset + sample)
        .map(r => ({ref_id: r.ref_id, bounding_group_id: r.grp,
                    hand: {transcription: r.tr!,
                           expanded: r.ex ?? undefined,
                           transliteration: r.tl ?? undefined}}));
}

export interface TranscribeEvalOptions {
    book: string;
    sample: number;
    offset: number;
    reportPath?: string;    // side-by-side markdown (the quick CLI artifact)
    jsonPath?: string;      // the batch DATA (the html is a pure function of it)
    htmlPath?: string;      // self-contained REVIEW PAGE (research-group shareable)
    log?: (m: string) => void;
}

const STAGE_FIELD: Record<string, keyof EvalItem['hand']> =
    {transcribe: 'transcription', expand: 'expanded', transliterate: 'transliteration'};

export async function transcribeEval(opts: TranscribeEvalOptions): Promise<void> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const llm = loadLlm('wordwiki');
    if(!llm.available)
        throw new Error('wordwiki-anthropic-credential.json missing/invalid - LLM unavailable');

    // Per-stage usage tally: only ACTUAL API calls land here (cache hits are
    // free), so the totals are the batch's real spend.
    const usage = new Map<string, LlmUsage & {calls: number}>();
    const cfg: ExtractConfig = {
        derivedDir: 'derived',
        image: groupCropImageSource,
        llm,
        onUsage: (stageName, u) => {
            const t = usage.get(stageName) ?? {inputTokens: 0, outputTokens: 0, calls: 0};
            t.inputTokens += u.inputTokens; t.outputTokens += u.outputTokens; t.calls++;
            usage.set(stageName, t);
        },
    };

    const items = goldSample(opts.book, opts.sample, opts.offset);
    log(`transcribe-eval: ${items.length} ${opts.book} refs with hand transcriptions ` +
        `(offset ${opts.offset}); prompt versions t${PROMPT_VERSION_TRANSCRIBE}/` +
        `e${PROMPT_VERSION_EXPAND}/x${PROMPT_VERSION_TRANSLITERATE}`);

    const recipe = pdmRecipe();
    const results: Array<{item: EvalItem, crop: string,
                          stages: Record<string, {text: string, tagged?: string,
                                                  confidence: number, sim?: number}>}> = [];
    const sums: Record<string, {sim: number, n: number, conf: number}> = {};

    for(const [i, item] of items.entries()) {
        const crop = await groupCropPath(item.bounding_group_id);
        const stages: Record<string, {text: string, tagged?: string,
                                      confidence: number, sim?: number}> = {};
        let input: unknown = null;
        for(const stage of recipe) {
            const out: any = await extractStage(cfg, crop, 0, stage, input);
            input = out;
            const field = STAGE_FIELD[stage.name];
            // Stages 1-2 return language-tagged RUNS; the final stage is flat.
            const text = out?.runs !== undefined
                ? runsToText(out.runs)
                : String(out?.transliteration ?? '');
            const confidence = Number(out?.confidence ?? 0);
            const hand = item.hand[field];
            const sim = hand !== undefined && hand.trim() !== ''
                ? similarity(text, hand) : undefined;
            stages[stage.name] = {text, confidence, sim,
                tagged: out?.runs !== undefined ? runsToTagged(out.runs) : undefined};
            if(sim !== undefined) {
                const s = sums[stage.name] ?? {sim: 0, n: 0, conf: 0};
                s.sim += sim; s.n++; s.conf += confidence;
                sums[stage.name] = s;
            }
        }
        results.push({item, crop, stages});
        log(`  [${i+1}/${items.length}] ref ${item.ref_id} group ${item.bounding_group_id}: ` +
            recipe.map(st => {
                const r = stages[st.name];
                return `${st.name}=${r.sim !== undefined ? (r.sim*100).toFixed(0)+'%' : '-'}` +
                       `(c${r.confidence})`;
            }).join(' '));
    }

    // --- Summary
    log('');
    for(const stage of recipe) {
        const s = sums[stage.name];
        if(s && s.n > 0)
            log(`${stage.name}: mean similarity ${(s.sim/s.n*100).toFixed(1)}% ` +
                `over ${s.n} refs, mean confidence ${(s.conf/s.n).toFixed(0)}`);
        else
            log(`${stage.name}: no gold data to score in this sample`);
    }
    let totalIn = 0, totalOut = 0, totalCalls = 0;
    for(const [name, u] of usage.entries()) {
        log(`usage ${name}: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out tokens`);
        totalIn += u.inputTokens; totalOut += u.outputTokens; totalCalls += u.calls;
    }
    log(`usage total: ${totalCalls} API calls, ${totalIn} input + ${totalOut} output tokens` +
        (totalCalls === 0 ? ' (all cache hits - free run)' : ''));

    // --- The side-by-side report (what actually drives prompt iteration).
    if(opts.reportPath) {
        const md: string[] = [];
        md.push(`# transcribe-eval: ${opts.book}, sample ${opts.sample} offset ${opts.offset}`);
        md.push('');
        md.push(`Prompt versions: transcribe v${PROMPT_VERSION_TRANSCRIBE}, ` +
                `expand v${PROMPT_VERSION_EXPAND}, transliterate v${PROMPT_VERSION_TRANSLITERATE}.`);
        md.push('');
        for(const r of results) {
            md.push(`## ref ${r.item.ref_id} — group ${r.item.bounding_group_id}`);
            md.push('');
            md.push(`![group](${r.crop})`);
            md.push('');
            for(const stage of recipe) {
                const field = STAGE_FIELD[stage.name];
                const st = r.stages[stage.name];
                const hand = r.item.hand[field];
                md.push(`**${stage.name}** ` +
                        (st.sim !== undefined ? `(similarity ${(st.sim*100).toFixed(0)}%, ` : '(') +
                        `confidence ${st.confidence})`);
                md.push('');
                md.push(`- hand: ${hand ?? '*(none)*'}`);
                md.push(`- llm:  ${st.tagged ?? st.text}`);
                md.push('');
            }
        }
        await Deno.writeTextFile(opts.reportPath, md.join('\n'));
        log(`report written to ${opts.reportPath}`);
    }

    // --- The batch DATA + the self-contained REVIEW PAGE (dz: dropped in
    //     resources/ so it is served at /resources/... and linked from the
    //     Reports menu - reviewers wander off through word links and find
    //     their way back; still single-file so the same page can be mailed
    //     to the research group or archived).
    const data: EvalData = {
        generatedAt: new Date().toISOString(),
        book: opts.book, sample: opts.sample, offset: opts.offset,
        promptVersions: {transcribe: PROMPT_VERSION_TRANSCRIBE,
                         expand: PROMPT_VERSION_EXPAND,
                         transliterate: PROMPT_VERSION_TRANSLITERATE},
        prompts: Object.fromEntries(recipe.map(st =>
            [st.name, {version: st.promptVersion, text: st.prompt(EXAMPLE_PROMPT_INPUT[st.name] ?? null)}])),
        usage: Object.fromEntries([...usage.entries()]),
        items: results.map(r => ({
            ref_id: r.item.ref_id,
            bounding_group_id: r.item.bounding_group_id,
            crop: r.crop,
            hand: r.item.hand,
            llm: r.stages,
        })),
    };
    if(opts.jsonPath) {
        await Deno.writeTextFile(opts.jsonPath, JSON.stringify(data, null, 1));
        log(`data written to ${opts.jsonPath}`);
    }
    if(opts.htmlPath) {
        await Deno.writeTextFile(opts.htmlPath, await renderEvalHtml(data));
        log(`review page written to ${opts.htmlPath}`);
    }
}

// Placeholder inputs so the RULES section can show each stage's full prompt
// (the per-entry text is appended where the placeholder sits).
const EXAMPLE_PROMPT_INPUT: Record<string, unknown> = {
    expand: {runs: [{text: '⟨the transcription runs go here⟩', lang: 'mm'}]},
    transliterate: {runs: [{text: '⟨the expanded runs go here⟩', lang: 'mm'}]},
};

// ---------------------------------------------------------------------------------
// --- The review page (a pure function of the batch data) ---------------------------
// ---------------------------------------------------------------------------------

export interface EvalData {
    generatedAt: string;
    book: string; sample: number; offset: number;
    promptVersions: Record<string, number>;
    prompts: Record<string, {version: number, text: string}>;
    usage: Record<string, {inputTokens: number, outputTokens: number, calls: number}>;
    items: Array<{
        ref_id: number; bounding_group_id: number; crop: string;
        hand: {transcription: string, expanded?: string, transliteration?: string};
        llm: Record<string, {text: string, tagged?: string, confidence: number, sim?: number}>;
    }>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STAGES: Array<{name: string, handField: 'transcription'|'expanded'|'transliteration',
                     label: string}> = [
    {name: 'transcribe', handField: 'transcription', label: 'Transcription'},
    {name: 'expand', handField: 'expanded', label: 'Expanded'},
    {name: 'transliterate', handField: 'transliteration', label: 'Transliteration'},
];

/** Self-contained HTML: inline styles (the .lm-diff-* family copied from
 *  liminal.css so the diff colors match the lexeme change-approval look -
 *  dz), images embedded as data URIs.  Diffs via the changelog's own
 *  diffValues (deletions struck on the researcher line, insertions
 *  highlighted on the LLM line); [a|b] ambiguity resolves to its best
 *  reading for the diff, with the raw marked text shown alongside. */
export async function renderEvalHtml(data: EvalData): Promise<string> {
    const imgSrc = async (crop: string): Promise<string> => {
        try {
            const bytes = await Deno.readFile(crop);
            let bin = '';
            for(const b of bytes) bin += String.fromCharCode(b);
            return `data:image/jpeg;base64,${btoa(bin)}`;
        } catch { return ''; }
    };

    const pct = (x: number|undefined) => x === undefined ? '—' : `${(x*100).toFixed(0)}%`;
    const simClass = (x: number|undefined) =>
        x === undefined ? '' : x >= 0.95 ? 'sim-great' : x >= 0.8 ? 'sim-ok' : 'sim-poor';

    // Summary + calibration over the scored stages.
    const stageStats = STAGES.map(st => {
        const scored = data.items
            .map(it => it.llm[st.name])
            .filter(r => r && r.sim !== undefined) as Array<{sim: number, confidence: number}>;
        const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : undefined;
        return {st, n: scored.length,
                meanSim: mean(scored.map(r=>r.sim)),
                meanConf: mean(scored.map(r=>r.confidence))};
    });
    const calBuckets = [[0,40],[40,60],[60,80],[80,101]];
    const calRows = calBuckets.map(([lo,hi]) => {
        const in_ = data.items.flatMap(it => STAGES.map(st => it.llm[st.name]))
            .filter(r => r && r.sim !== undefined && r.confidence >= lo && r.confidence < hi);
        const meanSim = in_.length ? in_.reduce((a,r)=>a+(r.sim ?? 0),0)/in_.length : undefined;
        return {lo, hi: hi-1, n: in_.length, meanSim};
    });

    const entryHtml: string[] = [];
    for(const [i, it] of data.items.entries()) {
        const img = await imgSrc(it.crop);
        const rows = STAGES.map(st => {
            const llm = it.llm[st.name];
            const hand = it.hand[st.handField];
            if(!llm) return '';
            const marked = /\[[^\][]*\|[^\][]*\]|⁇/.test(llm.text);
            let handHtml: string, llmHtml: string;
            if(hand !== undefined && hand.trim() !== '') {
                const d = diffValues(hand, bestCandidate(llm.text, hand));
                handHtml = renderToStringViaLinkeDOM(d.from);
                llmHtml = renderToStringViaLinkeDOM(d.to);
            } else {
                handHtml = '<span class="none">(none - not yet done by hand)</span>';
                llmHtml = esc(llm.text);
            }
            return `
      <tr class="stage-head"><th colspan="2">${st.label}
        <span class="badge ${simClass(llm.sim)}">similarity ${pct(llm.sim)}</span>
        <span class="badge conf">confidence ${llm.confidence}</span></th></tr>
      <tr><th>researcher</th><td>${handHtml}</td></tr>
      <tr><th>LLM</th><td>${llmHtml}${
          marked ? `<div class="rawmarks">with uncertainty markers: ${esc(llm.text)}</div>` : ''
      }${llm.tagged ? `<div class="tagged">${esc(llm.tagged)}</div>` : ''}</td></tr>`;
        }).join('');
        entryHtml.push(`
  <section class="entry" id="ref-${it.ref_id}">
    <h3>${i+1}. ref ${it.ref_id} <span class="muted">(group ${it.bounding_group_id})</span></h3>
    ${img ? `<img class="crop" src="${img}">` : ''}
    <table class="cmp">${rows}</table>
  </section>`);
    }

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDM LLM transcription eval — ${esc(data.book)} sample ${data.sample}</title>
<style>
 body { font-family: system-ui, sans-serif; margin: 1.5rem auto; max-width: 60rem;
        padding: 0 1rem; color: #1c1c1c; line-height: 1.45; }
 h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
 h3 { font-size: 1rem; margin: 0 0 .4rem; }
 .muted, .none { color: #6c757d; }
 img.crop { max-width: 100%; border: 1px solid #ccc; border-radius: 3px;
            background: #fff; margin-bottom: .4rem; }
 section.entry { margin: 1.6rem 0; padding-top: .8rem; border-top: 1px solid #ddd; }
 table.cmp { border-collapse: collapse; width: 100%; font-size: .95rem; }
 table.cmp th { text-align: left; vertical-align: top; padding: .15rem .6rem .15rem 0;
                white-space: nowrap; font-weight: 600; color: #444; width: 6.5rem; }
 table.cmp td { padding: .15rem 0; }
 tr.stage-head th { padding-top: .6rem; color: #1c1c1c; }
 .badge { font-size: .75rem; font-weight: 600; border-radius: .6rem;
          padding: .05rem .5rem; margin-left: .4rem; vertical-align: middle; }
 .sim-great { background: #d1e7dd; color: #0f5132; }
 .sim-ok    { background: #fff3cd; color: #664d03; }
 .sim-poor  { background: #f8d7da; color: #842029; }
 .conf      { background: #e7f1ff; color: #084298; }
 /* the lexeme change-approval diff family (liminal.css .lm-diff-*), inlined
    so this page is self-contained */
 .lm-diff-del { color: #842029; text-decoration: line-through; }
 .lm-diff-ins { color: #0f5132; background: #d1e7dd; border-radius: 0.15rem;
                padding: 0 0.05rem; }
 .lm-diff-elide { color: #6c757d; }
 .rawmarks { color: #664d03; background: #fff3cd; border-radius: .2rem;
             padding: 0 .25rem; display: inline-block; margin-top: .15rem;
             font-size: .85rem; }
 .tagged { color: #6c757d; font-size: .8rem; margin-top: .1rem; }
 pre.rule { background: #f6f6f6; border: 1px solid #e2e2e2; border-radius: 4px;
            padding: .6rem .8rem; white-space: pre-wrap; font-size: .82rem; }
 table.sum { border-collapse: collapse; margin: .5rem 0; }
 table.sum th, table.sum td { border: 1px solid #ddd; padding: .25rem .7rem;
                              font-size: .9rem; text-align: left; }
 details.rules > summary { cursor: pointer; font-weight: 600; margin: .4rem 0; }
</style></head><body>
<h1>PDM LLM transcription eval</h1>
<p class="muted">${esc(data.book)}, sample ${data.sample} (offset ${data.offset}),
 generated ${esc(data.generatedAt)}.
 Prompt versions: ${STAGES.map(s=>`${s.name} v${data.promptVersions[s.name] ?? '?'}`).join(', ')}.</p>

<p>Each entry shows the scanned group, then the researcher's version and the
LLM's version of each step, with <span class="lm-diff-del">what the LLM
missed struck out</span> on the researcher line and
<span class="lm-diff-ins">what it added or changed highlighted</span> on the
LLM line.  Where the LLM was <span class="rawmarks">unsure it wrote
[a|b]</span> (either reading) or ⁇ (illegible) instead of guessing — those
count as right if either reading matches.</p>

<h2>Summary</h2>
<table class="sum">
 <tr><th>step</th><th>scored</th><th>mean similarity</th><th>mean confidence</th></tr>
 ${stageStats.map(s=>`<tr><td>${s.st.label}</td><td>${s.n}</td>
   <td>${pct(s.meanSim)}</td><td>${s.meanConf === undefined ? '—' : s.meanConf.toFixed(0)}</td></tr>`).join('')}
</table>
<p class="muted">Confidence calibration (does the model's self-reported
confidence predict how good the result actually is?):</p>
<table class="sum">
 <tr><th>confidence</th><th>results</th><th>mean similarity</th></tr>
 ${calRows.map(r=>`<tr><td>${r.lo}–${r.hi}</td><td>${r.n}</td><td>${pct(r.meanSim)}</td></tr>`).join('')}
</table>

<h2>The rules (the instructions given to the model)</h2>
${STAGES.map(s=>`<details class="rules">
 <summary>${s.label} (v${data.prompts[s.name]?.version ?? '?'}) — click to expand</summary>
 <pre class="rule">${esc(data.prompts[s.name]?.text ?? '')}</pre>
</details>`).join('\n')}

<h2>Entries</h2>
${entryHtml.join('\n')}
</body></html>`;
}
