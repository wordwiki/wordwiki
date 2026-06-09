// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, sqldate, sqldatetime } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, PhoneField, EmailField, SecretField, EnumField, IntegerField, FloatingPointField, DateTimeField, TableRenderer, TableView, reloadableItemProps, editButtonProps, PublicViewable } from "../liminal/table.ts";
import {serializeAs, setSerialized, path} from "../liminal/serializable.ts";

import {block} from "../liminal/strings.ts";
import {Markup, h} from "../liminal/markup.ts";
import {lazy} from '../liminal/lazy.ts';
import * as action from "../liminal/action.ts";


/*
Tasks have:
- a title
- possibly details
- possibly progress
- status (done, in-progress, ???)
- assigned to: list of people

- possibly priority
- recurring tasks?  (like clean shop)
- good starter task?

- assigned by committees?

Tasks are in a tree.
PK is id path to a task 7/21/22
This allows efficient reads of a subtree (PK is the physical order)

Completed tasks are moved to a parallel DB with the same schema called completed_tasks - the
purpose of this is that that set will keep growing forever, and we want to keep the working
set small (current tasks) so we can read the whole thing with cost proportional to the
number of currrent tasks (with completed loaded when looking at a particular subtree - still
cheap becase of PK choice).





 */




// --------------------------------------------------------------------------------
// --- Task -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface Task {
    task_id: string;
  title: string
  name: string;
    email: string;
    phone: string;
    phone_number_visible_to_all_tasks: boolnum;

    // Skills or Experience You'd Like to Share e.g., bike repair, event planning, fundraising, social media, etc
    skills: string;
    
    emergency_contact_name: string;
    emergency_contact_phone: string;

    permissions: string;

    // Once a task is manually marked inactive, they will not show up in the common
    // lists etc.
    inactive: boolnum;
    marked_inactive_date: string;
    
    // For tasks with long inactivity, we may request exit feedback.
    exit_feedback_requested: boolnum;
    exit_reason?: string;
    exit_feedback?: string;
    
    /**
     * We disable tasks rather than deleting them because they are
     * needed to do historical statistics queries.  Depending on policy and
     * situation, one may choose to change the task, taskname and
     * email to some anon string on semantic 'delete'.
     */
    deleted: boolnum;
}
export type TaskOpt = Partial<Task>;

export class TaskTable extends Table<Task> {
    
    constructor() {
        super ('task', [
            new PrimaryKeyField('task_id', {prompt: 'Id'}),
            new DateTimeField('join_date', {nullable: true}),
            new StringField('name', {indexed: true, permissions: PublicViewable}),
            new EmailField('email', {indexed: true, unique: true, permissions: PublicViewable}),
            new PhoneField('phone', {nullable: true, permissions: PublicViewable}),
            new BooleanField('phone_number_visible_to_all_tasks', {default: 0}),
            new StringField('skills', {default: ''}),
            new StringField('emergency_contact_name', {default: ''}),
            new StringField('emergency_contact_phone', {default: ''}),
            new StringField('permissions', {nullable: true}),
            new BooleanField('inactive', {default: 0}),
            new DateTimeField('marked_inactive_date', {nullable: true}),
            new BooleanField('exit_feedback_requested', {default: 0}),
            new EnumField('exit_reason', exit_reason_enum, {nullable: true}),
            new StringField('exit_feedback', {nullable: true}),
            new BooleanField('deleted', {default: 0}),
        ], [
        ])
    };

    @path
    get byEmail() {
        return db().prepare<Task, {email: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM task
/**/          WHERE email = :email`);
    }

    @path
    get activeTasksByName() {
        return db().prepare<Task, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM task
/**/          WHERE deleted = 0 AND inactive = 0
/**/          ORDER BY name`);
    }

