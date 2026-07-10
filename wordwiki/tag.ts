// deno-lint-ignore-file no-explicit-any
/**
 * The TAG table — the controlled vocabulary of the entry tagging model
 * (dz 2026-07-10: the old fixed TODO enum, generalized).  Same shape as the
 * category/orthography vocabularies: slugs are the stable codes stored in
 * assertion data (create-only), display names rename freely, retired rows
 * stay valid for history but leave the pickers.
 *
 * THE CHARTER (which label mechanism is which - keep these from blurring):
 *   - categories : PUBLIC classification of meaning (two-level, table)
 *   - tag        : INTERNAL editorial classification + workflow (this table;
 *                  internal audience, stripped from the public bundle)
 *   - attr       : the keyed bag of PUBLIC word facts (borrowed-word)
 *   - status     : whole-lexeme lifecycle (load-bearing; not tags)
 *
 * `is_todo`: tags so marked DRIVE THE TODO SYSTEM (the todo report, the
 * word view's open-todos list, the dock's quick-post) - like `publishable`
 * on the orthography table, a behavior flag in plain sight.
 *
 * ZERO DATA MIGRATION by design: the storage tag stays 'tdo' and the seed
 * rows use the old enum codes as their slugs, so existing assertions are
 * reinterpreted, not rewritten.
 */
import { Table, PrimaryKeyField, BooleanField, StringField, MarkdownField } from "../liminal/table.ts";
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
// Vocabulary curation is its own grant, admin implies (the categories /
// lexical-forms / orthographies convention).
const editTags = security.or(security.hasRole('edit-tags'), admin);

// The old enum codes are grandfathered as slugs (CamelCase) so existing
// assertion values resolve without a rewrite; NEW tags use kebab-case by
// convention (not enforced - the ship sailed with the seed).
export const TAG_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

export interface Tag {
    tag_id: number;
    /** The stable code stored in the assertion data (attr1 of 'tdo' rows).
     *  Create-only. */
    slug: string;
    name: string;
    /** Presentation grouping (the category-table pattern); optional while
     *  the vocabulary is small. */
    theme?: string;
    /** What this tag means / when to apply it. */
    description?: string;
    /** Does this tag DRIVE THE TODO SYSTEM (todo report, open-todos list)? */
    is_todo: number;
    /** Offered directly in the word's Tags ☰ quick-pick (the common tags),
     *  vs living behind "More…"'s full insert dialog.  Lets the vocabulary
     *  grow without a long menu. */
    quick: number;
    /** Not offered for new tagging (existing values keep displaying). */
    retired: number;
    order_key: string;
}
export type TagOpt = Partial<Tag>;

// A column managed by the table code (the global ordering): hidden from the
// generic record form; insert() supplies it (the vocabulary-table pattern).
class ManagedStringField extends StringField {
    override isVisible(): boolean { return false; }
}

export class TagTable extends Table<Tag> {

    constructor(private app?: WordWiki) {
        super('tag', [
            new PrimaryKeyField('tag_id', {}),
            new StringField('slug', {indexed: true, unique: true,
                                     edit: a => editTags(a) && !(a.record as Tag|undefined)?.tag_id,
                                     prompt: 'Slug (stable code stored in dictionary data - cannot be changed later)'}),
            new StringField('name', {prompt: 'Display name'}),
            new StringField('theme', {nullable: true,
                                      prompt: 'Theme (optional presentation grouping)'}),
            new MarkdownField('description', {nullable: true,
                                              prompt: 'Description (what this tag means / when to apply it)'}),
            new BooleanField('is_todo', {default: 0,
                                         prompt: 'Todo tag (drives the todo report and the open-todos list)'}),
            new BooleanField('quick', {default: 0,
                                       prompt: 'Quick-pick (offered directly in the word’s Tags menu)'}),
            new BooleanField('retired', {default: 0,
                                         prompt: 'Retired (not offered in pickers)'}),
            new ManagedStringField('order_key', {default: ''}),
        ]);
    }

