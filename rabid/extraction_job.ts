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
         ForeignKeyField, DateTimeField, liveReloadableProps } from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
import { route, routeMutation, authenticated } from "../liminal/security.ts";
import { db } from "../liminal/db.ts";
import { Markup, h } from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
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
        return this.reloadEvent(event_id);
    }

    // The runner.  Runs OUTSIDE a request (detached), so it has no dirty collector -
    // it writes job state as system and emits liveness to the shared liveLog by hand
    // (a bare dirty.record would be dropped here).  Progress ticks the event's imports
    // section (one live fragment) so status + staged rows appear as they land.  Each
    // stage is cached (Layer 1), so re-running a failed job is nearly free.  cfg is
    // injectable for tests.
    async run(job_id: number, cfg: ExtractConfig = extractConfig()): Promise<void> {
        const job = security.runSystem(() => this.getById(job_id));
        const event_id = Number(this.context(job)?.event_id);
        const target = extractionTarget(job.target_kind);
        const sources = this.sourcesFor(target, this.context(job));
        const status: Record<string, {status: string; error?: string}> = {};
        for(const s of sources) status[s.gallery_photo_id] = {status: 'pending'};
        this.write(job_id, {status: 'running', stage_status: JsonField.format(status)});
        this.emitEvent(event_id);

        const staged: Record<string, unknown> = {};
        await pool(sources, 3, async (s) => {
            status[s.gallery_photo_id] = {status: 'running'};
            this.write(job_id, {stage_status: JsonField.format(status)});
            this.emitEvent(event_id);
            try {
                staged[s.gallery_photo_id] = await extractAll(cfg, s.path, s.rotate, target.stages);
                status[s.gallery_photo_id] = {status: 'done'};
            } catch(e) {
                status[s.gallery_photo_id] = {status: 'error', error: msg(e)};
            }
            this.write(job_id, {stage_status: JsonField.format(status), staged_output: JsonField.format(staged)});
            this.emitEvent(event_id);
        });

        const anyDone = Object.values(status).some((s) => s.status === 'done');
        this.write(job_id, {
            status: anyDone ? 'review' : 'failed',
            error: anyDone ? '' : (sources.length ? 'every source failed to extract' : 'no service-sheet photos to extract'),
            stage_status: JsonField.format(status), staged_output: JsonField.format(staged),
        });
        this.emitEvent(event_id);
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
        return this.reloadEvent(Number(context?.event_id));
    }

    // Undo a landed import: delete its rows (generic - by the provenance fk), per-row
    // so each emits its event dirty keys.  The job is kept, marked retracted.
    @routeMutation(authenticated)
    retract(job_id: number): Markup {
        const job = this.getById(job_id);
        const context = this.context(job);
        assertJobEdit(context);
        // Only service rows carry extraction_job_id today; when a second landable table
        // gains the column, dispatch on target_kind.
        const ids = db().all<{service_id: number}>(
            'SELECT service_id FROM service WHERE extraction_job_id = :job', {job: job_id});
        for(const {service_id} of ids) rabid.service.delete(service_id);
        this.update(job_id, {status: 'retracted'} as Partial<ExtractionJob>);
        return this.reloadEvent(Number(context?.event_id));
    }

    // ----------------------------------------------------------------------------
    // --- The event imports section (live) ---------------------------------------
    // ----------------------------------------------------------------------------

    // All imports for an event, newest first.  event_id lives in target_context JSON;
    // json_extract keeps the query index-free but exact (no LIKE false positives).
    forEvent(event_id: number): ExtractionJob[] {
        return security.runSystem(() => db().all<ExtractionJob>(
            `SELECT ${this.allFields} FROM extraction_job
              WHERE target_kind = 'service' AND json_extract(target_context, '$.event_id') = :event_id
              ORDER BY extraction_job_id DESC`, {event_id}));
    }

    // The live "Scanned record imports" section under the event's Service Record Sheets.
    // Rendered only when at least one import exists (the ☰ "Import scanned records…" is
    // the entry point).  Live on a per-event key the runner ticks as it progresses.
    @route(authenticated)
    renderEventImports(event_id: number): Markup {
        const jobs = this.forEvent(event_id);
        const canEdit = ownerCanEdit('event', event_id);
        const props = liveReloadableProps([this.eventKey(event_id)],
            `rabid.extraction_job.renderEventImports(${event_id})`);
        if(jobs.length === 0)
            return [h.div, {...props, 'data-testid': `event-imports-${event_id}`}];   // empty, but still live
        return [h.div, {...props, 'data-testid': `event-imports-${event_id}`},
            [h.div, {class: 'lm-doc-section-head'},
             [h.h4, {class: 'lm-doc-section-label'}, 'Scanned record imports']],
            [h.div, {class: 'lm-subsection'}, jobs.map((j) => this.renderJob(j, canEdit))]];
    }

    private renderJob(job: ExtractionJob, canEdit: boolean): Markup {
        const id = job.extraction_job_id;
        const status = this.stageStatus(job);
        const counts = Object.values(status).reduce((a, s) => {
            a[s.status] = (a[s.status] ?? 0) + 1; return a;
        }, {} as Record<string, number>);
        const badge = job_status_enum[job.status] ?? job.status;
        const progress = Object.keys(status).length
            ? `${counts.done ?? 0} done` + (counts.error ? `, ${counts.error} failed` : '') +
              (counts.running || counts.pending ? `, ${(counts.running ?? 0) + (counts.pending ?? 0)} to go` : '')
            : '';
        const target = extractionTarget(job.target_kind);
        const staged = this.stagedOutput(job);
        const allRows = Object.values(staged).flatMap((e) => target.rowsForReview(e));

        const actions: Markup[] = [];
        if(canEdit && job.status === 'review')
            actions.push(action.actionButton(`Land ${allRows.length} record${allRows.length === 1 ? '' : 's'}`,
                {kind: 'confirm', message: `Create ${allRows.length} service records from this scan?`,
                 expr: `rabid.extraction_job.land(${id})`},
                'btn btn-primary btn-sm'));
        if(canEdit && (job.status === 'review' || job.status === 'landed'))
            actions.push(action.actionButton(job.status === 'landed' ? 'Retract' : 'Discard',
                {kind: 'confirm',
                 message: job.status === 'landed' ? 'Delete the records this scan created?' : 'Discard this scan?',
                 expr: `rabid.extraction_job.retract(${id})`},
                'btn btn-outline-danger btn-sm'));

        return [h.div, {class: 'mb-4', 'data-testid': `extraction-job-${id}`},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-1'},
             [h.span, {class: 'fw-semibold'}, badge],
             progress ? [h.span, {class: 'text-muted small'}, progress] : undefined],
            job.error ? [h.div, {class: 'text-danger small mb-1'}, job.error] : undefined,
            (job.status === 'review' && allRows.length)
                ? this.renderReviewGrid(allRows)
                : undefined,
            actions.length ? [h.div, {class: 'd-flex gap-2 mt-2'}, actions] : undefined];
    }

    // A thin read-only preview of the staged rows (the service target's grid shape).
    // Corrections happen after landing, on the real service records (or discard + re-run).
    private renderReviewGrid(rows: Record<string, unknown>[]): Markup {
        const cols: [string, string][] = [
            ['client_name', 'Name'], ['service_kind', 'Kind'], ['bike_description', 'Bike'],
            ['service_description', 'Work'], ['client_postal', 'Postal'], ['client_phone', 'Phone'],
        ];
        const cell = (v: unknown) => String(v ?? '');
        return [h.div, {class: 'table-responsive'},
            [h.table, {class: 'table table-sm table-borderless mb-0'},
             [h.thead, {}, [h.tr, {}, cols.map(([, label]) => [h.th, {class: 'small text-muted fw-normal'}, label])]],
             [h.tbody, {}, rows.map((r) =>
                [h.tr, {}, cols.map(([key]) => [h.td, {class: 'small'}, cell(r[key])])])]]];
    }

    // ----------------------------------------------------------------------------
    // --- Live + helpers ---------------------------------------------------------
    // ----------------------------------------------------------------------------

    // A per-event dep key: the whole imports section re-renders on any job progress.
    private eventKey(event_id: number): string { return `-extraction_job-event-${event_id}-`; }

    // Write job state as system (no dirty collector in the detached runner).
    private write(job_id: number, fields: Partial<ExtractionJob>): void {
        security.runSystem(() => this.update(job_id, fields));
    }
    // Emit liveness for the event's imports section.  Client watches selector-form dep
    // keys ('.'+class), so append that form directly to the shared liveLog.
    private emitEvent(event_id: number): void {
        if(Number.isInteger(event_id)) rabid.liveLog.append(['.' + this.eventKey(event_id)]);
    }
    private failJob(job_id: number, e: unknown): void {
        const event_id = Number(this.context(security.runSystem(() => this.getById(job_id)))?.event_id);
        this.write(job_id, {status: 'failed', error: msg(e)});
        this.emitEvent(event_id);
    }
    // In-request mutation reload target for the event's imports section.
    private reloadEvent(event_id: number): Markup {
        return {action: 'reload', targets: ['.' + this.eventKey(event_id)]} as unknown as Markup;
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
