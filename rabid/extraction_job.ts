// The extraction_job table: Layer 2's orchestration + progress record for the
// scan -> extract substrate (scan-extract.md).  One row per import.  It carries:
//   - target_kind   : the recipe-registry key that selects stages + landing ('service')
//   - target_context: JSON domain anchors set when the import is created ({event_id})
//   - status        : the lifecycle (job_status_enum)
//   - stage_status  : JSON per-source progress  {"<gallery_photo_id>": {status, error}}
//   - staged_output : JSON extracted-but-not-committed rows, editable in review
//   - error         : a top-level failure message
// plus creation provenance.  Concurrent imports are just concurrent rows; the row
// carries liveness (its rowKey) so an open page renders status live.  The runner +
// the per-target recipes live in extraction-run.ts; THIS module is only the table.
import { Table, PrimaryKeyField, StringField, EnumField, JsonField,
         ForeignKeyField, DateTimeField } from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
import { route, routeMutation, authenticated } from "../liminal/security.ts";
import { db } from "../liminal/db.ts";
import { Markup } from "../liminal/markup.ts";
import * as date from "../liminal/date.ts";
import { parsePhotoValue } from "../liminal/photo.ts";
import { ExtractConfig, extractAll } from "../liminal/extract.ts";
import { extractionTarget, ExtractionTarget } from "./extraction_targets.ts";
import { ownerCanEdit } from "./owned.ts";
import { rabid } from "./rabid.ts";

// Managed (hidden, machine-set) column variants - the established per-module pattern.
class ManagedForeignKeyField extends ForeignKeyField { override isVisible(): boolean { return false; } }
class ManagedDateTimeField extends DateTimeField { override isVisible(): boolean { return false; } }

// The job lifecycle.  pending -> running -> review -> landed;  running -> failed;
// landed -> retracted.  Re-running a failed/retracted job is cheap (Layer 1 caches
// every already-computed extraction), so there is no separate "retry" state.
export const job_status_enum: Record<string, string> = {
    pending:   'Pending',        // created + queued, not yet run
    running:   'Running',        // extraction in flight
    review:    'Needs review',   // extracted; staged_output awaiting a human
    landed:    'Landed',         // rows written to the target table
    failed:    'Failed',         // see error / stage_status
    retracted: 'Retracted',      // landed rows deleted; the job is kept for history
};

export interface ExtractionJob {
    extraction_job_id: number;
    target_kind: string;
    target_context: string;   // JSON
    status: string;
    stage_status: string;     // JSON
    staged_output: string;    // JSON
    error: string;
    created_by?: number;
    created_time?: string;
}
export type ExtractionJobOpt = Partial<ExtractionJob>;

export class ExtractionJobTable extends Table<ExtractionJob> {
    constructor() {
        super('extraction_job', [
            new PrimaryKeyField('extraction_job_id', {}),
            new StringField('target_kind', {edit: security.never}),
            new JsonField('target_context', {default: '{}', edit: security.never}),
            new EnumField('status', job_status_enum, {default: 'pending'}),
            new JsonField('stage_status', {default: '{}'}),
            new JsonField('staged_output', {default: '{}'}),
            new StringField('error', {default: ''}),
            new ManagedForeignKeyField('created_by', 'volunteer', 'volunteer_id', {nullable: true}),
            new ManagedDateTimeField('created_time', {nullable: true}),
        ]);
    }

    // Per-source progress ({status, error?}) keyed by gallery_photo_id, and the staged
    // (uncommitted) extraction per source, both JSON columns.
    stageStatus(job: ExtractionJob): Record<string, {status: string; error?: string}> {
        return JsonField.parse(job.stage_status, {});
    }
    stagedOutput(job: ExtractionJob): Record<string, unknown> {
        return JsonField.parse(job.staged_output, {});
    }
    context(job: ExtractionJob): Record<string, unknown> {
        return JsonField.parse(job.target_context, {});
    }

    // ----------------------------------------------------------------------------
    // --- Create + run (the runner) ----------------------------------------------
    // ----------------------------------------------------------------------------

    // Start a service-sheets import for an event: create the job, then kick the runner
    // detached (LLM calls take seconds - the mutation returns immediately and the page
    // long-polls the job's live status).  Host/admin only (editing the event's data).
    @routeMutation(authenticated)
    startServiceImport(event_id: number): Markup {
        if(!ownerCanEdit('event', event_id))
            throw new Error('not permitted to import records for this event');
        const job_id = this.insert({
            target_kind: 'service',
            target_context: JsonField.format({event_id}),
            status: 'pending',
            created_by: security.current()?.actorId ?? undefined,
            created_time: date.currentSqliteDateTime(),
        } as ExtractionJobOpt);
        // Detached: the returned promise outlives this request; a terminal failure
        // marks the job failed rather than becoming an unhandled rejection.
        this.run(job_id).catch((e) => this.failJob(job_id, e));
        return this.reload(job_id);
    }

