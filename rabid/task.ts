// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types
/**
 * Projects / Tasks / Subtasks - a lightweight integrated task tracker.
 *
 * The model is a FIXED three-level hierarchy of three separate tables, NOT a
 * recursive tree.  The levels are different *meanings* (different fields,
 * security, rendering), so separate tables is the natural relational modeling,
 * and it dissolves the hard problems a uniform tree had:
 *
 *  - moves: a task changes project with one UPDATE of project_id (subtasks
 *    follow by FK) - no path/PK rewriting;
 *  - assignment inheritance: subtasks have NO assignees (they inherit by JOIN
 *    through their task), so there is no cascade machinery;
 *  - every query is a flat indexed join - no recursive CTEs.
 *
 * Decisions of record (see also assertion-model-style notes in git history):
 *  - ONE task table: done-ness is `status` (no parallel completed_tasks table).
 *    Live-set queries filter status != 'done'; completion is an UPDATE, so the
 *    last_change_time poll can see it.  Deletion is soft (same reason).
 *  - DEPTH IS FIXED FOREVER: no sub-subtasks.  If a subtask wants a due date or
 *    an assignee, that is the signal it is actually a task.
 *  - Subtasks are kept aggressively THIN: title + done + order, nothing else.
 *    They are part of their task's change unit - every subtask mutation stamps
 *    the parent task's last_change_time (a checklist tick IS a task change).
 *  - assigned-to lives on the PROJECT (an owned 'adhoc' volunteer set, or a
 *    committee's NAMED group - live membership - with the explicit
 *    snapshot-convert escape hatch).  Tasks INHERIT it: task.group_id is NULL
 *    by default; setting it is the per-task override - the EXCEPTION, not the
 *    rule - and it is EXCLUSIVE: an overridden task belongs to its override
 *    group alone (if it's assigned to you, it's on YOU, and it leaves your
 *    teammates' "My tasks" lists - people must be able to clear their list
 *    without doing other people's tasks).  Effective assignees may edit the
 *    task (and its override list); creating projects/tasks is host/admin.
 *  - order_key (liminal/orderkey.ts) orders tasks within a project and
 *    subtasks within a task; inserts append at the end.  Reorder UI later.
 */

import { db, Db, PreparedQuery, boolnum } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, DateField, DateTimeField, IntegerField, navChevron, reloadableItemProps, reloadableProps, liveReloadableProps, sel } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";
import {ownerLabel, ownerCanEdit} from "./owned.ts";
import {path} from "../liminal/serializable.ts";
import {Markup, h} from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated} from "../liminal/security.ts";   // hostOrAdmin is defined locally below
import * as date from "../liminal/date.ts";
import * as orderkey from "../liminal/orderkey.ts";
import * as templates from './templates.ts';
import {OwnedGroupField, createOwnedGroup, snapshotAsOwnedAdhocGroup, dropOrphanedAdhocGroup,
        renderAssignmentLine, renderGroupRef, VolunteerGroup} from './group.ts';
import {rabid} from './rabid.ts';
import {shortName, memberShortName} from './volunteer.ts';

export const routes = ()=> ({
});

const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

// Is the current actor a member of this volunteer_group?  (The "assignees may
// edit their task" check.)  A plain indexed lookup - membership is live data,
// never cached.
function actorInGroup(group_id: number|undefined|null): boolean {
    const actorId = security.current()?.actorId;
    if(group_id == null || actorId === undefined) return false;
    return !!security.runSystem(() => db().first<{x: number}>(
        'SELECT 1 AS x FROM group_member WHERE group_id = :group_id AND volunteer_id = :volunteer_id',
        {group_id, volunteer_id: actorId}));
}

// The cross-table hop for SubtaskTable's gates (mirrors canEditMembersOfGroup
// in group.ts: load the parent row as a system op, evaluate the permission as
// the current actor).
export function canEditTask(task_id: number): boolean {
    const t = security.runSystem(() => rabid.task.getById(task_id));
    return rabid.task.canEditRecord(t);
}

// A column managed entirely by the table code (order keys, change stamps,
// completion provenance): hidden from the generic record form, which also
// exempts it from required-input validation - insert()/update() overrides
// supply it.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}
class ManagedDateTimeField extends DateTimeField {
    override isVisible(): boolean { return false; }
}
class ManagedForeignKeyField extends ForeignKeyField {
    override isVisible(): boolean { return false; }
}
class ManagedBooleanField extends BooleanField {
    override isVisible(): boolean { return false; }
}

// Display name for a provenance column (null-safe: system writes - seeds,
// imports - leave no actor).  Uses the compact shortName, like volunteer
// references elsewhere.
function volunteerName(volunteer_id: number|null|undefined): string|undefined {
    if(volunteer_id == null) return undefined;
    const v = security.runSystem(() => db().first<{name: string, short_name: string}>(
        'SELECT name, short_name FROM volunteer WHERE volunteer_id = :id', {id: volunteer_id}));
    return v ? shortName(v) : undefined;
}

// A compact date for the task lists: "Jun 20" (year only when it isn't the
// current year).  Accepts a sqlite DATE or DATETIME (takes the date part).
function compactDate(d: string): string {
    const t = date.sqliteDateToTemporal(d.slice(0, 10));
    const opts: Record<string, string> = {month: 'short', day: 'numeric'};
    if (t.year !== date.orgToday().year) opts.year = 'numeric';
    return t.toLocaleString('en-US', opts);
}

// (The shared assigned-to line now lives in group.ts - renderAssignmentLine /
// renderGroupRef - packaged with the groups mechanism, since every owner
// table renders it.)

// --------------------------------------------------------------------------------
// --- Project ---------------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface Project {
    project_id: number;
    name: string;
    description: string;

    // The project's assignment - THE assigned-to of record for its tasks
    // (tasks inherit it unless individually overridden; see Task.group_id).
    // An owned 'adhoc' set of volunteers, or a committee's NAMED group (live:
    // membership follows the committee) with the explicit customize-snapshot
    // escape hatch.  (Subsumes the old informational committee_id FK.)
    group_id: number;

    // Soft backlink to a single owning record (e.g. 'event', 12) for a project
    // that IS another tuple's task list - an event/volunteer/bike owns a 1-1
    // project.  Null for a standalone project.  An owned project's name is kept
    // '' (it renders through its owner - see recordLabel), and its edit
    // permission delegates to the owner (see recordEdit).  1-1 enforced by a
    // unique index; created lazily on the owner's first task (see forOwner).
    owner_table?: string;
    owner_id?: number;

    // Archived projects are soft-deleted: their tasks/history keep working.
    deleted: boolnum;

    // Archive provenance (the project's terminal transition): who archived it
    // and when.  Describes the CURRENT state - unarchiving clears both (this
    // is not an audit log).  Null archived_by = a system write (seeds, imports).
    archived_time?: string;
    archived_by?: number;

    // Creation provenance: who created the project and when, so people know
    // who to ask about it.  Nullable: rows that predate these columns, and
    // system writes (seeds, imports), have no creator.
    created_time?: string;
    created_by?: number;
}

export type ProjectOpt = Partial<Project>;

export class ProjectTable extends Table<Project> {

    constructor() {
        super ('project', [
            new PrimaryKeyField('project_id', {}),
            new StringField('name', {default: ''}),
            new MarkdownField('description', {default: ''}),
            new OwnedGroupField('group_id'),
            new StringField('owner_table', {nullable: true}),
            new IntegerField('owner_id', {nullable: true}),
            new BooleanField('deleted', {default: 0, prompt: 'Done'}),
            new ManagedDateTimeField('archived_time', {nullable: true}),
            new ManagedForeignKeyField('archived_by', 'volunteer', 'volunteer_id', {nullable: true}, 'name'),
            new ManagedDateTimeField('created_time', {nullable: true}),
            new ManagedForeignKeyField('created_by', 'volunteer', 'volunteer_id', {nullable: true}, 'name'),
        ], [
            // 1-1: at most one project per owner.  (NULLs are distinct in SQLite,
            // so standalone projects - owner_table/owner_id NULL - are unconstrained.)
            'CREATE UNIQUE INDEX IF NOT EXISTS project_by_owner ON project(owner_table, owner_id);',
        ])
    };

    // Creating a project creates its (empty) assignment group (the same
    // owner-backlink sequence as committees/tasks); creation provenance rides
    // on every insert (the New-project saveForm path included - all managed
    // fields, absent from the form).
    override insert<P extends Partial<Project>>(tuple: P): number {
        const withManaged: any = {
            created_time: date.currentSqliteDateTime(),
            created_by: security.current()?.actorId ?? null,
            ...tuple};
        if(withManaged.group_id !== undefined)
            return super.insert(withManaged);
        const group_id = createOwnedGroup('adhoc', 'project');
        const project_id = super.insert({...withManaged, group_id});
        rabid.volunteer_group.update(group_id, {owner_id: project_id});
        return project_id;
    }

    // ------------------------------------------------------------------------
    // --- Assignment (people, or a committee) ----------------------------------
    // ------------------------------------------------------------------------
    //
    // The project's assignment is the assigned-to of record for its tasks
    // (tasks inherit unless overridden - see Task.group_id).  Same dual model
    // and the same actions as a task override: an adhoc set of volunteers, or
    // a committee's named group (live) with the explicit customize snapshot.

    @route(authenticated)
    assignCommitteeDialog(project_id: number): Markup {
        const p = this.getById(project_id);
        if(!this.canEditRecord(p))
            throw new Error('Not permitted to edit this project');
        return [
            [h.p, {class: 'text-muted small'},
             'The current assignee list is replaced; membership then follows the committee.'],
            action.renderParamForm(
                [new ForeignKeyField('committee_id', 'committee', 'committee_id', {}, 'name')],
                {},
                {
                    title: `Assign a committee to ${this.recordLabel(p)}`,
                    submitLabel: 'Assign',
                    hidden: {project_id},
                    dispatch: {onsubmit:
                        'event.preventDefault(); tx`rabid.project.assignCommittee(${getFormJSON(event.target)})`'},
                }),
        ];
    }

