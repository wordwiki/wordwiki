// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, IntegerField, FloatingPointField, DateTimeField, navChevron, renderFieldValue, pencilIcon, editButtonProps } from "../liminal/table.ts";
import * as content from "../liminal/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import * as orderkey from '../liminal/orderkey.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as date from '../liminal/date.ts';
import {Markup, h} from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated} from "../liminal/security.ts";
import * as action from "../liminal/action.ts";
import * as templates from './templates.ts';
import * as pageQueries from './page-queries.ts';
import {rabid} from './rabid.ts';

export const routes = ()=> ({
});

// Hosts run service intake day-to-day: only hosts/admins edit service records
// (check-in flows for volunteers come later).
const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

// A framework-managed order column: hidden from the form, set by insert()/moves.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

// --------------------------------------------------------------------------------
// --- Service --------------------------------------------------------------------
// --------------------------------------------------------------------------------

export const service_kind_enum: Record<string, string> = {
    'diy': 'DIY',
    'full': 'We Repair',
    'adult-learn': 'Adult Learn to Ride',
    'kid-learn': 'Kid Learn to Ride',
    'vocational': 'Vocational Training',
    'other': 'Other',
};

// Drop-off fields appear in the service form only while service_kind is 'full'.
const showForFull = {field: 'service_kind', in: ['full']};

export interface Service {
    service_id: number;

    // Every service belongs to an event (a scheduled event, or the day's Ad-hoc
    // catch-all - see event.ts catchAllForDate).  The event is the aggregate root
    // for activity; there are no standalone services.
    event_id: number;

    service_kind: string;

    // name, bike_description, service_description, client_postal are the core fields
    client_name: string;
    bike_description?: string; // added
    service_description?: string;
    client_postal?: string;

    // only used for when bikes are dropped off (mostly clients stay
    // with the bike, so we don't need this)
    client_phone?: string;

    // Sometimes we will provide training to multiple people on
    // one bike - we can record this here (defaults to 1)
    // NOTE: removed this one - too much work to track.
    //client_number_of_people_served: number;

    // NOTE: removed this one - we don't know this - the event is enoght
    //service_check_in_time?: string;

    // Will often be quite a bit after service is complete so should not
    // be used to compute total service time.  NOTE removing this one - we don't close records
    // (because mostly DIY)
    //service_record_closed_time?: string;

    // Presently only used when service_kind == 'full' (but may add more service kinds that use this)
    // Ideally, would only show in the UI when service_kind == 'full'
    drop_off_notes: string;
    drop_off_scheduled_pick_up_time?: string;
    drop_off_ready_call_done: boolnum;
    //drop_off_pick_up_call_done: boolnum;
    drop_off_pick_up_done: boolnum;

    // Removed - too COMPLICATED
    //work_start_time?: string;
    //work_end_time?: string;
    //work_stand_id?: number;

    notes?: string;

    // Sibling order within the event (orderkey.ts) - drives the event log's order
    // and lets scanned rows be reordered / inserted between.  Managed.
    order_key: string;
}

export type ServiceOpt = Partial<Service>;

export class ServiceTable extends Table<Service> {
    
    constructor() {
        super ('service', [
            new PrimaryKeyField('service_id', {}),

            // Every service belongs to an event (a scheduled event or the day's
            // Ad-hoc catch-all).  Mandatory - the event is the aggregate root.  Not
            // user-editable: a service is bound to its event, so the edit form omits it.
            new ForeignKeyField('event_id', "event", "event_id", {indexed: true, edit: security.never}),

            new EnumField('service_kind', service_kind_enum, {default: 'diy'}),

            // The core intake fields (name / bike / work needed / postal - the
            // shape of the scanned intake table).  Strings are NOT NULL DEFAULT ''
            // (one canonical empty, never null); client_name is the only required
            // one (bare {} -> non-empty enforced).  We don't track customers - no
            // separate customer table.
            new StringField('client_name', {}),
            new StringField('bike_description', {default: ''}),
            new StringField('service_description', {default: ''}),
            // Not the full postal code - just the prefix (first 3 of a Canadian
            // code) for general area.
            new StringField('client_postal', {default: ''}),
            // Client PII: clients are not volunteers and never opted into the
            // open-books model - their phone is host/admin-only, redacted for
            // everyone else.  Mostly only relevant to drop-offs.
            new StringField('client_phone', {default: '', view: hostOrAdmin, redact: true}),

            // Drop-off ("We Repair" / full) service: the bike is LEFT, so it needs a
            // small ready-call / pickup checklist.  Empty/0 for the common DIY case
            // (client stays with the bike).  showWhen -> these appear in the form only
            // while service_kind is 'full' (progressive disclosure; FieldOptions.showWhen).
            new StringField('drop_off_notes', {default: '', showWhen: showForFull}),
            new DateTimeField('drop_off_scheduled_pick_up_time', {nullable: true, showWhen: showForFull}),
            new BooleanField('drop_off_ready_call_done', {default: 0, showWhen: showForFull}),
            new BooleanField('drop_off_pick_up_done', {default: 0, showWhen: showForFull}),

            new MarkdownField('notes', {default: ''}),
            new ManagedStringField('order_key', {default: ''}),
        ])
    };

