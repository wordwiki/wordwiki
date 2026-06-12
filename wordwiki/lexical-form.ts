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
import { Table, PrimaryKeyField, BooleanField, StringField } from "../liminal/table.ts";
import { path } from "../liminal/serializable.ts";
import { block } from "../liminal/strings.ts";
import { Markup } from "../liminal/markup.ts";
import * as action from "../liminal/action.ts";
import * as security from "../liminal/security.ts";
import * as orderkey from "../liminal/orderkey.ts";
import { groupByTheme, isInternalCategorySlug } from "./category.ts";

const admin = security.hasRole('admin');

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
    admin(a) && !(a.record as LexicalForm|undefined)?.lexical_form_id;

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

    constructor() {
        super('lexical_form', [
            new PrimaryKeyField('lexical_form_id', {}),
            new LexicalFormSlugField('slug', {indexed: true, unique: true, edit: onCreateOnly,
                                              prompt: 'Slug (stable code used in entries - cannot be changed later)'}),
            new StringField('name', {prompt: 'Display name'}),
            new StringField('theme', {nullable: true}),
            new StringField('description', {nullable: true,
                                            prompt: 'Description (public: what this form means)'}),
            new StringField('tagger_notes', {nullable: true,
                                             prompt: 'Editor notes (internal: when to use this form)'}),
            new BooleanField('retired', {default: 0,
                                         prompt: 'Retired (not offered in pickers)'}),
            new ManagedStringField('order_key', {default: ''}),
        ]);
    }

    // Same policy as categories: open-books viewing, admin-only vocabulary.
    defaultFieldView: security.Permission = security.loggedIn;
    defaultFieldEdit: security.Permission = admin;
    override get recordEdit(): security.Permission { return admin; }

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

    renderLexicalFormsPage(): Markup {
        const canCreate = this.canEditRecord({} as LexicalForm);
        return ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-2'},
             ['h2', {class: 'mb-0'}, 'Lexical Form Table'],
             canCreate
                 ? action.actionButton('New lexical form',
                     {kind: 'modal', dialogUrl: '/ww/wordwiki.lexicalForms.newDialog()'},
                     'btn btn-outline-primary btn-sm')
                 : undefined],
            ['p', {class: 'text-muted'},
             'The controlled vocabulary for parts of speech / grammatical forms. ',
             'Slugs are the stable codes stored in the dictionary data; names are ',
             'display text.'],
            this.renderLexicalFormList(),
        ];
    }

    renderLexicalFormList(): Markup {
        const forms = this.allByOrder.all({});
        const props = this.reloadableItemProps(undefined, `/ww/wordwiki.lexicalForms.renderLexicalFormList()`);
        if(forms.length === 0)
            return ['div', props,
                ['p', {class: 'text-muted'},
                 'No lexical forms yet (run ./wordwiki.sh seed-lexical-forms).']];
        return ['div', props,
            groupByTheme(forms).map(group => [
                ['h5', {class: 'mt-3 mb-1'}, group.theme],
                ['div', {class: 'list-group lm-list'},
                 group.cats.map(f => this.renderLexicalFormRow(f))]])];
    }

    renderLexicalFormRow(f: LexicalForm): Markup {
        const id = f.lexical_form_id;
        const secondary = [f.slug,
                           f.retired ? 'retired' : '',
                           f.description ?? '']
            .filter(Boolean).join(' · ');
        const body =
            ['div', {class: 'lm-item-body'},
             ['div', {class: 'lm-item-primary'},
              f.name || f.slug,
              isInternalCategorySlug(f.slug)
                  ? ['span', {class: 'badge text-bg-secondary ms-2'}, 'internal'] : undefined],
             ['div', {class: 'lm-item-secondary'}, secondary]];

        // Pencil-only editing: no detail page yet, so the row surface is inert
        // (no whole-surface tap; cf. the navigable species Table.detailItemProps
        // used where a detail page exists).  Reloadable tagging re-renders just
        // this item after an edit save.
        const props = this.reloadableItemProps(id, `/ww/wordwiki.lexicalForms.renderLexicalFormRowById(${id})`);
        props.class = 'list-group-item lm-item ' + props.class;
        return ['div', {...props, 'data-testid': `lexical-form-row-${id}`},
            body, this.canEditRecord(f) ? this.editPencil(id) : undefined];
    }

    renderLexicalFormRowById(id: number): Markup {
        return this.renderLexicalFormRow(this.getById(id));
    }

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