    // Point the project at the committee's named group (live), and drop the
    // project's own now-orphaned adhoc group.
    @routeMutation(authenticated)
    assignCommittee(args: {project_id?: string|number, committee_id?: string|number}): Markup {
        const project_id = Number(args?.project_id);
        const committee_id = Number(args?.committee_id);
        if(!Number.isInteger(project_id) || !project_id) throw new Error('Missing project');
        if(!Number.isInteger(committee_id) || !committee_id) throw new Error('Please choose a committee');
        const p = this.getById(project_id);
        if(!this.canEditRecord(p))
            throw new Error('Not permitted to edit this project');
        const committee = security.runSystem(() => rabid.committee.getById(committee_id));
        if(committee.group_id !== p.group_id) {
            const old = security.runSystem(() => rabid.volunteer_group.getById(p.group_id));
            this.update(project_id, {group_id: committee.group_id});
            if(old.group_kind === 'adhoc' && old.owner_table === 'project' && old.owner_id === project_id)
                security.runSystem(() => dropOrphanedAdhocGroup(old.group_id));
        }
        return {action:'reload', targets:[`.-project-${project_id}-`]} as unknown as Markup;
    }

    // The EXPLICIT committee->custom conversion (always behind a confirm).
    @routeMutation(authenticated)
    customizeMembers(project_id: number): Markup {
        const p = this.getById(project_id);
        if(!this.canEditRecord(p))
            throw new Error('Not permitted to edit this project');
        const g = security.runSystem(() => rabid.volunteer_group.getById(p.group_id));
        if(g.group_kind === 'named') {
            const group_id = security.runSystem(() =>
                snapshotAsOwnedAdhocGroup(g.group_id, 'project', project_id));
            this.update(project_id, {group_id});
        }
        return {action:'reload', targets:[`.-project-${project_id}-`]} as unknown as Markup;
    }

    // Standalone projects are host/admin-managed; an OWNED project delegates to
    // its owner (whoever may edit the event may manage the event's tasks).
    private canEditProject: security.Permission = a => {
        const p = a.record as Project | undefined;
        if(p && p.owner_table != null && p.owner_id != null)
            return ownerCanEdit(p.owner_table, p.owner_id);
        return hostOrAdmin(a);
    };
    defaultFieldEdit: security.Permission = a => this.canEditProject(a);
    override get recordEdit(): security.Permission { return this.canEditProject; }

    override formTitle(p: Project): string {
        return p.project_id ? `Edit ${this.recordLabel(p)}` : 'New project';
    }

    // An owned project renders through its owner (suffixed so it reads as a
    // task list in mixed lists); a standalone project goes by its own name.
    override recordLabel(p: Project): string {
        if(p.owner_table != null && p.owner_id != null)
            return `${ownerLabel(p.owner_table, p.owner_id)} — tasks`;
        return p.name || 'Unnamed project';
    }

    // The owner's 1-1 project, found by backlink (any state - the unique index
    // means there's at most one ever).  `create` materializes it lazily, which
    // is how an owned project comes into being: on the owner's first task.
    @path
    get ownedProjectByOwner() {
        return this.prepare<Project, {owner_table: string, owner_id: number}>(block`
/**/   SELECT ${this.allFields} FROM project
/**/          WHERE owner_table = :owner_table AND owner_id = :owner_id
/**/          LIMIT 1`);
    }
    forOwner(owner_table: string, owner_id: number, create = false): number | undefined {
        const existing = security.runSystem(() => this.ownedProjectByOwner.first({owner_table, owner_id}));
        if(existing) return existing.project_id;
        if(!create) return undefined;
        return this.insert({owner_table, owner_id, name: ''} as Partial<Project>);
    }

    // A `deleted` change across the archive boundary sets/clears the archive
    // provenance.  All updates funnel through updateNamedFields (update()
    // delegates), so the generic saveForm path and direct calls both stamp.
    override updateNamedFields<P extends Partial<Project>>(id: number, fieldNames: Array<keyof P>, fields: P) {
        const amended: any = {...fields};
        const names: any[] = [...fieldNames];
        if(amended.deleted !== undefined && amended.archived_time === undefined) {
            const wasArchived = !!security.runSystem(() => this.getById(id)).deleted;
            if(amended.deleted && !wasArchived) {
                amended.archived_time = date.currentSqliteDateTime();
                amended.archived_by = security.current()?.actorId ?? null;
                names.push('archived_time', 'archived_by');
            } else if(!amended.deleted && wasArchived) {
                amended.archived_time = null;
                amended.archived_by = null;
                names.push('archived_time', 'archived_by');
            }
        }
        super.updateNamedFields(id, names, amended);
    }
    override update<P extends Partial<Project>>(id: number, fields: P) {
        this.updateNamedFields(id, Object.keys(fields) as Array<keyof P>, fields);
    }

    // Mark done / reopen: first-class confirmed actions over the project's
    // terminal flag (the `deleted` column, presented as "Done" in the UI; the
    // edit dialog's Done checkbox is the same flag).  updateNamedFields above
    // stamps/clears the archived_time/archived_by provenance.
    @routeMutation(authenticated)
    markDone(project_id: number): Markup {
        return this.setDone(project_id, 1);
    }
    @routeMutation(authenticated)
    reopen(project_id: number): Markup {
        return this.setDone(project_id, 0);
    }
    private setDone(project_id: number, deleted: 0|1): Markup {
        const p = this.getById(project_id);
        if(!this.canEditRecord(p))
            throw new Error('Not permitted to edit this project');
        this.updateNamedFields(project_id, ['deleted'], {deleted});
        return {action:'reload', targets:[`.-project-${project_id}-`]} as unknown as Markup;
    }

    @path
    get activeProjects() {
        return this.prepare<Project & {committee_name?: string, open_task_count: number}, {}>(block`
/**/   SELECT ${this.allFields},
/**/          (SELECT c.name FROM volunteer_group g
/**/                  JOIN committee c ON g.owner_table = 'committee' AND c.committee_id = g.owner_id
/**/                  WHERE g.group_id = project.group_id)
/**/              AS committee_name,
/**/          (SELECT COUNT(*) FROM task t
/**/                  WHERE t.project_id = project.project_id
/**/                    AND t.deleted = 0 AND t.status != 'done')
/**/              AS open_task_count
/**/          FROM project
/**/          WHERE deleted = 0
/**/          ORDER BY name`);
    }

    // Projects ASSIGNED to a committee (project.group_id is the committee's
    // group) - distinct from the committee's own owned project (which carries
    // owner_table='committee' and has its own group; excluded here).
    @path
    get projectsForCommittee() {
        return this.prepare<Project & {open_task_count: number}, {committee_id: number}>(block`
/**/   SELECT ${this.allFields},
/**/          (SELECT COUNT(*) FROM task t WHERE t.project_id = project.project_id
/**/                  AND t.deleted = 0 AND t.status != 'done') AS open_task_count
/**/          FROM project
/**/          WHERE owner_table IS NULL AND deleted = 0
/**/            AND group_id = (SELECT group_id FROM committee WHERE committee_id = :committee_id)
/**/          ORDER BY name`);
    }