    @path
    get allTasksByName() {
        return db().prepare<Task, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM task
/**/          WHERE deleted = 0
/**/          ORDER BY name`);
    }

    @path
    get tasksForEvent() {
        return db().prepare<Task, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM event LEFT JOIN task
/**/          WHERE event.task_id = task.task_id
/**/          ORDER BY name`);
    }

    @path
    get tableRenderer(): TableRenderer<Task> {
        const fields = this.fieldsByName;
        return new TableRenderer(this, [fields.name, fields.email, fields.phone]);
    }

    @path
    get tableView(): TableView<Task> {
        return new TableView<Task>(this.tableRenderer, this.activeTasksByName.closure());
    }

    // ------------------------------------------------------------------------
    // --- Search (a worked example of "an action with a parameter list") -----
    // ------------------------------------------------------------------------
    //
    // Demonstrates the general popup-action model on something that is NOT a
    // record edit: a button opens a dialog collecting a search term, and
    // submitting it narrows the task list in place.  The search `scope`
    // (active-only vs. all) is a *hidden* parameter - fixed by whichever button
    // opened the dialog, not editable by the user, but submitted along with the
    // typed term.

    // Matches tasks whose email starts with the term, or whose name has a
    // word starting with the term (the leading-space trick makes the term match
    // at the start of any word).  An empty term matches everyone in scope.
    // LIKE is case-insensitive for ASCII in SQLite, so no lower() is needed.
    @path
    get searchByPrefix() {
        return db().prepare<Task, {q: string, scope: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM task
/**/          WHERE deleted = 0
/**/            AND (:scope = 'all' OR inactive = 0)
/**/            AND ( email LIKE :q || '%'
/**/                  OR (' ' || name) LIKE '% ' || :q || '%' )
/**/          ORDER BY name`);
    }

    // The Tasks section: buttons that open the search dialog with a fixed
    // (hidden) scope, plus the results container (initially the full active list).
    renderSearchableTasks(): Markup {
        return [
            [h.div, {class: 'mb-2 d-flex gap-2'},
             action.actionButton('Search active tasks',
                 {kind: 'modal', dialogUrl: "/rabid.task.searchDialog('active')"},
                 'btn btn-outline-primary btn-sm'),
             action.actionButton('Search all tasks',
                 {kind: 'modal', dialogUrl: "/rabid.task.searchDialog('all')"},
                 'btn btn-outline-secondary btn-sm'),
            ],
            [h.div, {id: 'task-search-results'},
             this.renderTaskList('', 'active')],
        ];
    }

    // Returns a fragment (a count line + the table).  rpcHandler now renders a
    // top-level fragment, so render helpers no longer need a single root element.
    renderTaskList(q: string, scope: string): Markup {
        const rows = this.searchByPrefix.all({q, scope});
        const scopeLabel = scope === 'all' ? 'all' : 'active';
        return [
            [h.p, {class: 'text-muted small mb-2'},
             q ? `${rows.length} ${scopeLabel} task(s) matching “${q}”`
               : `${rows.length} ${scopeLabel} task(s)`],
            this.tableRenderer.renderTable(rows),
        ];
    }

    // Step 1 (generator): build the parameter dialog using the same Field
    // widgets as the tables.  `scope` rides along as a hidden field.
    searchDialog(scope: string): Markup {
        const inScope = scope === 'all' ? 'all' : 'active';
        return action.renderParamForm(
            [new StringField('q', {prompt: 'Name or email starts with…', nullable: true})],
            {},
            {
                title: inScope === 'all' ? 'Search all tasks' : 'Search active tasks',
                submitLabel: 'Search',
                hidden: {scope: inScope},
                dispatch: {
                    'hx-get': '/rabid.task.searchResults(queryArgs)',
                    'hx-target': '#task-search-results',
                    'hx-swap': 'innerHTML',
                    'hx-on::after-request': 'hideModalEditor()',
                },
            });
    }

    // Step 2 (action): render the narrowed list to swap into the results
    // container.  Reads the typed `q` and the hidden `scope` from the form.
    searchResults(args: {q?: string, scope?: string}): Markup {
        return this.renderTaskList(String(args?.q ?? ''), args?.scope === 'all' ? 'all' : 'active');
    }
}
