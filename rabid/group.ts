// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types
/**
 * Groups of volunteers - THE unified, SQL-joinable "set of volunteers" model.
 * Anything that needs to point at some volunteers (a committee's membership, a
 * task's assignees, ...) points at ONE volunteer_group row and joins through
 * group_member; there is a single membership UI, a single security story, and
 * every page renders live from the db (no caching/flattening layers).
 *
 * Two kinds:
 *   - 'named':  shareable, user-visible, LIVE semantics - referencing one means
 *               "whoever its members are at the time" (e.g. a committee's group:
 *               assign a task to the committee and committee changes propagate).
 *   - 'adhoc':  owned by exactly ONE referencing record and NEVER aliased -
 *               that single-owner invariant (rather than immutability) is what
 *               makes sharing a group_id safe.  Membership edits are therefore
 *               plain row inserts/deletes (stable group_id, no copy-on-write).
 *
 * Owner backlink: owned groups carry (owner_table, owner_id) - a soft reference
 * used for security delegation ("may you edit this group's members?" = "may you
 * edit the owning record?") and for GC/audit.  It is never used for page
 * rendering, so it doesn't violate the live-render-from-SQL rule.
 *
 * Mixing quirk (by design): when a task assigned to a NAMED group needs one-off
 * member changes, the UI must EXPLICITLY convert it to a snapshot adhoc group
 * (confirmation - never a silent side effect); `derived_from` keeps the
 * provenance label so the page can say "Logistics Committee (modified)".  The
 * conversion helper lands with the first consumer that mixes (tasks).
 */

import { db, Db, PreparedQuery, boolnum } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import {Markup, h} from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import * as templates from './templates.ts';
import {rabid} from './rabid.ts';

export const routes = ()=> ({
});

const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

export const group_kind_enum: Record<string, string> = {
    'named': 'Named',
    'adhoc': 'Ad hoc',
};

// --------------------------------------------------------------------------------
// --- VolunteerGroup --------------------------------------------------------------
// --------------------------------------------------------------------------------
// (Named volunteer_group, not 'group': GROUP is a reserved word in SQLite.)

export interface VolunteerGroup {
    group_id: number;
    group_kind: string;       // 'named' | 'adhoc' (see file header)

    // Display fallback only.  An OWNED group renders through its owner (e.g. the
    // committee's name) - kept '' there so there is a single source of truth.
    name: string;

    // Soft backlink to the single owning record (e.g. 'committee', 7).  Set for
    // owned groups; null for a standalone named group.  Used for security
    // delegation and GC/audit - never for rendering (see file header).
    owner_table?: string;
    owner_id?: number;

    // Provenance label stamped when a named group is unrolled into an adhoc
    // snapshot (the explicit "convert" act), e.g. 'Logistics Committee'.
    derived_from: string;

    deleted: boolnum;
}

export type VolunteerGroupOpt = Partial<VolunteerGroup>;

// A group_member row joined with the volunteer's name (the member-list shape).
export interface GroupMemberWithName {
    group_member_id: number;
    group_id: number;
    volunteer_id: number;
    volunteer_name: string;
}

export class VolunteerGroupTable extends Table<VolunteerGroup> {

    constructor() {
        super ('volunteer_group', [
            new PrimaryKeyField('group_id', {}),
            new EnumField('group_kind', group_kind_enum, {}),
            new StringField('name', {default: ''}),
            new StringField('owner_table', {nullable: true}),
            new IntegerField('owner_id', {nullable: true}),
            new StringField('derived_from', {default: ''}),
            new BooleanField('deleted', {default: 0}),
        ], [
            'CREATE INDEX IF NOT EXISTS volunteer_group_by_owner ON volunteer_group(owner_table, owner_id);',
        ])
    };

    // Groups are not edited through the generic record form (membership has its
    // own actions below; the row itself is managed by its owner) - but declare
    // the delegating gates anyway as the crafted-POST backstop.
    defaultFieldEdit: security.Permission = a =>
        a.record ? this.canEditMembers(a.record as VolunteerGroup) : false;
    override get recordEdit(): security.Permission {
        return a => a.record ? this.canEditMembers(a.record as VolunteerGroup) : false;
    }

    // THE membership-edit gate.  An owned group delegates to the owning record's
    // own row-level edit permission (committee -> host/admin; a task's assignee
    // group -> whoever may edit that task); a standalone named group is
    // host/admin-managed.  The owner record is loaded as a system op (we need
    // the true row to evaluate ownership), but the permission itself is
    // evaluated against the CURRENT actor.
    canEditMembers(g: VolunteerGroup): boolean {
        const ctx = security.current();
        if(!ctx || ctx.system) return true;
        if(g.owner_table != null && g.owner_id != null) {
            const ownerTable = tableByName(g.owner_table);
            const owner = security.runSystem(() => ownerTable.getById(g.owner_id!));
            return ownerTable.canEditRecord(owner);
        }
        return hostOrAdmin({ctx, record: g});
    }