    // The committee's assigned-projects list, for embedding on the committee page.
    @route(authenticated)
    renderForCommittee(committee_id: number): Markup {
        const projects = this.projectsForCommittee.all({committee_id});
        if(projects.length === 0)
            return [h.p, {class: 'text-muted small mb-0'}, 'No projects assigned.'];
        return [h.div, {class: 'list-group lm-list'}, projects.map(p => this.renderProjectRow(p))];
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list -----------------------------------------
    // ------------------------------------------------------------------------

    // Self-fetching reloadable list wrapper: a "New project" insert reloads
    // `.-project-` (the pk-less reload target the base saveForm emits).
    @route(authenticated)
    renderProjectList(): Markup {
        const projects = this.activeProjects.all({});
        const props = this.reloadableItemProps(undefined, `rabid.project.renderProjectList()`);
        return [h.div, props,
            projects.length === 0
                ? [h.p, {class: 'text-muted'}, 'No projects yet.']
                : [h.div, {class: 'list-group lm-list'},
                   projects.map(p => this.renderProjectRow(p))]];
    }

    renderProjectRow(p: Project & {committee_name?: string, open_task_count?: number}): Markup {
        const id = p.project_id;
        const count = p.open_task_count
            ?? rabid.task.openCountForProject.required({project_id: id}).n;
        const secondary = [`${count} open task${count === 1 ? '' : 's'}`,
                           p.committee_name, p.description]
            .filter(Boolean).join(' · ');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link name); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `rabid.project.renderProjectRowById(${id})`);
        return [h.div, {...item, 'data-testid': `project-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.project.detailPage(${id})`),
                     class: 'lm-nav-link'}, this.recordLabel(p)]],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(p) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderProjectRowById(id: number): Markup {
        return this.renderProjectRow(this.getById(id));
    }

    // The top-level Projects page body (dispatched from the navbar's /projects).
    @route(authenticated)
    renderProjectsPage(): Markup {
        const canCreate = this.canEditRecord({} as Project);
        return [h.div, {class: 'container py-3'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-2'},
             [h.h2, {class: 'mb-0'}, 'Projects'],
             canCreate
                 ? action.actionButton('New project',
                     {kind: 'modal', dialogUrl: '/rabid.project.newDialog()'},
                     'btn btn-outline-primary btn-sm')
                 : undefined],
            this.renderProjectList(),
        ];
    }

    @route(hostOrAdmin)
    newDialog(): Markup {
        return this.renderForm({} as Project);
    }

    // ------------------------------------------------------------------------
    // --- Project detail page --------------------------------------------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    detailPage(project_id: number): templates.Page {
        const p = this.getById(project_id);
        return templates.page(`${this.recordLabel(p)} — Project`, this.renderProjectDetail(project_id));
    }

    // Composition ONLY - deliberately NOT itself a reloadable fragment: the
    // project-record header, the task list, and the provenance foot are each
    // their own fragment registering their own keys, so a project-record edit
    // (name, description, assignment) re-renders the header/foot WITHOUT
    // touching the task list, and task churn touches neither (liminal.md:
    // register the finest sufficient key).
    @route(authenticated)
    renderProjectDetail(project_id: number): Markup {
        return [h.div, {class: 'container py-3'},
            this.renderProjectHeader(project_id),
            rabid.task.renderProjectTasks(project_id),
            this.renderProjectProvenance(project_id),
        ];
    }

    // The project-record header: the title (a heading) + a soft Done pill +
    // edit + the project's ☰ (its terminal mark-done/reopen transition; the
    // confirm carries the open-task count - finishing with work outstanding
    // should be deliberate), then the project's own prose and its assignment
    // line.  Registered under the project ROW key: a record edit re-renders
    // exactly this.
    @route(authenticated)
    renderProjectHeader(project_id: number): Markup {
        const p = this.getById(project_id);
        const openCount = rabid.task.openCountForProject.required({project_id}).n;
        const props = reloadableProps([this.rowKey(project_id)],
                                      `rabid.project.renderProjectHeader(${project_id})`);
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-2'},
             [h.h2, {class: 'mb-0'}, this.recordLabel(p)],
             p.deleted
                 ? [h.span, {class: 'badge rounded-pill bg-secondary-subtle text-secondary-emphasis'}, 'Done']
                 : undefined,
             this.canEditRecord(p) ? this.editPencil(project_id) : undefined,
             this.canEditRecord(p)
                 ? action.actionMenu([
                       p.deleted
                           ? {label: 'Reopen project…',
                              mode: {kind: 'confirm', expr: `rabid.project.reopen(${project_id})`,
                                     message: `Reopen ${this.recordLabel(p)}?`}}
                           : {label: 'Mark project done…',
                              mode: {kind: 'confirm', expr: `rabid.project.markDone(${project_id})`,
                                     message: openCount > 0
                                         ? `${openCount} open task${openCount === 1 ? '' : 's'} remain - ` +
                                           `mark ${this.recordLabel(p)} done anyway?`
                                         : `Mark ${this.recordLabel(p)} done?`}},
                   ], {ariaLabel: 'Project actions'})
                 : undefined],
            // The project's own prose, given prominence (the "what is this") -
            // not buried beneath provenance metadata as before.
            p.description
                ? [h.div, {class: 'lm-prose mb-3'}, this.fieldsByName.description.render(p.description)]
                : undefined,
            // The project's assignment: THE assigned-to its tasks inherit.
            renderAssignmentLine('rabid.project', project_id, p.group_id, this.canEditRecord(p)),
        ];
    }

    // The quiet provenance foot: when/by-whom the project was created (and
    // marked done) - reference, not the headline, so it sits BELOW the tasks.
    // Its own row-keyed fragment (the Done line changes on markDone/reopen);
    // the wrapper always renders, even empty, so it can reload back into
    // existence.
    @route(authenticated)
    renderProjectProvenance(project_id: number): Markup {
        const p = this.getById(project_id);
        const props = reloadableProps([this.rowKey(project_id)],
                                      `rabid.project.renderProjectProvenance(${project_id})`);
        const who = (id: number|undefined) =>
            id != null
                ? [' by ', templates.pageLink(`/rabid.volunteer.detailPage(${id})`,
                                              volunteerName(id) ?? `volunteer ${id}`)]
                : undefined;
        const lines: Markup[] = [];
        if (p.deleted && p.archived_time)
            lines.push([h.div, {}, `Done ${date.sqliteDateTimeToDateString(p.archived_time)}`, who(p.archived_by)]);
        if (p.created_time)
            lines.push([h.div, {}, `Created ${date.sqliteDateTimeToDateString(p.created_time)}`, who(p.created_by)]);
        return [h.div, {...props,
                        class: 'text-muted small mt-4 pt-2 ' + (lines.length > 0 ? 'border-top ' : '') + props.class},
                ...lines];
    }
}

// --------------------------------------------------------------------------------
// --- Task ------------------------------------------------------------------------
// --------------------------------------------------------------------------------

export const task_status_enum: Record<string, string> = {
    'open': 'Open',
    'in-progress': 'In progress',
    'done': 'Done',
};

export const task_priority_enum: Record<string, string> = {
    'low': 'Low',
    'normal': 'Normal',
    'high': 'High',
};

export interface Task {
    task_id: number;
    project_id: number;        // visible in the edit form: moving a task IS editing this
    title: string;
    details: string;
    priority: string;          // task_priority_enum
    due?: string;              // 'YYYY-MM-DD' (day granularity)
    status: string;            // task_status_enum - done-ness lives HERE (one table)

    // The task's EXCLUSIVE assignment override - the EXCEPTION, not the rule.
    // NULL (the default) = the task belongs to whoever the project is
    // assigned to (Project.group_id).  Set = this task is on the override
    // group ALONE: it shows on their "My tasks" list and leaves everyone
    // else's (people must be able to clear their list without doing other
    // people's tasks).  An owned 'adhoc' set, or a committee's named group,
    // exactly like the project-level assignment.
    group_id?: number;

    order_key: string;         // sibling order within the project (orderkey.ts)
    last_change_time: string;  // stamped on every insert/update + subtask change
    deleted: boolnum;

    // Completion provenance: who moved it to 'done' and when.  Describes the
    // CURRENT done state - reopening clears both (not an audit log).  Null
    // done_by = a system write (seeds, imports).
    done_time?: string;
    done_by?: number;

    // Creation provenance: who created the task and when, so an assignee
    // (staff especially - they can't just ignore an assigned item) knows who
    // to ask about it.  Nullable: rows that predate these columns, and system
    // writes (seeds, imports), have no creator.
    created_time?: string;
    created_by?: number;
}

export type TaskOpt = Partial<Task>;

// A task row carrying its list context (project name + the row counts) - the
// shape the cross-project queries return.
export type TaskWithContext = Task & {
    project_name: string;
    // The owning record of the task's project, when it is an OWNED project - so
    // the cross-project lists can derive its label (see projectRowLabel).
    project_owner_table?: string | null;
    project_owner_id?: number | null;
    subtask_count: number;
    subtask_done_count: number;
    assignee_count: number;
};

// The label to show for a task row's project: the stored name, or - for an owned
// project (name kept '') - the owner's label, suffixed.
export function projectRowLabel(t: Partial<TaskWithContext>): string {
    if(t.project_name && t.project_name.trim()) return t.project_name;
    if(t.project_owner_table && t.project_owner_id != null)
        return `${ownerLabel(t.project_owner_table, t.project_owner_id)} — tasks`;
    return 'Unnamed project';
}

export class TaskTable extends Table<Task> {

    constructor() {
        super ('task', [
            new PrimaryKeyField('task_id', {}),
            new ForeignKeyField('project_id', 'project', 'project_id', {prompt: 'Project'}, 'name'),
            new StringField('title', {}),
            new MarkdownField('details', {default: ''}),
            new EnumField('priority', task_priority_enum, {default: 'normal'}),
            new DateField('due', {nullable: true, prompt: 'Due date'}),
            new EnumField('status', task_status_enum, {default: 'open'}),
            new OwnedGroupField('group_id', {nullable: true}),   // NULL = inherit project's
            new ManagedStringField('order_key', {default: ''}),
            new ManagedDateTimeField('last_change_time', {}),
            new BooleanField('deleted', {default: 0}),
            new ManagedDateTimeField('done_time', {nullable: true}),
            new ManagedForeignKeyField('done_by', 'volunteer', 'volunteer_id', {nullable: true}, 'name'),
            new ManagedDateTimeField('created_time', {nullable: true}),
            new ManagedForeignKeyField('created_by', 'volunteer', 'volunteer_id', {nullable: true}, 'name'),
        ], [
            'CREATE INDEX IF NOT EXISTS task_by_project ON task(project_id);',
            'CREATE INDEX IF NOT EXISTS task_by_group ON task(group_id);',
            // The concurrent-change poll ("what changed since :t?") - covers
            // completions and soft-deletes too, since both are UPDATEs.
            'CREATE INDEX IF NOT EXISTS task_by_change ON task(last_change_time);',
            // Completed-by-volunteer (the Time view's task layer): WHERE done_by
            // ORDER BY done_time.
            'CREATE INDEX IF NOT EXISTS task_by_done_by ON task(done_by, done_time);',
        ])
    };

    // Hosts/admins, OR the task's EFFECTIVE assignees: being assigned a task
    // means being able to work it (status, checklist, and - via the group
    // owner backlink - the override assignee list).  Effective = the override
    // group when set (EXCLUSIVE - see Task.group_id), else the project's
    // assignment.  Creation (no record yet) is host/admin only.
    private canWorkTask: security.Permission = a => {
        if(hostOrAdmin(a)) return true;
        const t = a.record as Task|undefined;
        return t != null && actorInGroup(this.effectiveGroupId(t));
    };
    defaultFieldEdit: security.Permission = a => this.canWorkTask(a);
    override get recordEdit(): security.Permission { return this.canWorkTask; }

    // The group a task's assignment resolves to: its own exclusive override
    // when set, else its project's assignment.
    effectiveGroupId(t: Task): number|undefined {
        if(t.group_id != null) return t.group_id;
        if(t.project_id == null) return undefined;
        return security.runSystem(() => rabid.project.getById(t.project_id)).group_id;
    }

    override formTitle(t: Task): string {
        return t.task_id ? `Edit ${t.title || 'task'}` : 'New task';
    }

