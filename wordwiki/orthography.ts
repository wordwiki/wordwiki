// deno-lint-ignore-file no-explicit-any
/**
 * The ORTHOGRAPHY table — the controlled vocabulary of writing systems, a
 * peer of the lexical-form and category tables (dz 2026-07-07): "I want to
 * gradually reduce the specific language hacks" — this system is heading
 * toward other language-preservation projects, so which orthographies exist,
 * their display names, and whether words may GO PUBLIC in them are DATA, not
 * code.  The old hard-coded `entrySchema.variants` map survives only as the
 * seed (and as a fallback while a db is unseeded).
 *
 * `publishable`: may a word be made public in this orthography?  Listuguj
 * and Smith-Francis yes; Modified Pacifique and the Pacifique Manuscript are
 * the archaic source-material orthographies — content in them is real and
 * editable, but they are never publish targets, so the Public row and the
 * makePublic verb consult this flag instead of a hard-coded filter.
 *
 * The 'mm' wildcard is deliberately NOT a row: it is MODEL semantics
 * (variant-policy.ts variantMatches / the $allowAll flag), not a writing
 * system — selects offer it only where the schema grants $allowAll.
 *
 * Slugs are the stable codes stored in assertion data (`variant` columns) —
 * create-only, like usernames and lexical-form slugs.
 */
import { Table, PrimaryKeyField, BooleanField, StringField } from "../liminal/table.ts";
import { db } from "../liminal/db.ts";
import { path } from "../liminal/serializable.ts";
import { block, plural } from "../liminal/strings.ts";
import { Markup } from "../liminal/markup.ts";
import * as security from "../liminal/security.ts";
import { route, authenticated } from "../liminal/security.ts";
import * as action from "../liminal/action.ts";
import * as orderkey from "../liminal/orderkey.ts";
import * as templates from './templates.ts';
import * as entrySchema from './entry-schema.ts';
import type { WordWiki } from './wordwiki.ts';

const admin = security.hasRole('admin');
// Vocabulary curation is its own grant, admin implies (the lexical-forms /
// categories convention).
const editOrthographies = security.or(security.hasRole('edit-orthographies'), admin);

export const ORTHOGRAPHY_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

// A column managed by the table code (the global ordering): hidden from the
// generic record form; insert() supplies it (the lexical-form pattern).
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

export interface Orthography {
    orthography_id: number;
    /** The stable code stored in the assertion data's variant columns. */
    slug: string;
    name: string;
    /** The QUIET marker shown beside a text in multi-orthography contexts
     *  (the editor's side-by-side rows) - two letters, e.g. 'Li'. */
    abbreviation?: string;
    /** May a word be made public in this orthography?  (The Public row and
     *  makePublic consult this - archaic source orthographies say no.) */
    publishable: number;
    /** The published EDITION's maturity: 'full' or 'preview'.  ONE
     *  editorial judgment that drives every public-site consequence of an
     *  edition being young (multi-ortho-publish.md: no per-feature flags):
     *  a 'preview' edition carries the preview banner, elides home search
     *  (a dead-end machine until there are enough words), and cross-links
     *  the primary edition's book sections instead of publishing its own
     *  (its lane has almost no public words for the scan links to land
     *  on).  Defaults 'preview': a new orthography is by definition
     *  young; the staff flip it to 'full' when the edition is complete
     *  enough. */
    edition: string;
    /** Not offered for new content (existing values keep displaying). */
    retired: number;
    order_key: string;
}
export type OrthographyOpt = Partial<Orthography>;

export class OrthographyTable extends Table<Orthography> {

    constructor(private app?: WordWiki) {
        super('orthography', [
            new PrimaryKeyField('orthography_id', {}),
            new StringField('slug', {indexed: true, unique: true,
                                     edit: a => editOrthographies(a) && !(a.record as Orthography|undefined)?.orthography_id,
                                     prompt: 'Slug (stable code stored in dictionary data - cannot be changed later)'}),
            new StringField('name', {prompt: 'Display name'}),
            new StringField('abbreviation', {nullable: true,
                                             prompt: 'Abbreviation (the tiny marker beside texts, e.g. Li)'}),
            new StringField('edition', {default: 'preview',
                prompt: "Edition maturity: 'full' or 'preview' (a preview edition gets the banner, " +
                        "no public search, and books cross-linked to the primary edition)"}),
            new BooleanField('publishable', {default: 0,
                                             prompt: 'Publishable (words can be made public in this orthography)'}),
            new BooleanField('retired', {default: 0,
                                         prompt: 'Retired (not offered in pickers)'}),
            new ManagedStringField('order_key', {default: ''}),
        ]);
    }

