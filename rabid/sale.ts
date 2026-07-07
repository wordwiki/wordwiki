// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, IntegerField, FloatingPointField, DateTimeField, ImageField, navChevron } from "../liminal/table.ts";
import { VolunteerForeignKeyField } from "./volunteer-activity.ts";
import { shortName } from "./volunteer.ts";
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import {Markup, h} from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import {route, routeMutation, authenticated} from "../liminal/security.ts";
import * as action from "../liminal/action.ts";
import * as templates from './templates.ts';
import * as pageQueries from './page-queries.ts';
import {rabid} from './rabid.ts';

// --------------------------------------------------------------------------------
// --- Sale -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

// Hosts run the books: only hosts/admins edit sale records (recording flows
// for volunteers come later).
const hostOrAdmin = security.or(security.hasRole('host'), security.hasRole('admin'));

export const sale_kind_enum: Record<string, string> = {
    'bike': 'Bike',
    'free-bike': 'Free Adult Bike',
    'free-kids-bike': 'Free Kids Bike',
    'free-helmet': 'Free Helmet',
    'balance-bike-loan': 'Balance Bike Loan',
    'parts': 'Parts',
    'other': 'Other',
};

export const payment_method_enum: Record<string, string> = {
    'cash': 'Cash',
    'card': 'Card',
    'etransfer': 'Etransfer',
    'other': 'Other',
};

export interface Sale {
    sale_id: number;
    // Every sale (incl. free bikes/helmets, balance-bike loans) belongs to an
    // event - a scheduled event or the day's Ad-hoc catch-all (event.ts
    // catchAllForDate).  The event is the aggregate root for activity.
    event_id: number;
    sale_time: string;
    sale_recorded_by: number;
    sale_kind: string;
    description: string;
    // Optional photo of the item (a content-store path - see liminal/photo.ts).
    photo?: string;
    amount: number;
    payment_method: string;
    notes?: string;
}

export type SaleOpt = Partial<Sale>;

export class SaleTable extends Table<Sale> {

    constructor() {
        super ('sale', [
            new PrimaryKeyField('sale_id', {}),
            // Every sale belongs to an event (scheduled or the day's Ad-hoc
            // catch-all).  Mandatory - the event is the aggregate root.
            new ForeignKeyField('event_id', "event", "event_id", {indexed: true}),
            new DateTimeField('sale_time', {}),
            // (was unique:true - a copy-paste bug that would have limited each
            // volunteer to recording ONE sale ever)
            new VolunteerForeignKeyField('sale_recorded_by', {indexed: true}),
            new EnumField('sale_kind', sale_kind_enum, {}),
            new StringField('description', {default: ''}),
            new ImageField('photo', 'rabid.photo', {aspect: 'landscape', nullable: true, prompt: 'Photo'}),
            new FloatingPointField('amount', {}),
            new EnumField('payment_method', payment_method_enum, {default: 'cash'}),
            new MarkdownField('notes', {nullable: true})
        ])
    };

    defaultFieldEdit: security.Permission = hostOrAdmin;
    override get recordEdit(): security.Permission { return hostOrAdmin; }

    override formTitle(s: Sale): string {
        return `Edit sale: ${s.description || sale_kind_enum[s.sale_kind] || 'sale'}`;
    }

