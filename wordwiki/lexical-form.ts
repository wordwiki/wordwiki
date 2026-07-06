// deno-lint-ignore-file no-explicit-any
/**
 * The lexical form table - the controlled vocabulary for parts of speech /
 * grammatical forms, in the rabid-standard liminal style.  The same
 * treatment as the category table (category.ts), for the same reason: the
 * subentry part_of_speech is free text today, and beside the dominant codes
 * (vai, vat, ni, na, vit, vii, PTCL...) the data holds a junk tail of
 * one-offs ('vai  PL', 'ni·dt', '??', 'Wp ini'...).  This table makes the
 * vocabulary deliberate; the lexeme editor offers a select over the
 * non-retired rows.
 *
 * Identity: assertions reference a lexical form by its SLUG, never by
 * lexical_form_id (the assertion data must read standalone in 1000 years).
 * Slugs are immutable once created; the display `name` ('verb animate
 * intransitive') renames freely.  Unlike category slugs, lexical-form slugs
 * allow uppercase, because the established codes already stored in the data
 * include 'PTCL' - the slug must EQUAL the stored value for the select to
 * recognize existing tuples.
 *
 * Junk legacy values are deliberately NOT seeded: they stay un-tabled, the
 * editor's select shows them as "(not in the lexical form table)" until an
 * editor fixes each one, and creating any new form is an admin act here.
 *
 * The '~' internal-slug convention is honored here too (isInternal... from
 * category.ts is the shared test), though no internal lexical forms exist
 * yet.  No orthography columns, as with categories (later i18n project).
 */
import { db, boolnum } from "../liminal/db.ts";
import { Table, PrimaryKeyField, BooleanField, StringField, MarkdownField } from "../liminal/table.ts";
import { path } from "../liminal/serializable.ts";
import { block, plural } from "../liminal/strings.ts";
import { Markup } from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as templates from './templates.ts';
import * as security from "../liminal/security.ts";
import {route, authenticated} from "../liminal/security.ts";
import * as orderkey from "../liminal/orderkey.ts";
import { groupByTheme, isInternalCategorySlug } from "./category.ts";
import * as entrySchema from './entry-schema.ts';
import type { WordWiki } from './wordwiki.ts';

const nameCollator = Intl.Collator('en');

const admin = security.hasRole('admin');
// Vocabulary curation is its own grant: 'edit-lexical-forms' can be given to
// a non-admin curator; 'admin' implies it (the approve-role convention).
const editLexicalForms = security.or(security.hasRole('edit-lexical-forms'), admin);

// Slugs: the codes stored in assertions.  Uppercase allowed (PTCL); '~'
// marks internal, as for categories.
export const LEXICAL_FORM_SLUG_PATTERN = /^~?[A-Za-z0-9][A-Za-z0-9-]*$/;

// A column managed by the table code (the global ordering): hidden from the
// generic record form; insert() supplies it.
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

// Editable when CREATING a lexical form, immutable afterwards (assertions
// reference it); pattern-validated on the form path.
class LexicalFormSlugField extends StringField {
    override parseSimpleInput(value: string): any {
        const slug = value.trim();
        if(!LEXICAL_FORM_SLUG_PATTERN.test(slug))
            throw new Error(`Invalid lexical form slug '${slug}' - letters/digits/'-' ` +
                            `(e.g. 'vai', 'PTCL'), optionally prefixed with '~' for internal`);
        return slug;
    }
}
const onCreateOnly: security.Permission = a =>
    editLexicalForms(a) && !(a.record as LexicalForm|undefined)?.lexical_form_id;

// --------------------------------------------------------------------------------
// --- LexicalForm -----------------------------------------------------------------
// --------------------------------------------------------------------------------

export interface LexicalForm {
    lexical_form_id: number;

    // The stable code stored in assertion attribute values ('vai', 'PTCL').
    // Immutable once created (a rename is a bulk data migration).
    slug: string;

    // Display name, freely renameable ('verb animate intransitive').
    name: string;

    // Presentation grouping ('Verbs', 'Nouns', 'Other').
    theme?: string;

    // Longer public-facing description of the form.
    description?: string;

    // Internal guidance for editors (when to use which form).
    tagger_notes?: string;

    // Retired forms stay valid for display/history but are not offered in
    // pickers.
    retired: boolnum;

    // Global presentation order (liminal/orderkey.ts).
    order_key: string;
}
export type LexicalFormOpt = Partial<LexicalForm>;

