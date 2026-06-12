// deno-lint-ignore-file no-explicit-any
/**
 * The category table - the controlled vocabulary for lexeme categories, in
 * the rabid-standard liminal style (like user.ts).
 *
 * Until now categories were free text in the assertions, which produced
 * misspellings, duplicates and a long once-used tail.  This table makes
 * creating a category a deliberate (admin) act; the lexeme editor will offer
 * a select over the non-retired rows instead of a text input.
 *
 * Identity: assertions reference a category by its SLUG (the stable,
 * human-readable kebab-case identifier, e.g. 'smell-and-taste'), NOT by
 * category_id.  The assertion table and its JSON exports are pure data meant
 * to be readable in 1000 years, so they must not depend on this table's
 * surrogate ids.  Consequence: slugs are immutable once created (the edit
 * form never offers the slug field on an existing row); the display `name`
 * is freely renameable.
 *
 * Internal categories are marked by a '~' slug prefix (sorts after z in
 * ASCII/binary collations): they are never rendered on the public site, and
 * serve workflow/provenance/functional-set purposes (~needs-human, ~old-*,
 * ~tier-*, ~game-*).  The prefix lives in the slug - i.e. in the assertion
 * data itself - so exports are self-describing; there is deliberately no
 * separate "internal" column that could disagree with it.
 *
 * No orthography columns: Mi'gmaq display names (Listuguj vs Smith-Francis
 * vs ...) are a later, generic localization project - see
 * categorization/categorization-design.md.
 *
 * The category rows themselves (descriptions, tagger notes) are data with
 * the same longevity goal as the assertions, so they ride along in exports.
 */
import { db, boolnum } from "../liminal/db.ts";
import { Table, PrimaryKeyField, BooleanField, StringField, navChevron } from "../liminal/table.ts";
import { path } from "../liminal/serializable.ts";
import { block } from "../liminal/strings.ts";
import { Markup } from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import * as orderkey from "../liminal/orderkey.ts";
import * as templates from './templates.ts';

const admin = security.hasRole('admin');

// Slugs: kebab-case ascii, optionally marked internal with a leading '~'.
export const SLUG_PATTERN = /^~?[a-z0-9][a-z0-9-]*$/;

// Internal categories ('~' prefix) are never rendered on the public site.
// THE test for internal-ness - use this everywhere, never a bare startsWith.
export function isInternalCategorySlug(slug: string): boolean {
    return slug.startsWith('~');
}

/**
 * Group categories into theme groups for presentation - THE grouping, shared
 * by the Category Table admin page, the lexeme editor's category select, the
 * editor's by-category report and the public categories page:
 *  - themes keep their first-appearance order (pass categories in table
 *    order, i.e. allByOrder/activeByOrder - so the scheme's theme order,
 *    with Internal and Old categories at the end);
 *  - WITHIN a theme, categories sort alphabetically by display name (the
 *    table order drives theme order; alphabetical is what eyes want inside
 *    a group).
 */
// (Generic over the minimal vocab-row shape so the lexical-form table - the
// same controlled-vocabulary treatment for parts of speech - shares it.)
export interface VocabRow { slug: string; name: string; theme?: string; }
export interface ThemeGroup<T extends VocabRow> { theme: string; cats: T[]; }
export type CategoryThemeGroup = ThemeGroup<Category>;
const nameCollator = Intl.Collator('en');
export function groupByTheme<T extends VocabRow>(cats: T[]): ThemeGroup<T>[] {
    const groups: ThemeGroup<T>[] = [];
    const byTheme = new Map<string, ThemeGroup<T>>();
    for(const c of cats) {
        const theme = c.theme || (isInternalCategorySlug(c.slug) ? 'Internal' : 'Other');
        let g = byTheme.get(theme);
        if(!g) { g = {theme, cats: []}; byTheme.set(theme, g); groups.push(g); }
        g.cats.push(c);
    }
    for(const g of groups)
        g.cats.sort((a, b) => nameCollator.compare(a.name || a.slug, b.name || b.slug));
    return groups;
}

// A column managed by the table code (the global ordering): hidden from the
// generic record form; insert() supplies it.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

