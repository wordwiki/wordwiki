// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, IntegerField, FloatingPointField, DateTimeField, navChevron, renderFieldValue, pencilIcon, editButtonProps, reloadableProps, liveReloadableProps } from "../liminal/table.ts";
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
import {tallyPostals} from './servicemap/fsa.ts';
import {renderServiceMap} from './servicemap/servicemap.ts';

export const routes = ()=> ({
});

// Hosts run service intake day-to-day: only hosts/admins edit service records
// (check-in flows for volunteers come later).
const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

// A framework-managed order column: hidden from the form, set by insert()/moves.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

// A hidden FK column, machine-set (scan provenance) - never in the edit form.
class ManagedForeignKeyField extends ForeignKeyField {
    override isVisible(): boolean { return false; }
}

// --------------------------------------------------------------------------------
// --- Service --------------------------------------------------------------------
// --------------------------------------------------------------------------------

export const service_kind_enum: Record<string, string> = {
    'diy': 'DIY',
    'full': 'We Repair',
    'other': 'Other',
};

// Drop-off fields appear in the service form only while service_kind is 'full'.
const showForFull = {field: 'service_kind', in: ['full']};

// A drop-off's needed-by time as a short 12h clock ("2:30 PM") for the We-Repair
// badge; '' when unset.  The stored value is org-local wall time (as entered).
function shortDueTime(dt?: string): string {
    const t = date.sqliteDateTimeToTemporalOrNull(dt ?? null);
    if(!t) return '';
    const h = t.hour % 12 || 12;
    return `${h}:${String(t.minute).padStart(2, '0')} ${t.hour >= 12 ? 'PM' : 'AM'}`;
}

// ONE field order for BOTH the add dialog and the edit form: client fields, then
// service_kind sitting directly before the drop-off block it reveals (showWhen),
// then notes.  So add and edit are the same dialog and the show/hide works in both.
const SERVICE_FORM_FIELDS = [
    'client_name', 'bike_description', 'service_description', 'client_postal', 'client_phone',
    'service_kind',
    'drop_off_notes', 'drop_off_scheduled_pick_up_time',
    'drop_off_repair_done', 'drop_off_ready_call_done', 'drop_off_pick_up_done',
    'notes',
];