export class LexicalFormTable extends Table<LexicalForm> {

    // The app back-reference (same pattern as CategoryTable): the detail
    // page reaches across into the assertion world (subentries using this
    // form, the remove verb via app.lexemeOps).
    constructor(private app?: WordWiki) {
        super('lexical_form', [
            new PrimaryKeyField('lexical_form_id', {}),
            new LexicalFormSlugField('slug', {indexed: true, unique: true, edit: onCreateOnly,
                                              prompt: 'Slug (stable code used in entries - cannot be changed later)'}),
            new StringField('name', {prompt: 'Display name'}),
            new StringField('theme', {nullable: true}),
            new MarkdownField('description', {nullable: true,
                                            prompt: 'Description (public: what this form means)'}),
            new MarkdownField('tagger_notes', {nullable: true,
                                             prompt: 'Editor notes (internal: when to use this form)'}),
            new BooleanField('retired', {default: 0,
                                         prompt: 'Retired (not offered in pickers)'}),
            new ManagedStringField('order_key', {default: ''}),
        ]);
    }

    // Same policy as categories: open-books viewing; only
    // 'edit-lexical-forms' holders (admin implies) change the vocabulary.
    defaultFieldView: security.Permission = security.loggedIn;
    defaultFieldEdit: security.Permission = editLexicalForms;
    override get recordEdit(): security.Permission { return editLexicalForms; }

    override formTitle(f: LexicalForm): string {
        return f.lexical_form_id ? `Edit ${f.name || f.slug || 'lexical form'}` : 'New lexical form';
    }

    override insert<P extends Partial<LexicalForm>>(tuple: P): number {
        if(typeof tuple.slug !== 'string' || !LEXICAL_FORM_SLUG_PATTERN.test(tuple.slug))
            throw new Error(`Invalid lexical form slug '${tuple.slug}'`);
        const withManaged: any = {order_key: this.nextOrderKey(), ...tuple};
        return super.insert(withManaged);
    }

    private nextOrderKey(): string {
        const last = db().first<{k: string|null}>(
            'SELECT MAX(order_key) AS k FROM lexical_form', {});
        return orderkey.between(last?.k ?? undefined, undefined);
    }

    @path
    get bySlug() {
        return this.prepare<LexicalForm, {slug: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM lexical_form
/**/          WHERE slug = :slug`);
    }

    @path
    get allByOrder() {
        return this.prepare<LexicalForm, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM lexical_form
/**/          ORDER BY order_key, slug`);
    }