    @path
    get allSales() {
        return this.prepare<Sale, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM sale
/**/          ORDER BY sale_time DESC`);
    }

    // The sales (incl. free bikes/giveaways) logged at one event - its Activity
    // section, newest first.
    @path
    get salesForEvent() {
        return this.prepare<Sale, {event_id: number}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM sale
/**/          WHERE event_id = :event_id
/**/          ORDER BY sale_time DESC`);
    }

    // Add a sale/giveaway bound to an event (the event page's "Add sale…").
    // event_id rides hidden; sale_time (now) and sale_recorded_by (the actor) are
    // stamped by the mutation, not entered.  host/admin only.
    @route(hostOrAdmin)
    newSaleForEventDialog(event_id: number): Markup {
        const f = this.fieldsByName;
        return action.renderParamForm(
            [f.sale_kind, f.description, f.amount, f.payment_method],
            {sale_kind: 'bike', amount: 0, payment_method: 'cash'} as Partial<Sale>,
            {
                title: 'Add sale',
                submitLabel: 'Add',
                hidden: {event_id},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.sale.addSaleForEvent(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(hostOrAdmin)
    addSaleForEvent(args: {event_id?: string|number, sale_kind?: string,
                           description?: string, amount?: string|number,
                           payment_method?: string}): Markup {
        const event_id = Number(args?.event_id);
        if(!Number.isInteger(event_id) || !event_id) throw new Error('Missing event');
        const sale_kind = args.sale_kind || 'bike';
        this.insert({
            event_id, sale_kind,
            sale_time: date.temporalToSqliteDateTime(date.orgNow()),
            sale_recorded_by: security.current()!.actorId!,
            description: (args.description ?? '').trim(),
            amount: Number(args.amount) || 0,
            payment_method: args.payment_method || 'cash',
        } as Partial<Sale>);
        // Reload the event's Activity section (registered under this fk key).
        return {action: 'reload',
                targets: ['.' + this.fkKey('event_id', event_id)]} as unknown as Markup;
    }

    // Windowed variant for the Sales page (DATE() includes the whole `to` day).
    @path
    get salesInWindow() {
        return this.prepare<Sale, {from: string, to: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM sale
/**/          WHERE DATE(sale_time) BETWEEN :from AND :to
/**/          ORDER BY sale_time DESC`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the baseline; structured per-day/month
    // --- summaries come later) ----------------------------------------------
    // ------------------------------------------------------------------------

    renderSaleList(sales: Sale[]): Markup {
        if(sales.length === 0)
            return [h.p, {class: 'text-muted'}, 'No sales recorded yet.'];
        return [h.div, {class: 'list-group lm-list'},
                sales.map(s => this.renderSaleRow(s))];
    }

    renderSaleRow(s: Sale): Markup {
        const id = s.sale_id;
        const primaryText = s.description || sale_kind_enum[s.sale_kind] || 'Sale';
        const badges = [
            [h.span, {class: 'badge text-bg-light border ms-2'}, sale_kind_enum[s.sale_kind] ?? s.sale_kind],
            [h.span, {class: 'badge text-bg-light border ms-1'}, payment_method_enum[s.payment_method] ?? s.payment_method],
        ];
        const secondary = [date.sqliteDateTimeToString(s.sale_time), `$${(s.amount ?? 0).toFixed(2)}`]
            .filter(Boolean).join(' · ');

        // A bike sale with a photo leads with a small thumbnail.
        const thumb = s.photo ? rabid.photo.aspectImg(s.photo, 'landscape', 'thumb', {class: 'lm-row-thumb'}) : undefined;

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link title); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `rabid.sale.renderSaleRowById(${id})`);
        return [h.div, {...item, 'data-testid': `sale-row-${id}`},
            thumb,
            [h.div, {class: 'lm-item-body'},
             [h.div, {class: 'lm-item-primary'},
              [h.a, {...templates.pageLinkProps(`/rabid.sale.detailPage(${id})`),
                     class: 'lm-nav-link'}, primaryText], badges],
             [h.div, {class: 'lm-item-secondary'}, secondary]],
            this.canEditRecord(s) ? this.editPencil(id) : undefined,
            navChevron(),
        ];
    }

    // Reload target for a single list row (after an edit save).
    @route(authenticated)
    renderSaleRowById(id: number): Markup {
        return this.renderSaleRow(this.getById(id));
    }

    // The Sales page query: a from/to date window (page-state; liminal.md
    // § On-page view state).  Defaults to the last 120 days.
    static readonly pageQuery = pageQueries.windowQuery('sales_query');

    // The top-level Sales page body (dispatched from the navbar's /sales),
    // windowed by the route arg.
    renderSalesPage(q?: Record<string, any>): Markup {
        const query = SaleTable.pageQuery.normalize(q) as pageQueries.WindowQuery;
        const w = pageQueries.resolveWindow(query);
        const sales = this.salesInWindow.all(w);
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Sales'],
            pageQueries.renderWindowBar({
                fieldSet: SaleTable.pageQuery, pageRoute: 'sales',
                filterDialogRoute: 'rabid.sale.salesFilterDialog',
                q: query, count: sales.length, noun: 'sale'}),
            this.renderSaleList(sales),
        ];
    }

    @route(authenticated)
    salesFilterDialog(q?: Record<string, any>): Markup {
        return pageQueries.renderFilterDialog(
            SaleTable.pageQuery, SaleTable.pageQuery.normalize(q),
            'rabid.sale.applySalesFilter', {title: 'Filter sales'});
    }
    @route(authenticated)
    applySalesFilter(form: Record<string, any>): any {
        return pageQueries.applyFilterNavigate(SaleTable.pageQuery, form, 'sales');
    }

    // ------------------------------------------------------------------------
    // --- Sale detail page ----------------------------------------------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    detailPage(sale_id: number): templates.Page {
        const s = this.getById(sale_id);
        return templates.page(`${s.description || sale_kind_enum[s.sale_kind] || 'Sale'} — Sale`,
                              this.renderSaleDetail(sale_id));
    }

    // Reloadable fragment (an edit save re-renders it).
    @route(authenticated)
    renderSaleDetail(sale_id: number): Markup {
        const s = this.getById(sale_id);
        const recordedBy = security.runSystem(() =>
            db().prepare<{name: string, short_name: string}, {id: number}>(
                'SELECT name, short_name FROM volunteer WHERE volunteer_id = :id').first({id: s.sale_recorded_by}));
        const props = this.reloadableItemProps(sale_id, `rabid.sale.renderSaleDetail(${sale_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [[h.dt, {class: 'col-sm-3'}, label], [h.dd, {class: 'col-sm-9'}, value]];
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, s.description || sale_kind_enum[s.sale_kind] || 'Sale'],
             this.canEditRecord(s) ? this.editPencil(sale_id) : undefined],
            s.photo ? [h.div, {class: 'mb-3'},
                       rabid.photo.aspectImg(s.photo, 'landscape', 'detail', {class: 'lm-photo-detail'}),
                       [h.div, {class: 'mt-1'}, this.photoButton(sale_id, 'photo')]] : undefined,
            [h.dl, {class: 'row mb-0'},
             row('Kind', sale_kind_enum[s.sale_kind] ?? s.sale_kind),
             row('Time', date.sqliteDateTimeToString(s.sale_time, '—')),
             row('Amount', `$${(s.amount ?? 0).toFixed(2)}`),
             row('Payment', payment_method_enum[s.payment_method] ?? s.payment_method),
             row('Recorded by', recordedBy
                 ? templates.pageLink(`/rabid.volunteer.detailPage(${s.sale_recorded_by})`, shortName(recordedBy))
                 : '—'),
             row('Notes', s.notes ? this.fieldsByName.notes.render(s.notes) : '—'),
            ],
        ];
    }
}
export const saleMetaData = new SaleTable();

export const allDml = saleMetaData.createDMLString();
