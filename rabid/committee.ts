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
import { Table, FieldSet, Field, PrimaryKeyField, BooleanField, StringField, MarkdownField, CheckboxField, navChevron } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import {Markup, h} from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import {route, authenticated} from "../liminal/security.ts";   // hostOrAdmin is defined locally below
import * as templates from './templates.ts';
import {OwnedGroupField, createOwnedGroup} from './group.ts';
import {memberShortName} from './volunteer.ts';
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
            new MarkdownField('description', {prompt: 'Description', default: ''}),
            new OwnedGroupField('group_id'),
            new MarkdownField('notes', {default: ''}),
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

    // The Committees page list, optionally including DISSOLVED committees (so
    // they can be found and un-dissolved).  Dissolved sort after active.
    @path
    get committeesForList() {
        return this.prepare<Committee, {include_dissolved: number}>(block`
/**/   SELECT ${this.allFields} FROM committee
/**/          WHERE (:include_dissolved = 1 OR deleted = 0)
/**/          ORDER BY deleted, name`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list -----------------------------------------
    // ------------------------------------------------------------------------

    // The list as a reloadable fragment that self-fetches: a "New committee"
    // insert reloads `.-committee-` (the classless-pk reload target the base
    // saveForm emits), which is this wrapper.
    @route(authenticated)
    renderCommitteeList(include_dissolved: boolean = false): Markup {
        const committees = this.committeesForList.all({include_dissolved: include_dissolved ? 1 : 0});
        const props = this.reloadableItemProps(undefined,
            `rabid.committee.renderCommitteeList(${include_dissolved})`);
        // No list-group box: the committees read as document SECTIONS separated
        // by whitespace, not framed cards.
        return [h.div, props,
            committees.length === 0
                ? [h.p, {class: 'text-muted'}, include_dissolved ? 'No committees yet.' : 'No active committees.']
                : committees.map(c => this.renderCommitteeRow(c))];
    }

    renderCommitteeRow(c: Committee): Markup {
        const id = c.committee_id;
        const members = rabid.volunteer_group.members.all({group_id: c.group_id});

        // A navigable document SECTION - no card box, no per-row pencil (editing
        // committee parameters is rare; do it from the detail page).  The title
        // is a heading-weight link to the detail page and the whole section is
        // tappable; a quiet chevron marks that it navigates (the one persistent,
        // touch-friendly affordance).
        const item = this.reloadableItemProps(id, `rabid.committee.renderCommitteeRowById(${id})`);
        item.class = 'lm-doc-section lm-navigable ' + item.class;
        item.onclick = 'lmNavigableClick(event)';
        return [h.section, {...item, 'data-testid': `committee-row-${id}`},
            [h.h3, {class: 'lm-doc-title'},
             [h.a, {...templates.pageLinkProps(`/rabid.committee.detailPage(${id})`),
                    class: 'lm-nav-link'}, c.name || 'Unnamed committee'],
             c.deleted
                 ? [h.span, {class: 'badge text-bg-secondary ms-2 fw-normal align-middle'}, 'Dissolved']
                 : undefined,
             navChevron()],
            // Members inline (the names people actually care about), not a bare
            // "N members" count.
            members.length
                ? [h.div, {class: 'lm-doc-meta', 'data-testid': `committee-${id}-members`},
                   members.map(m => memberShortName(m)).join(', ')]
                : [h.div, {class: 'lm-doc-meta fst-italic'}, 'No members yet'],
            // The committee's markdown description as prose (notes stay internal).
            c.description
                ? [h.div, {class: 'lm-markdown mt-1', 'data-testid': `committee-${id}-description`},
                   this.fieldsByName.description.render(c.description)]
                : undefined,
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderCommitteeRowById(id: number): Markup {
        return this.renderCommitteeRow(this.getById(id));
    }

    // The top-level Committees page body (dispatched from the navbar's
    // /committees).  Hosts also get the "New committee" button - the first
    // record-INSERT affordance in the standard UI (modal of the same record
    // form, with no primary key, so saveForm inserts).
    // The Committees page query (page-state; liminal.md § On-page view state):
    // an include_dissolved toggle carried in the route, so dissolved committees
    // can be found (and un-dissolved from their detail page).
    static readonly pageQuery = new FieldSet('committees_query',
        [new CheckboxField('include_dissolved', {prompt: 'Include dissolved', default: false})]);

    renderCommitteesPage(q?: Record<string, any>): Markup {
        const query = CommitteeTable.pageQuery.normalize(q) as {include_dissolved: boolean};
        const canCreate = this.canEditRecord({} as Committee);
        // Rare admin acts live in a quiet ☰ (room for more later), not prominent
        // buttons that would make the page read like an editor rather than a
        // document: New committee (hosts), and the dissolved-view toggle.
        const menuItems: action.ActionMenuItem[] = [];
        if(canCreate)
            menuItems.push({label: 'New committee…',
                            mode: {kind: 'modal', dialogUrl: '/rabid.committee.newDialog()'}});
        menuItems.push(query.include_dissolved
            ? {label: 'Hide dissolved', link: templates.pageLinkProps('/committees')}
            : {label: 'Show dissolved',
               link: templates.pageLinkProps(`/committees(${CommitteeTable.pageQuery.literal({include_dissolved: true})})`)});
        return [h.div, {class: 'container py-3'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, 'Committees'],
             action.actionMenu(menuItems, {ariaLabel: 'Committee actions'})],
            this.renderCommitteeList(query.include_dissolved),
        ];
    }

    // The create dialog: the record edit form over an empty record (renderForm
    // gates on recordEdit, so non-hosts are refused server-side too).
    @route(hostOrAdmin)
    newDialog(): Markup {
        return this.renderForm({} as Committee);
    }

    // ------------------------------------------------------------------------
    // --- Committee detail page -----------------------------------------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    detailPage(committee_id: number): templates.Page {
        const c = this.getById(committee_id);
        return templates.page(`${c.name || 'Committee'} — Committee`, this.renderCommitteeDetail(committee_id));
    }

    // Reloadable fragment (an edit save re-renders it); the member editor below
    // it is its own reloadable fragment (membership edits reload just that).
    @route(authenticated)
    renderCommitteeDetail(committee_id: number): Markup {
        const c = this.getById(committee_id);
        const props = this.reloadableItemProps(committee_id, `rabid.committee.renderCommitteeDetail(${committee_id})`);
        props.class = 'container py-3 ' + props.class;
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, c.name || 'Unnamed committee'],
             c.deleted ? [h.span, {class: 'badge text-bg-secondary'}, 'Dissolved'] : undefined,
             this.canEditRecord(c) ? this.editPencil(committee_id) : undefined],
            // The committee's markdown description as clean prose (same
            // treatment as the list - no accent bar; that orange rule reads as a
            // callout, not document body).  Notes are internal - NOT shown here.
            c.description
                ? [h.div, {class: 'lm-markdown lm-doc-lead mb-4'},
                   this.fieldsByName.description.render(c.description)]
                : undefined,
            // Quiet section labels (document sections, not bold form headings).
            // Members / Projects / Tasks sit level as peer sections; each body is
            // an indented, demoted .lm-subsection so weight tracks depth (the
            // section label reads heavier than the items nested under it).
            [h.div, {class: 'lm-doc-section-head'},
             [h.h4, {class: 'lm-doc-section-label'}, 'Members']],
            [h.div, {class: 'lm-subsection'}, rabid.volunteer_group.renderMemberEditor(c.group_id)],

            // Projects the committee is responsible for (assigned via its group),
            // each drilling in to its own page.  The "+" creates one directly in
            // the committee's group (peer to the Tasks "+").
            [h.div, {class: 'lm-doc-section-head'},
             [h.h4, {class: 'lm-doc-section-label'}, 'Projects'],
             this.canEditRecord(c)
                 ? action.actionButton(action.plusIcon(),
                     {kind: 'modal', dialogUrl: `/rabid.project.newCommitteeProjectDialog(${committee_id})`},
                     'lm-menu-button', {'aria-label': 'New project', title: 'New project'})
                 : undefined],
            [h.div, {class: 'lm-subsection'}, rabid.project.renderForCommittee(committee_id)],

            // The committee's own task list - a 1-1 owned project, created lazily
            // on the first task.  docHeading=true so its "Tasks" heading matches
            // the Members/Projects section labels above (and it indents its own
            // task list into a .lm-subsection).
            rabid.task.renderOwnerTasks('committee', committee_id, null, true),
            // Photos (the generic gallery, gallery.ts).
            [h.div, {class: 'mt-4'}, rabid.gallery_photo.renderGallery('committee', committee_id)],
        ];
    }
}

export const allDml = new CommitteeTable().createDMLString();
