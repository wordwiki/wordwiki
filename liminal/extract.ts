// Layer 1 of the scan -> extract substrate (scan-extract.md): the cached, content-
// addressed extraction primitive.  NO tables, NO job, NO UI - just a pure function
//
//     (image, stage, prompt_version, model, image_box) -> validated JSON
//
// memoised in the derived content store exactly like the derived crop store.  An
// extraction is a `.json` file keyed by the hash of its inputs, so:
//   - re-running a LATER stage (transliterate) reuses every cached EARLIER stage
//     (transcribe) - the per-stage key is what makes that work;
//   - bumping `promptVersion` (or the model, or the image box) re-extracts only what
//     changed;
//   - a killed/again job is nearly free to resume - the cache IS the resumability.
//
// A consumer that already owns its images (PDM: dict page scans + hand-drawn boxes)
// uses this directly as a read-through derived attribute; the flow (jobs, review,
// filing) is Layer 2 and lives in the app.
import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";
import { getDerived } from "./content-store.ts";
import { Llm } from "./llm.ts";

// ---------------------------------------------------------------------------------
// --- Recipe + config --------------------------------------------------------------
// ---------------------------------------------------------------------------------

/**
 * One extraction stage.  An ordered list of these is a recipe; stage k's output feeds
 * stage k+1's input.  Everything that changes the OUTPUT must be in the cache key
 * (name, model, promptVersion, imageBox, input) - anything output-relevant left out of
 * the key silently serves stale extractions.
 */
export interface ExtractStage {
    name: string;                 // 'transcribe' | 'extract' | 'transliterate'
    model: string;                // e.g. 'claude-opus-4-8'  (in the cache key)
    promptVersion: number;        // bump to re-run / re-grade  (in the cache key)
    imageBox: number;             // longest edge fed to the model - a GRADEABLE knob (in
                                  // the key); default 1600.  May exceed 1600 only if the
                                  // source original is kept full-res (a capture exception).
    schema: Record<string, unknown>;   // output JSON schema; the result is validated against it
    // Build the prompt from the prior stage's output.  Stage 0 gets `null`.
    prompt(input: unknown): string;
}
export type ExtractRecipe = ExtractStage[];

// What Layer 1 needs from an image store - structurally satisfied by PhotoService.
// containedBytes returns an oriented, size-bounded JPEG (whole image, never cropped).
export interface ExtractImageSource {
    containedBytes(photoPath: string, boxW: number, boxH: number, rotate: number): Promise<Uint8Array>;
}

export interface ExtractConfig {
    derivedDir: string;           // fs path to the derived store root (PhotoServiceConfig.derivedDir)
    image: ExtractImageSource;    // usually the app's PhotoService
    llm: Llm;                     // usually loadLlm(appName)
}

export const DEFAULT_IMAGE_BOX = 1600;

// ---------------------------------------------------------------------------------
// --- The cached primitive ---------------------------------------------------------
// ---------------------------------------------------------------------------------

/**
 * Run ONE stage over one image, memoised in the derived store.
 *
 * `photoPath` is a bare content path (`content/photos/…`, already content-addressed,
 * so it stands in for the image bytes in the key); `rotate` is parsed from the stored
 * photo value by the caller and passed explicitly (it changes the pixels the model
 * sees, so it's in the key too).  Returns the parsed, schema-validated JSON.
 */
export async function extractStage(cfg: ExtractConfig, photoPath: string, rotate: number,
                                   stage: ExtractStage, input: unknown): Promise<unknown> {
    const box = stage.imageBox || DEFAULT_IMAGE_BOX;
    const inputHash = await digestString(JSON.stringify(input ?? null));
    const contentId = await getDerived(
        `${cfg.derivedDir}/extractions`,
        { extract: async (_target: string) => {
            // rotate-FIRST, then contain to `box` (never crop for the LLM) - both via the
            // existing contained-photo derivation, itself cached & content-addressed.
            const jpeg = await cfg.image.containedBytes(photoPath, box, box, rotate);
            const raw = await cfg.llm.extract(stage.model, stage.prompt(input),
                                              {bytes: jpeg, mediaType: 'image/jpeg'}, stage.schema);
            // A string return is written to the .json file by getDerived.
            return JSON.stringify(validateExtraction(stage.schema, raw));
        }},
        ['extract', photoPath, rotate, stage.model, stage.promptVersion, box, stage.name, inputHash],
        'json');
    return JSON.parse(await readDerived(cfg.derivedDir, contentId));
}

// Run a whole recipe over one image; each stage cached independently.
export async function extractAll(cfg: ExtractConfig, photoPath: string, rotate: number,
                                 recipe: ExtractRecipe): Promise<unknown> {
    let out: unknown = null;
    for(const stage of recipe)
        out = await extractStage(cfg, photoPath, rotate, stage, out);
    return out;
}

// getDerived returns only a contentId (`extractions/<3hex>/<hash>.json`); read the file.
export async function readDerived(derivedDir: string, contentId: string): Promise<string> {
    return Deno.readTextFile(posix.join(derivedDir, contentId));
}

// ---------------------------------------------------------------------------------
// --- Minimal JSON-schema validation -----------------------------------------------
// ---------------------------------------------------------------------------------

// The model's tool output is already schema-constrained by the API, but a landed row
// built from a wrong-shaped extraction would be a real bug, so we still check.  A
// compact validator for the subset we use: type (incl. union arrays like
// ['string','null']), properties, required, items, enum.  Throws with a JSON path;
// returns the value on success.
export function validateExtraction(schema: unknown, value: unknown, path = '$'): unknown {
    const fail = (msg: string) => { throw new Error(`extraction does not match schema at ${path}: ${msg}`); };
    if(!schema || typeof schema !== 'object') return value;   // no constraint
    const s = schema as Record<string, unknown>;

    if(Array.isArray(s.enum) && !s.enum.includes(value))
        fail(`expected one of ${JSON.stringify(s.enum)}, got ${JSON.stringify(value)}`);

    const types: string[] = Array.isArray(s.type) ? s.type as string[]
        : (typeof s.type === 'string' ? [s.type] : []);
    if(types.length && !types.some(t => matchesType(t, value)))
        fail(`expected ${types.join('|')}, got ${jsonTypeOf(value)}`);

    // Object: required keys + recurse into declared properties that are present.
    if(value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const o = value as Record<string, unknown>;
        for(const req of (Array.isArray(s.required) ? s.required as string[] : []))
            if(!(req in o)) fail(`missing required property '${req}'`);
        if(s.properties && typeof s.properties === 'object')
            for(const [k, sub] of Object.entries(s.properties as Record<string, unknown>))
                if(k in o) validateExtraction(sub, o[k], `${path}.${k}`);
    }
    // Array: recurse into each item.
    if(Array.isArray(value) && s.items)
        value.forEach((el, i) => validateExtraction(s.items, el, `${path}[${i}]`));

    return value;
}

function matchesType(t: string, v: unknown): boolean {
    switch(t) {
        case 'object':  return v !== null && typeof v === 'object' && !Array.isArray(v);
        case 'array':   return Array.isArray(v);
        case 'string':  return typeof v === 'string';
        case 'integer': return typeof v === 'number' && Number.isInteger(v);
        case 'number':  return typeof v === 'number';
        case 'boolean': return typeof v === 'boolean';
        case 'null':    return v === null;
        default:        return true;    // unknown type keyword: no structural check
    }
}

function jsonTypeOf(v: unknown): string {
    if(v === null) return 'null';
    if(Array.isArray(v)) return 'array';
    return typeof v;
}

async function digestString(s: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