    defaultFieldView: security.Permission = security.loggedIn;
    defaultFieldEdit: security.Permission = editOrthographies;
    override get recordEdit(): security.Permission { return editOrthographies; }

    override formTitle(o: Orthography): string {
        return o.orthography_id ? `Edit ${o.name || o.slug || 'orthography'}` : 'New orthography';
    }

    override insert<P extends Partial<Orthography>>(tuple: P): number {
        if(typeof tuple.slug !== 'string' || !ORTHOGRAPHY_SLUG_PATTERN.test(tuple.slug))
            throw new Error(`Invalid orthography slug '${tuple.slug}'`);
        if(tuple.slug === 'mm')
            throw new Error(`'mm' is the all-orthographies wildcard (model semantics), not a table row`);
        const withManaged: any = {order_key: this.nextOrderKey(), ...tuple};
        return super.insert(withManaged);
    }

    private nextOrderKey(): string {
        const last = db().first<{k: string|null}>(
            'SELECT MAX(order_key) AS k FROM orthography', {});
        return orderkey.between(last?.k ?? undefined, undefined);
    }

    @path
    get bySlug() {
        return this.prepare<Orthography, {slug: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM orthography
/**/          WHERE slug = :slug`);
    }

    @path
    get allByOrder() {
        return this.prepare<Orthography, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM orthography
/**/          ORDER BY order_key, slug`);
    }

