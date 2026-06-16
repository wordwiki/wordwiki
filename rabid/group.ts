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
import { VolunteerForeignKeyField } from "./volunteer-activity.ts";
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import {Markup, h} from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated} from "../liminal/security.ts";
import {ownerLabel, ownerCanEdit} from "./owned.ts";
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
        if(g.owner_table != null && g.owner_id != null)
            return ownerCanEdit(g.owner_table, g.owner_id);
        return hostOrAdmin({ctx, record: g});
    }

    // What to call this group in UI text: an owned group goes by its owner's
    // label (single source of truth - the group's own name stays '' there).
    // ownerLabel chains through Table.recordLabel, so an owner that itself
    // derives its name (an owned project -> its event) resolves correctly.
    displayName(g: VolunteerGroup): string {
        if(g.owner_table != null && g.owner_id != null)
            return ownerLabel(g.owner_table, g.owner_id);
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
    @routeMutation(authenticated)   // gated in-method by canEditMembers (owner delegation)
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

    @routeMutation(authenticated)   // gated in-method by canEditMembers
    removeMember(group_id: number, volunteer_id: number): Markup {
        const g = this.getById(group_id);
        if(!this.canEditMembers(g))
            throw new Error(`Not permitted to edit the members of ${this.displayName(g)}`);
        db().execute<{group_id: number, volunteer_id: number}>(
            'DELETE FROM group_member WHERE group_id = :group_id AND volunteer_id = :volunteer_id',
            {group_id, volunteer_id});
        this.clearDerivedFromIfEmpty(group_id);
        return {action:'reload', targets:[`.-volunteer_group-${group_id}-`]} as unknown as Markup;
    }

    // "Add me": sign the CURRENT actor up.  Deliberately NOT gated by
    // canEditMembers - self-signup is the ONE membership edit that is always
    // allowed (dz policy: in a volunteer org, "I'll take that" is the
    // dominant flow and must never need an editor).  No-op if already a
    // member (the unique index).
    @routeMutation(authenticated)   // self-signup: always allowed for a logged-in volunteer
    addSelf(group_id: number): Markup {
        const actorId = security.current()?.actorId;
        if(actorId === undefined)
            throw new Error('Not logged in as a volunteer');
        this.getById(group_id);                  // must exist (and be viewable)
        db().execute<{group_id: number, volunteer_id: number}>(
            'INSERT OR IGNORE INTO group_member(group_id, volunteer_id) VALUES (:group_id, :volunteer_id)',
            {group_id, volunteer_id: actorId});
        return {action:'reload', targets:[`.-volunteer_group-${group_id}-`]} as unknown as Markup;
    }

    // Clear the roster wholesale (the long-roster escape hatch; the one
    // removal that keeps a confirm - it's bulk).
    @routeMutation(authenticated)   // gated in-method by canEditMembers
    removeAllMembers(group_id: number): Markup {
        const g = this.getById(group_id);
        if(!this.canEditMembers(g))
            throw new Error(`Not permitted to edit the members of ${this.displayName(g)}`);
        db().execute<{group_id: number}>(
            'DELETE FROM group_member WHERE group_id = :group_id', {group_id});
        this.clearDerivedFromIfEmpty(group_id);
        return {action:'reload', targets:[`.-volunteer_group-${group_id}-`]} as unknown as Markup;
    }

    // An emptied roster sheds its provenance: "customized from X" with nobody
    // left in it is stale noise - erasing the members (one by one or via
    // Remove all) resets the group to a plain blank slate.
    private clearDerivedFromIfEmpty(group_id: number): void {
        db().execute<{group_id: number}>(block`
/**/   UPDATE volunteer_group SET derived_from = ''
/**/          WHERE group_id = :group_id AND derived_from != ''
/**/            AND NOT EXISTS (SELECT 1 FROM group_member gm WHERE gm.group_id = :group_id)`,
            {group_id});
    }

    // ------------------------------------------------------------------------
    // --- Member editor (the shared membership UI) ----------------------------
    // ------------------------------------------------------------------------

    // The reloadable members fragment for one group - the COMPLETE membership
    // UI: the member names as a pure document phrase ("Hazel, Bob and
    // Carol"), plus ONE ☰ holding every membership verb.  The menu lives
    // INSIDE the fragment so a membership reload regenerates it (the
    // per-member Remove items must track the roster); the owner's assignment
    // verbs ride in via ownerRoute/owner_id - plain route-string params, so
    // the fragment's own reload URL carries them too.
    //
    // Verbs and their gates:
    //   - "Add me": offered to any logged-in non-member - self-signup is the
    //     ONE membership edit that is always allowed (dz policy);
    //   - everything else needs canEditMembers: Add member…, the owner's
    //     assignment verbs, the per-member removes ("Remove me" for the
    //     actor's own entry; IMMEDIATE - picking a named item is already a
    //     deliberate act, and re-adding is trivial), and the confirm-gated
    //     Remove all… (bulk) once there are 2+.
    @route(authenticated)
    renderMemberEditor(group_id: number, ownerRoute?: string, owner_id?: number): Markup {
        const g = this.getById(group_id);
        const members = this.members.all({group_id});
        const canEdit = this.canEditMembers(g);
        const actorId = security.current()?.actorId;
        const isMember = actorId !== undefined && members.some(m => m.volunteer_id === actorId);
        const reloadURL = ownerRoute != null && owner_id != null
            ? `rabid.volunteer_group.renderMemberEditor(${group_id},${JSON.stringify(ownerRoute)},${owner_id})`
            : `rabid.volunteer_group.renderMemberEditor(${group_id})`;
        const props = this.reloadableItemProps(group_id, reloadURL);

        const items: action.ActionMenuItem[] = [];
        if(actorId !== undefined && !isMember)
            items.push({label: 'Add me',
                        mode: {kind: 'immediate', expr: `rabid.volunteer_group.addSelf(${group_id})`}});
        if(canEdit) {
            items.push({label: 'Add member…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.volunteer_group.addMemberDialog(${group_id})`}});
            if(ownerRoute != null && owner_id != null) {
                items.push({label: 'Assign committee…',
                            mode: {kind: 'modal', dialogUrl: `/${ownerRoute}.assignCommitteeDialog(${owner_id})`}});
                // The task owner's extra verb (a mild layering wink, but it
                // keeps the whole menu inside the reloadable fragment).
                if(ownerRoute === 'rabid.task')
                    items.push({label: 'Use project assignees…',
                                mode: {kind: 'confirm',
                                       expr: `rabid.task.revertAssignees(${owner_id})`,
                                       message: `Drop this task's own assignees and go back to the project's?`}});
            }
            if(members.length > 0) items.push('divider');
            for(const m of members)
                items.push({label: m.volunteer_id === actorId ? 'Remove me' : `Remove ${m.volunteer_name}`,
                            mode: {kind: 'immediate',
                                   expr: `rabid.volunteer_group.removeMember(${group_id},${m.volunteer_id})`}});
            if(members.length >= 2)
                items.push({label: 'Remove all…',
                            mode: {kind: 'confirm',
                                   expr: `rabid.volunteer_group.removeAllMembers(${group_id})`,
                                   message: `Remove all ${members.length} members?`}});
        }

        return [h.span, {...props, class: 'lm-name-list ' + props.class},
            joinNames(members.map(m => this.renderMemberName(m))),
            members.length === 0 && items.length === 0
                ? [h.span, {class: 'text-muted small'}, 'nobody yet'] : undefined,
            // Provenance reads as part of the phrase, BEFORE the menu.
            g.derived_from
                ? [h.span, {class: 'text-muted small'}, ` (customized from ${g.derived_from})`]
                : undefined,
            items.length > 0
                ? [members.length > 0 || g.derived_from ? ' ' : '',
                   action.actionMenu(items, {ariaLabel: 'Membership actions'})]
                : undefined,
        ];
    }

    // Read-only member names (no menu) - used where a group is shown through
    // an ALIASING reference (e.g. a task assigned to a committee's named
    // group, or a task showing its project's assignees): member edits there
    // must go through the explicit flows, never silently into the referenced
    // group.
    @route(authenticated)
    renderMemberList(group_id: number): Markup {
        const members = this.members.all({group_id});
        return [h.span, {class: 'lm-name-list'},
            members.length === 0
                ? [h.span, {class: 'text-muted small'}, 'nobody yet']
                : joinNames(members.map(m => this.renderMemberName(m)))];
    }

    // One member as inline text: the name, a quiet link to the volunteer page.
    renderMemberName(m: GroupMemberWithName): Markup {
        return [h.span, {class: 'lm-member', 'data-testid': `member-row-${m.volunteer_id}`},
            templates.pageLink(`/rabid.volunteer.detailPage(${m.volunteer_id})`, m.volunteer_name)];
    }

    // The add-member parameter dialog: one volunteer picker (remote type-ahead
    // via group_member's volunteer_id FK route) + the group id riding hidden.
    @route(authenticated)   // gated in-method by canEditMembers
    addMemberDialog(group_id: number): Markup {
        const g = this.getById(group_id);
        if(!this.canEditMembers(g))
            throw new Error(`Not permitted to edit the members of ${this.displayName(g)}`);
        return action.renderParamForm(
            [new VolunteerForeignKeyField('volunteer_id', {})],
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
            new VolunteerForeignKeyField('volunteer_id', {indexed: true}),
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

// --------------------------------------------------------------------------------
// --- Owned-group plumbing for owner tables ---------------------------------------
// --------------------------------------------------------------------------------

/**
 * The FK from an owning record to its group.  Hidden from the generic record
 * form (the group is created WITH the record and never user-assigned), which
 * also exempts it from the required-input validation on insert - the owning
 * table's insert() supplies it (see createOwnedGroup / CommitteeTable.insert).
 * Nullable for owners where "no group" means something (a task's NULL =
 * inherit the project's assignment - see task.ts).
 */
export class OwnedGroupField extends ForeignKeyField {
    constructor(name: string = 'group_id', opts: {nullable?: boolean} = {}) {
        super(name, 'volunteer_group', 'group_id', {indexed: true, ...opts});
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

// The EXPLICIT named->adhoc conversion (the "mixing quirk" in the file header):
// copy the named group's CURRENT members into a fresh adhoc group owned by
// (owner_table, owner_id), stamped with derived_from = the named group's
// display name - so pages can say "Customized from Logistics Committee".  Only
// ever invoked behind a user confirmation (never as a silent side effect of a
// member edit); the named group itself is untouched.
export function snapshotAsOwnedAdhocGroup(named_group_id: number,
                                          owner_table: string, owner_id: number): number {
    const src = rabid.volunteer_group.getById(named_group_id);
    const group_id = rabid.volunteer_group.insert({
        group_kind: 'adhoc', name: '', owner_table, owner_id,
        derived_from: rabid.volunteer_group.displayName(src), deleted: 0});
    db().execute<{src: number, dst: number}>(block`
/**/   INSERT INTO group_member(group_id, volunteer_id)
/**/          SELECT :dst, volunteer_id FROM group_member WHERE group_id = :src`,
        {src: named_group_id, dst: group_id});
    return group_id;
}

// Hard-delete an owned adhoc group its owner no longer references (e.g. a
// task's original assignee group after the task was pointed at a committee's
// named group).  Unreferenced adhoc groups have no historical referent, so -
// unlike named groups, which soft-delete - they are simply garbage.  A module
// function (NOT on the route tree): callers gate via the owning record's edit
// permission before the reference is repointed.
export function dropOrphanedAdhocGroup(group_id: number): void {
    const g = rabid.volunteer_group.getById(group_id);
    if(g.group_kind !== 'adhoc')
        throw new Error(`Refusing to drop non-adhoc group ${group_id}`);
    db().execute<{group_id: number}>(
        'DELETE FROM group_member WHERE group_id = :group_id', {group_id});
    db().execute<{group_id: number}>(
        'DELETE FROM volunteer_group WHERE group_id = :group_id', {group_id});
}

// "A", "A and B", "A, B and C" - members read as a document phrase.
function joinNames(parts: Markup[]): Markup[] {
    return parts.flatMap((p, i) =>
        i === 0 ? [p] : [i === parts.length - 1 ? ' and ' : ', ', p]);
}

// --------------------------------------------------------------------------------
// --- Assignment rendering (the shared assigned-to language) ----------------------
// --------------------------------------------------------------------------------

// A read-only reference to a group's assignees: the committee (a quiet link -
// a committee assignment does NOT unroll its members; tap through for the
// roster) when the group is a committee's named group, else the member names.
export function renderGroupRef(group_id: number): Markup {
    const g = security.runSystem(() => rabid.volunteer_group.getById(group_id));
    if(g.group_kind === 'named') {
        const committee = g.owner_table === 'committee' && g.owner_id != null
            ? security.runSystem(() => rabid.committee.getById(g.owner_id!))
            : undefined;
        return [h.span, {class: 'lm-name-list'},
            committee
                ? templates.pageLink(`/rabid.committee.detailPage(${committee.committee_id})`, committee.name)
                : rabid.volunteer_group.displayName(g)];
    }
    return rabid.volunteer_group.renderMemberList(group_id);
}

// The shared assigned-to LINE for an assignment group (a project's, or a
// task's exclusive override) - part of the groups mechanism because every
// owner renders it.  Document-weight: one wrapping line of
// "Assigned to: <who>", where <who> is the committee (a quiet link, members
// NOT unrolled) or the editable member names (with the inline "+ add member"
// verb).  The rarer assignment actions (assign/change committee, customize
// snapshot, plus the caller's extraItems, e.g. a task's revert) sit one tap
// behind the line's ☰ menu.  ownerRoute ('rabid.project' | 'rabid.task')
// parameterizes the routes.  Still THE one place to tune the presentation.
export function renderAssignmentLine(ownerRoute: string, owner_id: number, group_id: number,
                                     canEdit: boolean,
                                     extraItems: Array<{label: string, mode: action.ActionMode}> = []): Markup {
    const g = security.runSystem(() => rabid.volunteer_group.getById(group_id));
    const menu = (items: Array<{label: string, mode: action.ActionMode}>) =>
        canEdit ? action.actionMenu([...items, ...extraItems],
                                    {ariaLabel: 'Assignment actions'}) : undefined;

    if(g.group_kind === 'named') {
        return [h.div, {class: 'lm-assign-line d-flex align-items-center gap-2 flex-wrap mt-3 mb-2'},
            [h.span, {class: 'text-muted'}, 'Assigned to:'],
            renderGroupRef(group_id),
            menu([
                {label: 'Change committee…',
                 mode: {kind: 'modal', dialogUrl: `/${ownerRoute}.assignCommitteeDialog(${owner_id})`}},
                {label: 'Customize members…',
                 mode: {kind: 'confirm',
                        expr: `${ownerRoute}.customizeMembers(${owner_id})`,
                        message: `Detach from ${rabid.volunteer_group.displayName(g)}? The assignees ` +
                                 `start as the current committee members, but committee changes ` +
                                 `will no longer apply here.`}},
            ]),
        ];
    }
    // Adhoc: the member editor IS the line - its in-fragment ☰ carries all
    // the membership verbs plus (via ownerRoute/owner_id) the owner's
    // assignment verbs, so there is exactly ONE menu and it can never go
    // stale on a membership reload.
    return [h.div, {class: 'lm-assign-line d-flex align-items-center gap-2 flex-wrap mt-3 mb-2'},
        [h.span, {class: 'text-muted'}, 'Assigned to:'],
        rabid.volunteer_group.renderMemberEditor(group_id, ownerRoute, owner_id),
    ];
}

export const allDml =
    new VolunteerGroupTable().createDMLString() +
    new GroupMemberTable().createDMLString();