// The slug field: editable when CREATING a category, immutable afterwards
// (assertions reference it - see the module comment).  parseSimpleInput
// validates the pattern so both the create form and any programmatic form
// path reject malformed slugs.
class SlugField extends StringField {
    override parseSimpleInput(value: string): any {
        const slug = value.trim();
        if(!SLUG_PATTERN.test(slug))
            throw new Error(`Invalid category slug '${slug}' - lowercase kebab-case `+
                            `(a-z, 0-9, '-'), optionally prefixed with '~' for internal`);
        return slug;
    }
}
const onCreateOnly: security.Permission = a =>
    admin(a) && !(a.record as Category|undefined)?.category_id;

// --------------------------------------------------------------------------------
// --- Category --------------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface Category {
    category_id: number;

    // The stable identifier stored in assertion attribute values.  Immutable
    // once created (a true rename is a bulk data migration over the dict
    // assertions, not an edit here).  '~' prefix = internal.
    slug: string;

    // Display name, freely renameable (e.g. 'Smell, Taste & Touch').
    name: string;

    // Presentation grouping (e.g. 'Body & Health').  Plain text - 12-ish
    // values; ordering keeps a theme's categories contiguous.
    theme?: string;

    // Longer public-facing description: the inclusion criteria, suitable as a
    // category page header or tooltip.
    description?: string;

    // Internal guidance for taggers/editors: the boundary conventions
    // ("scatter/spread/pile -> position"), counter-examples, etc.
    tagger_notes?: string;

    // Retired categories stay valid for display/history but are not offered
    // in pickers (~old-* imports are born retired).  We retire rather than
    // delete because assertions (and their history) reference slugs.
    retired: boolnum;

    // Global presentation order (liminal/orderkey.ts); new categories sort
    // before the ~old-* imports.
    order_key: string;
}
export type CategoryOpt = Partial<Category>;

export class CategoryTable extends Table<Category> {

    constructor() {
        super('category', [
            new PrimaryKeyField('category_id', {}),
            new SlugField('slug', {indexed: true, unique: true, edit: onCreateOnly,
                                   prompt: 'Slug (stable id used in assertions - cannot be changed later)'}),
            new StringField('name', {prompt: 'Display name'}),
            new StringField('theme', {nullable: true}),
            new StringField('description', {nullable: true,
                                            prompt: 'Description (public: what belongs here)'}),
            new StringField('tagger_notes', {nullable: true,
                                             prompt: 'Tagger notes (internal: boundary rules)'}),
            new BooleanField('retired', {default: 0,
                                         prompt: 'Retired (not offered in pickers)'}),
            new ManagedStringField('order_key', {default: ''}),
        ]);
    }

    // Open books: any logged-in user sees categories; only admins change the
    // vocabulary - creating a category is a deliberate act, not a volunteer
    // typing a new string into an entry.
    defaultFieldView: security.Permission = security.loggedIn;
    defaultFieldEdit: security.Permission = admin;
    override get recordEdit(): security.Permission { return admin; }

    override formTitle(c: Category): string {
        return c.category_id ? `Edit ${c.name || c.slug || 'category'}` : 'New category';
    }

    // Appends at the end of the global order; programmatic inserts (the
    // importer) may supply an explicit order_key instead.  Slug is re-checked
    // here so non-form inserts get the same validation as the form path.
    override insert<P extends Partial<Category>>(tuple: P): number {
        if(typeof tuple.slug !== 'string' || !SLUG_PATTERN.test(tuple.slug))
            throw new Error(`Invalid category slug '${tuple.slug}'`);
        const withManaged: any = {order_key: this.nextOrderKey(), ...tuple};
        return super.insert(withManaged);
    }

    private nextOrderKey(): string {
        const last = db().first<{k: string|null}>(
            'SELECT MAX(order_key) AS k FROM category', {});
        return orderkey.between(last?.k, undefined);
    }

    @path
    get bySlug() {
        return this.prepare<Category, {slug: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM category
/**/          WHERE slug = :slug`);
    }

    @path
    get allByOrder() {
        return this.prepare<Category, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM category
/**/          ORDER BY order_key, slug`);
    }

