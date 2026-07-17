// The block-kind registry - the seam that lets the site editor (in this shared
// `components` package) dispatch to both built-in block kinds AND site-specific
// blocks injected by the hosting app (rabid, wordwiki), without components ever
// importing an app.  See site-editor.md.
//
// A block kind is a payload FieldSet + a render function; there is ONE physical
// `block` table (kind + JSON payload), and this Map is the polymorphism table -
// in code, where dispatch belongs.  Apps push their kinds in at startup exactly
// as wordwiki pushes link providers into render-page-editor.ts, which sidesteps
// the init-order import cycle.

import { FieldSet, JsonField, type Tuple } from "../liminal/table.ts";
import type { Markup } from "../liminal/markup.ts";

/**
 * Everything a block render/edit needs that is NOT ambient request state, so a
 * block renders identically live in-app and inside the static-site generator.
 * A site-specific block MUST render from this ctx, never from a live request.
 */
export interface BlockCtx {
    site_id: number;
    dict: Record<string, string>;   // page-supplied specialization values (macros - deferred)
    editing: boolean;               // show edit affordances, or produce final output
}

export interface BlockKind {
    kind: string;                       // registry key, stored in block.kind ('title', 'rabid-hours')
    label: string;                      // label in the add-block picker
    schema: FieldSet;                   // the payload's fields - drives edit form + validation + hydrate
    render(payload: Tuple, ctx: BlockCtx): Markup;
    category?: 'content' | 'app';       // grouping in the add-block picker (default 'content')

    // Optional payload-schema migration escape hatch (site-editor.md "Payload
    // schema migration").  hydrate() handles add/remove-a-field with no
    // migration; only rename/retype needs this.  `payloadVersion` is the current
    // version (default 0); `migratePayload` brings an older stored payload up to
    // it, applied on read BEFORE hydrate.
    payloadVersion?: number;
    migratePayload?: (payload: any, from: number) => any;
}

const registry = new Map<string, BlockKind>();

/**
 * Register a block kind.  Rejects a duplicate kind, and enforces that the
 * payload schema is hydratable (every field nullable-or-defaulted) so old stored
 * blobs always upgrade to a complete value on read.
 */
export function registerBlockKind(k: BlockKind): void {
    if(registry.has(k.kind))
        throw new Error(`duplicate block kind '${k.kind}'`);
    k.schema.assertHydratable();
    registry.set(k.kind, k);
}

export function blockKind(kind: string): BlockKind | undefined {
    return registry.get(kind);
}

export function allBlockKinds(): BlockKind[] {
    return [...registry.values()];
}

/** Test/tooling helper - drop a registration (e.g. between test cases). */
export function unregisterBlockKind(kind: string): void {
    registry.delete(kind);
}

// The current payload version a kind writes (0 unless it declares migrations).
function currentVersion(k: BlockKind): number {
    return k.payloadVersion ?? 0;
}

/**
 * The READ path for a stored payload: parse the JSON, migrate it up to the
 * kind's current version if needed, then hydrate against the schema (absent ->
 * default, unknown -> dropped, present-but-stale -> left intact).  The stored
 * version rides in the payload as `v`; hydrate drops it as an unknown key.
 */
export function readPayload(k: BlockKind, rawJson: unknown): Tuple {
    const stored = JsonField.parse<Record<string, any>>(rawJson, {});
    const from = typeof stored.v === 'number' ? stored.v : 0;
    const migrated = (k.migratePayload && from < currentVersion(k))
        ? k.migratePayload(stored, from)
        : stored;
    return k.schema.hydrate(migrated);
}

/**
 * The WRITE path: serialize a (hydrated) payload tuple to the stored JSON,
 * stamping the kind's current version as `v` so a future migration knows where a
 * blob started.  `v` is meta, not a schema field, so it survives round-trips via
 * readPayload (which reads it) but never leaks into the hydrated tuple.
 */
export function writePayload(k: BlockKind, payload: Tuple): string {
    return JsonField.format({...payload, v: currentVersion(k)});
}