    // Append at the end of the event's order; an explicit order_key (insert
    // before/after) wins.
    override insert<P extends ServiceOpt>(tuple: P): number {
        const withManaged: any = {order_key: this.nextOrderKey(Number(tuple.event_id)), ...tuple};
        return super.insert(withManaged);
    }
    private nextOrderKey(event_id: number): string {
        const last = security.runSystem(() => db().prepare<{k: string}, {event_id: number}>(
            'SELECT MAX(order_key) AS k FROM service WHERE event_id = :event_id').first({event_id}));
        return orderkey.between(last?.k, undefined);
    }

    defaultFieldEdit: security.Permission = hostOrAdmin;
    override get recordEdit(): security.Permission { return hostOrAdmin; }

    override formTitle(s: Service): string {
        return `Edit service for ${s.client_name || 'client'}`;
    }

    @path
    get allServices() {
        return this.prepare<Service, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM service
/**/          ORDER BY service_id DESC`);
    }

    // The services logged at one event (its Activity section), in the event log's
    // display order.
    @path
    get servicesForEvent() {
        return this.prepare<Service, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM service
/**/          WHERE event_id = :event_id
/**/          ORDER BY order_key, service_id`);
    }

    // Add a service bound to an event (the event page's "Add service…").  A
    // curated intake subset (the rest is filled in later via the detail edit
    // form); event_id rides as a hidden field so the record lands on this event.
    // host/admin only, like all service editing.
    @route(hostOrAdmin)
    newServiceForEventDialog(event_id: number): Markup {
        const f = this.fieldsByName;
        // The scanned-intake core: name / bike / work needed / postal + kind.  The
        // rest (phone, drop-off checklist) is filled in later via the detail edit.
        return action.renderParamForm(
            [f.client_name, f.bike_description, f.service_description, f.client_postal, f.service_kind],
            {service_kind: 'diy'} as Partial<Service>,
            {
                title: 'Add service',
                submitLabel: 'Add',
                hidden: {event_id},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.service.addServiceForEvent(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(hostOrAdmin)
    addServiceForEvent(args: {event_id?: string|number, client_name?: string,
                              bike_description?: string, service_description?: string,
                              client_postal?: string, service_kind?: string}): Markup {
        const event_id = Number(args?.event_id);
        if(!Number.isInteger(event_id) || !event_id) throw new Error('Missing event');
        const client_name = (args.client_name ?? '').trim();
        if(!client_name) throw new Error('Client name is required');
        this.insert({
            event_id, client_name,
            bike_description: (args.bike_description ?? '').trim(),
            service_description: (args.service_description ?? '').trim(),
            client_postal: (args.client_postal ?? '').trim(),
            service_kind: args.service_kind || 'diy',
        } as Partial<Service>);
        // A new row changes the section's shape -> reload the section (it's
        // registered on the shape key; an edit reloads only its own row).
        return {action: 'reload',
                targets: ['.' + this.shapeKey('event_id', event_id)]} as unknown as Markup;
    }

    // Insert a blank service directly before/after an anchor (for correcting a
    // scanned intake - slotting in a missed row).  Blank client name -> "Unnamed
    // client" until edited.
    @routeMutation(hostOrAdmin)
    insertRelative(anchor_id: number, position: string): Markup {
        const anchor = this.getById(anchor_id);
        const sibs = security.runSystem(() => this.servicesForEvent.all({event_id: anchor.event_id}));
        const i = sibs.findIndex(s => s.service_id === anchor_id);
        const order_key = position === 'before'
            ? orderkey.between(sibs[i-1]?.order_key, sibs[i]?.order_key)
            : orderkey.between(sibs[i]?.order_key, sibs[i+1]?.order_key);
        this.insert({event_id: anchor.event_id, client_name: '', service_kind: 'diy',
                     order_key} as Partial<Service>);
        return {action: 'reload', targets: ['.' + this.shapeKey('event_id', anchor.event_id)]} as unknown as Markup;
    }

    @routeMutation(hostOrAdmin)
    moveUp(id: number): Markup { return this.moveBy(id, -1); }
    @routeMutation(hostOrAdmin)
    moveDown(id: number): Markup { return this.moveBy(id, +1); }
    private moveBy(id: number, dir: -1|1): Markup {
        const s = this.getById(id);
        const sibs = security.runSystem(() => this.servicesForEvent.all({event_id: s.event_id}));
        const i = sibs.findIndex(x => x.service_id === id);
        const j = i + dir;
        if(i >= 0 && j >= 0 && j < sibs.length) {
            const order_key = dir < 0
                ? orderkey.between(sibs[j-1]?.order_key, sibs[j].order_key)
                : orderkey.between(sibs[j].order_key, sibs[j+1]?.order_key);
            this.update(id, {order_key} as any);
        }
        return {action: 'reload', targets: ['.' + this.shapeKey('event_id', s.event_id)]} as unknown as Markup;
    }

    @routeMutation(hostOrAdmin)
    remove(id: number): Markup {
        const event_id = this.getById(id).event_id;
        this.delete(id);
        return {action: 'reload', targets: ['.' + this.shapeKey('event_id', event_id)]} as unknown as Markup;
    }

    // Windowed variant for the Service page.  A service has no time of its own
    // (minimal ceremony - the EVENT supplies the time); we window by the owning
    // event's date, newest first.
    @path
    get servicesInWindow() {
        return this.prepare<Service, {from: string, to: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM service
/**/          WHERE DATE((SELECT start_time FROM event WHERE event.event_id = service.event_id))
/**/                BETWEEN :from AND :to
/**/          ORDER BY (SELECT start_time FROM event WHERE event.event_id = service.event_id) DESC,
/**/                   service.order_key`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the baseline; structured intake views
    // --- come later) ---------------------------------------------------------
    // ------------------------------------------------------------------------

    renderServiceList(services: Service[]): Markup {
        if(services.length === 0)
            return [h.p, {class: 'text-muted'}, 'No service records yet.'];
        return [h.div, {class: 'list-group lm-list'},
                services.map(s => this.renderServiceRow(s))];
    }

    serviceBadges(s: Service): Markup {
        return [
            [h.span, {class: 'badge text-bg-light border ms-2'}, service_kind_enum[s.service_kind] ?? s.service_kind],
            // Drop-off ('full') bikes are the only ones with a lifecycle: flag one
            // that's still waiting to be collected.
            (s.service_kind === 'full' && !s.drop_off_pick_up_done)
                ? [h.span, {class: 'badge text-bg-warning ms-1'}, 'Awaiting pickup'] : undefined,
        ];
    }

    renderServiceRow(s: Service): Markup {
        const id = s.service_id;
        const secondary = [s.bike_description, s.service_description].filter(Boolean).join(' · ');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link name).  Editors get BOTH a
        // pencil (the natural, obvious "edit this" - opens the same conditional
        // form) AND a ☰ menu (reorder + insert before/after + delete, mostly for
        // fixing up scanned intake).  A <button> click never triggers the row's
        // navigation (lmNavigableClick bails on buttons).
        const item = this.detailItemProps(id, `rabid.service.renderServiceRowById(${id})`, {}, /*live*/ true);
        const pencil = this.canEditRecord(s)
            ? [h.button, {...editButtonProps(`rabid.service.renderServiceForm(${id})`),
                          class: 'edit lm-edit-pencil', type: 'button', 'aria-label': 'Edit service'},
               pencilIcon()]
            : undefined;
        const menu = this.canEditRecord(s) ? action.actionMenu([
            {label: 'Edit…', mode: {kind: 'modal', dialogUrl: `/rabid.service.renderServiceForm(${id})`}},
            {label: 'Add before', mode: {kind: 'immediate', expr: `rabid.service.insertRelative(${id}, 'before')`}},
            {label: 'Add after', mode: {kind: 'immediate', expr: `rabid.service.insertRelative(${id}, 'after')`}},
            {label: 'Move up', mode: {kind: 'immediate', expr: `rabid.service.moveUp(${id})`}},
            {label: 'Move down', mode: {kind: 'immediate', expr: `rabid.service.moveDown(${id})`}},
            {label: 'Delete', mode: {kind: 'confirm', message: 'Delete this service record?', expr: `rabid.service.remove(${id})`}},
        ], {ariaLabel: 'Service actions'}) : undefined;
        return [h.div, {...item, 'data-testid': `service-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.service.detailPage(${id})`),
                     class: 'lm-nav-link'}, s.client_name || 'Unnamed client'],
              this.serviceBadges(s)],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            pencil,
            menu,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderServiceRowById(id: number): Markup {
        return this.renderServiceRow(this.getById(id));
    }

    // The service edit form.  All fields are rendered; the drop-off checklist ones
    // carry showWhen (see the constructor), so the client reveals/hides them LIVE
    // as service_kind changes - 'full' (We Repair) shows them, other kinds don't,
    // no reopen needed (form-state mechanism, liminal.md).
    @route(hostOrAdmin)
    renderServiceForm(id: number): Markup {
        return this.renderEditForm(this.getById(id));
    }

    // The Service page query: a from/to date window (page-state; liminal.md
    // § On-page view state).  Defaults to the last 120 days (plus pending
    // records, see servicesInWindow).
    static readonly pageQuery = pageQueries.windowQuery('service_query');

    // The top-level Service page body (dispatched from the navbar's /service),
    // windowed by the route arg.
    renderServicePage(q?: Record<string, any>): Markup {
        const query = ServiceTable.pageQuery.normalize(q) as pageQueries.WindowQuery;
        const w = pageQueries.resolveWindow(query);
        const services = this.servicesInWindow.all(w);
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Service'],
            pageQueries.renderWindowBar({
                fieldSet: ServiceTable.pageQuery, pageRoute: 'service',
                filterDialogRoute: 'rabid.service.serviceFilterDialog',
                q: query, count: services.length, noun: 'record'}),
            this.renderServiceList(services),
        ];
    }

    @route(authenticated)
    serviceFilterDialog(q?: Record<string, any>): Markup {
        return pageQueries.renderFilterDialog(
            ServiceTable.pageQuery, ServiceTable.pageQuery.normalize(q),
            'rabid.service.applyServiceFilter', {title: 'Filter service records'});
    }
    @route(authenticated)
    applyServiceFilter(form: Record<string, any>): any {
        return pageQueries.applyFilterNavigate(ServiceTable.pageQuery, form, 'service');
    }

    // ------------------------------------------------------------------------
    // --- Service detail page -------------------------------------------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    detailPage(service_id: number): templates.Page {
        const s = this.getById(service_id);
        return templates.page(`${s.client_name || 'Service'} — Service`, this.renderServiceDetail(service_id));
    }

    // Reloadable fragment (an edit save re-renders it).
    @route(authenticated)
    renderServiceDetail(service_id: number): Markup {
        const s = this.getById(service_id);
        const f = this.fieldsByName;
        const props = this.reloadableItemProps(service_id, `rabid.service.renderServiceDetail(${service_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [[h.dt, {class: 'col-sm-3'}, label], [h.dd, {class: 'col-sm-9'}, value]];
        const dropOff = s.service_kind === 'full';
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, s.client_name || 'Unnamed client'],
             this.serviceBadges(s),
             this.canEditRecord(s)
                 ? action.actionButton(pencilIcon(), {kind: 'modal', dialogUrl: `/rabid.service.renderServiceForm(${service_id})`},
                     'btn btn-link p-0 lm-edit-pencil', {'aria-label': 'Edit service', title: 'Edit service'})
                 : undefined],
            [h.dl, {class: 'row mb-0'},
             row('Kind', service_kind_enum[s.service_kind] ?? s.service_kind),
             row('Bike', s.bike_description || '—'),
             row('Work needed', s.service_description || '—'),
             row('Client postal', s.client_postal || '—'),
             row('Client phone', renderFieldValue(f.client_phone, s.client_phone) || '—'),
             // The drop-off checklist, only for a "full" service (a left bike).
             ...(dropOff ? [
                 row('Pickup', s.drop_off_pick_up_done ? 'Picked up'
                     : (s.drop_off_scheduled_pick_up_time
                         ? 'Scheduled ' + date.sqliteDateTimeToString(s.drop_off_scheduled_pick_up_time)
                         : 'Awaiting pickup')),
                 row('Ready call', s.drop_off_ready_call_done ? 'Made' : 'Not yet'),
                 row('Drop-off notes', s.drop_off_notes || '—'),
             ] : []),
             row('Notes', s.notes ? this.fieldsByName.notes.render(s.notes) : '—'),
            ],
            // The service's own tasks - same generic owner machinery as events: a
            // free-form Tasks list (any volunteer can add) + the Bike Checklist,
            // instantiated from its template.  Both are created lazily (0 db rows
            // until the first task / the checklist is set up).
            [h.div, {class: 'mt-4'},
             rabid.task.renderOwnerTasks('service', service_id, null, /*docHeading*/ true),
             rabid.task.renderOwnerChecklists('service', service_id)],
            // Photos of the bike / the problem (the generic gallery, gallery.ts).
            [h.div, {class: 'mt-4'}, rabid.gallery_photo.renderGallery('service', service_id)],
        ];
    }
}
export const serviceMetaData = new ServiceTable();

export const allDml = serviceMetaData.createDMLString();