// The posted service add form (getFormJSON values + the hidden anchor/event).
interface ServiceFormArgs {
    event_id?: string|number; anchor_id?: string|number; position?: string;
    client_name?: string; bike_description?: string; service_description?: string;
    client_postal?: string; client_phone?: string; service_kind?: string;
    drop_off_notes?: string; drop_off_scheduled_pick_up_time?: string;
    drop_off_repair_done?: string; drop_off_ready_call_done?: string; drop_off_pick_up_done?: string; notes?: string;
}

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
    drop_off_repair_done: boolnum;
    drop_off_ready_call_done: boolnum;
    //drop_off_pick_up_call_done: boolnum;
    drop_off_pick_up_done: boolnum;

    // Removed - too COMPLICATED
    //work_start_time?: string;
    //work_end_time?: string;
    //work_stand_id?: number;

    notes?: string;

    // Provenance for rows created by the scan -> extract flow (scan-extract.md); NULL
    // for manually-entered services.  extraction_job_id makes retract generic (delete
    // where extraction_job_id = :job); source_gallery_photo_id points at the
    // photographed sheet the row came from (its "from scan" badge + review crop).
    extraction_job_id?: number;
    source_gallery_photo_id?: number;

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
            // The drop-off lifecycle, in order: repair the bike -> call the client ->
            // they collect it.  "Awaiting pickup" only makes sense once repaired.
            new BooleanField('drop_off_repair_done', {default: 0, showWhen: showForFull}),
            new BooleanField('drop_off_ready_call_done', {default: 0, showWhen: showForFull}),
            new BooleanField('drop_off_pick_up_done', {default: 0, showWhen: showForFull}),

            new MarkdownField('notes', {default: ''}),

            // Scan -> extract provenance (nullable; NULL for manual rows).  Indexed so
            // generic retract (DELETE WHERE extraction_job_id = :job) and "rows from this
            // scan" queries are cheap.
            new ManagedForeignKeyField('extraction_job_id', 'extraction_job', 'extraction_job_id', {nullable: true, indexed: true}),
            new ManagedForeignKeyField('source_gallery_photo_id', 'gallery_photo', 'gallery_photo_id', {nullable: true}),

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
    private serviceFormFields(): Field[] {
        return SERVICE_FORM_FIELDS.map(n => this.fieldsByName[n]);
    }

    // Coerce the intake/edit form's extra (beyond name) fields for an insert -
    // reusing each field's own parser.  Booleans render as a Yes/No <select> that
    // ALWAYS submits '0' or '1' (never absent), so parse with the field's parser - a
    // bare `arg ? 1 : 0` treats the string '0' as truthy and turns every No into Yes.
    // Client_name is handled by the caller (it's the one required field).
    private serviceValuesFromArgs(args: ServiceFormArgs): Partial<Service> {
        const dt = args.drop_off_scheduled_pick_up_time;
        const yesNo = (v: unknown): boolnum => (v === '1' || v === 1 || v === 'true' || v === true) ? 1 : 0;
        return {
            bike_description: (args.bike_description ?? '').trim(),
            service_description: (args.service_description ?? '').trim(),
            client_postal: (args.client_postal ?? '').trim(),
            client_phone: (args.client_phone ?? '').trim(),
            service_kind: args.service_kind || 'diy',
            drop_off_notes: (args.drop_off_notes ?? '').trim(),
            drop_off_scheduled_pick_up_time: dt
                ? this.fieldsByName.drop_off_scheduled_pick_up_time.parseSimpleInput(dt) : undefined,
            drop_off_repair_done: yesNo(args.drop_off_repair_done),
            drop_off_ready_call_done: yesNo(args.drop_off_ready_call_done),
            drop_off_pick_up_done: yesNo(args.drop_off_pick_up_done),
            notes: (args.notes ?? '').trim(),
        } as Partial<Service>;
    }

    @route(hostOrAdmin)
    newServiceForEventDialog(event_id: number): Markup {
        return action.renderParamForm(
            this.serviceFormFields(),
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
    addServiceForEvent(args: ServiceFormArgs): Markup {
        const event_id = Number(args?.event_id);
        if(!Number.isInteger(event_id) || !event_id) throw new Error('Missing event');
        const client_name = (args.client_name ?? '').trim();
        if(!client_name) throw new Error('Client name is required');
        this.insert({event_id, client_name, ...this.serviceValuesFromArgs(args)} as Partial<Service>);
        // A new row changes the section's shape -> reload the section (it's
        // registered on the shape key; an edit reloads only its own row).
        return {action: 'reload',
                targets: ['.' + this.shapeKey('event_id', event_id)]} as unknown as Markup;
    }

    // Add a service before/after an anchor via the SAME intake dialog (not a blank
    // row) - for slotting a missed row into a scanned batch.  The dialog carries the
    // anchor + position; the insert lands at that slot.
    @route(hostOrAdmin)
    newServiceRelativeDialog(anchor_id: number, position: string): Markup {
        this.getById(anchor_id);   // 404 early if the anchor is gone
        return action.renderParamForm(
            this.serviceFormFields(),
            {service_kind: 'diy'} as Partial<Service>,
            {
                title: position === 'before' ? 'Add service before' : 'Add service after',
                submitLabel: 'Add',
                hidden: {anchor_id, position},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.service.addServiceRelative(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(hostOrAdmin)
    addServiceRelative(args: ServiceFormArgs): Markup {
        const anchor_id = Number(args?.anchor_id);
        if(!Number.isInteger(anchor_id) || !anchor_id) throw new Error('Missing anchor');
        const anchor = this.getById(anchor_id);
        const client_name = (args.client_name ?? '').trim();
        if(!client_name) throw new Error('Client name is required');
        const sibs = security.runSystem(() => this.servicesForEvent.all({event_id: anchor.event_id}));
        const i = sibs.findIndex(s => s.service_id === anchor_id);
        const order_key = args.position === 'before'
            ? orderkey.between(sibs[i-1]?.order_key, sibs[i]?.order_key)
            : orderkey.between(sibs[i]?.order_key, sibs[i+1]?.order_key);
        this.insert({event_id: anchor.event_id, client_name, order_key,
                     ...this.serviceValuesFromArgs(args)} as Partial<Service>);
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
        // A flat NUMBERED list (design-language.md: flat, not framed): an <ol> so the
        // browser owns the number (correct under a single-row live reload AND a full
        // re-render, nothing computed server-side).  Each <li> is one scannable line.
        return [h.ol, {class: 'lm-list lm-doc-list'},
                services.map(s => this.renderServiceRow(s))];
    }

    // The full kind badge, always shown (DIY included) - for the DETAIL PAGE header,
    // where the kind is a headline fact.  The compact list uses serviceLineBadge.
    serviceBadges(s: Service): Markup {
        return [
            [h.span, {class: 'badge text-bg-light border ms-2'}, service_kind_enum[s.service_kind] ?? s.service_kind],
            // Drop-off ('full') bikes have a lifecycle: repaired -> picked up.  Show the
            // CURRENT stage - "Awaiting pickup" only once the repair is done (before that
            // it's awaiting repair, not pickup); nothing once collected.
            this.dropOffStatusBadge(s),
        ];
    }

    // The current drop-off stage as a badge (or undefined - not a drop-off, or done).
    private dropOffStatusBadge(s: Service): Markup {
        if(s.service_kind !== 'full' || s.drop_off_pick_up_done) return undefined;
        return s.drop_off_repair_done
            ? [h.span, {class: 'badge text-bg-warning ms-1'}, 'Awaiting pickup']
            : [h.span, {class: 'badge text-bg-secondary ms-1'}, 'Awaiting repair'];
    }

    // The compact list badge.  SUPPRESSED for DIY (the common case), so a badge stands
    // out simply by BEING there - it needs no loud colour (a filled warning pill read
    // as an error and dominated the page).  A quiet grey tag; an OPEN We-Repair carries
    // its needed-by time, the one time-critical fact for QC.
    serviceLineBadge(s: Service): Markup {
        if(s.service_kind === 'diy') return undefined;
        let text = (service_kind_enum[s.service_kind] ?? s.service_kind).toUpperCase();
        if(s.service_kind === 'full' && !s.drop_off_pick_up_done) {
            const due = shortDueTime(s.drop_off_scheduled_pick_up_time);
            if(due) text = `${text} · ${due}`;
        }
        return [h.span, {class: 'lm-line-badge'}, text];
    }

    // A compact, scannable line: "1) NAME [WE REPAIR · 2:30] bike · work   POSTAL  ✎ ⋮".
    // The <li> itself is the flex row (so the actions dock at the far right) AND the
    // live/navigable fragment - flat, no list-group box (design-language.md).  The "1)"
    // is an <ol> counter (CSS ::before), not markup, so it can't drift.  Name in the
    // blue nav style; QC-critical badge (kind + needed-by) and postal are fixed columns;
    // only the bike/work description flows and wraps under the name on a narrow screen.
    // (Structured as one element per row - a natural future keyboard stop, keyboard-driven-editing.md.)
    renderServiceRow(s: Service): Markup {
        const id = s.service_id;
        const secondary = [s.bike_description, s.service_description].filter(Boolean).join(' · ');
        // The row is its own live fragment + a navigable stop; no boxed list-group item.
        const props = liveReloadableProps([this.rowKey(id)], `rabid.service.renderServiceRowById(${id})`);
        props.class = `${props.class} lm-doc-row lm-navigable`;
        (props as Record<string, string>).onclick = 'lmNavigableClick(event)';
        // Editors get a pencil (edit) + a ☰ (reorder / insert / delete, mostly for
        // fixing up scanned intake).  A <button> click never triggers row navigation.
        const pencil = this.canEditRecord(s)
            ? [h.button, {...editButtonProps(`rabid.service.renderServiceForm(${id})`),
                          class: 'edit lm-edit-pencil', type: 'button', 'aria-label': 'Edit service'},
               pencilIcon()]
            : undefined;
        const menu = this.canEditRecord(s) ? action.actionMenu([
            {label: 'Edit…', mode: {kind: 'modal', dialogUrl: `/rabid.service.renderServiceForm(${id})`}},
            {label: 'Add before…', mode: {kind: 'modal', dialogUrl: `/rabid.service.newServiceRelativeDialog(${id}, 'before')`}},
            {label: 'Add after…', mode: {kind: 'modal', dialogUrl: `/rabid.service.newServiceRelativeDialog(${id}, 'after')`}},
            {label: 'Move up', mode: {kind: 'immediate', expr: `rabid.service.moveUp(${id})`}},
            {label: 'Move down', mode: {kind: 'immediate', expr: `rabid.service.moveDown(${id})`}},
            {label: 'Delete', mode: {kind: 'confirm', message: 'Delete this service record?', expr: `rabid.service.remove(${id})`}},
        ], {ariaLabel: 'Service actions'}) : undefined;
        return [h.li, {...props, 'data-testid': `service-row-${id}`},
            [h.span, {class: 'lm-doc-num'}],   // the "N)" is the <ol> counter (CSS ::before)
            // Name + badge + description flow inline here; only this column wraps.
            [h.div, {class: 'lm-doc-main'},
             [h.a, {...templates.pageLinkProps(`/rabid.service.detailPage(${id})`),
                    class: 'lm-nav-link'}, s.client_name || 'Unnamed client'],
             this.serviceLineBadge(s),
             secondary ? [h.span, {class: 'lm-doc-sub'}, secondary] : undefined],
            // Postal pinned right (a QC column); always present so postals line up.
            [h.span, {class: 'lm-doc-right'}, s.client_postal || ''],
            pencil,
            menu,
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderServiceRowById(id: number): Markup {
        return this.renderServiceRow(this.getById(id));
    }

    // The service edit form - the SAME field set + order as the add dialog
    // (SERVICE_FORM_FIELDS).  The drop-off fields carry showWhen, so the client
    // reveals/hides them LIVE as service_kind changes ('full' shows them), no
    // reopen needed (form-state mechanism, liminal.md).
    @route(hostOrAdmin)
    renderServiceForm(id: number): Markup {
        return this.renderEditForm(this.getById(id), SERVICE_FORM_FIELDS);
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
    // --- Services-by-area map (servicemap/) ----------------------------------
    // ------------------------------------------------------------------------

    // Its own from/to window, defaulting (below) to the current CALENDAR YEAR -
    // the map is a yearly fundraising artifact, not a rolling recent-activity list.
    static readonly mapRangeQuery = pageQueries.windowQuery('service_map_range');

    // The yearly "Services by area" page (Reports): a self-contained SVG
    // choropleth of where our clients came from, by postal-code area, over the
    // window.  Reads client_postal off the windowed services and hands it to the
    // pure renderer (servicemap/); no PII (the FSA is a coarse area only).
    renderServiceMapPage(q?: Record<string, any>): Markup {
        const query = ServiceTable.mapRangeQuery.normalize(q) as pageQueries.WindowQuery;
        // Calendar-year default (Jan 1 .. today), not the generic rolling window.
        const year = date.orgNow().year;
        if(!query.from) query.from = `${year}-01-01`;
        if(!query.to)   query.to = date.temporalToSqliteDate(date.orgToday());
        const w = pageQueries.resolveWindow(query);
        const services = this.servicesInWindow.all(w);
        const tally = tallyPostals(services.map(s => s.client_postal));
        const sameYear = w.from.slice(0, 4) === w.to.slice(0, 4);
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Services by area'],
            pageQueries.renderWindowBar({
                fieldSet: ServiceTable.mapRangeQuery, pageRoute: 'serviceMap',
                filterDialogRoute: 'rabid.service.serviceMapFilterDialog',
                q: query, count: services.length, noun: 'service'}),
            renderServiceMap(tally, {size: 'large',
                title: sameYear ? `Services in ${w.from.slice(0, 4)}` : `Services ${w.from} – ${w.to}`}),
        ];
    }

    @route(authenticated)
    serviceMapFilterDialog(q?: Record<string, any>): Markup {
        return pageQueries.renderFilterDialog(
            ServiceTable.mapRangeQuery, ServiceTable.mapRangeQuery.normalize(q),
            'rabid.service.applyServiceMapFilter', {title: 'Service map date range'});
    }
    @route(authenticated)
    applyServiceMapFilter(form: Record<string, any>): any {
        return pageQueries.applyFilterNavigate(ServiceTable.mapRangeQuery, form, 'serviceMap');
    }

    // The compact per-event map (bottom of the event detail page): where THIS
    // event's clients came from.  DELIBERATELY NOT a live/dep-key fragment - it
    // registers no service dependency key, so editing services does NOT recompute
    // it (the projection + tally is a bit costly and rarely needs to be live
    // mid-shift).  Instead it carries a Refresh button that re-fetches just this
    // region on demand (htmx hx-get -> outerHTML swap of #services-map), and a
    // note that it is not live.
    @route(authenticated)
    renderEventServiceMap(event_id: number): Markup {
        const services = security.runSystem(() => this.servicesForEvent.all({event_id}));
        const tally = tallyPostals(services.map(s => s.client_postal));
        const located = tally.inRegionTotal + tally.outsideTotal
                        + tally.edge.reduce((s, e) => s + e.count, 0) > 0;
        return [h.div, {id: 'services-map', class: 'lm-doc-section'},
            [h.div, {class: 'd-flex align-items-center gap-2 mb-1'},
                [h.h4, {class: 'lm-doc-section-label mb-0'}, 'Where clients came from'],
                // Manual refresh: re-fetch just this fragment and swap it in place.
                ['button', {type: 'button', class: 'btn btn-sm btn-outline-secondary py-0',
                            'hx-get': `/rabid.service.renderEventServiceMap(${event_id})`,
                            'hx-target': '#services-map', 'hx-swap': 'outerHTML',
                            title: 'This map is not live — click to refresh after adding or editing services'},
                    '↻ Refresh']],
            located
                ? renderServiceMap(tally, {size: 'small'})
                : [h.p, {class: 'text-muted small mb-1'}, 'No client postal codes captured yet.'],
            [h.div, {class: 'text-muted', style: 'font-size:0.7rem;'},
                'Not live — use Refresh after adding services.'],
        ];
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
                 // Lifecycle order: repaired -> ready call -> picked up.
                 row('Repaired', s.drop_off_repair_done ? 'Done' : 'Not yet'),
                 row('Ready call', s.drop_off_ready_call_done ? 'Made' : 'Not yet'),
                 row('Pickup', s.drop_off_pick_up_done ? 'Picked up'
                     : (s.drop_off_scheduled_pick_up_time
                         ? 'Scheduled ' + date.sqliteDateTimeToString(s.drop_off_scheduled_pick_up_time)
                         : 'Awaiting pickup')),
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
