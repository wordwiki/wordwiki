// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField, navigableItemProps, navChevron, renderFieldValue } from "../liminal/table.ts";
import * as content from "../liminal/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import * as orderkey from '../liminal/orderkey.ts';
import * as timestamp from '../liminal/timestamp.ts';
import * as date from '../liminal/date.ts';
import {Markup, h} from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import * as templates from './templates.ts';

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

    // Nullable because Can do service outside of an event.
    event_id?: number;

    client_name: string;
    client_postal?: string;
    client_phone?: string;
    client_number_of_people_served: number;

    service_kind: string;
    service_description: string;
    service_check_in_time?: string;
    service_done: boolnum;
    // Will often be quite a bit after service is complete so should not
    // be used to compute total service time.  For example will be closed
    // when the customer
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
            new ForeignKeyField('event_id', "event", "event_id", {indexed: true, nullable: true}),
            
            new StringField('client_name', {}),
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
            
            new StringField('notes', {nullable: true})
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

        if(this.canEditRecord(s)) {
            const item = this.editableItemProps(id, `rabid.service.renderServiceRowById(${id})`);
            return [h.div, {...item, 'data-testid': `service-row-${id}`},
                [h.div, {class: 'lm-item-body'},
                 [h.div, {class: 'lm-item-primary'},
                  templates.pageLink(`/rabid.service.detailPage(${id})`, s.client_name || 'Unnamed client'),
                  this.serviceBadges(s)],
                 [h.div, {class: 'lm-item-secondary'}, secondary]],
                this.editPencil(id),
            ];
        }

        return [h.a, {...navigableItemProps(`/rabid.service.detailPage(${id})`),
                      'data-testid': `service-row-${id}`},
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'}, s.client_name || 'Unnamed client', this.serviceBadges(s)],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    renderServiceRowById(id: number): Markup {
        return this.renderServiceRow(this.getById(id));
    }

    // The top-level Service page body (dispatched from the navbar's /service).
    // For now the full standard list; structured intake/pickup views come later.
    renderServicePage(): Markup {
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Service'],
            this.renderServiceList(this.allServices.all()),
        ];
    }

    // ------------------------------------------------------------------------
    // --- Service detail page -------------------------------------------------
    // ------------------------------------------------------------------------

    detailPage(service_id: number): templates.Page {
        const s = this.getById(service_id);
        return templates.page(`${s.client_name || 'Service'} — Service`, this.renderServiceDetail(service_id));
    }

    // Reloadable fragment (an edit save re-renders it).
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
             row('Notes', s.notes || '—'),
            ],
        ];
    }
}
export const serviceMetaData = new ServiceTable();

export const allDml = serviceMetaData.createDMLString();