    // Appends the task at the end of its project's order.  A new task has NO
    // assignment group of its own - it inherits the project's (group_id NULL;
    // overrideAssignees / assignCommittee create the exceptional override).
    // Serves the generic saveForm insert path too (group_id/order_key/
    // last_change_time are managed fields, absent from the form).
    override insert<P extends Partial<Task>>(tuple: P): number {
        const withManaged: any = {
            order_key: this.nextOrderKey(tuple.project_id),
            last_change_time: date.currentSqliteDateTime(),
            created_time: date.currentSqliteDateTime(),
            created_by: security.current()?.actorId ?? null,
            ...tuple};
        // A task born done (seeds, imports) still gets its completion stamp.
        if(withManaged.status === 'done' && withManaged.done_time === undefined) {
            withManaged.done_time = date.currentSqliteDateTime();
            withManaged.done_by = security.current()?.actorId;
        }
        return super.insert(withManaged);
    }

    // Every update stamps last_change_time, and a status change across the
    // 'done' boundary sets/clears the completion provenance (done_time/done_by
    // describe the CURRENT done state - reopening clears them; full history
    // would be an audit log, which this deliberately is not).  All updates
    // funnel through here (update() delegates), so the generic saveForm path
    // and direct calls both stamp.
    override updateNamedFields<P extends Partial<Task>>(id: number, fieldNames: Array<keyof P>, fields: P) {
        const amended: any = {...fields, last_change_time: date.currentSqliteDateTime()};
        const names: any[] = [...fieldNames, 'last_change_time'];
        if(typeof amended.status === 'string' && amended.done_time === undefined) {
            const wasDone = security.runSystem(() => this.getById(id)).status === 'done';
            if(amended.status === 'done' && !wasDone) {
                amended.done_time = date.currentSqliteDateTime();
                amended.done_by = security.current()?.actorId ?? null;
                names.push('done_time', 'done_by');
            } else if(amended.status !== 'done' && wasDone) {
                amended.done_time = null;
                amended.done_by = null;
                names.push('done_time', 'done_by');
            }
        }
        super.updateNamedFields(id, names, amended);
    }
    override update<P extends Partial<Task>>(id: number, fields: P) {
        this.updateNamedFields(id, Object.keys(fields) as Array<keyof P>, fields);
    }

    // A subtask mutation IS a change to its task (the poll watches tasks).
    // DELIBERATELY a raw write with NO dirty-key emission: its consumer is the
    // task_by_change poll, not page fragments - going through this.update
    // would notify `-task-<id>-` (and the project fk key) and cascade a full
    // task-block/list re-render on every checklist tick.
    touch(task_id: number): void {
        db().execute<{task_id: number, now: string}>(
            'UPDATE task SET last_change_time = :now WHERE task_id = :task_id',
            {task_id, now: date.currentSqliteDateTime()});
    }

    // Append after the project's current last task.  Order keys are decimal
    // strings ('0.5...') whose lexicographic order is their numeric order, so
    // SQL MAX finds the last one.
    private nextOrderKey(project_id: number|undefined): string {
        const last = project_id === undefined ? undefined :
            db().first<{k: string|null}>(
                'SELECT MAX(order_key) AS k FROM task WHERE project_id = :project_id',
                {project_id});
        return orderkey.between(last?.k, undefined);
    }

    @path
    get tasksForProject() {
        return this.prepare<Task & {subtask_count: number, subtask_done_count: number, assignee_count: number},
                            {project_id: number}>(block`
/**/   SELECT ${this.allFields},
/**/          (SELECT COUNT(*) FROM subtask s WHERE s.task_id = task.task_id) AS subtask_count,
/**/          (SELECT COUNT(*) FROM subtask s WHERE s.task_id = task.task_id AND s.done = 1)
/**/              AS subtask_done_count,
/**/          (SELECT COUNT(*) FROM group_member gm WHERE gm.group_id = COALESCE(task.group_id,
/**/                  (SELECT p.group_id FROM project p WHERE p.project_id = task.project_id)))
/**/              AS assignee_count
/**/          FROM task
/**/          WHERE project_id = :project_id AND deleted = 0
/**/          ORDER BY order_key`);
    }

    @path
    get openCountForProject() {
        return this.prepare<{n: number}, {project_id: number}>(block`
/**/   SELECT COUNT(*) AS n FROM task
/**/          WHERE project_id = :project_id AND deleted = 0 AND status != 'done'`);
    }

    // Tasks a volunteer COMPLETED (done_by them), each with its project's owner
    // and - when event-owned - the event's context.  Feeds the Time view's
    // completed-task layer (see volunteer_time CompletedTaskRow / taskToSpan).
    @path
    get completedByVolunteer() {
        return this.prepare<{
            task_id: number, title: string, done_time: string,
            project_owner_table: string | null, project_owner_id: number | null,
            event_start: string | null, event_end: string | null, event_label: string | null,
        }, {volunteer_id: number}>(block`
/**/   SELECT t.task_id, t.title, t.done_time,
/**/          p.owner_table AS project_owner_table, p.owner_id AS project_owner_id,
/**/          e.start_time AS event_start, e.end_time AS event_end, e.description AS event_label
/**/          FROM task t
/**/               JOIN project p ON p.project_id = t.project_id
/**/               LEFT JOIN event e ON p.owner_table = 'event' AND e.event_id = p.owner_id
/**/          WHERE t.done_by = :volunteer_id AND t.status = 'done' AND t.done_time IS NOT NULL
/**/          ORDER BY t.done_time`);
    }

    // The cross-project work views (the queries the assigned-to group model
    // exists for: task -> group_member is one flat indexed join).

    // "My tasks": open tasks the volunteer is EFFECTIVELY assigned to (their
    // task overrides + the non-overridden tasks of their projects - an
    // overridden task is exclusive, so it leaves teammates' lists), most
    // urgent first (overdue/dated before undated).
    @path
    get openTasksForVolunteer() {
        return this.prepare<TaskWithContext, {volunteer_id: number}>(block`
/**/   SELECT ${this.fieldNames.map(n => 'task.'+n).join(',')},
/**/          p.name AS project_name,
/**/          p.owner_table AS project_owner_table, p.owner_id AS project_owner_id,
/**/          (SELECT COUNT(*) FROM subtask s WHERE s.task_id = task.task_id) AS subtask_count,
/**/          (SELECT COUNT(*) FROM subtask s WHERE s.task_id = task.task_id AND s.done = 1)
/**/              AS subtask_done_count,
/**/          (SELECT COUNT(*) FROM group_member g2
/**/                  WHERE g2.group_id = COALESCE(task.group_id, p.group_id))
/**/              AS assignee_count
/**/          FROM task JOIN project p ON p.project_id = task.project_id
/**/               JOIN group_member gm ON gm.group_id = COALESCE(task.group_id, p.group_id)
/**/          WHERE gm.volunteer_id = :volunteer_id
/**/            AND task.deleted = 0 AND task.status != 'done'
/**/          ORDER BY task.due IS NULL, task.due, project_name, task.order_key`);
    }

    // All open tasks, grouped by project (the render inserts the headings).
    @path
    get allOpenTasks() {
        return this.prepare<TaskWithContext, {}>(block`
/**/   SELECT ${this.allFields},
/**/          (SELECT p.name FROM project p WHERE p.project_id = task.project_id) AS project_name,
/**/          (SELECT p.owner_table FROM project p WHERE p.project_id = task.project_id) AS project_owner_table,
/**/          (SELECT p.owner_id FROM project p WHERE p.project_id = task.project_id) AS project_owner_id,
/**/          (SELECT COUNT(*) FROM subtask s WHERE s.task_id = task.task_id) AS subtask_count,
/**/          (SELECT COUNT(*) FROM subtask s WHERE s.task_id = task.task_id AND s.done = 1)
/**/              AS subtask_done_count,
/**/          (SELECT COUNT(*) FROM group_member gm WHERE gm.group_id = COALESCE(task.group_id,
/**/                  (SELECT p.group_id FROM project p WHERE p.project_id = task.project_id)))
/**/              AS assignee_count
/**/          FROM task
/**/          WHERE deleted = 0 AND status != 'done'
/**/          ORDER BY project_name, project_id, order_key`);
    }

    // ------------------------------------------------------------------------
    // --- The merged project overview (google-keep style) -----------------------
    // ------------------------------------------------------------------------
    //
    // The PROJECT page is the working surface: every task renders directly on
    // it - checkbox, title, badges, and its checklist inline - so the whole
    // project is workable from one page.  Task detail pages remain for the
    // longer-form stuff (details text, provenance, assignment override).
    // Done tasks stay IN PLACE (plain order_key order) and render
    // struck-through, NOT collapsed or moved to a done wall - the
    // strikethrough shows stuff is HAPPENING (half the point in a
    // volunteer-primarily org), toggling done doesn't make the list jump
    // (jarring, and doubly confusing when liveness replays other people's
    // toggles), and a toggle re-renders only the task's own block.
    // (dz 2026-07-03: replaced the earlier sort-done-to-the-bottom wall.)

