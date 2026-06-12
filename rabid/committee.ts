// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types
/**
 * Committees - the first owner of a volunteer_group (see group.ts for the
 * model).  A committee row carries the descriptive fields; its member set IS
 * its group (kind 'named': shareable + live, so a future task assigned to the
 * committee follows membership changes).  The group is created with the
 * committee (non-nullable FK - "no members" is an EMPTY group, never NULL),
 * and membership is edited through the shared member editor on the detail
 * page (gated, via the owner backlink, by THIS table's recordEdit).
 */

import { db, Db, PreparedQuery, boolnum } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, BooleanField, StringField, navChevron } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import {Markup, h} from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import * as templates from './templates.ts';
import {OwnedGroupField, createOwnedGroup} from './group.ts';
import {rabid} from './rabid.ts';

export const routes = ()=> ({
});

// Hosts run the org: only hosts/admins create/edit committees (and thereby -
// via the group owner backlink - their member lists).
const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

// --------------------------------------------------------------------------------
// --- Committee -------------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface Committee {
    committee_id: number;

    name: string;
    description: string;

    // The committee's member set: an owned 'named' group (see group.ts).
    group_id: number;

    notes: string;

    // Dissolved committees are soft-deleted (like volunteers): historical
    // references to the committee/its group must keep working.
    deleted: boolnum;
}

export type CommitteeOpt = Partial<Committee>;

export class CommitteeTable extends Table<Committee> {

    constructor() {
        super ('committee', [
            new PrimaryKeyField('committee_id', {}),
            new StringField('name', {}),
            new StringField('description', {default: ''}),
            new OwnedGroupField('group_id'),
            new StringField('notes', {default: ''}),
            new BooleanField('deleted', {default: 0, prompt: 'Dissolved'}),
        ])
    };

    defaultFieldEdit: security.Permission = hostOrAdmin;
    override get recordEdit(): security.Permission { return hostOrAdmin; }

    override formTitle(c: Committee): string {
        return c.committee_id ? `Edit ${c.name || 'committee'}` : 'New committee';
    }

    // Creating a committee creates its member group, then patches the group's
    // owner backlink with the new committee id (group first: the committee's
    // group_id is NOT NULL).  This also serves the generic saveForm insert
    // path, where group_id is absent (OwnedGroupField is hidden from forms).
    override insert<P extends Partial<Committee>>(tuple: P): number {
        if(tuple.group_id !== undefined)
            return super.insert(tuple);
        const group_id = createOwnedGroup('named', 'committee');
        const committee_id = super.insert({...tuple, group_id});
        rabid.volunteer_group.update(group_id, {owner_id: committee_id});
        return committee_id;
    }

    @path
    get activeCommittees() {
        return this.prepare<Committee & {member_count: number}, {}>(block`
/**/   SELECT ${this.allFields},
/**/          (SELECT COUNT(*) FROM group_member gm WHERE gm.group_id = committee.group_id)
/**/              AS member_count
/**/          FROM committee
/**/          WHERE deleted = 0
/**/          ORDER BY name`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list -----------------------------------------
    // ------------------------------------------------------------------------

    // The list as a reloadable fragment that self-fetches: a "New committee"
    // insert reloads `.-committee-` (the classless-pk reload target the base
    // saveForm emits), which is this wrapper.
    renderCommitteeList(): Markup {
        const committees = this.activeCommittees.all({});
        const props = this.reloadableItemProps(undefined, `rabid.committee.renderCommitteeList()`);
        return [h.div, props,
            committees.length === 0
                ? [h.p, {class: 'text-muted'}, 'No committees yet.']
                : [h.div, {class: 'list-group lm-list'},
                   committees.map(c => this.renderCommitteeRow(c))]];
    }

    renderCommitteeRow(c: Committee & {member_count?: number}): Markup {
        const id = c.committee_id;
        const count = c.member_count ?? rabid.volunteer_group.members.all({group_id: c.group_id}).length;
        const secondary = [`${count} member${count === 1 ? '' : 's'}`, c.description]
            .filter(Boolean).join(' · ');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link name); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `rabid.committee.renderCommitteeRowById(${id})`);
        return [h.div, {...item, 'data-testid': `committee-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.committee.detailPage(${id})`),
                     class: 'lm-nav-link'}, c.name || 'Unnamed committee']],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(c) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    renderCommitteeRowById(id: number): Markup {
        return this.renderCommitteeRow(this.getById(id));
    }

    // The top-level Committees page body (dispatched from the navbar's
    // /committees).  Hosts also get the "New committee" button - the first
    // record-INSERT affordance in the standard UI (modal of the same record
    // form, with no primary key, so saveForm inserts).
    renderCommitteesPage(): Markup {
        const canCreate = this.canEditRecord({} as Committee);
        return [h.div, {class: 'container py-3'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-2'},
             [h.h2, {class: 'mb-0'}, 'Committees'],
             canCreate
                 ? action.actionButton('New committee',
                     {kind: 'modal', dialogUrl: '/rabid.committee.newDialog()'},
                     'btn btn-outline-primary btn-sm')
                 : undefined],
            this.renderCommitteeList(),
        ];
    }

    // The create dialog: the record edit form over an empty record (renderForm
    // gates on recordEdit, so non-hosts are refused server-side too).
    newDialog(): Markup {
        return this.renderForm({} as Committee);
    }

    // ------------------------------------------------------------------------
    // --- Committee detail page -----------------------------------------------
    // ------------------------------------------------------------------------

    detailPage(committee_id: number): templates.Page {
        const c = this.getById(committee_id);
        return templates.page(`${c.name || 'Committee'} — Committee`, this.renderCommitteeDetail(committee_id));
    }

    // Reloadable fragment (an edit save re-renders it); the member editor below
    // it is its own reloadable fragment (membership edits reload just that).
    renderCommitteeDetail(committee_id: number): Markup {
        const c = this.getById(committee_id);
        const props = this.reloadableItemProps(committee_id, `rabid.committee.renderCommitteeDetail(${committee_id})`);
        props.class = 'container py-3 ' + props.class;
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, c.name || 'Unnamed committee'],
             c.deleted ? [h.span, {class: 'badge text-bg-secondary'}, 'Dissolved'] : undefined,
             this.canEditRecord(c) ? this.editPencil(committee_id) : undefined],
            c.description ? [h.p, {}, c.description] : undefined,
            c.notes ? [h.p, {class: 'text-muted'}, c.notes] : undefined,
            [h.h4, {class: 'mt-3'}, 'Members'],
            rabid.volunteer_group.renderMemberEditor(c.group_id),
        ];
    }
}

export const allDml = new CommitteeTable().createDMLString();