    // What to call this group in UI text: an owned group goes by its owner's
    // name (single source of truth - the group's own name stays '' there).
    displayName(g: VolunteerGroup): string {
        if(g.owner_table != null && g.owner_id != null) {
            const owner = security.runSystem(() => tableByName(g.owner_table!).getById(g.owner_id!));
            const name = (owner as Record<string, unknown>)['name'];
            if(typeof name === 'string' && name) return name;
        }
        return g.name || `group ${g.group_id}`;
    }

    @path
    get members() {
        return this.prepare<GroupMemberWithName, {group_id: number}>(block`
/**/   SELECT gm.group_member_id, gm.group_id, gm.volunteer_id, v.name AS volunteer_name
/**/          FROM group_member gm JOIN volunteer v USING (volunteer_id)
/**/          WHERE gm.group_id = :group_id
/**/          ORDER BY v.name`);
    }

    // ------------------------------------------------------------------------
    // --- Membership actions --------------------------------------------------
    // ------------------------------------------------------------------------
    //
    // Membership edits are plain row inserts/deletes on group_member (the
    // owned-mutable model: stable group_id, no copy-on-write) - each gated by
    // canEditMembers and reloading the group's member-editor fragment.

    // Args arrive from our own add-member dialog's form (strings, like every
    // bodyArgs form - the same trust model as saveForm).
    addMember(args: {group_id?: string|number, volunteer_id?: string|number}): Markup {
        const group_id = Number(args?.group_id);
        const volunteer_id = Number(args?.volunteer_id);
        if(!Number.isInteger(group_id) || !Number.isInteger(volunteer_id) || !volunteer_id)
            throw new Error('Please choose a volunteer');
        const g = this.getById(group_id);
        if(!this.canEditMembers(g))
            throw new Error(`Not permitted to edit the members of ${this.displayName(g)}`);
        // Adding someone already in the group is a no-op (the unique index).
        db().execute<{group_id: number, volunteer_id: number}>(
            'INSERT OR IGNORE INTO group_member(group_id, volunteer_id) VALUES (:group_id, :volunteer_id)',
            {group_id, volunteer_id});
        return {action:'reload', targets:[`.-volunteer_group-${group_id}-`]} as unknown as Markup;
    }

    removeMember(group_id: number, volunteer_id: number): Markup {
        const g = this.getById(group_id);
        if(!this.canEditMembers(g))
            throw new Error(`Not permitted to edit the members of ${this.displayName(g)}`);
        db().execute<{group_id: number, volunteer_id: number}>(
            'DELETE FROM group_member WHERE group_id = :group_id AND volunteer_id = :volunteer_id',
            {group_id, volunteer_id});
        return {action:'reload', targets:[`.-volunteer_group-${group_id}-`]} as unknown as Markup;
    }

    // ------------------------------------------------------------------------
    // --- Member editor (the shared membership UI) ----------------------------
    // ------------------------------------------------------------------------

    // The reloadable members fragment for one group: every owner detail page
    // (committee today, tasks later) embeds this same editor.  Members link to
    // their volunteer page; the Remove/Add affordances appear only for actors
    // who pass canEditMembers (UI mutation model: every mutation is a button -
    // Remove is confirm-style, Add is a modal-of-action-arguments).
    renderMemberEditor(group_id: number): Markup {
        const g = this.getById(group_id);
        const members = this.members.all({group_id});
        const canEdit = this.canEditMembers(g);
        const props = this.reloadableItemProps(group_id, `rabid.volunteer_group.renderMemberEditor(${group_id})`);
        return [h.div, props,
            members.length === 0
                ? [h.p, {class: 'text-muted'}, 'No members yet.']
                : [h.div, {class: 'list-group lm-list mb-2'},
                   members.map(m => this.renderMemberRow(m, canEdit))],
            canEdit
                ? action.actionButton('Add member',
                    {kind: 'modal', dialogUrl: `/rabid.volunteer_group.addMemberDialog(${group_id})`},
                    'btn btn-outline-primary btn-sm')
                : undefined,
        ];
    }