    // The runner.  Runs OUTSIDE a request (detached), so it has no dirty collector -
    // it writes job state as system and emits liveness to the shared liveLog by hand
    // (a bare dirty.record would be dropped here).  Each stage is cached (Layer 1), so
    // re-running a failed job is nearly free.  cfg is injectable for tests.
    async run(job_id: number, cfg: ExtractConfig = extractConfig()): Promise<void> {
        const job = security.runSystem(() => this.getById(job_id));
        const target = extractionTarget(job.target_kind);
        const sources = this.sourcesFor(target, this.context(job));
        const status: Record<string, {status: string; error?: string}> = {};
        for(const s of sources) status[s.gallery_photo_id] = {status: 'pending'};
        this.patch(job_id, {status: 'running', stage_status: JsonField.format(status)});

        const staged: Record<string, unknown> = {};
        await pool(sources, 3, async (s) => {
            status[s.gallery_photo_id] = {status: 'running'};
            this.patch(job_id, {stage_status: JsonField.format(status)});
            try {
                staged[s.gallery_photo_id] = await extractAll(cfg, s.path, s.rotate, target.stages);
                status[s.gallery_photo_id] = {status: 'done'};
            } catch(e) {
                status[s.gallery_photo_id] = {status: 'error', error: msg(e)};
            }
            this.patch(job_id, {stage_status: JsonField.format(status), staged_output: JsonField.format(staged)});
        });

        const anyDone = Object.values(status).some((s) => s.status === 'done');
        this.patch(job_id, {
            status: anyDone ? 'review' : 'failed',
            error: anyDone ? '' : (sources.length ? 'every source failed to extract' : 'no service-sheet photos to extract'),
            stage_status: JsonField.format(status), staged_output: JsonField.format(staged),
        });
    }

    // The job's source images.  Anchor case: the event's service-sheets gallery photos
    // (rotation parsed from each stored photo value).  Generalise per-target when a
    // second, non-gallery source lands.
    private sourcesFor(_target: ExtractionTarget, context: Record<string, unknown>): JobSource[] {
        const event_id = Number(context?.event_id);
        if(!Number.isInteger(event_id)) return [];
        const photos = security.runSystem(() => rabid.gallery_photo.forOwner.all(
            {owner_table: 'event', owner_id: event_id, scope: 'service-sheets'}));
        return photos
            .filter((p) => typeof p.photo === 'string' && p.photo)
            .map((p) => {
                const v = parsePhotoValue(p.photo as string);
                return {gallery_photo_id: p.gallery_photo_id, path: v.path, rotate: v.rotate};
            });
    }

    // ----------------------------------------------------------------------------
    // --- Land + retract ---------------------------------------------------------
    // ----------------------------------------------------------------------------

    // Commit the reviewed staged rows into the target table, stamping provenance.
    // In-request, so the service inserts auto-emit their event's dirty keys (the log
    // refreshes); we add the job's own key so its section flips to 'landed'.
    @routeMutation(authenticated)
    land(job_id: number): Markup {
        const job = this.getById(job_id);
        const context = this.context(job);
        assertJobEdit(context);
        if(job.status !== 'review')
            throw new Error(`extraction job ${job_id} is not awaiting review`);
        const target = extractionTarget(job.target_kind);
        const staged = this.stagedOutput(job);
        for(const [gid, extraction] of Object.entries(staged))
            target.land(extraction, context, {extraction_job_id: job_id, source_gallery_photo_id: Number(gid)});
        this.update(job_id, {status: 'landed'} as Partial<ExtractionJob>);
        return this.reload(job_id);
    }

    // Undo a landed import: delete its rows (generic - by the provenance fk), per-row
    // so each emits its event dirty keys.  The job is kept, marked retracted.
    @routeMutation(authenticated)
    retract(job_id: number): Markup {
        const job = this.getById(job_id);
        assertJobEdit(this.context(job));
        // Only service rows carry extraction_job_id today; when a second landable table
        // gains the column, dispatch on target_kind.
        const ids = db().all<{service_id: number}>(
            'SELECT service_id FROM service WHERE extraction_job_id = :job', {job: job_id});
        for(const {service_id} of ids) rabid.service.delete(service_id);
        this.update(job_id, {status: 'retracted'} as Partial<ExtractionJob>);
        return this.reload(job_id);
    }

    // ----------------------------------------------------------------------------
    // --- Live + helpers ---------------------------------------------------------
    // ----------------------------------------------------------------------------

    // Write job state as system + emit liveness so an open page re-renders.  The client
    // watches selector-form dep keys ('.'+class), so we append that form directly to
    // the shared liveLog (the runner is outside any request's dirty collector).
    private patch(job_id: number, fields: Partial<ExtractionJob>): void {
        security.runSystem(() => this.update(job_id, fields));
        rabid.liveLog.append(['.' + this.rowKey(job_id)]);
    }
    private failJob(job_id: number, e: unknown): void {
        this.patch(job_id, {status: 'failed', error: msg(e)});
    }
    // In-request mutation reload target for the job's own fragment.
    private reload(job_id: number): Markup {
        return {action: 'reload', targets: ['.' + this.rowKey(job_id)]} as unknown as Markup;
    }
}

interface JobSource { gallery_photo_id: number; path: string; rotate: number; }

// The Layer-1 config: the app's derived store + PhotoService (contained-bytes) + LLM.
function extractConfig(): ExtractConfig {
    return {derivedDir: rabid.photo.config.derivedDir, image: rabid.photo, llm: rabid.llm};
}

function assertJobEdit(context: Record<string, unknown>): void {
    const event_id = Number(context?.event_id);
    if(!Number.isInteger(event_id) || !ownerCanEdit('event', event_id))
        throw new Error('not permitted to modify this extraction job');
}

function msg(e: unknown): string { return String((e as Error)?.message ?? e); }

// A tiny fixed-concurrency pool (batch policy: 3 concurrent LLM calls per job).
async function pool<X>(items: X[], limit: number, fn: (x: X) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({length: Math.min(limit, queue.length)}, async () => {
        for(;;) {
            const x = queue.shift();
            if(x === undefined) return;
            await fn(x);
        }
    });
    await Promise.all(workers);
}

export const extractionJobMetaData = new ExtractionJobTable();
export const allDml = extractionJobMetaData.createDMLString();