    /** The publish targets (the Public row / makePublic source). */
    @path
    get publishableByOrder() {
        return this.prepare<Orthography, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM orthography
/**/          WHERE retired = 0 AND publishable = 1
/**/          ORDER BY order_key, slug`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the rabid UI standard) -----------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    renderOrthographiesPage(): Markup {
        const canCreate = this.canEditRecord({} as Orthography);
        const menuItems: action.ActionMenuItem[] = [];
        if(canCreate)
            menuItems.push({label: 'New orthography…',
                            mode: {kind: 'modal', dialogUrl: '/ww/wordwiki.orthographies.newDialog()'}});
        return ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-2'},
             ['h2', {class: 'mb-0'}, 'Orthography Table'],
             menuItems.length > 0
                 ? action.actionMenu(menuItems, {ariaLabel: 'Orthography actions'})
                 : undefined],
            ['p', {class: 'text-muted'},
             'The writing systems of the dictionary. Slugs are the stable codes ',
             'stored in the data; PUBLISHABLE orthographies are the ones words ',
             'can be made public in (archaic source orthographies are not).'],
            this.renderOrthographyList(),
        ];
    }

    @route(authenticated)
    renderOrthographyList(): Markup {
        const rows = this.allByOrder.all({});
        const props = this.reloadableItemProps(undefined, `/ww/wordwiki.orthographies.renderOrthographyList()`);
        if(rows.length === 0)
            return ['div', props,
                ['p', {class: 'text-muted'}, 'No orthographies yet (they seed at server start).']];
        return ['div', props,
            ['p', {class: 'text-muted small mb-2'},
             `${rows.length} ${plural(rows.length, 'orthography', 'orthographies')}`],
            ['table', {class: 'lm-data-table'},
             ['thead', {},
              ['tr', {},
               ['th', {}, 'Name'],
               ['th', {}, 'Slug'],
               ['th', {}, 'Publishable']]],
             ['tbody', {}, rows.map(o => this.renderOrthographyRow(o))]]];
    }

    renderOrthographyRow(o: Orthography): Markup {
        const id = o.orthography_id;
        const item = this.reloadableItemProps(id, `/ww/wordwiki.orthographies.renderOrthographyRowById(${id})`);
        item.class = 'lm-navigable ' + item.class;
        item.onclick = 'lmNavigableClick(event)';
        return ['tr', {...item, 'data-testid': `orthography-row-${id}`},
            ['td', {},
             ['a', {...templates.pageLinkProps(`/ww/wordwiki.orthographies.detailPage(${id})`),
                    class: 'lm-nav-link'}, o.name || o.slug],
             o.retired ? ['span', {class: 'badge text-bg-secondary ms-2'}, 'Retired'] : undefined],
            ['td', {class: 'text-muted'}, o.slug],
            ['td', {class: 'text-muted'}, o.publishable ? 'Yes' : '—'],
        ];
    }

    @route(authenticated)
    renderOrthographyRowById(id: number): Markup {
        return this.renderOrthographyRow(this.getById(id));
    }

    @route(authenticated)
    detailPage(orthography_id: number): templates.Page {
        const o = this.getById(orthography_id);
        return templates.page(`${o.name || o.slug} — Orthography`, this.renderDetail(orthography_id));
    }

    @route(authenticated)
    renderDetail(orthography_id: number): Markup {
        const o = this.getById(orthography_id);
        const props = this.reloadableItemProps(orthography_id, `/ww/wordwiki.orthographies.renderDetail(${orthography_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [['dt', {class: 'col-sm-3'}, label], ['dd', {class: 'col-sm-9'}, value]];
        return ['div', props,
            ['div', {class: 'd-flex align-items-center gap-2 mb-3'},
             ['h2', {class: 'mb-0'}, o.name || o.slug],
             o.retired ? ['span', {class: 'badge text-bg-secondary'}, 'Retired'] : undefined,
             this.canEditRecord(o) ? this.editPencil(orthography_id) : undefined],
            ['dl', {class: 'row mb-0'},
             row('Slug', o.slug),
             row('Publishable', o.publishable ? 'Yes - words can be made public in it' : 'No'),
            ]];
    }
}

// --------------------------------------------------------------------------
// --- Seed + fallback helpers ------------------------------------------------
// --------------------------------------------------------------------------

/** The seed rows (from the old hard-coded map; dz-confirmed publishable
 *  flags): the two living orthographies are publish targets; the two archaic
 *  Pacifique source orthographies are not. */
export const SEED_ORTHOGRAPHIES: Array<{slug: string, name: string, abbreviation: string,
                                        publishable: number, edition: string}> = [
    // edition: Listuguj is the mature full edition; the young Smith-Francis
    // edition publishes as a 'preview' (banner, no public search, books
    // cross-linked to the primary) until the staff flip it (dz 2026-07-09).
    { slug: 'mm-li', name: 'Listuguj',             abbreviation: 'Li', publishable: 1, edition: 'full' },
    { slug: 'mm-sf', name: 'Smith-Francis',        abbreviation: 'SF', publishable: 1, edition: 'preview' },
    { slug: 'mm-mp', name: 'Modified Pacifique',   abbreviation: 'MP', publishable: 0, edition: 'preview' },
    { slug: 'mm-pm', name: 'Pacifique Manuscript', abbreviation: 'PM', publishable: 0, edition: 'preview' },
];

/** Idempotent seed (insert-if-missing; never overwrites an edited row - but
 *  a NULL abbreviation on an existing row is backfilled, so rows created by
 *  an earlier seed version gain the column's seed value).  Called at every
 *  ensure (reads first, so a fully seeded db sees no writes). */
export function seedOrthographies(table: OrthographyTable): {inserted: number} {
    let inserted = 0;
    for(const seed of SEED_ORTHOGRAPHIES) {
        const existing = table.bySlug.first({slug: seed.slug});
        if(existing) {
            if(existing.abbreviation == null)
                table.updateNamedFields(existing.orthography_id,
                    ['abbreviation'], {abbreviation: seed.abbreviation} as any);
            continue;
        }
        table.insert({...seed, retired: 0});
        inserted++;
    }
    return {inserted};
}

/** The variant-value vocabulary for the scan/validator: every table slug +
 *  the 'mm' wildcard.  Falls back to the seed map while a db is unseeded
 *  (early migrations, minimal tests). */
export function orthographyVocabulary(table: OrthographyTable): string[] {
    const slugs = table.allByOrder.all({}).map(o => o.slug);
    return slugs.length > 0 ? [...slugs, 'mm'] : Object.keys(entrySchema.variants);
}

/** Display name for an orthography slug, table-first with the seed map (and
 *  the raw slug) as fallbacks - for reports and read-only rendering. */
export function orthographyDisplayName(table: OrthographyTable, slug: string): string {
    return table.bySlug.first({slug})?.name ?? entrySchema.variants[slug] ?? slug;
}