    renderMemberRow(m: GroupMemberWithName, canEdit: boolean): Markup {
        return [h.div, {class: 'list-group-item lm-item d-flex align-items-center',
                        'data-testid': `member-row-${m.volunteer_id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              templates.pageLink(`/rabid.volunteer.detailPage(${m.volunteer_id})`, m.volunteer_name)]],
            canEdit
                ? action.actionButton('Remove',
                    {kind: 'confirm',
                     expr: `rabid.volunteer_group.removeMember(${m.group_id},${m.volunteer_id})`,
                     message: `Remove ${m.volunteer_name}?`},
                    'btn btn-outline-danger btn-sm')
                : undefined,
        ];
    }

    // The add-member parameter dialog: one volunteer picker (remote type-ahead
    // via group_member's volunteer_id FK route) + the group id riding hidden.
    addMemberDialog(group_id: number): Markup {
        const g = this.getById(group_id);
        if(!this.canEditMembers(g))
            throw new Error(`Not permitted to edit the members of ${this.displayName(g)}`);
        return action.renderParamForm(
            [new ForeignKeyField('volunteer_id', 'volunteer', 'volunteer_id', {}, 'name')],
            {},
            {
                title: `Add member to ${this.displayName(g)}`,
                submitLabel: 'Add',
                hidden: {group_id},
                fieldContext: {ownerPath: 'rabid.group_member'},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.volunteer_group.addMember(${getFormJSON(event.target)})`'},
            });
    }
}

// --------------------------------------------------------------------------------
// --- GroupMember -----------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface GroupMember {
    group_member_id: number;
    group_id: number;
    volunteer_id: number;
}

export type GroupMemberOpt = Partial<GroupMember>;

export class GroupMemberTable extends Table<GroupMember> {

    constructor() {
        super ('group_member', [
            new PrimaryKeyField('group_member_id', {}),
            new ForeignKeyField('group_id', 'volunteer_group', 'group_id', {indexed: true}),
            new ForeignKeyField('volunteer_id', 'volunteer', 'volunteer_id', {indexed: true}, 'name'),
        ], [
            // One membership row per (group, volunteer) - addMember's
            // INSERT OR IGNORE leans on this.
            'CREATE UNIQUE INDEX IF NOT EXISTS group_member_by_group_volunteer ON group_member(group_id, volunteer_id);',
            // "What is this volunteer in?" - the reverse path (assignment lists,
            // future security checks).
            'CREATE INDEX IF NOT EXISTS group_member_by_volunteer ON group_member(volunteer_id);',
        ])
    };

    // Membership rows are managed by the actions on VolunteerGroupTable; these
    // delegating gates are the crafted-POST backstop for the generic saveForm
    // path.  With no record (a crafted INSERT) we can't resolve the group, so
    // the answer is no - the supported write path is addMember.
    defaultFieldEdit: security.Permission = a =>
        a.record ? canEditMembersOfGroup((a.record as GroupMember).group_id) : false;
    override get recordEdit(): security.Permission {
        return a => a.record ? canEditMembersOfGroup((a.record as GroupMember).group_id) : false;
    }
}

// The cross-table hop for GroupMemberTable's gates (the group row itself is
// loaded as a system op; the permission is evaluated against the current actor
// inside canEditMembers).
export function canEditMembersOfGroup(group_id: number): boolean {
    const g = security.runSystem(() => rabid.volunteer_group.getById(group_id));
    return rabid.volunteer_group.canEditMembers(g);
}

// Resolve an owner_table backlink to its Table.  Generic over rabid.tables, so
// new owner types (tasks etc.) need no registration beyond being a table.
function tableByName(name: string): Table<any> {
    const t = rabid.tables.find(t => t.name === name);
    if(!t) throw new Error(`Unknown group owner table '${name}'`);
    return t;
}

// --------------------------------------------------------------------------------
// --- Owned-group plumbing for owner tables ---------------------------------------
// --------------------------------------------------------------------------------

/**
 * The FK from an owning record to its group.  Hidden from the generic record
 * form (the group is created WITH the record and never user-assigned), which
 * also exempts it from the required-input validation on insert - the owning
 * table's insert() supplies it (see createOwnedGroup / CommitteeTable.insert).
 */
export class OwnedGroupField extends ForeignKeyField {
    constructor(name: string = 'group_id') {
        super(name, 'volunteer_group', 'group_id', {indexed: true});
    }
    override isVisible(): boolean { return false; }
}

// Create the group an owning record points at.  owner_id is usually not known
// yet (the owner row is inserted AFTER, with this group's id) - the owner's
// insert() patches it in; see CommitteeTable.insert for the canonical sequence.
export function createOwnedGroup(group_kind: 'named'|'adhoc', owner_table: string,
                                 owner_id?: number): number {
    return rabid.volunteer_group.insert({
        group_kind, name: '', owner_table, owner_id,
        derived_from: '', deleted: 0});
}

export const allDml =
    new VolunteerGroupTable().createDMLString() +
    new GroupMemberTable().createDMLString();
