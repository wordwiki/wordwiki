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
}

export const extractionJobMetaData = new ExtractionJobTable();
export const allDml = extractionJobMetaData.createDMLString();
