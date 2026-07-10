// deno-lint-ignore-file no-unused-vars, no-explicit-any, ban-types

import * as utils from "../liminal/utils.ts";
import {unwrap} from "../liminal/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import * as date from "../liminal/date.ts";
import { Table, Field, PrimaryKeyField, ForeignKeyField, BooleanField, StringField, MarkdownField, EnumField, IntegerField, FloatingPointField, DateTimeField, ImageField, navChevron, liveReloadableProps } from "../liminal/table.ts";
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

// Giveaways/loans carry no money; everything else is a paid sale.  Drives both
// the "Add ..." menu wording and which fields the add dialog shows.
export function isFreeSaleKind(kind: string): boolean {
    return kind.startsWith('free-') || kind === 'balance-bike-loan';
}

// A sale's time as a short 12h clock ("2:30 PM") for the compact list line; '' if
// unset.  (Sales are grouped under a single-day event, so the date is redundant.)
function shortClock(dt?: string): string {
    const t = date.sqliteDateTimeToTemporalOrNull(dt ?? null);
    if(!t) return '';
    const h = t.hour % 12 || 12;
    return `${h}:${String(t.minute).padStart(2, '0')} ${t.hour >= 12 ? 'PM' : 'AM'}`;
}
// The menu/dialog label for adding a sale of a given kind: a paid kind reads
// "<Kind> Sale" (e.g. "Bike Sale"), a giveaway/loan by its own label (already
// "Free ..." / "Balance ...").
export function saleAddLabel(kind: string): string {
    const label = sale_kind_enum[kind] ?? kind;
    return isFreeSaleKind(kind) ? label : `${label} Sale`;
}

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

    // These should not display in the editor - they are auto set only
    sale_time: string;
    sale_recorded_by: number;

    sale_kind: string;

    // Optional: used mostly for loans
    client_name: string;
    description: string;
    // Optional: used primarily for balance bike loans.
    client_phone?: string;

    // Optional photo of the item (a content-store path - see liminal/photo.ts).
    photo?: string;

    // Amount and payment method.  Should not be displayed for the free and loan sale_kinds.
    amount: number;
    payment_method: string;
    
    notes?: string;
}

export type SaleOpt = Partial<Sale>;

// The paid sale kinds (everything that isn't free/loan) - the single source of
// truth is isFreeSaleKind, so this can't drift as kinds are added.  amount +
// payment_method show only for these.
const PAID_SALE_KINDS = Object.keys(sale_kind_enum).filter(k => !isFreeSaleKind(k));
const showForPaid = {field: 'sale_kind', in: PAID_SALE_KINDS};
// A phone number is only relevant to a balance-bike loan.
const showForLoan = {field: 'sale_kind', in: ['balance-bike-loan']};

export class SaleTable extends Table<Sale> {

