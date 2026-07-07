// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, IntegerField, FloatingPointField, DateTimeField, navChevron, renderFieldValue } from "../liminal/table.ts";
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

export const routes = ()=> ({
});

// Hosts run service intake day-to-day: only hosts/admins edit service records
// (check-in flows for volunteers come later).
const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

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

export interface Service {
    service_id: number;

    // Every service belongs to an event (a scheduled event, or the day's Ad-hoc
    // catch-all - see event.ts catchAllForDate).  The event is the aggregate root
    // for activity; there are no standalone services.
    event_id: number;

    client_name: string;
    client_postal?: string;
    client_phone?: string;
    client_number_of_people_served: number;

    service_kind: string;
    service_description: string;
    service_check_in_time?: string;
    service_done: boolnum;
    // Will often be quite a bit after service is complete so should not
    // be used to compute total service time.
    service_record_closed_time?: string;

    will_pick_up: boolnum;
    scheduled_pick_up_time?: string;
    pick_up_done: boolnum;

    work_start_time?: string;
    work_end_time?: string;
    work_stand_id?: number;

    notes?: string;
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

            // Note: we don't track customers - thus no separate customer table.
            new StringField('client_name', {}),
            // Not full postal code - just prefix that is long enough to know general area.
            // (First 3 characters of Canadian postal code for us).
            new StringField('client_postal', {nullable: true}),
            
            // Client PII: clients are not volunteers and never opted into the
            // open-books model - their phone is host/admin-only, redacted for
            // everyone else.
            new StringField('client_phone', {nullable: true, view: hostOrAdmin, redact: true}),

            new IntegerField('client_number_of_people_served', {default: 1}),
            
            new EnumField('service_kind', service_kind_enum, {default: 'diy'}),
            new StringField('service_description', {}),
            new DateTimeField('service_check_in_time', {nullable: true}),
            new BooleanField('service_done', {default: 0}),
            new DateTimeField('service_record_closed_time', {nullable: true}),
            
            new BooleanField('will_pick_up', {default: 0}),
            new DateTimeField('scheduled_pick_up_time', {nullable: true}),
            new BooleanField('pick_up_done', {default: 0}),
            
            new DateTimeField('work_start_time', {nullable: true}),
            new DateTimeField('work_end_time', {nullable: true}),
            new IntegerField('work_stand_id', {nullable: true}),
            
            new MarkdownField('notes', {nullable: true})
        ])
    };

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
/**/          ORDER BY service_check_in_time DESC`);
    }

    // The services logged at one event (its Activity section).  Ordered by
    // check-in time (NULLs - not-yet-checked-in - sort last).
    @path
    get servicesForEvent() {
        return this.prepare<Service, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM service
/**/          WHERE event_id = :event_id
/**/          ORDER BY service_check_in_time IS NULL, service_check_in_time`);
    }

    // Add a service bound to an event (the event page's "Add service…").  A
    // curated intake subset (the rest is filled in later via the detail edit
    // form); event_id rides as a hidden field so the record lands on this event.
    // host/admin only, like all service editing.
    @route(hostOrAdmin)
    newServiceForEventDialog(event_id: number): Markup {
        const f = this.fieldsByName;
        return action.renderParamForm(
            [f.client_name, f.client_postal, f.client_phone, f.service_kind,
             f.service_description, f.client_number_of_people_served],
            {service_kind: 'diy', client_number_of_people_served: 1} as Partial<Service>,
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
                              client_postal?: string, client_phone?: string,
                              service_kind?: string, service_description?: string,
                              client_number_of_people_served?: string|number}): Markup {
        const event_id = Number(args?.event_id);
        if(!Number.isInteger(event_id) || !event_id) throw new Error('Missing event');
        const client_name = (args.client_name ?? '').trim();
        if(!client_name) throw new Error('Client name is required');
        this.insert({
            event_id, client_name,
            client_postal: (args.client_postal ?? '') || undefined,
            client_phone: (args.client_phone ?? '') || undefined,
            service_kind: args.service_kind || 'diy',
            service_description: (args.service_description ?? '').trim(),
            client_number_of_people_served: Number(args.client_number_of_people_served) || 1,
        } as Partial<Service>);
        // A new row changes the section's shape -> reload the section (it's
        // registered on the shape key; an edit reloads only its own row).
        return {action: 'reload',
                targets: ['.' + this.shapeKey('event_id', event_id)]} as unknown as Markup;
    }

    // Windowed variant for the Service page.  A NULL check-in time is a
    // pending/not-yet-checked-in record - always surface those (they're the
    // active work), plus checked-in services within [from, to].
    @path
    get servicesInWindow() {
        return this.prepare<Service, {from: string, to: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM service
/**/          WHERE service_check_in_time IS NULL
/**/             OR DATE(service_check_in_time) BETWEEN :from AND :to
/**/          ORDER BY service_check_in_time DESC`);
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
            s.service_done ? [h.span, {class: 'badge text-bg-success ms-1'}, 'Done'] : undefined,
            s.will_pick_up && !s.pick_up_done
                ? [h.span, {class: 'badge text-bg-warning ms-1'}, 'Pickup pending'] : undefined,
        ];
    }

    renderServiceRow(s: Service): Markup {
        const id = s.service_id;
        const secondary = [date.sqliteDateTimeToString(s.service_check_in_time ?? null),
                           s.service_description].filter(Boolean).join(' · ');

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link name); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `rabid.service.renderServiceRowById(${id})`);
        return [h.div, {...item, 'data-testid': `service-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.service.detailPage(${id})`),
                     class: 'lm-nav-link'}, s.client_name || 'Unnamed client'],
              this.serviceBadges(s)],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(s) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderServiceRowById(id: number): Markup {
        return this.renderServiceRow(this.getById(id));
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
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, s.client_name || 'Unnamed client'],
             this.serviceBadges(s),
             this.canEditRecord(s) ? this.editPencil(service_id) : undefined],
            [h.dl, {class: 'row mb-0'},
             row('Kind', service_kind_enum[s.service_kind] ?? s.service_kind),
             row('Description', s.service_description || '—'),
             row('Checked in', date.sqliteDateTimeToString(s.service_check_in_time ?? null, '—')),
             row('Client phone', renderFieldValue(f.client_phone, s.client_phone) || '—'),
             row('Client postal', s.client_postal || '—'),
             row('People served', String(s.client_number_of_people_served ?? 1)),
             row('Pickup', s.will_pick_up
                 ? `${s.pick_up_done ? 'Done' : 'Pending'}${s.scheduled_pick_up_time
                     ? ' · ' + date.sqliteDateTimeToString(s.scheduled_pick_up_time) : ''}`
                 : '—'),
             row('Work', s.work_start_time
                 ? `${date.sqliteDateTimeToString(s.work_start_time)}${s.work_end_time
                     ? ' - ' + date.sqliteDateTimeToTimeString(s.work_end_time) : ''}`
                 : '—'),
             row('Notes', s.notes ? this.fieldsByName.notes.render(s.notes) : '—'),
            ],
        ];
    }
}
export const serviceMetaData = new ServiceTable();

export const allDml = serviceMetaData.createDMLString();
