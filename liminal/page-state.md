# On-page state: pages as pure functions of their route expression

*(liminal/table.ts `FieldSet`, liminal/action.ts `renderParamForm`; worked
examples: wordwiki/change-feed.ts and wordwiki/activity-report.ts; in rabid,
`volunteer.search` (the filter → navigation case) and volunteer_time.ts's Time
view (a configurable SECTION with hx-replace-url depth toggles).  Written to
inform future Claudes - read this before building any page with filters,
paging, anchors, or other view state.)*

## The principle

A page's view state (filters, depth, time anchors) lives in its route
expression, as `{}`-literal arguments:

    /ww/wordwiki.changes({to_time:215001495719999,restrict_to_user:"djz"})
    /ww/wordwiki.activity({months:12})

The page render is a **pure function of its arguments**.  Everything follows
from this: every view is bookmarkable, refreshable, and shareable (including
scroll-back depth); tests render views by constructing the arguments, no
browser or session needed; and there is no hidden DOM/session state to drift.

Two load-bearing design decisions (dz):

- **Do not privilege a textual base-URL.**  URLs here are composable route
  expressions.  A `{}` value is an ordinary argument, composed into the
  route expression like any other (`${R}.page(${fs.literal(q)})`).
- **One schema mechanism.**  The same Field objects that define a db table
  (Table extends FieldSet) define page queries: the URL codec, the
  auto-generated filter dialog, and the typed in-code representation are one
  declaration.

## The unit of state is the SECTION, not the page

A FieldSet is a codec for exactly ONE `{}` value - and that one-ness is
deliberately **per configurable section, not per page**.  A page with
several independently-configurable parts (multiple filtered widgets, "more"
buttons on separate lists, embedded sub-renderers) carries several `{}`
arguments, one per section, each with its own FieldSet:

    /ww/x.page({from_time:...,max_rows:200}, {status:"pending"})
                ^ the change-list section     ^ the sidebar section

Do NOT merge a page's state into one grand `{}` block.  Merging breaks the
mechanism's own affordances: the auto-generated dialog edits a FieldSet's
FIELDS, so a merged block would make every filter dialog show every
section's knobs instead of just the one the user asked to configure; a
depth bump ("Show older") on one list would have to understand and re-emit
every other section's state; and two sections could not evolve their
schemas independently.  Each section instead:

- normalizes ITS argument and renders as a pure function of it;
- generates ITS dialog from ITS fields (`renderParamForm(fs.fields, ...)`);
- emits new-state URLs by re-composing the FULL route expression - its own
  argument re-rendered via `literal`, the OTHER sections' arguments passed
  through verbatim.

The feed and the activity report each happen to have one configurable
section, so their routes take a single `{}` argument - the common
degenerate case, not the model.

## FieldSet: the codec (liminal/table.ts)

`FieldSet` is the extracted base of `Table`: an ordered set of named `Field`s
describing one record-shaped value, with no persistence.  `Table` layers DML
/ queries / field security on top; a page query uses `FieldSet` directly:

```ts
export const feedQuery = new FieldSet('feed_query', [
    new TimestampField('from_time', {nullable: true, prompt: 'From'}),
    new TimestampField('to_time',   {nullable: true, prompt: 'To'}),
    new UserField('restrict_to_user', feedUsers, {nullable: true, prompt: 'Only changes by'}),
    new IntegerField('max_rows', {nullable: true, default: FEED_PAGE_ROWS, prompt: 'Max rows'}),
]);
export interface FeedQuery extends Tuple {   // the typed view of the same thing
    from_time: number|null; to_time: number|null;
    restrict_to_user: string|null; max_rows: number;
}
```

The three codec operations:

- **`normalize(q)`** - route-literal → value.  Route arguments are
  user-typeable text, so this is the guard: unknown keys rejected, each
  present value type-checked/coerced by its field's `fromLiteral`, absent or
  null values take the field's `default` (or null).  Every route method
  begins `const query = fs.normalize(q) as MyQuery;`.
- **`literal(q)`** - value → canonical route literal.  Declaration order;
  null AND default-valued fields are OMITTED, so the common views get the
  shortest URLs and *equal views get equal URLs*.  Strings JSON-quote (JSON
  is a subset of the route grammar).  The inverse of normalize.
- **`parseFormValues(form)`** - filter-dialog postback → COMPLETE value
  (empty inputs fall back to default/null).  Contrast `parseFormChanges`,
  the record-EDIT parse, which extracts only changed fields against
  `before-<name>` snapshots - a query dialog's submitted state IS the new
  value, so it uses the complete parse.

Useful field types beyond the obvious: `TimestampField` codecs the HLC
timestamps (see liminal/timestamp.ts) to `datetime-local` inputs and local
display; `EnumField` renders a select from a `Record<value, label>`.  When
historic data carries values outside today's vocabulary, subclass and loosen
`fromLiteral` (see `UserField` in change-feed.ts: the dropdown offers known
editors, but any username string stays URL-typeable and filterable).

Nullable-with-default vs nullable-no-default matters: `max_rows` has
`default: 1000` so it always normalizes to a number; `months` has NO default
so null survives normalize and means "no limit" (activity-report.ts).