    constructor() {
        super ('sale', [
            new PrimaryKeyField('sale_id', {}),
            // Every sale belongs to an event (scheduled or the day's Ad-hoc
            // catch-all).  Mandatory - the event is the aggregate root.  Not
            // user-editable: a sale is bound to its event, so the edit form omits it.
            new ForeignKeyField('event_id', "event", "event_id", {indexed: true, edit: security.never}),
            // Auto-set on insert (org-now / the acting volunteer); never user-editable.
            new DateTimeField('sale_time', {edit: security.never}),
            // (was unique:true - a copy-paste bug that would have limited each
            // volunteer to recording ONE sale ever)
            new VolunteerForeignKeyField('sale_recorded_by', {indexed: true, edit: security.never}),
            new EnumField('sale_kind', sale_kind_enum, {}),
            // Optional; mostly for loans (a name to hold the loaned bike against).
            // Always shown.
            new StringField('client_name', {default: ''}),
            new StringField('description', {default: ''}),
            // Optional contact number - only for a balance-bike loan (showWhen).
            new StringField('client_phone', {default: '', showWhen: showForLoan}),
            new ImageField('photo', 'rabid.photo', {aspect: 'landscape', nullable: true, prompt: 'Photo'}),
            // Money: only the PAID kinds (free/loan carry none) - showWhen; default 0
            // so a hidden amount isn't treated as a missing required field.
            new FloatingPointField('amount', {default: 0, showWhen: showForPaid}),
            new EnumField('payment_method', payment_method_enum, {default: 'cash', showWhen: showForPaid}),
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

    // The "Add ..." menu items for the event Activity section's Sales sub-section:
    // one per sale kind (Add Bike Sale / Add Free Helmet / ...), each opening the
    // pre-bound dialog for that kind.  New kinds in sale_kind_enum appear here
    // automatically.
    saleAddMenuItems(event_id: number): action.ActionMenuItem[] {
        return Object.keys(sale_kind_enum).map(kind => ({
            label: `Add ${saleAddLabel(kind)}`,
            mode: {kind: 'modal' as const,
                   dialogUrl: `/rabid.sale.newSaleForEventDialog(${event_id}, '${kind}')`},
        }));
    }

    // Add a sale/giveaway of a specific KIND bound to an event (the kind is chosen
    // from the Sales menu, so it's hidden here, not re-picked).  A giveaway/loan
    // needs no amount or payment method.  event_id rides hidden; sale_time (now)
    // and sale_recorded_by (the actor) are stamped by the mutation.  host/admin.
    @route(hostOrAdmin)
    newSaleForEventDialog(event_id: number, sale_kind: string = 'bike'): Markup {
        const f = this.fieldsByName;
        // The kind is fixed by the menu (hidden), so we pick the right fields
        // server-side here rather than via showWhen (which drives the EDIT form,
        // where the kind IS a select).  Name always; phone for a loan; money for a
        // paid kind.
        const paid = !isFreeSaleKind(sale_kind);
        const isLoan = sale_kind === 'balance-bike-loan';
        const fields = [f.client_name, f.description,
                        ...(isLoan ? [f.client_phone] : []),
                        ...(paid ? [f.amount, f.payment_method] : [])];
        return action.renderParamForm(
            fields,
            {amount: 0, payment_method: 'cash'} as Partial<Sale>,
            {
                title: `Add ${saleAddLabel(sale_kind)}`,
                submitLabel: 'Add',
                hidden: {event_id, sale_kind},
                dispatch: {onsubmit:
                    'event.preventDefault(); tx`rabid.sale.addSaleForEvent(${getFormJSON(event.target)})`'},
            });
    }

    @routeMutation(hostOrAdmin)
    addSaleForEvent(args: {event_id?: string|number, sale_kind?: string,
                           client_name?: string, description?: string, client_phone?: string,
                           amount?: string|number, payment_method?: string}): Markup {
        const event_id = Number(args?.event_id);
        if(!Number.isInteger(event_id) || !event_id) throw new Error('Missing event');
        const sale_kind = args.sale_kind || 'bike';
        this.insert({
            event_id, sale_kind,
            sale_time: date.temporalToSqliteDateTime(date.orgNow()),
            sale_recorded_by: security.current()!.actorId!,
            client_name: (args.client_name ?? '').trim(),
            description: (args.description ?? '').trim(),
            client_phone: (args.client_phone ?? '').trim(),
            amount: Number(args.amount) || 0,
            payment_method: args.payment_method || 'cash',
        } as Partial<Sale>);
        // A new row changes the section's shape -> reload the section (it's
        // registered on the shape key; an edit reloads only its own row).
        return {action: 'reload',
                targets: ['.' + this.shapeKey('event_id', event_id)]} as unknown as Markup;
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
        // Same flat numbered document list as the Services list (rabid.css lm-doc-list).
        return [h.ol, {class: 'lm-list lm-doc-list'},
                sales.map(s => this.renderSaleRow(s))];
    }

    // A compact, scannable line ported from the Services list: "1) ITEM [KIND] client ·
    // time                 $AMOUNT  ✎".  Title (the item) in the blue nav style; a quiet
    // KIND tag (dropped when the title already IS the kind); the money pinned right as
    // the report column (blank for a free giveaway / loan).  The <li> is the flat flex
    // row + live/navigable fragment - no list-group box (design-language.md).
    renderSaleRow(s: Sale): Markup {
        const id = s.sale_id;
        const paid = (s.amount ?? 0) !== 0;
        const kindLabel = sale_kind_enum[s.sale_kind] ?? s.sale_kind;
        const title = s.description || kindLabel;
        // Show the kind tag unless the title already IS the kind (empty description).
        const badge = s.description ? [h.span, {class: 'lm-line-badge'}, kindLabel.toUpperCase()] : undefined;
        const sub = [s.client_name || undefined, shortClock(s.sale_time)].filter(Boolean).join(' · ');
        const amount = paid ? `$${(s.amount ?? 0).toFixed(2)}` : '';

        const props = liveReloadableProps([this.rowKey(id)], `rabid.sale.renderSaleRowById(${id})`);
        props.class = `${props.class} lm-doc-row lm-navigable`;
        (props as Record<string, string>).onclick = 'lmNavigableClick(event)';
        return [h.li, {...props, 'data-testid': `sale-row-${id}`},
            [h.span, {class: 'lm-doc-num'}],
            [h.div, {class: 'lm-doc-main'},
             [h.a, {...templates.pageLinkProps(`/rabid.sale.detailPage(${id})`), class: 'lm-nav-link'}, title],
             badge,
             sub ? [h.span, {class: 'lm-doc-sub'}, sub] : undefined],
            [h.span, {class: 'lm-doc-right'}, amount],
            this.canEditRecord(s) ? this.editPencil(id) : undefined,
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
        // A giveaway/loan (amount 0) shows no amount/payment; kind and who recorded
        // it share one line; notes only when present.
        const paid = (s.amount ?? 0) !== 0;
        const recordedByMk = recordedBy
            ? templates.pageLink(`/rabid.volunteer.detailPage(${s.sale_recorded_by})`, shortName(recordedBy))
            : undefined;
        return [h.div, props,
            [h.div, {class: 'd-flex align-items-center gap-2 mb-3'},
             [h.h2, {class: 'mb-0'}, s.description || sale_kind_enum[s.sale_kind] || 'Sale'],
             this.canEditRecord(s) ? this.editPencil(sale_id) : undefined],
            s.photo ? [h.div, {class: 'mb-3'},
                       rabid.photo.aspectImg(s.photo, 'landscape', 'detail', {class: 'lm-photo-detail'}),
                       [h.div, {class: 'mt-1'}, this.photoButton(sale_id, 'photo')]] : undefined,
            [h.dl, {class: 'row mb-0'},
             row('Kind', [sale_kind_enum[s.sale_kind] ?? s.sale_kind,
                          recordedByMk ? [' · recorded by ', recordedByMk] : undefined]),
             row('Time', date.sqliteDateTimeToString(s.sale_time, '—')),
             s.client_name ? row('Client', s.client_name) : undefined,
             s.client_phone ? row('Client phone', s.client_phone) : undefined,
             paid ? row('Amount', `$${(s.amount ?? 0).toFixed(2)}`) : undefined,
             paid ? row('Payment', payment_method_enum[s.payment_method] ?? s.payment_method) : undefined,
             s.notes ? row('Notes', this.fieldsByName.notes.render(s.notes)) : undefined,
            ],
        ];
    }
}
export const saleMetaData = new SaleTable();

export const allDml = saleMetaData.createDMLString();