    // Self-fetching DELEGATING wrapper: the Tasks heading + the task blocks,
    // where each block is its own self-refreshing fragment.  It therefore
    // registers the SHAPE key `-task-project_id-<pid>-shape-` (liminal.md):
    // inserts, deletes, moves and archive flips re-render the list; a
    // member-content edit (checking a task off, a rename) refreshes only the
    // member's own block plus the little open-count fragment below.  The
    // fragment always renders (empty -> 'No tasks yet.'), so the in-fragment
    // affordances survive reloads.  LIVE: a project's task list is a
    // genuinely shared surface, so it also tracks other actors' edits (the
    // shape key watches structure; the count fragment is the page's CONTENT
    // liveness antenna).
    @route(authenticated)
    renderProjectTasks(project_id: number): Markup {
        const tasks = this.tasksForProject.all({project_id});
        const canCreateTask = this.canEditRecord({} as any);
        const props = liveReloadableProps([this.shapeKey('project_id', project_id)],
                                          `rabid.task.renderProjectTasks(${project_id})`);
        // The Tasks heading: the open count at a glance (its own content-keyed
        // fragment - it changes on every toggle, the wrapper doesn't), then a
        // quiet + for the common verb (new task) and the ☰ naming it for
        // discoverability.
        const heading: Markup =
            [h.div, {class: 'd-flex align-items-center gap-2 mt-4'},
             [h.h4, {class: 'mb-0'}, 'Tasks'],
             this.renderProjectOpenCount(project_id),
             canCreateTask
                 ? action.actionButton(action.plusIcon(),
                     {kind: 'modal', dialogUrl: `/rabid.task.newDialog(${project_id})`},
                     'lm-menu-button', {'aria-label': 'New task', title: 'New task'})
                 : undefined,
             canCreateTask
                 ? action.actionMenu([
                       {label: 'Add task…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.task.newDialog(${project_id})`}},
                   ], {ariaLabel: 'Task list actions'})
                 : undefined];
        if (tasks.length === 0)
            return [h.div, props, heading, [h.p, {class: 'text-muted'}, 'No tasks yet.']];
        return [h.div, props, heading, tasks.map(t => this.renderTaskBlock(t))];
    }

    // The "N open" count beside the Tasks heading: a tiny CONTENT-keyed
    // fragment (`-task-project_id-<pid>-`) - every task write in the project
    // refreshes it, while the surrounding shape-keyed wrapper stays put.
    // Being lm-live it doubles as the page's content liveness antenna:
    // another actor's toggle wakes the poll via this fragment's watch key,
    // and the entry's row key then reloads the toggled block itself.  Always
    // renders its span (empty when nothing is open) so it can reload back.
    @route(authenticated)
    renderProjectOpenCount(project_id: number): Markup {
        const n = rabid.task.openCountForProject.required({project_id}).n;
        const props = liveReloadableProps([this.fkKey('project_id', project_id)],
                                          `rabid.task.renderProjectOpenCount(${project_id})`);
        return [h.span, {...props, class: 'text-muted small ' + props.class},
                n > 0 ? `${n} open` : undefined];
    }

    // One task on the project page: a compact task line (checkbox toggles
    // done; title links to the detail page) + the checklist inline.  Its own
    // reloadable fragment, so a toggle/edit re-renders just this block.
    // Assignment shows ONLY when overridden (the exception) - the project
    // header already says who everything else belongs to.
    renderTaskBlock(t: Task): Markup {
        const id = t.task_id;
        const done = t.status === 'done';
        const canEdit = this.canEditRecord(t);
        const overdue = !done && t.due != null && t.due < date.currentSqliteDate();
        const props = this.reloadableItemProps(id, `rabid.task.renderTaskBlockById(${id})`);

        // The override marker: the committee's name, or the override members as
        // short names (the project header already says who everything else
        // belongs to; this is just the exception).
        let overrideLabel: string|undefined;
        if(t.group_id != null) {
            const g = security.runSystem(() => rabid.volunteer_group.getById(t.group_id!));
            overrideLabel = g.group_kind === 'named'
                ? rabid.volunteer_group.displayName(g)
                : security.runSystem(() => rabid.volunteer_group.members.all({group_id: t.group_id!}))
                    .map(m => memberShortName(m)).join(', ') || 'nobody yet';
        }

        return [h.div, {...props, class: 'lm-task-block ' + props.class,
                        'data-testid': `task-block-${id}`},
            // The task line: whole row navigates to the task detail (lm-navigable);
            // the checkbox toggles done and the ☰ holds the rest - both real
            // controls the navigable-click guard declines, so tapping them never
            // navigates.  No separate pencil: Edit lives in the ☰.
            [h.div, {class: 'd-flex align-items-center gap-2 lm-navigable',
                     onclick: 'lmNavigableClick(event)'},
             [h.input, {type: 'checkbox', class: 'form-check-input m-0 flex-shrink-0',
                        ...(done ? {checked: ''} : {}),
                        ...(canEdit
                            // A toggle is a member-CONTENT edit: the row key
                            // matches this block, the content fk key matches
                            // the little open-count fragment - both swap in
                            // one trip.  The shape-keyed list wrapper is
                            // deliberately not touched (tasks stay in place
                            // when toggled).
                            ? {onclick: `txd(${JSON.stringify([sel(this.rowKey(id)), sel(this.fkKey('project_id', t.project_id))])})\`rabid.task.toggleDone(${id})\``}
                            : {disabled: ''}),
                        'aria-label': `Mark ${t.title || 'task'} done`}],
             [h.div, {class: 'lm-item-primary' + (done ? ' text-muted' : '')},
              [h.a, {...templates.pageLinkProps(`/rabid.task.detailPage(${id})`),
                     class: 'lm-nav-link' + (done ? ' text-decoration-line-through' : '')},
               t.title || 'Untitled task'],
              t.status === 'in-progress'
                  ? [h.span, {class: 'badge rounded-pill bg-info-subtle text-info-emphasis fw-normal ms-2'},
                     'In progress'] : undefined,
              t.priority === 'high' && !done
                  ? [h.span, {class: 'badge rounded-pill bg-danger-subtle text-danger-emphasis fw-normal ms-2'},
                     'High'] : undefined],
             t.due && !done
                 ? [h.span, {class: 'small flex-shrink-0 ' + (overdue ? 'text-danger' : 'text-muted')},
                    compactDate(t.due), overdue ? ' · overdue' : '']
                 : undefined,
             overrideLabel
                 ? [h.span, {class: 'text-muted small flex-shrink-0',
                             'data-testid': `task-${id}-override`}, `→ ${overrideLabel}`]
                 : undefined,
             // One ☰ for everything beyond the checkbox: edit, checklist, reorder.
             canEdit
                 ? action.actionMenu([
                       {label: 'Edit…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.task.renderForm(rabid.task.getById(${id}))`}},
                       {label: 'Add checklist item…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.subtask.addItemDialog(${id})`}},
                       {label: 'Add completed item…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.subtask.addItemDialog(${id},true)`}},
                       // Moves change the list's SHAPE (order_key is a shape
                       // field) - speculate the shape key so the wrapper is
                       // the anticipated section.
                       {label: 'Move up',
                        mode: {kind: 'immediate', expr: `rabid.task.moveUp(${id})`,
                               deps: [sel(this.shapeKey('project_id', t.project_id))]}},
                       {label: 'Move down',
                        mode: {kind: 'immediate', expr: `rabid.task.moveDown(${id})`,
                               deps: [sel(this.shapeKey('project_id', t.project_id))]}},
                   ], {ariaLabel: `More actions for ${t.title || 'task'}`})
                 : undefined],
            [h.div, {class: 'lm-task-block-checklist'},
             rabid.subtask.renderChecklist(id)],
        ];
    }

    // Reload target for a single block (after a toggle or an edit save).
    @route(authenticated)
    renderTaskBlockById(id: number): Markup {
        return this.renderTaskBlock(this.getById(id));
    }

    // The merged-page checkbox: open <-> done.  (in-progress counts as
    // not-done: checking completes it; unchecking a done task reopens to
    // 'open'.)  updateNamedFields stamps/clears the completion provenance.
    @routeMutation(authenticated)
    toggleDone(task_id: number): Markup {
        const t = this.getById(task_id);
        if(!this.canEditRecord(t))
            throw new Error('Not permitted to edit this task');
        this.update(task_id, {status: t.status === 'done' ? 'open' : 'done'});
        // Dirty keys are emitted automatically by the update funnel.
        return {action:'reload'} as unknown as Markup;
    }

    // Reorder within the project, as DISPLAYED: tasks keep their place when
    // toggled done (no done wall), so open and done interleave and a move
    // ranges over ALL siblings.  A move at the end is a plain no-op; either
    // way the list fragment reloads.
    @routeMutation(authenticated)
    moveUp(task_id: number): Markup { return this.moveBy(task_id, -1); }
    @routeMutation(authenticated)
    moveDown(task_id: number): Markup { return this.moveBy(task_id, +1); }
    private moveBy(task_id: number, dir: -1|1): Markup {
        const t = this.getById(task_id);
        if(!this.canEditRecord(t))
            throw new Error('Not permitted to edit this task');
        const sibs = security.runSystem(() => this.tasksForProject.all({project_id: t.project_id}));
        const i = sibs.findIndex(s => s.task_id === task_id);
        const j = i + dir;
        if(i >= 0 && j >= 0 && j < sibs.length) {
            // Land on the far side of the displaced neighbour.
            const order_key = dir < 0
                ? orderkey.between(sibs[j-1]?.order_key, sibs[j].order_key)
                : orderkey.between(sibs[j].order_key, sibs[j+1]?.order_key);
            this.update(task_id, {order_key} as any);
        }
        // The order_key update's automatic emission (incl. the project fk
        // key) notifies the project's task list; a no-op move emits nothing.
        return {action:'reload'} as unknown as Markup;
    }

    // ------------------------------------------------------------------------
    // --- Task rows (the cross-project lists: /tasks, My tasks) -----------------
    // ------------------------------------------------------------------------

    renderTaskRow(t: Task & Partial<TaskWithContext>): Markup {
        const id = t.task_id;
        const done = t.status === 'done';
        const badges = [
            t.status !== 'open'
                ? [h.span, {class: `badge ms-2 ${done ? 'text-bg-secondary' : 'text-bg-info'}`},
                   task_status_enum[t.status] ?? t.status]
                : undefined,
            t.priority === 'high' && !done
                ? [h.span, {class: 'badge text-bg-danger ms-1'}, 'High'] : undefined,
        ];
        // Counts come with the list query; a single-row reload recomputes them.
        const items = t.subtask_count === undefined ? rabid.subtask.forTask.all({task_id: id}) : undefined;
        const subtotal = t.subtask_count ?? items!.length;
        const subDone = t.subtask_done_count ?? items!.filter(s => s.done).length;
        const effectiveGroup = t.assignee_count === undefined ? this.effectiveGroupId(t) : undefined;
        const assignees = t.assignee_count
            ?? (effectiveGroup == null ? 0
                : rabid.volunteer_group.members.all({group_id: effectiveGroup}).length);
        const overdue = !done && t.due != null && t.due < date.currentSqliteDate();
        const parts: Markup[] = [
            // A done row leads with when it was done; an open row with its due date.
            done
                ? (t.done_time ? `Done ${date.sqliteDateTimeToDateString(t.done_time)}` : undefined)
                : t.due
                    ? (overdue
                       ? [h.span, {class: 'text-danger'}, `Due ${date.sqliteDateToString(t.due)}`]
                       : `Due ${date.sqliteDateToString(t.due)}`)
                    : undefined,
            // Cross-project lists say which project the task lives in (undefined
            // project_name = a single-row reload / grouped row, where it's hidden).
            t.project_name === undefined ? undefined : projectRowLabel(t),
            assignees ? `${assignees} assigned` : 'unassigned',
            subtotal ? `${subDone}/${subtotal} done` : undefined,
        ].filter(p => p !== undefined);
        const secondary = parts.flatMap((p, i) => i ? [' · ', p] : [p]);
        const titleClass = 'lm-item-primary' + (done ? ' text-decoration-line-through text-muted' : '');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link title); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        // (the strike class rides on the <a> too: text-decoration on the
        // wrapping div doesn't reach into the anchor's own decoration)
        const item = this.detailItemProps(id, `rabid.task.renderTaskRowById(${id})`);
        return [h.div, {...item, 'data-testid': `task-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: titleClass},
              [h.a, {...templates.pageLinkProps(`/rabid.task.detailPage(${id})`),
                     class: 'lm-nav-link' + (done ? ' text-decoration-line-through' : '')},
               t.title || 'Untitled task'], badges],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(t) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderTaskRowById(id: number): Markup {
        return this.renderTaskRow(this.getById(id));
    }

    // The "new task in this project" dialog: the record form over a partial
    // record carrying the project (renderForm's empty before-snapshots on
    // inserts are what make the preset survive an untouched picker).
    @route(hostOrAdmin)
    newDialog(project_id: number): Markup {
        return this.renderForm({project_id} as Task);
    }

    // ------------------------------------------------------------------------
    // --- Owner-embedded task list (event/volunteer/bike own a 1-1 project) ----
    // ------------------------------------------------------------------------
    //
    // A reloadable "Tasks" fragment for embedding on an owner's detail page.  The
    // owned project is created LAZILY (on the first task, via addOwnerTask) - so
    // owners with no tasks stay project-free and don't clutter global lists.

    @route(authenticated)
    renderOwnerTasks(owner_table: string, owner_id: number): Markup {
        const project_id = rabid.project.forOwner(owner_table, owner_id, false);
        const props = reloadableItemProps(`owner_tasks_${owner_table}`, owner_id,
            `rabid.task.renderOwnerTasks('${owner_table}',${owner_id})`);
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mt-3'},
             [h.h4, {class: 'mb-0'}, 'Tasks'],
             ownerCanEdit(owner_table, owner_id)
                 ? action.actionButton(action.plusIcon(),
                     {kind: 'modal', dialogUrl: `/rabid.task.newOwnerTaskDialog('${owner_table}',${owner_id})`},
                     'lm-menu-button', {'aria-label': 'New task', title: 'New task'})
                 : undefined],
            project_id !== undefined
                ? this.renderProjectTasks(project_id)
                : [h.p, {class: 'text-muted small mb-0'}, 'No tasks yet.'],
        ];
    }

    // New-task dialog for an owner (no project picker - the project is the
    // owner's own).  Submit funnels through addOwnerTask, which creates the
    // owned project if this is the first task.
    @route(authenticated)
    newOwnerTaskDialog(owner_table: string, owner_id: number): Markup {
        if(!ownerCanEdit(owner_table, owner_id))
            throw new Error('Not permitted to add tasks here');
        const f = this.fieldsByName;
        return action.renderParamForm(
            [f.title, f.details, f.priority, f.due],
            {priority: 'normal'} as Partial<Task>,
            {
                title: 'New task',
                submitLabel: 'Add',
                hidden: {owner_table, owner_id},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.task.addOwnerTask(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(authenticated)
    addOwnerTask(args: {owner_table?: string, owner_id?: string|number,
                        title?: string, details?: string, priority?: string, due?: string}): Markup {
        const owner_table = String(args?.owner_table ?? '');
        const owner_id = Number(args?.owner_id);
        if(!owner_table || !Number.isInteger(owner_id) || !owner_id)
            throw new Error('Missing owner');
        if(!ownerCanEdit(owner_table, owner_id))
            throw new Error('Not permitted to add tasks here');
        const title = (args.title ?? '').trim();
        if(!title) throw new Error('Title is required');
        const project_id = rabid.project.forOwner(owner_table, owner_id, /*create*/ true)!;
        this.insert({
            project_id, title,
            details: args.details ?? '',
            priority: (args.priority as any) || 'normal',
            due: (args.due ?? '') || null,
            status: 'open', deleted: 0,
        } as Partial<Task>);
        return {action: 'reload',
                targets: [`.-owner_tasks_${owner_table}-${owner_id}-`]} as unknown as Markup;
    }

    // ------------------------------------------------------------------------
    // --- The top-level Tasks page (cross-project work view) -------------------
    // ------------------------------------------------------------------------

    // Dispatched from the navbar's /tasks: "My tasks" (assigned to the current
    // actor, most urgent first), then all open tasks grouped by project.  New
    // tasks are created from a project page (a task needs its project); rows
    // here reload individually after an edit (`.-task-<id>-`).
    @route(authenticated)
    renderTasksPage(): Markup {
        const actorId = security.current()?.actorId;
        const mine = actorId === undefined ? []
            : this.openTasksForVolunteer.all({volunteer_id: actorId});
        const all = this.allOpenTasks.all({});
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Tasks'],
            mine.length > 0
                ? [[h.h4, {class: 'mt-3'}, 'My tasks'],
                   [h.div, {class: 'list-group lm-list', 'data-testid': 'my-tasks'},
                    mine.map(t => this.renderTaskRow(t))]]
                : undefined,
            [h.h4, {class: 'mt-3'}, 'All open tasks'],
            all.length === 0
                ? [h.p, {class: 'text-muted'}, 'No open tasks.']
                : this.renderTasksGroupedByProject(all),
        ];
    }

    // One heading + list per project (rows arrive ordered by project).
    private renderTasksGroupedByProject(tasks: TaskWithContext[]): Markup {
        const out: Markup[] = [];
        let current: number|undefined;
        let group: TaskWithContext[] = [];
        const flush = () => {
            if(group.length === 0) return;
            out.push([h.h6, {class: 'mt-2 mb-1'},
                      templates.pageLink(`/rabid.project.detailPage(${group[0].project_id})`,
                                         projectRowLabel(group[0]))]);
            out.push([h.div, {class: 'list-group lm-list'},
                      group.map(t => this.renderTaskRow({...t, project_name: undefined as any}))]);
            group = [];
        };
        for(const t of tasks) {
            if(t.project_id !== current) { flush(); current = t.project_id; }
            group.push(t);
        }
        flush();
        return out;
    }

    // ------------------------------------------------------------------------
    // --- Task detail page ------------------------------------------------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    detailPage(task_id: number): templates.Page {
        const t = this.getById(task_id);
        return templates.page(`${t.title || 'Task'} — Task`, this.renderTaskDetail(task_id));
    }

    // Reloadable fragment; the assignee editor and the checklist below it are
    // their own fragments (their mutations reload just themselves).
    @route(authenticated)
    renderTaskDetail(task_id: number): Markup {
        const t = this.getById(task_id);
        const project = security.runSystem(() => rabid.project.getById(t.project_id));
        const done = t.status === 'done';
        const props = this.reloadableItemProps(task_id, `rabid.task.renderTaskDetail(${task_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [[h.dt, {class: 'col-sm-3'}, label], [h.dd, {class: 'col-sm-9'}, value]];
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0' + (done ? ' text-decoration-line-through text-muted' : '')},
              t.title || 'Untitled task'],
             [h.span, {class: `badge ${done ? 'text-bg-secondary' : 'text-bg-info'}`},
              task_status_enum[t.status] ?? t.status],
             t.deleted ? [h.span, {class: 'badge text-bg-secondary'}, 'Deleted'] : undefined,
             this.canEditRecord(t) ? this.editPencil(task_id) : undefined],
            [h.dl, {class: 'row mb-0'},
             row('Project', templates.pageLink(`/rabid.project.detailPage(${project.project_id})`, project.name)),
             row('Priority', task_priority_enum[t.priority] ?? t.priority),
             row('Due', t.due ? date.sqliteDateToString(t.due) : '—'),
             // Who to ask about this task (staff especially - they can't just
             // ignore an assigned item).
             t.created_time
                 ? row('Created', [date.sqliteDateTimeToDateString(t.created_time),
                                   t.created_by != null
                                       ? [' by ', templates.pageLink(
                                           `/rabid.volunteer.detailPage(${t.created_by})`,
                                           volunteerName(t.created_by) ?? `volunteer ${t.created_by}`)]
                                       : undefined])
                 : undefined,
             done && t.done_time
                 ? row('Done', [date.sqliteDateTimeToString(t.done_time),
                                t.done_by != null
                                    ? [' by ', templates.pageLink(
                                        `/rabid.volunteer.detailPage(${t.done_by})`,
                                        volunteerName(t.done_by) ?? `volunteer ${t.done_by}`)]
                                    : undefined])
                 : undefined,
             t.details ? row('Details', this.fieldsByName.details.render(t.details)) : undefined,
            ],
            this.renderAssignedTo(t),
            // Checklist heading in the standard grammar: a quiet + for the
            // common verb, the ☰ naming it plus the work-log variant.
            [h.div, {class: 'd-flex align-items-center gap-2 mt-3'},
             [h.h4, {class: 'mb-0'}, 'Checklist'],
             this.canEditRecord(t)
                 ? action.actionButton(action.plusIcon(),
                     {kind: 'modal', dialogUrl: `/rabid.subtask.addItemDialog(${task_id})`},
                     'lm-menu-button', {'aria-label': 'Add item', title: 'Add item'})
                 : undefined,
             this.canEditRecord(t)
                 ? action.actionMenu([
                       {label: 'Add item…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.subtask.addItemDialog(${task_id})`}},
                       {label: 'Add completed item…',
                        mode: {kind: 'modal', dialogUrl: `/rabid.subtask.addItemDialog(${task_id},true)`}},
                   ], {ariaLabel: 'Checklist actions'})
                 : undefined],
            rabid.subtask.renderChecklist(task_id),
        ];
    }

    // ------------------------------------------------------------------------
    // --- Assignment (inherited from the project; exclusive override) -----------
    // ------------------------------------------------------------------------
    //
    // The RULE is inheritance: group_id NULL -> the task belongs to whoever
    // the project is assigned to.  The EXCEPTION is the exclusive override
    // (group_id set): its own adhoc set or a committee's named group, with the
    // same customize-snapshot escape hatch as the project level.  Committee
    // assignments render READ-ONLY (member edits must never silently mutate
    // the committee).

    // The "Assigned to" line of the detail page (part of the `.-task-<id>-`
    // fragment, so the assignment actions reload the whole detail).
    renderAssignedTo(t: Task): Markup {
        const canEdit = this.canEditRecord(t);

        if(t.group_id == null) {
            // Inherited (the rule): one line referencing the project's
            // assignment (a committee shows as its name, NOT unrolled), with
            // the override actions behind the ☰.
            const project = security.runSystem(() => rabid.project.getById(t.project_id));
            return [h.div, {class: 'lm-assign-line d-flex align-items-center gap-2 flex-wrap mt-3 mb-2'},
                [h.span, {class: 'text-muted'}, 'Assigned to:'],
                renderGroupRef(project.group_id),
                [h.span, {class: 'text-muted small'},
                 '(everyone on ',
                 templates.pageLink(`/rabid.project.detailPage(${project.project_id})`,
                                    project.name || 'the project'), ')'],
                canEdit
                    ? action.actionMenu([
                          {label: 'Assign specific people…',
                           mode: {kind: 'immediate', expr: `rabid.task.overrideAssignees(${t.task_id})`}},
                          {label: 'Assign committee…',
                           mode: {kind: 'modal', dialogUrl: `/rabid.task.assignCommitteeDialog(${t.task_id})`}},
                      ], {ariaLabel: 'Assignment actions'})
                    : undefined,
            ];
        }

        // Overridden (the exception, and exclusive - this task is on these
        // people alone, not the wider project team); revert lives in the ☰.
        return renderAssignmentLine('rabid.task', t.task_id, t.group_id, canEdit, [
            {label: 'Use project assignees…',
             mode: {kind: 'confirm',
                    expr: `rabid.task.revertAssignees(${t.task_id})`,
                    message: `Drop this task's own assignees and go back to the project's?`}},
        ]);
    }

    // Start an exclusive per-task assignment: an empty task-owned adhoc group,
    // ready for Add member.  (The two-step - override, then add - keeps this a
    // plain immediate action; the action row appears as soon as it reloads.)
    @routeMutation(authenticated)
    overrideAssignees(task_id: number): Markup {
        const t = this.getById(task_id);
        if(!this.canEditRecord(t))
            throw new Error('Not permitted to edit this task');
        if(t.group_id == null) {
            const group_id = security.runSystem(() => createOwnedGroup('adhoc', 'task', task_id));
            this.update(task_id, {group_id});
        }
        return {action:'reload', targets:[`.-task-${task_id}-`]} as unknown as Markup;
    }

    // Back to inheritance: drop the override (and its now-orphaned owned adhoc
    // group; a committee's group is never touched).
    @routeMutation(authenticated)
    revertAssignees(task_id: number): Markup {
        const t = this.getById(task_id);
        if(!this.canEditRecord(t))
            throw new Error('Not permitted to edit this task');
        if(t.group_id != null) {
            const old = security.runSystem(() => rabid.volunteer_group.getById(t.group_id!));
            this.update(task_id, {group_id: null} as any);
            if(old.group_kind === 'adhoc' && old.owner_table === 'task' && old.owner_id === task_id)
                security.runSystem(() => dropOrphanedAdhocGroup(old.group_id));
        }
        return {action:'reload', targets:[`.-task-${task_id}-`]} as unknown as Markup;
    }

    // The assign-committee parameter dialog: one committee picker (type-ahead
    // via project's committee_id FK route) + the task id riding hidden.
    @route(authenticated)
    assignCommitteeDialog(task_id: number): Markup {
        const t = this.getById(task_id);
        if(!this.canEditRecord(t))
            throw new Error('Not permitted to edit this task');
        return [
            [h.p, {class: 'text-muted small'},
             'The current assignee list is replaced; membership then follows the committee.'],
            action.renderParamForm(
                [new ForeignKeyField('committee_id', 'committee', 'committee_id', {}, 'name')],
                {},
                {
                    title: `Assign a committee to ${t.title || 'this task'}`,
                    submitLabel: 'Assign',
                    hidden: {task_id},
                    dispatch: {onsubmit:
                        'event.preventDefault(); tx`rabid.task.assignCommittee(${getFormJSON(event.target)})`'},
                }),
        ];
    }

    // Override the task's assignment with the committee's named group (live),
    // and drop the task's own now-orphaned adhoc group if it had one.  Args
    // arrive from our own dialog's form (strings - the same trust model as
    // saveForm).
    @routeMutation(authenticated)
    assignCommittee(args: {task_id?: string|number, committee_id?: string|number}): Markup {
        const task_id = Number(args?.task_id);
        const committee_id = Number(args?.committee_id);
        if(!Number.isInteger(task_id) || !task_id) throw new Error('Missing task');
        if(!Number.isInteger(committee_id) || !committee_id) throw new Error('Please choose a committee');
        const t = this.getById(task_id);
        if(!this.canEditRecord(t))
            throw new Error('Not permitted to edit this task');
        const committee = security.runSystem(() => rabid.committee.getById(committee_id));
        if(committee.group_id !== t.group_id) {
            const old = t.group_id != null
                ? security.runSystem(() => rabid.volunteer_group.getById(t.group_id!))
                : undefined;
            this.update(task_id, {group_id: committee.group_id});   // stamps last_change_time
            // The task's old OWN adhoc group is now unreferenced garbage.  (A
            // previous COMMITTEE assignment fails this ownership test and is
            // left alone - reassigning never touches a committee's group.)
            if(old && old.group_kind === 'adhoc' && old.owner_table === 'task' && old.owner_id === task_id)
                security.runSystem(() => dropOrphanedAdhocGroup(old.group_id));
        }
        return {action:'reload', targets:[`.-task-${task_id}-`]} as unknown as Markup;
    }

    // The EXPLICIT committee->custom conversion (always behind the confirm
    // button above): snapshot the committee's current members into a fresh
    // task-owned adhoc group, with derived_from keeping the provenance label.
    @routeMutation(authenticated)
    customizeMembers(task_id: number): Markup {
        const t = this.getById(task_id);
        if(!this.canEditRecord(t))
            throw new Error('Not permitted to edit this task');
        if(t.group_id == null)   // inherited - nothing to customize here
            return {action:'reload', targets:[`.-task-${task_id}-`]} as unknown as Markup;
        const g = security.runSystem(() => rabid.volunteer_group.getById(t.group_id!));
        if(g.group_kind === 'named') {
            const group_id = security.runSystem(() =>
                snapshotAsOwnedAdhocGroup(g.group_id, 'task', task_id));
            this.update(task_id, {group_id});
        }
        return {action:'reload', targets:[`.-task-${task_id}-`]} as unknown as Markup;
    }
}

// --------------------------------------------------------------------------------
// --- Subtask ---------------------------------------------------------------------
// --------------------------------------------------------------------------------

// Thin BY DESIGN: a subtask is a checklist line on its task - title, done,
// order.  No assignees, no due date, no details, no soft-delete (rows are
// just deleted; the parent task's stamp records that something changed).
export interface Subtask {
    subtask_id: number;
    task_id: number;
    title: string;
    done: boolnum;
    order_key: string;

    // Check-off provenance (same rule as Task.done_time/done_by: current
    // state only; unchecking clears).
    done_time?: string;
    done_by?: number;
}

export type SubtaskOpt = Partial<Subtask>;

export class SubtaskTable extends Table<Subtask> {

    constructor() {
        super ('subtask', [
            new PrimaryKeyField('subtask_id', {}),
            // Managed (form-invisible): an item never moves between tasks, and
            // done-ness is the checkbox/toggle path (which stamps provenance) -
            // so the pencil-edit dialog is title-only.
            new ManagedForeignKeyField('task_id', 'task', 'task_id', {}, 'title'),
            new StringField('title', {}),
            new ManagedBooleanField('done', {default: 0}),
            new ManagedStringField('order_key', {default: ''}),
            new ManagedDateTimeField('done_time', {nullable: true}),
            new ManagedForeignKeyField('done_by', 'volunteer', 'volunteer_id', {nullable: true}, 'name'),
        ], [
            'CREATE INDEX IF NOT EXISTS subtask_by_task ON subtask(task_id);',
        ])
    };

    // Subtask rows are managed by the checklist actions below; these delegating
    // gates are the crafted-POST backstop for the generic saveForm path (no
    // record -> can't resolve the task -> no).
    defaultFieldEdit: security.Permission = a =>
        a.record ? canEditTask((a.record as Subtask).task_id) : false;
    override get recordEdit(): security.Permission {
        return a => a.record ? canEditTask((a.record as Subtask).task_id) : false;
    }

    override formTitle(s: Subtask): string {
        return `Edit "${s.title || 'checklist item'}"`;
    }

    // No saveForm/speculatedSaveTargets overrides needed: the checklist
    // fragment registers the fk key `-subtask-task_id-<tid>-` (renderChecklist)
    // and the automatic DML emission notifies it on every subtask write - the
    // old hand retarget to a task-keyed fake id is gone.

    // Append at the end of the task's checklist; every insert stamps the task.
    override insert<P extends Partial<Subtask>>(tuple: P): number {
        const withManaged: any = {order_key: this.nextOrderKey(tuple.task_id), ...tuple};
        // An item born checked (seeds, imports) still gets its check-off stamp.
        if(withManaged.done && withManaged.done_time === undefined) {
            withManaged.done_time = date.currentSqliteDateTime();
            withManaged.done_by = security.current()?.actorId;
        }
        const subtask_id = super.insert(withManaged);
        if(tuple.task_id !== undefined) rabid.task.touch(tuple.task_id);
        return subtask_id;
    }

    private nextOrderKey(task_id: number|undefined): string {
        const last = task_id === undefined ? undefined :
            db().first<{k: string|null}>(
                'SELECT MAX(order_key) AS k FROM subtask WHERE task_id = :task_id',
                {task_id});
        return orderkey.between(last?.k, undefined);
    }

    @path
    get forTask() {
        return this.prepare<Subtask, {task_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM subtask
/**/          WHERE task_id = :task_id
/**/          ORDER BY order_key`);
    }

    // ------------------------------------------------------------------------
    // --- Checklist actions ----------------------------------------------------
    // ------------------------------------------------------------------------
    //
    // Each gated by the parent task's edit permission and reloading the task's
    // checklist fragment (UI mutation model: toggle is immediate, remove is
    // confirm, add is a modal-of-action-arguments).

    // Args arrive from our own add-item dialogs' forms (strings, like every
    // bodyArgs form - the same trust model as saveForm).  done='1' is the
    // "Add completed item" path: this is a SHARED task system, also used to
    // tell others what got done - insert() stamps the born-done provenance
    // (who/when) so the item reads "Hazel, Jun 12" immediately.
    @routeMutation(authenticated)
    addItem(args: {task_id?: string|number, title?: string, done?: string|number}): Markup {
        const task_id = Number(args?.task_id);
        const title = String(args?.title ?? '').trim();
        const done = Number(args?.done ?? 0) ? 1 : 0;
        if(!Number.isInteger(task_id) || !task_id) throw new Error('Missing task');
        if(!title) throw new Error('Please enter a checklist item');
        if(!canEditTask(task_id))
            throw new Error('Not permitted to edit this task');
        this.insert({task_id, title, done});
        // Dirty keys (incl. the checklist's `-subtask-task_id-<tid>-`) are
        // emitted automatically by the insert funnel.
        return {action:'reload'} as unknown as Markup;
    }

    // Checking stamps who/when; unchecking clears (current-state provenance).
    @routeMutation(authenticated)
    toggle(subtask_id: number): Markup {
        const s = this.getById(subtask_id);
        if(!canEditTask(s.task_id))
            throw new Error('Not permitted to edit this task');
        this.update(subtask_id, (s.done
            ? {done: 0, done_time: null, done_by: null}
            : {done: 1, done_time: date.currentSqliteDateTime(),
               done_by: security.current()?.actorId ?? null}) as any);
        rabid.task.touch(s.task_id);
        return {action:'reload'} as unknown as Markup;
    }

    @routeMutation(authenticated)
    remove(subtask_id: number): Markup {
        const s = this.getById(subtask_id);
        if(!canEditTask(s.task_id))
            throw new Error('Not permitted to edit this task');
        this.delete(subtask_id);   // the delete funnel emits the dirty keys
        rabid.task.touch(s.task_id);
        return {action:'reload'} as unknown as Markup;
    }

    // Reorder within the task's checklist; a move at the end is a plain
    // no-op.  Reloads the checklist fragment (and stamps the task).
    @routeMutation(authenticated)
    moveUp(subtask_id: number): Markup { return this.moveBy(subtask_id, -1); }
    @routeMutation(authenticated)
    moveDown(subtask_id: number): Markup { return this.moveBy(subtask_id, +1); }
    private moveBy(subtask_id: number, dir: -1|1): Markup {
        const s = this.getById(subtask_id);
        if(!canEditTask(s.task_id))
            throw new Error('Not permitted to edit this task');
        const sibs = this.forTask.all({task_id: s.task_id});
        const i = sibs.findIndex(x => x.subtask_id === subtask_id);
        const j = i + dir;
        if(i >= 0 && j >= 0 && j < sibs.length) {
            const order_key = dir < 0
                ? orderkey.between(sibs[j-1]?.order_key, sibs[j].order_key)
                : orderkey.between(sibs[j].order_key, sibs[j+1]?.order_key);
            this.update(subtask_id, {order_key} as any);
            rabid.task.touch(s.task_id);
        }
        return {action:'reload'} as unknown as Markup;
    }

    // ------------------------------------------------------------------------
    // --- The checklist fragment ------------------------------------------------
    // ------------------------------------------------------------------------

    // The reloadable checklist for one task: BARE items only - an empty
    // checklist renders nothing at all (the page is a document presenting the
    // project's state; "No checklist items." is noise, and the add actions
    // live in the task line's ☰ menu / the detail page's buttons, both
    // OUTSIDE this fragment so reloads never eat them).  Its query is WHERE
    // task_id, so it registers the fk key `-subtask-task_id-<tid>-` - which
    // every subtask write notifies automatically.  LIVE: checking items off a
    // shared checklist is THE motivating liveness case.
    @route(authenticated)
    renderChecklist(task_id: number): Markup {
        const items = this.forTask.all({task_id});
        const canEdit = canEditTask(task_id);
        const props = liveReloadableProps([this.fkKey('task_id', task_id)],
                                          `rabid.subtask.renderChecklist(${task_id})`);
        return [h.div, props,
            items.length === 0
                ? undefined
                : [h.div, {class: 'list-group lm-list'},
                   items.map(s => this.renderChecklistRow(s, canEdit))],
        ];
    }

    renderChecklistRow(s: Subtask, canEdit: boolean): Markup {
        // Check-off provenance, shown quietly beside a done item ("Hazel · Jun 10")
        // - short name + compact date, matching the rest of the page.
        const doneByName = s.done ? volunteerName(s.done_by) : undefined;
        const prov = s.done
            ? [doneByName ? shortName({name: doneByName}) : undefined,
               s.done_time ? compactDate(s.done_time) : undefined]
                  .filter(Boolean).join(' · ')
            : '';
        return [h.div, {class: 'list-group-item lm-item d-flex align-items-center gap-2',
                        'data-testid': `subtask-row-${s.subtask_id}`},
            [h.input, {type: 'checkbox', class: 'form-check-input m-0 flex-shrink-0',
                       ...(s.done ? {checked: ''} : {}),
                       ...(canEdit
                           ? {onclick: `txd(${JSON.stringify([sel(this.fkKey('task_id', s.task_id))])})\`rabid.subtask.toggle(${s.subtask_id})\``}
                           : {disabled: ''})}],
            [h.div, {class: 'lm-item-body' + (s.done ? ' text-decoration-line-through text-muted' : '')},
             s.title],
            prov ? [h.span, {class: 'text-muted small flex-shrink-0'}, prov] : undefined,
            // One ☰ for everything beyond the checkbox (no separate pencil):
            // edit, reorder, remove.  Lighter than the parent task line.
            canEdit
                ? action.actionMenu([
                      {label: 'Edit…',
                       mode: {kind: 'modal',
                              dialogUrl: `/rabid.subtask.renderForm(rabid.subtask.getById(${s.subtask_id}))`}},
                      {label: 'Move up',
                       mode: {kind: 'immediate', expr: `rabid.subtask.moveUp(${s.subtask_id})`,
                              deps: [sel(this.fkKey('task_id', s.task_id))]}},
                      {label: 'Move down',
                       mode: {kind: 'immediate', expr: `rabid.subtask.moveDown(${s.subtask_id})`,
                              deps: [sel(this.fkKey('task_id', s.task_id))]}},
                      {label: 'Remove…',
                       mode: {kind: 'confirm',
                              expr: `rabid.subtask.remove(${s.subtask_id})`,
                              message: `Remove "${s.title}"?`,
                              deps: [sel(this.fkKey('task_id', s.task_id))]}},
                  ], {ariaLabel: `More actions for ${s.title}`})
                : undefined,
        ];
    }

    // The add-item parameter dialog: one title input + the task id (and, for
    // the Add-completed-item variant, done=1) riding hidden.
    @route(authenticated)
    addItemDialog(task_id: number, completed: boolean = false): Markup {
        if(!canEditTask(task_id))
            throw new Error('Not permitted to edit this task');
        return action.renderParamForm(
            [new StringField('title', {prompt: completed ? 'Item (already done)' : 'Item'})],
            {},
            {
                title: completed ? 'Add completed item' : 'Add checklist item',
                submitLabel: 'Add',
                hidden: completed ? {task_id, done: 1} : {task_id},
                dispatch: {onsubmit:
                    `event.preventDefault(); txd(${JSON.stringify([sel(this.fkKey('task_id', task_id))])})\`rabid.subtask.addItem(\${getFormJSON(event.target)})\``},
            });
    }
}

export const allDml =
    new ProjectTable().createDMLString() +
    new TaskTable().createDMLString() +
    new SubtaskTable().createDMLString();
