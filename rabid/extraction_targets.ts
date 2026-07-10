// The scan -> extract RECIPE layer (scan-extract.md § filing): a registry keyed by
// target_kind supplying, per target, {stages, land, review}.  The generic layer
// (extraction_job.ts) selects a recipe by kind and never sees a domain schema.
//
// `land` is the only domain-specific piece: it turns a validated extraction into rows
// in the target table, stamping provenance.  retract stays generic (delete where
// extraction_job_id = :job) and lives in the runner.  Generalise this interface only
// once a SECOND target exists (grid vs per-entry), so the abstraction is drawn from
// real difference - for now there is one: `service`.
import { ExtractRecipe } from "../liminal/extract.ts";
import * as service from "./service.ts";
import { service_kind_enum } from "./service.ts";
import { rabid } from "./rabid.ts";

// Provenance stamped onto every landed row so retract + the "from scan" badge are free.
export interface ExtractionProvenance {
    extraction_job_id: number;
    source_gallery_photo_id: number;
}

export interface ExtractionTarget {
    kind: string;
    label: string;
    reviewShape: 'grid' | 'form';
    stages: ExtractRecipe;
    // Write one source's extraction to the domain table; return the landed row keys.
    land(extraction: unknown, context: Record<string, unknown>, prov: ExtractionProvenance): number[];
    // Flatten an extraction to display rows for the review UI (sub-part C).
    rowsForReview(extraction: unknown): Record<string, unknown>[];
}

export const extractionTargets: Record<string, ExtractionTarget> = {};

export function extractionTarget(kind: string): ExtractionTarget {
    const t = extractionTargets[kind];
    if(!t) throw new Error(`unknown extraction target_kind '${kind}'`);
    return t;
}

// --------------------------------------------------------------------------------
// --- The `service` target: photographed paper service-record sheets -> service rows
// --------------------------------------------------------------------------------

// Anthropic tool input_schema must be an object at the top level, so the sheet's rows
// live under `records`.  Field descriptions ARE the extraction spec - keep them tight
// and matched to the paper form (co-design the form + these).
const SERVICE_ROW_SCHEMA = {
    type: 'object',
    properties: {
        client_name:         {type: 'string', description: "The client's name exactly as written; '' if blank."},
        service_kind:        {type: 'string', enum: Object.keys(service_kind_enum),
                              description: "diy = client did the work themselves; full = 'We Repair' / bike dropped off; other. Default diy if unclear."},
        bike_description:    {type: 'string', description: "Bike make/model/colour as written; '' if none."},
        service_description: {type: 'string', description: "The work done or requested; '' if none."},
        client_postal:       {type: 'string', description: "First 3 characters of a Canadian postal code (the forward sortation area), else ''."},
        client_phone:        {type: 'string', description: "Phone number as written; '' if none."},
    },
    required: ['client_name'],
};

const SERVICE_SHEET_SCHEMA = {
    type: 'object',
    properties: {records: {type: 'array', items: SERVICE_ROW_SCHEMA}},
    required: ['records'],
};

const SERVICE_SHEET_PROMPT =
    'This is a photograph of a paper service-record sheet from a community bike shop. ' +
    'Each row is one client interaction. Transcribe EVERY row into the records array, ' +
    'in top-to-bottom order, using exactly the fields provided. Copy handwriting faithfully; ' +
    "do not invent values - use '' for any blank field. Do not merge or skip rows.";

function normalizeServiceKind(v: unknown): string {
    const k = String(v ?? '').trim().toLowerCase();
    return k in service_kind_enum ? k : 'diy';
}

function landServiceRows(extraction: unknown, context: Record<string, unknown>,
                         prov: ExtractionProvenance): number[] {
    const rows = (extraction as {records?: unknown})?.records;
    if(!Array.isArray(rows)) return [];
    const event_id = Number(context?.event_id);
    if(!Number.isInteger(event_id))
        throw new Error('service extraction target: target_context is missing event_id');
    return rows.map((r: Record<string, unknown>) => rabid.service.insert({
        event_id,
        client_name: String(r?.client_name ?? '').trim() || '(from scan)',
        service_kind: normalizeServiceKind(r?.service_kind),
        bike_description: String(r?.bike_description ?? ''),
        service_description: String(r?.service_description ?? ''),
        client_postal: String(r?.client_postal ?? ''),
        client_phone: String(r?.client_phone ?? ''),
        extraction_job_id: prov.extraction_job_id,
        source_gallery_photo_id: prov.source_gallery_photo_id,
    } as service.ServiceOpt));
}

extractionTargets['service'] = {
    kind: 'service',
    label: 'Service records',
    reviewShape: 'grid',
    stages: [{
        name: 'extract',
        model: '',            // '' -> the credential's defaultModel
        promptVersion: 1,
        imageBox: 1600,
        schema: SERVICE_SHEET_SCHEMA,
        prompt: () => SERVICE_SHEET_PROMPT,
    }],
    land: landServiceRows,
    rowsForReview: (extraction) => {
        const rows = (extraction as {records?: unknown})?.records;
        return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
    },
};