    // The picker source (for the lexeme editor's category select).
    @path
    get activeByOrder() {
        return this.prepare<Category, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM category
/**/          WHERE retired = 0
/**/          ORDER BY order_key, slug`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the rabid UI standard) -----------------
    // ------------------------------------------------------------------------

    renderCategoriesPage(): Markup {
        const canCreate = this.canEditRecord({} as Category);
        return ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-2'},
             ['h2', {class: 'mb-0'}, 'Category Table'],
             canCreate
                 ? action.actionButton('New category',
                     {kind: 'modal', dialogUrl: '/ww/wordwiki.categories.newDialog()'},
                     'btn btn-outline-primary btn-sm')
                 : undefined],
            ['p', {class: 'text-muted'},
             'The controlled vocabulary for lexeme categories. Slugs are stable ',
             'identifiers stored in the dictionary data; names are display text. ',
             "'~' slugs are internal (never shown on the public site)."],
            this.renderCategoryList(),
        ];
    }

    // The list as a reloadable fragment (a "New category" insert reloads the
    // pk-less `.-category-` target, which is this wrapper), grouped by theme.
    renderCategoryList(): Markup {
        const cats = this.allByOrder.all({});
        const props = this.reloadableItemProps(undefined, `/ww/wordwiki.categories.renderCategoryList()`);
        if(cats.length === 0)
            return ['div', props,
                ['p', {class: 'text-muted'},
                 'No categories yet (the import seeds these - see categorization/).']];

        return ['div', props,
            groupByTheme(cats).map(group => [
                ['h5', {class: 'mt-3 mb-1'}, group.theme],
                ['div', {class: 'list-group lm-list'},
                 group.cats.map(c => this.renderCategoryRow(c))]])];
    }

    renderCategoryRow(c: Category): Markup {
        const id = c.category_id;
        const secondary = [c.slug,
                           c.retired ? 'retired' : '',
                           c.description ?? '']
            .filter(Boolean).join(' · ');
        const body =
            ['div', {class: 'lm-item-body'},
             ['div', {class: 'lm-item-primary'},
              ['a', {...templates.pageLinkProps(`/ww/wordwiki.categories.detailPage(${id})`),
                     class: 'lm-nav-link'}, c.name || c.slug],
              isInternalCategorySlug(c.slug)
                  ? ['span', {class: 'badge text-bg-secondary ms-2'}, 'internal'] : undefined],
             ['div', {class: 'lm-item-secondary'}, secondary]];

        // One navigable row species for every viewer (Table.detailItemProps:
        // tap anywhere drills in via the lm-nav-link name); the pencil - shown
        // only to viewers with recordEdit - is the only edit affordance.
        const item = this.detailItemProps(id, `/ww/wordwiki.categories.renderCategoryRowById(${id})`);
        return ['div', {...item, 'data-testid': `category-row-${id}`},
            body, this.canEditRecord(c) ? this.editPencil(id) : undefined, navChevron()];
    }

    renderCategoryRowById(id: number): Markup {
        return this.renderCategoryRow(this.getById(id));
    }

    // ------------------------------------------------------------------------
    // --- Category detail page ------------------------------------------------
    // ------------------------------------------------------------------------

    // Full page for one category (navigated to by tapping the list row).  For
    // now the same info as the row, plus the pencil; domain-specific detail
    // (entries in this category, tagging stats, ...) comes later.
    detailPage(category_id: number): templates.Page {
        const c = this.getById(category_id);
        return templates.page(`${c.name || c.slug} — Category`, this.renderDetail(category_id));
    }

    // The detail body, as a reloadable fragment (an edit save re-renders it).
    renderDetail(category_id: number): Markup {
        const c = this.getById(category_id);
        const props = this.reloadableItemProps(category_id, `/ww/wordwiki.categories.renderDetail(${category_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [['dt', {class: 'col-sm-3'}, label], ['dd', {class: 'col-sm-9'}, value]];
        return ['div', props,
            ['div', {class: 'd-flex align-items-center gap-2 mb-3'},
             ['h2', {class: 'mb-0'}, c.name || c.slug],
             isInternalCategorySlug(c.slug)
                 ? ['span', {class: 'badge text-bg-secondary'}, 'internal'] : undefined,
             c.retired ? ['span', {class: 'badge text-bg-secondary'}, 'Retired'] : undefined,
             this.canEditRecord(c) ? this.editPencil(category_id) : undefined],
            ['dl', {class: 'row mb-0'},
             row('Slug', c.slug),
             row('Theme', c.theme || '—'),
             row('Description', c.description || '—'),
             row('Tagger notes', c.tagger_notes || '—'),
            ],
        ];
    }

    // The create dialog: the record form over an empty record (renderForm
    // gates on recordEdit server-side too).
    newDialog(): Markup {
        return this.renderForm({} as Category);
    }
}