**Dates (rabid) vs HLC timestamps (wordwiki).**  wordwiki's versioned store
uses `TimestampField` (a raw HLC number).  rabid stores SQLite date strings,
so a rabid date/time filter uses `DateField` (`YYYY-MM-DD`) or `DateTimeField`
(`YYYY-MM-DD HH:MM:SS`) - NOT `TimestampField`.  Both now validate STRUCTURALLY
in `fromLiteral` (a hand-typed URL can't smuggle junk into a date filter),
matching their `parseSimpleInput` bar - shape, not calendar validity.  A
boolean query knob (rendered as a checkbox) uses `CheckboxField`, whose whole
codec is boolean so `flag:true/false` round-trips canonically
(rabid/volunteer.ts `volunteerQuery`).

## The page pattern

```ts
const R = '/ww/wordwiki.report';                      // the routes' prefix

@route(authenticated)
somePage(q?: Record<string, any>): templates.Page | server.Response {
    const query = myQuery.normalize(q) as MyQuery;
    // (optional anchor stamping - see below)
    return templates.page('Title', [
        header,
        filterSummary(query),                          // quiet "by X · last N months"
        action.actionButton('Filter…',
            {kind: 'modal', dialogUrl: `${R}.filterDialog(${myQuery.literal(query)})`}, ...),
        this.renderBody(query)]);                      // pure function of query
}

@route(authenticated)
filterDialog(q?: Record<string, any>): Markup {        // AUTO-GENERATED from the fields
    const query = myQuery.normalize(q);
    return [['script', {}, 'setTimeout(showModalEditor)'],
        action.renderParamForm(myQuery.fields, query, {
            title: 'Filter …', submitLabel: 'Apply',
            dispatch: {id: 'edit-form',
                onsubmit: 'event.preventDefault(); tx`x.applyFilter(${getFormJSON(event.target)})`'}})];
}

@route(authenticated)
applyFilter(form: Record<string, any>): any {
    const query = myQuery.parseFormValues(form);
    return {action: 'navigate', url: `/ww/x.page(${myQuery.literal(query)})`};
}
```

`renderParamForm` renders each field with its own widget (date pickers,
selects…), pre-filled from the current value - the dialog is the schema, so
adding a field to the FieldSet adds it to the URL, the dialog, and the typed
query simultaneously.  The `navigate` tx action lives in rabid-scripts.js
(client-side); a tab whose in-memory scripts predate that action makes Apply
a silent no-op - reload fixes (resources revalidate via etag, but an OPEN
tab keeps its loaded JS).

## State-change taxonomy: navigation vs replacement

Two kinds of state change, deliberately different in history behavior:

- **Filter changes are REAL navigations** (`{action:'navigate', url}` →
  pushState).  Distinct filters are distinct views; Back walks filter
  history.
- **Depth/refinement changes replace in place.**  The feed's "Show older" is
  the SAME view with `max_rows` bumped, htmx-swapped into `#content` with
  `hx-replace-url` (replaceState): depth is always in the URL (refresh
  keeps it) but Back leaves the page rather than un-scrolling.  This works
  because a deeper page's shared prefix re-renders identically (valid_from
  is append-only), so the swap never visibly moves content.

## Temporal anchors: stamp or drift, choose per page

- **The feed STAMPS**: a visit with no `to_time` redirects
  (`server.forwardResponse`) to the canonical URL with it stamped at the
  db's top tx timestamp.  The anchor rides in the browser URL (survives
  refresh/Back), pages anchored in the past are immutable, and the anchor
  doubles as the review-sitting `since` carried into entry links.
- **The activity report does NOT**: it is a live dashboard - "the last 12
  months" should drift with today.  Reproducibility lives in the LINKS it
  emits, which are absolute closed ranges.

Pages are served no-store (bfcache deliberately defeated); the page must be
cheap to re-render, which the purity discipline gives you.

## Counts must be their links

When a report links into another view (activity counts → feed pages /
createdPage), the two must compute from the SAME predicate - import the
predicate (`CHANGE_ROW`), don't re-derive it.  A number that opens a page
showing a different number is worse than no link.

## Testing (see change-feed_test.ts / activity-report_test.ts)

Purity makes this cheap: `markupToString(x.renderBody(fs.normalize({...})))`
over the in-memory fixture; assert canonical URLs exactly
(`wordwiki.changes({to_time:5,max_rows:1001})`); pin the redirect stamping
(`isRedirectResponse` + Location); pin EXPLAIN QUERY PLAN for every query
shape a page fetch uses (export the shapes from the module so the test
can't drift from the implementation).

## Gotchas

- `literal` omits defaults: changing a field's `default` silently changes
  which URLs are canonical (old URLs still normalize fine).
- Braces in URLs: browsers percent-encode transparently; curl does NOT
  (its `{}` globbing mangles them) - encode `%7B`/`%7D` when testing by
  hand.
- `normalize` treats absent and null identically (both → default/null);
  only `literal`-round-tripping preserves canonicality, so always emit URLs
  through `literal`, never by string-building.
- A FieldSet field name is also its form-input name and its URL key: rename
  = breaking old bookmarks (old keys are REJECTED by normalize, by design).
- Server-rendered relative times / "now"-dependent labels age in an open
  tab until a fragment reload; anchor-stamped pages avoid the worst of it.
