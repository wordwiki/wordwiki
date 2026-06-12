// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, EnumField, IntegerField, FloatingPointField, DateTimeField, ImageField, navChevron } from "../liminal/table.ts";
import {block} from "../liminal/strings.ts";
import {path} from "../liminal/serializable.ts";
import {Markup, h} from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import * as templates from './templates.ts';
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
    'parts': 'Parts',
    'other': 'Other',
};

export const payment_method_enum: Record<string, string> = {
    'cash': 'Cash',
    'square': 'Square',
    'etransfer': 'Etransfer',
    'other': 'Other',
};

export interface Sale {
    sale_id: number;
    sale_time: string;
    sale_recorded_by: number;
    sale_kind: string;
    description: string;
    // Optional photo of the bike (a content-store path - see liminal/photo.ts).
    photo?: string;
    amount: number;
    payment_method: string;
    notes?: string;
}

export type SaleOpt = Partial<Sale>;

export class SaleTable extends Table<Sale> {

    constructor() {
        super ('bike_sale', [
            new PrimaryKeyField('sale_id', {}),
            new DateTimeField('sale_time', {}),
            // (was unique:true - a copy-paste bug that would have limited each
            // volunteer to recording ONE sale ever)
            new ForeignKeyField('sale_recorded_by', 'volunteer', 'volunteer_id', {indexed: true}, 'name'),
            new EnumField('sale_kind', sale_kind_enum, {}),
            new StringField('description', {default: ''}),
            new ImageField('photo', 'rabid.photo', {nullable: true, prompt: 'Photo'}),
            new FloatingPointField('amount', {}),
            new EnumField('payment_method', payment_method_enum, {default: 'cash'}),
            new StringField('notes', {nullable: true})
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
/**/          FROM bike_sale
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
        const thumb = s.photo ? rabid.photo.img(s.photo, 96, {class: 'lm-row-thumb'}) : undefined;

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
    renderSaleRowById(id: number): Markup {
        return this.renderSaleRow(this.getById(id));
    }

    // The top-level Sales page body (dispatched from the navbar's /sales).
    // For now the full standard list; per-day summaries with monthly totals
    // are the plan here.
    renderSalesPage(): Markup {
        return [h.div, {class: 'container py-3'},
            [h.h2, {}, 'Sales'],
            this.renderSaleList(this.allSales.all()),
        ];
    }

    // ------------------------------------------------------------------------
    // --- Sale detail page ----------------------------------------------------
    // ------------------------------------------------------------------------

    detailPage(sale_id: number): templates.Page {
        const s = this.getById(sale_id);
        return templates.page(`${s.description || sale_kind_enum[s.sale_kind] || 'Sale'} — Sale`,
                              this.renderSaleDetail(sale_id));
    }

    // Reloadable fragment (an edit save re-renders it).
    renderSaleDetail(sale_id: number): Markup {
        const s = this.getById(sale_id);
        const recordedBy = security.runSystem(() =>
            db().prepare<{name: string}, {id: number}>(
                'SELECT name FROM volunteer WHERE volunteer_id = :id').first({id: s.sale_recorded_by}));
        const props = this.reloadableItemProps(sale_id, `rabid.sale.renderSaleDetail(${sale_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [[h.dt, {class: 'col-sm-3'}, label], [h.dd, {class: 'col-sm-9'}, value]];
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, s.description || sale_kind_enum[s.sale_kind] || 'Sale'],
             this.canEditRecord(s) ? this.editPencil(sale_id) : undefined],
            s.photo ? rabid.photo.img(s.photo, 512, {class: 'lm-photo-detail'}) : undefined,
            [h.dl, {class: 'row mb-0'},
             row('Kind', sale_kind_enum[s.sale_kind] ?? s.sale_kind),
             row('Time', date.sqliteDateTimeToString(s.sale_time, '—')),
             row('Amount', `$${(s.amount ?? 0).toFixed(2)}`),
             row('Payment', payment_method_enum[s.payment_method] ?? s.payment_method),
             row('Recorded by', recordedBy
                 ? templates.pageLink(`/rabid.volunteer.detailPage(${s.sale_recorded_by})`, recordedBy.name)
                 : '—'),
             row('Notes', s.notes || '—'),
            ],
        ];
    }
}
export const saleMetaData = new SaleTable();

export const allDml = saleMetaData.createDMLString();
