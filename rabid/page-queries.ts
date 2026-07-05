// deno-lint-ignore-file no-explicit-any
// Shared page-state scaffolding for rabid list/report pages (see liminal.md
// § On-page view state).  The recurring shape is a "recent date window": a
// time-ordered list defaults to the last N days (drifting), with a Show-older
// depth control and a Filter dialog for an explicit range - all carried in the
// page's route expression as a `{}` argument decoded by a FieldSet.  Factored
// here so each page stays thin (a FieldSet + a windowed query + these
// helpers).
import { FieldSet, DateField, type Tuple } from "../liminal/table.ts";
import * as action from "../liminal/action.ts";
import * as templates from "./templates.ts";
import * as date from "../liminal/date.ts";
import { Markup, h } from "../liminal/markup.ts";

// The default recent window (dz): show a good chunk of history before the user
// has to Show older.
export const DEFAULT_WINDOW_DAYS = 120;
// The lower bound "Show all" pins to (older than any real rabid record).
export const WINDOW_EPOCH = '2000-01-01';

// A from/to date-range page query.  Both fields nullable with NO default, so
// an absent value survives normalize as null and means "the default end of the
// window" (resolveWindow fills it) - the drift-vs-pin split falls out of
// literal (an omitted `from` drifts; an explicit one pins).
export function windowQuery(name: string): FieldSet {
    return new FieldSet(name, [
        new DateField('from', {prompt: 'From', nullable: true}),
        new DateField('to', {prompt: 'To', nullable: true}),
    ]);
}
export interface WindowQuery extends Tuple {
    from: string | null;
    to: string | null;
}

// Resolve a normalized window query to concrete sqlite date bounds: absent
// `from` → today − DEFAULT_WINDOW_DAYS (drifting default), absent `to` → today.
export interface ResolvedWindow { from: string; to: string; }
export function resolveWindow(q: WindowQuery): ResolvedWindow {
    const today = date.orgToday();
    return {
        from: q.from ?? date.temporalToSqliteDate(today.subtract({days: DEFAULT_WINDOW_DAYS})),
        to: q.to ?? date.temporalToSqliteDate(today),
    };
}

// The window control strip: "N · from – to", a Show-older / Show-all depth
// control (a boosted #content swap that REPLACES the page URL - depth rides
// the URL, but Back leaves the page; page-state.md's replacement taxonomy),
// and a Filter… dialog button (a real navigation).
export function renderWindowBar(opts: {
    fieldSet: FieldSet,
    pageRoute: string,           // bare page identifier, e.g. 'timesheets'
    q: WindowQuery,
    count?: number,              // list length; omit for a non-list (report)
    noun?: string,               // singular, e.g. 'entry' (with count)
    nounPlural?: string,         // default noun + 's'; give 'entries' etc.
    filterDialogRoute?: string,  // omit to drop the Filter… button
    otherArgs?: string,          // a sibling filter's literal placed BEFORE this
                                 // one in the route (a page with two filters);
                                 // threads through the depth links + Filter dialog
    conditionText?: string,      // extra filter condition to summarise (e.g.
                                 // 'public only'), appended to the count · range
}): Markup {
    const w = resolveWindow(opts.q);
    const pre = opts.otherArgs ? opts.otherArgs + ', ' : '';
    const pageUrl = (query: Tuple) => `/${opts.pageRoute}(${pre}${opts.fieldSet.literal(query)})`;
    const olderFrom = date.temporalToSqliteDate(
        date.sqliteDateToTemporal(w.from).subtract({days: DEFAULT_WINDOW_DAYS}));
    const showingAll = w.from <= WINDOW_EPOCH;
    const countLabel = opts.count === undefined ? undefined
        : `${opts.count} ${opts.count === 1 ? opts.noun : (opts.nounPlural ?? (opts.noun ?? '') + 's')} · `;
    // A depth link: boosted swap of #content + hx-replace-url (replaceState).
    const depthLink = (label: string, query: Tuple): Markup =>
        [h.a, {...templates.pageLinkProps(pageUrl(query)),
               'hx-replace-url': pageUrl(query), class: 'link-secondary'}, label];
    return [h.div, {class: 'd-flex align-items-center flex-wrap gap-3 mb-3 text-muted small',
                    'data-testid': 'window-bar'},
        [h.span, {}, `${countLabel ?? ''}`
                     + `${date.sqliteDateToString(w.from)} – ${date.sqliteDateToString(w.to)}`
                     + (opts.conditionText ? ` · ${opts.conditionText}` : '')],
        showingAll ? undefined : depthLink('Show older', {...opts.q, from: olderFrom}),
        showingAll ? undefined : depthLink('Show all', {...opts.q, from: WINDOW_EPOCH}),
        opts.filterDialogRoute
            ? action.actionButton('Filter…',
                {kind: 'modal', dialogUrl: `/${opts.filterDialogRoute}(${pre}${opts.fieldSet.literal(opts.q)})`},
                'btn btn-sm btn-link p-0')
            : undefined,
    ];
}

// A single "flip this view knob" link (e.g. Show done / Hide done): a boosted
// #content swap that REPLACES the page URL with the flipped `{}` (page-state's
// replacement taxonomy — refresh keeps it, Back leaves the page).  For a
// simple status toggle that doesn't warrant a filter dialog.
export function renderToggleLink(opts: {
    pageRoute: string, fieldSet: FieldSet, next: Tuple, label: string,
}): Markup {
    const url = `/${opts.pageRoute}(${opts.fieldSet.literal(opts.next)})`;
    return [h.a, {...templates.pageLinkProps(url), 'hx-replace-url': url,
                  class: 'link-secondary small', 'data-testid': 'view-toggle'}, opts.label];
}

// A filter dialog auto-generated from a page query's fields, dispatching an
// applyFilter route (server-side form → canonical URL → navigate).  The
// opening actionButton already runs showModalEditor, so no inline script.
export function renderFilterDialog(fieldSet: FieldSet, q: Tuple, applyRoute: string,
                                   opts: {title?: string, applyArgsBefore?: string,
                                          applyArgsAfter?: string} = {}): Markup {
    // applyArgsBefore/After thread a sibling filter's literal through the apply
    // call so it's preserved on a two-filter page.
    const before = opts.applyArgsBefore ? opts.applyArgsBefore + ', ' : '';
    const after = opts.applyArgsAfter ? ', ' + opts.applyArgsAfter : '';
    return action.renderParamForm(fieldSet.fields, q, {
        title: opts.title ?? 'Filter',
        submitLabel: 'Apply',
        dispatch: {onsubmit: `event.preventDefault(); tx\`${applyRoute}(${before}\${getFormJSON(event.target)}${after})\``},
    });
}

// Filter-dialog postback → canonical page URL → real navigation.  before/after
// place a sibling filter's literal around this one (a two-filter page).
export function applyFilterNavigate(fieldSet: FieldSet, form: Record<string, any>,
                                    pageRoute: string,
                                    opts: {before?: string, after?: string} = {}): any {
    const q = fieldSet.parseFormValues(form);
    const before = opts.before ? opts.before + ', ' : '';
    const after = opts.after ? ', ' + opts.after : '';
    return {action: 'navigate', url: `/${pageRoute}(${before}${fieldSet.literal(q)}${after})`};
}
