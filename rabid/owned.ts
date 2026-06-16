// Polymorphic "owned-by" plumbing, shared by every table that carries an
// (owner_table, owner_id) soft backlink to a single owning record.
//
// Two tables use it today: volunteer_group (a committee/task/project owns its
// member set) and project (an event/volunteer/bike owns a 1-1 project for its
// tasks).  An owned row renders THROUGH its owner - the owner is the single
// source of truth for the label - and delegates its edit permission to the
// owner, so "can edit the event" == "can manage the event's tasks".
//
// Loaded as system ops: we need the true owner row to label / gate it, but the
// permission itself is evaluated against the CURRENT actor.

import {Table} from "../liminal/table.ts";
import * as security from "../liminal/security.ts";
import {rabid} from "./rabid.ts";

// Resolve an owner_table backlink to its Table.  Generic over rabid.tables, so
// new owner types need no registration beyond being a table.
export function tableByName(name: string): Table<any> {
    const t = rabid.tables.find(t => t.name === name);
    if(!t) throw new Error(`Unknown owner table '${name}'`);
    return t;
}

// The display label of an owner record.  Recurses through Table.recordLabel, so
// an owner that itself derives its label (an owned project) resolves to the real
// source (the event).
export function ownerLabel(owner_table: string, owner_id: number): string {
    const t = tableByName(owner_table);
    const rec = security.runSystem(() => t.getById(owner_id));
    return t.recordLabel(rec);
}

// Whether the current actor may edit the owner record - an owned row delegates
// its edit permission here.  (System/no-context contexts pass, as elsewhere.)
export function ownerCanEdit(owner_table: string, owner_id: number): boolean {
    const ctx = security.current();
    if(!ctx || ctx.system) return true;
    const t = tableByName(owner_table);
    const rec = security.runSystem(() => t.getById(owner_id));
    return t.canEditRecord(rec);
}