    defaultFieldView: security.Permission = security.loggedIn;
    defaultFieldEdit: security.Permission = editTags;
    override get recordEdit(): security.Permission { return editTags; }

    override formTitle(t: Tag): string {
        return t.tag_id ? `Edit ${t.name || t.slug || 'tag'}` : 'New tag';
    }

    override insert<P extends Partial<Tag>>(tuple: P): number {
        if(typeof tuple.slug !== 'string' || !TAG_SLUG_PATTERN.test(tuple.slug))
            throw new Error(`Invalid tag slug '${tuple.slug}'`);
        const withManaged: any = {order_key: this.nextOrderKey(), ...tuple};
        return super.insert(withManaged);
    }

    private nextOrderKey(): string {
        const last = db().first<{k: string|null}>(
            'SELECT MAX(order_key) AS k FROM tag', {});
        return orderkey.between(last?.k ?? undefined, undefined);
    }

    @path
    get bySlug() {
        return this.prepare<Tag, {slug: string}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM tag
/**/          WHERE slug = :slug`);
    }

    @path
    get allByOrder() {
        return this.prepare<Tag, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM tag
/**/          ORDER BY order_key, slug`);
    }

    /** The word Tags ☰ quick-pick set: non-retired, quick-flagged. */
    @path
    get quickByOrder() {
        return this.prepare<Tag, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM tag
/**/          WHERE retired = 0 AND quick = 1
/**/          ORDER BY order_key, slug`);
    }

    /** The picker source (the lexeme editor's tag select). */
    @path
    get activeByOrder() {
        return this.prepare<Tag, {}>(block`
/**/   SELECT ${this.allFields}
/**/          FROM tag
/**/          WHERE retired = 0
/**/          ORDER BY order_key, slug`);
    }

    // ------------------------------------------------------------------------
    // --- Standard editable-item list (the rabid UI standard) -----------------
    // ------------------------------------------------------------------------

    @route(authenticated)
    renderTagsPage(): Markup {
        const canCreate = this.canEditRecord({} as Tag);
        const menuItems: action.ActionMenuItem[] = [];
        if(canCreate)
            menuItems.push({label: 'New tag…',
                            mode: {kind: 'modal', dialogUrl: '/ww/wordwiki.tags.newDialog()'}});
        return ['div', {class: 'container py-3'},
            ['div', {class: 'd-flex align-items-center gap-2 mb-2'},
             ['h2', {class: 'mb-0'}, 'Tag Table'],
             menuItems.length > 0
                 ? action.actionMenu(menuItems, {ariaLabel: 'Tag actions'})
                 : undefined],
            ['p', {class: 'text-muted'},
             'The editorial tagging vocabulary. Slugs are the stable codes ',
             'stored in the data; TODO tags drive the todo report and the ',
             'word view’s open-todos list.'],
            this.renderTagList(),
        ];
    }

    @route(authenticated)
    renderTagList(): Markup {
        const rows = this.allByOrder.all({});
        const props = this.reloadableItemProps(undefined, `/ww/wordwiki.tags.renderTagList()`);
        if(rows.length === 0)
            return ['div', props,
                ['p', {class: 'text-muted'}, 'No tags yet (they seed at server start).']];
        return ['div', props,
            ['p', {class: 'text-muted small mb-2'},
             `${rows.length} ${plural(rows.length, 'tag', 'tags')}`],
            ['table', {class: 'lm-data-table'},
             ['thead', {},
              ['tr', {},
               ['th', {}, 'Name'],
               ['th', {}, 'Slug'],
               ['th', {}, 'Theme'],
               ['th', {}, 'Todo'],
               ['th', {}, 'Quick']]],
             ['tbody', {}, rows.map(t => this.renderTagRow(t))]]];
    }

    renderTagRow(t: Tag): Markup {
        const id = t.tag_id;
        const item = this.reloadableItemProps(id, `/ww/wordwiki.tags.renderTagRowById(${id})`);
        item.class = 'lm-navigable ' + item.class;
        item.onclick = 'lmNavigableClick(event)';
        return ['tr', {...item, 'data-testid': `tag-row-${id}`},
            ['td', {},
             ['a', {...templates.pageLinkProps(`/ww/wordwiki.tags.detailPage(${id})`),
                    class: 'lm-nav-link'}, t.name || t.slug],
             t.retired ? ['span', {class: 'badge text-bg-secondary ms-2'}, 'Retired'] : undefined],
            ['td', {class: 'text-muted'}, t.slug],
            ['td', {class: 'text-muted'}, t.theme || '—'],
            ['td', {class: 'text-muted'}, t.is_todo ? 'Yes' : '—'],
            ['td', {class: 'text-muted'}, t.quick ? 'Yes' : '—'],
        ];
    }

    @route(authenticated)
    renderTagRowById(id: number): Markup {
        return this.renderTagRow(this.getById(id));
    }

    // The create dialog: the record form over an empty record (renderForm
    // gates on recordEdit server-side too).  Was MISSING (the 'New tag…'
    // menu 404'd) - the category/orthography tables each have this and it
    // is NOT inherited (routeterp only exposes declared members).
    @route(editTags)
    newDialog(): Markup {
        return this.renderForm({} as Tag);
    }

    @route(authenticated)
    detailPage(tag_id: number): templates.Page {
        const t = this.getById(tag_id);
        return templates.page(`${t.name || t.slug} — Tag`, this.renderDetail(tag_id));
    }

    // A reloadable fragment (an edit save re-renders it - the same
    // -tag-<id>- key the list row carries).
    @route(authenticated)
    renderDetail(tag_id: number): Markup {
        const t = this.getById(tag_id);
        const props = this.reloadableItemProps(tag_id, `/ww/wordwiki.tags.renderDetail(${tag_id})`);
        props.class = 'container py-3 ' + props.class;
        const row = (label: string, value: Markup) =>
            [['dt', {class: 'col-sm-3'}, label], ['dd', {class: 'col-sm-9'}, value]];
        return ['div', props,
            ['div', {class: 'd-flex align-items-center gap-2 mb-3'},
             ['h2', {class: 'mb-0'}, t.name || t.slug],
             t.is_todo ? ['span', {class: 'badge text-bg-primary'}, 'todo'] : undefined,
             t.retired ? ['span', {class: 'badge text-bg-secondary'}, 'Retired'] : undefined,
             this.canEditRecord(t) ? this.editPencil(tag_id) : undefined],
            ['dl', {class: 'row mb-0'},
             row('Slug', t.slug),
             row('Theme', t.theme || '—'),
             row('Todo', t.is_todo ? 'Yes - drives the todo report' : 'No'),
             row('Quick-pick', t.quick ? 'Yes - in the word Tags menu' : 'No'),
             row('Description', t.description ? this.fieldsByName.description.render(t.description) : '—'),
            ],
            this.renderTagEntries(t),
        ];
    }

    // ------------------------------------------------------------------------
    // --- Entries carrying this tag (the assertion world) ---------------------
    // ------------------------------------------------------------------------

    // ALL entries carrying this tag - unpublished included (a curation
    // page).  The value/assignee/done are shown so a todo tag reads as its
    // worklist.  Sorted by spelling.
    private entriesForSlug(slug: string): Array<{e: entrySchema.Entry, tags: entrySchema.Tag[]}> {
        if(!this.app) return [];
        const out: Array<{e: entrySchema.Entry, tags: entrySchema.Tag[]}> = [];
        for(const e of this.app.entriesById.values()) {
            const tags = e.tag.filter(t => t.tag === slug);
            if(tags.length > 0) out.push({e, tags});
        }
        return out.sort((a, b) => TAG_ENTRY_COLLATOR.compare(
            entrySchema.renderEntrySpellingsSummary(a.e),
            entrySchema.renderEntrySpellingsSummary(b.e)));
    }

    private renderTagEntries(t: Tag): Markup {
        if(!this.app) return undefined;
        const rows = this.entriesForSlug(t.slug);
        return [
            ['h4', {class: 'mt-4 mb-2'}, `Entries (${rows.length})`],
            rows.length === 0
                ? ['p', {class: 'text-muted'}, 'No entries carry this tag.']
                : ['div', {class: 'list-group lm-list'},
                   rows.map(({e, tags}) => {
                       const spelling = entrySchema.renderEntrySpellingsSummary(e);
                       const glosses = e.subentry.flatMap(s => s.gloss.map(g => g.gloss))
                           .filter(Boolean).join(' / ');
                       // The tag's own facts on this word (value / assignee /
                       // done) - what makes a todo tag read as a worklist.
                       const detail = tags.map(tag => [
                           tag.value || undefined,
                           tag.assigned_to && tag.assigned_to !== '___'
                               ? `→ ${entrySchema.displayUsername(tag.assigned_to)}` : undefined,
                           tag.done ? '✓ done' : undefined,
                       ].filter(Boolean).join('  ')).filter(Boolean).join(' ; ');
                       return ['div', {class: 'list-group-item lm-item'},
                           ['div', {class: 'lm-item-body'},
                            ['div', {class: 'lm-item-primary'},
                             ['a', {...templates.pageLinkProps(`/ww/wordwiki.wordView(${e.entry_id})`),
                                    class: 'lm-nav-link'}, spelling],
                             glosses ? ['span', {class: 'text-muted'}, ' — ', glosses] : undefined],
                            detail ? ['div', {class: 'lm-item-secondary text-muted'}, detail] : undefined]];
                   })]];
    }
}

const TAG_ENTRY_COLLATOR = new Intl.Collator('en', {sensitivity: 'base', numeric: true});

// --------------------------------------------------------------------------
// --- Seed -------------------------------------------------------------------
// --------------------------------------------------------------------------

/** The seed rows: the old fixed TODO kinds, slugs = the enum codes already
 *  stored in assertions (ZERO data migration - reinterpretation).  All
 *  todo-marked: the old model only had todos. */
export const SEED_TAGS: Array<{slug: string, name: string, is_todo: number, quick: number}> = [
    { slug: 'Todo',                     name: 'Todo',                        is_todo: 1, quick: 1 },
    { slug: 'NeedsResearchGroupReview', name: 'Needs Research Group Review', is_todo: 1, quick: 1 },
    { slug: 'NeedsSpeakerGroupReview',  name: 'Needs Speaker Group Review',  is_todo: 1, quick: 1 },
    { slug: 'NeedsRecording',           name: 'Needs Recording',             is_todo: 1, quick: 1 },
    { slug: 'NeedsApproval',            name: 'Needs Approval',              is_todo: 1, quick: 1 },
];

/** Idempotent seed (insert-if-missing; never overwrites an edited row).
 *  Called at every ensure - reads first, so a seeded db sees no writes. */
export function seedTags(table: TagTable): {inserted: number} {
    let inserted = 0;
    for(const seed of SEED_TAGS) {
        if(table.bySlug.first({slug: seed.slug})) continue;
        table.insert({...seed, retired: 0});
        inserted++;
    }
    return {inserted};
}

/** Display name for a tag slug, table-first with the old enum map (and the
 *  raw slug) as fallbacks - for reports and read-only rendering. */
export function tagDisplayName(table: TagTable, slug: string): string {
    return table.bySlug.first({slug})?.name ?? entrySchema.todos[slug] ?? slug;
}

/** The todo-marked slugs (the todo system's driving set); falls back to the
 *  old enum map while a db is unseeded. */
export function todoTagSlugs(table: TagTable): Set<string> {
    const rows = table.allByOrder.all({});
    if(rows.length === 0) return new Set(Object.keys(entrySchema.todos));
    return new Set(rows.filter(t => t.is_todo).map(t => t.slug));
}