    // The picker source (for the lexeme editor's part-of-speech select).
    @path
    get activeByOrder() {
        return this.prepare<LexicalForm, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM lexical_form
/**/          WHERE retired = 0
/**/          ORDER BY order_key, slug`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the rabid UI standard) -----------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    renderLexicalFormsPage(): Markup {
        const canCreate = this.canEditRecord({} as LexicalForm);
        // Rare admin acts live in a quiet ☰, not prominent buttons (the
        // committee.ts list-header pattern).
        const menuItems: action.ActionMenuItem[] = [];
        if(canCreate)
            menuItems.push({label: 'New lexical form…',
                            mode: {kind: 'modal', dialogUrl: '/ww/wordwiki.lexicalForms.newDialog()'}});
        return ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-2'},
             ['h2', {class: 'mb-0'}, 'Lexical Form Table'],
             menuItems.length > 0
                 ? action.actionMenu(menuItems, {ariaLabel: 'Lexical form actions'})
                 : undefined],
            ['p', {class: 'text-muted'},
             'The controlled vocabulary for parts of speech / grammatical forms. ',
             'Slugs are the stable codes stored in the dictionary data; names are ',
             'display text.'],
            this.renderLexicalFormList(),
        ];
    }

    // A DATA TABLE, not flat blocks (design-language.md; modelled on rabid's
    // volunteers page): many uniform records you scan and compare, the theme
    // groups as colspan section rows within ONE aligned table.
    @route(authenticated)
    renderLexicalFormList(): Markup {
        const forms = this.allByOrder.all({});
        const props = this.reloadableItemProps(undefined, `/ww/wordwiki.lexicalForms.renderLexicalFormList()`);
        if(forms.length === 0)
            return ['div', props,
                ['p', {class: 'text-muted'},
                 'No lexical forms yet (run ./wordwiki.sh seed-lexical-forms).']];
        const sectionHeading = (title: string): Markup =>
            ['tr', {class: 'lm-data-section'}, ['td', {colspan: '3'}, title]];
        return ['div', props,
            ['p', {class: 'text-muted small mb-2'},
             `${forms.length} ${plural(forms.length, 'lexical form')}`],
            ['table', {class: 'lm-data-table'},
             ['thead', {},
              ['tr', {},
               ['th', {}, 'Name'],
               ['th', {}, 'Slug'],
               ['th', {}, 'Description']]],
             ['tbody', {},
              groupByTheme(forms).map(group => [
                  sectionHeading(group.theme),
                  group.cats.map(f => this.renderLexicalFormRow(f))])]]];
    }

    // A navigable data-table row: the whole row drills in to the detail page
    // via the accent-coloured name; no row pencil - editing lives on the
    // detail page (dz: vocabulary edits are a big-deal operation - the extra
    // step is fine).  Reloadable tagging (outerHTML swap of the <tr>)
    // re-renders just this row after a save.
    renderLexicalFormRow(f: LexicalForm): Markup {
        const id = f.lexical_form_id;
        const item = this.reloadableItemProps(id, `/ww/wordwiki.lexicalForms.renderLexicalFormRowById(${id})`);
        item.class = 'lm-navigable ' + item.class;
        item.onclick = 'lmNavigableClick(event)';
        return ['tr', {...item, 'data-testid': `lexical-form-row-${id}`},
            ['td', {},
             ['a', {...templates.pageLinkProps(`/ww/wordwiki.lexicalForms.detailPage(${id})`),
                    class: 'lm-nav-link'}, f.name || f.slug],
             isInternalCategorySlug(f.slug)
                 ? ['span', {class: 'badge text-bg-secondary ms-2'}, 'internal'] : undefined,
             f.retired ? ['span', {class: 'badge text-bg-secondary ms-2'}, 'Retired'] : undefined],
            ['td', {class: 'text-muted'}, f.slug],
            ['td', {class: 'text-muted'}, f.description ?? ''],
        ];
    }

    @route(authenticated)
    renderLexicalFormRowById(id: number): Markup {
        return this.renderLexicalFormRow(this.getById(id));
    }

    // ------------------------------------------------------------------------
    // --- Lexical form detail page --------------------------------------------
    // ------------------------------------------------------------------------

    // Full page for one lexical form (navigated to by tapping the list row).
    // For now the same info as the row, plus the pencil; domain-specific
    // detail (entries using this form, usage stats, ...) comes later.
    @route(authenticated)
    detailPage(lexical_form_id: number): templates.Page {
        const f = this.getById(lexical_form_id);
        return templates.page(`${f.name || f.slug} — Lexical Form`, this.renderDetail(lexical_form_id));
    }

    // The detail body, as a reloadable fragment (an edit save re-renders it).
    @route(authenticated)
    renderDetail(lexical_form_id: number): Markup {
        const f = this.getById(lexical_form_id);
        const props = this.reloadableItemProps(lexical_form_id, `/ww/wordwiki.lexicalForms.renderDetail(${lexical_form_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [['dt', {class: 'col-sm-3'}, label], ['dd', {class: 'col-sm-9'}, value]];
        return ['div', props,
            ['div', {class: 'd-flex align-items-center gap-2 mb-3'},
             ['h2', {class: 'mb-0'}, f.name || f.slug],
             isInternalCategorySlug(f.slug)
                 ? ['span', {class: 'badge text-bg-secondary'}, 'internal'] : undefined,
             f.retired ? ['span', {class: 'badge text-bg-secondary'}, 'Retired'] : undefined,
             this.canEditRecord(f) ? this.editPencil(lexical_form_id) : undefined],
            ['dl', {class: 'row mb-0'},
             row('Slug', f.slug),
             row('Theme', f.theme || '—'),
             row('Description', f.description ? this.fieldsByName.description.render(f.description) : '—'),
             row('Editor notes', f.tagger_notes ? this.fieldsByName.tagger_notes.render(f.tagger_notes) : '—'),
            ],
            this.renderFormSubentries(f),
        ];
    }

    // ------------------------------------------------------------------------
    // --- Subentries with this form (the assertion world) ---------------------
    // ------------------------------------------------------------------------

    // Unlike a category (a child tuple), the part of speech is a FIELD of
    // the subentry - so the rows here are SUBENTRIES (an entry can appear
    // once per subentry).  Deliberately NO remove button (unlike the
    // category detail page): clearing a part of speech is not a meaningful
    // curation act - a wrong POS gets FIXED, in the lexeme editor the row
    // navigates to.

    // ALL entries' subentries - including unpublished entries (curation
    // page).  Sorted by spelling.
    private subentriesForSlug(slug: string): {e: entrySchema.Entry, s: any}[] {
        if(!this.app) return [];
        const rows = Array.from(this.app.entriesById.values())
            .flatMap(e => e.subentry
                .filter(s => s.part_of_speech === slug)
                .map(s => ({e, s})));
        return rows.sort((a, b) => nameCollator.compare(
            entrySchema.renderEntrySpellingsSummary(a.e),
            entrySchema.renderEntrySpellingsSummary(b.e)));
    }

    private renderFormSubentries(f: LexicalForm): Markup {
        if(!this.app) return undefined;
        const rows = this.subentriesForSlug(f.slug);
        return [
            ['h4', {class: 'mt-4 mb-2'}, `Subentries (${rows.length})`],
            rows.length === 0
                ? ['p', {class: 'text-muted'}, 'No subentries carry this form.']
                : ['div', {class: 'list-group lm-list'},
                   rows.map(({e, s}) => this.renderFormSubentryRow(f, e, s))]];
    }

    private renderFormSubentryRow(_f: LexicalForm, e: entrySchema.Entry, s: any): Markup {
        const spelling = entrySchema.renderEntrySpellingsSummary(e);
        const glosses = s.gloss.map((g: any) => g.gloss).filter(Boolean).join(' / ');
        return ['div', {class: 'list-group-item lm-item d-flex align-items-center'},
            ['div', {class: 'lm-item-body'},
             ['div', {class: 'lm-item-primary'},
              ['a', {...templates.pageLinkProps(`/ww/wordwiki.wordView(${e.entry_id})`),
                     class: 'lm-nav-link'}, spelling]],
             ['div', {class: 'lm-item-secondary'}, glosses]],
        ];
    }

    @route(editLexicalForms)
    newDialog(): Markup {
        return this.renderForm({} as LexicalForm);
    }
}

// --------------------------------------------------------------------------------
// --- Seeding ---------------------------------------------------------------------
// --------------------------------------------------------------------------------

/**
 * The curated initial vocabulary: the entry-schema partsOfSpeech label map
 * (which stays, for now, as the public renderer's label source - same
 * arrangement as the users map) plus the sane codes seen in the data that
 * the map lacked (loc, voc).  The junk tail ('vai  PL', '??', 'Wp ini'...)
 * is deliberately NOT seeded - those values remain visible-but-unoffered in
 * the editor until each is fixed.
 */
export const SEED_LEXICAL_FORMS: Array<{slug: string, name: string, theme: string}> = [
    {slug: 'na',           name: 'noun animate',                theme: 'Nouns'},
    {slug: 'ni',           name: 'noun inanimate',              theme: 'Nouns'},
    {slug: 'n',            name: 'noun',                        theme: 'Nouns'},
    {slug: 'vai',          name: 'verb animate intransitive',   theme: 'Verbs'},
    {slug: 'vii',          name: 'verb inanimate intransitive', theme: 'Verbs'},
    {slug: 'vat',          name: 'verb animate transitive',     theme: 'Verbs'},
    {slug: 'vit',          name: 'verb inanimate transitive',   theme: 'Verbs'},
    {slug: 'PTCL',         name: 'particle',                    theme: 'Other'},
    {slug: 'adv',          name: 'adverb',                      theme: 'Other'},
    {slug: 'pn',           name: 'pronoun',                     theme: 'Other'},
    {slug: 'pna',          name: 'pronoun animate',             theme: 'Other'},
    {slug: 'pni',          name: 'pronoun inanimate',           theme: 'Other'},
    {slug: 'loc',          name: 'locative',                    theme: 'Other'},
    {slug: 'voc',          name: 'vocative',                    theme: 'Other'},
    {slug: 'unclassified', name: 'unclassified part of speech', theme: 'Other'},
];

// Idempotent: existing slugs are left untouched (re-run freely; also the
// production-import prototype, like the category seeding).
export function seedLexicalForms(forms: LexicalFormTable): {inserted: number, skipped: number} {
    let inserted = 0, skipped = 0;
    for(const f of SEED_LEXICAL_FORMS) {
        if(forms.bySlug.first({slug: f.slug})) { skipped++; continue; }
        forms.insert({...f, retired: 0});
        inserted++;
    }
    return {inserted, skipped};
}
