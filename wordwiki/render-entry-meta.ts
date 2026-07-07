// deno-lint-ignore-file no-explicit-any
/**
 * Metadata-driven lexeme renderer (EXPERIMENT).
 *
 * The public/read renderer in entry-schema.ts is hand-written: one bespoke
 * function per relation, with the presentation (order, labels, joins, the
 * headword+gloss title, the collapse-a-lone-subentry rule) baked into code.
 * This renderer instead WALKS THE SCHEMA (model.RelationField tree) and takes
 * every presentation decision from the field's `$view` metadata (model.ts
 * ViewStyle).  The goal: make the metadata rich enough that a new relation - or
 * a whole new language schema - renders as nicely with NO code change.
 *
 * Structure (see the design thread):
 *   - EntryRenderer is a CLASS: config is instance state, the render steps are
 *     (mostly protected) methods.  A future EDIT renderer subclasses it and
 *     overrides a few affordance hooks - "the editor is the read view + a few
 *     overrides".  $view stays separate from $shape (which drives the current
 *     editor) so evolving this never perturbs that.
 *   - Data access goes through a small SEAM (EntryNode): "child tuples of a
 *     relation under this node" and "scalar value of a field on this node".
 *     Today the only backend is JsonNode over the projected Entry JSON (also
 *     the ONLY thing the public static export has - no workspace).  A
 *     workspace-query backend (fact identity, for editor affordances / approval
 *     / history) drops in later WITHOUT touching the layout below.
 *
 * The core principle: `$view` is DECLARED INTENT; the render MODE decides how
 * far to honour it.  Read mode collapses singletons and elides empty sections;
 * a future edit mode keeps them (so add affordances show).
 */
import { Markup } from "../liminal/markup.ts";
import * as model from "./model.ts";
import { markdownToMarkup } from "../liminal/markdown.ts";
import * as audio from "./audio.ts";  // REMOVE_FOR_WEB

// --- Config ------------------------------------------------------------------

export interface EntryRenderConfig {
    rootPath: string;
    // 'internal' (the editor context) shows editorial content - notably ALL
    // keys of a keyed bag; 'public' shows only the configured public keys.
    audience?: "public" | "internal";
    mode?: "read";                 // future: "edit"
    // Which keys of a keyed-bag relation ($view.keyField) are shown to a
    // non-internal audience.  e.g. ['borrowed-word'].
    publicKeys?: string[];
    // Primitive renderer for the reference scan (a $shape:'boundingGroup'
    // field).  INJECTED because it needs a DB lookup (scan + the composed
    // reference-book link/description) that only exists server-side - keeping
    // it out of this module lets the renderer run on the public export too.
    // Given the bounding_group_id, return the full reference presentation.
    renderBoundingGroup?: (bounding_group_id: number) => Markup;
    // Optional affordance appended INSIDE the headword <h1> (the standard edit
    // pencil).  Context-specific, so injected - the public export passes none.
    titleAffordance?: Markup;
    // Display names for controlled-VOCABULARY values (category slugs,
    // part-of-speech codes): the vocab tables are dynamic, so static
    // $options can't know them - the app injects the lookup.  Return
    // undefined to fall through to the default rendering (incl. static
    // $options), so unknown/legacy values still show raw.
    valueLabel?: (f: model.ScalarField, value: any) => string | undefined;
    // EDIT MODE.  When present, the renderer stops honouring the read-only
    // conveniences (singleton collapse, empty elide, value joining) - see the
    // "declared intent, mode decides" principle - and hangs affordances off
    // each tuple / relation.  The affordance markup is BUILT BY THE EDITOR (it
    // owns the action + workspace machinery); the renderer only places it.
    editing?: EditingHooks;
}

/** Identity of a tuple in the versioned workspace - enough for the editor to
 *  build its affordances (edit dialog, insert, move, delete).  A JsonNode has
 *  none (read/export); a WorkspaceNode supplies it. */
export interface TupleIdentity {
    entryId: number;
    factId: number;
    parentFactId: number;
}

export interface EditingHooks {
    // Wrap a tuple's rendered value `body` as an editable surface: the standard
    // lm-editable click-to-edit + the row's ☰ menu (which carries Insert
    // before/after, so a non-empty relation needs no separate add affordance).
    tupleSurface: (rf: model.RelationField, id: TupleIdentity, body: Markup) => Markup;
    // The placeholder for an EMPTY relation: a quiet "<prompt> — empty" line
    // carrying an insert-first menu.  Keyed on the PARENT id + the child tag (no
    // fact exists yet), so it can add the first item.
    emptyRelation: (rf: model.RelationField, parentId: TupleIdentity) => Markup;
    // Optional extra affordance on a NON-EMPTY relation's section heading line
    // (only relations with $view label:'heading' have one).  For relations
    // whose add is NOT the generic insert dialog - the document reference's
    // per-book buttons, which launch the scanned-page tagger flow - this is
    // the only place an add can live: the rows themselves carry no + (a new
    // reference needs a book choice first).
    relationHead?: (rf: model.RelationField, parentId: TupleIdentity) => Markup;
    // Fine-grained refresh (meta-editor-refresh-design.md).  When present,
    // EVERY relation rendering is wrapped (the editor supplies a fragment
    // element registering the relation's SHAPE key with its own re-render
    // route) - including EMPTY and demoted-empty renderings, so an insert
    // into a currently-empty relation still finds its wrapper in the DOM.
    relationWrapper?: (rf: model.RelationField, parentId: TupleIdentity, body: Markup) => Markup;
    // Wraps the <h1> as its own fragment (the title collects headword/gloss
    // values from the whole tree - a titleRole edit dirties it).
    titleWrapper?: (body: Markup) => Markup;
}

// --- Data-access seam --------------------------------------------------------

/** A node in the entry tree - the entry root or a tuple.  It yields the child
 *  tuples of a relation and the scalar values of its fields.  Backends: JSON
 *  now; a versioned-workspace query later (which would also expose fact
 *  identity for the editor). */
export interface EntryNode {
    children(rf: model.RelationField): EntryNode[];
    value(f: model.Field): any;
    // Versioned identity (editor only); undefined for plain JSON.
    identity?(): TupleIdentity | undefined;
    // Per-tuple annotations (fix-orthographies.md): 'aside' is the public
    // qualifying text rendered next to the tuple's value; 'note' is the
    // internal annotation (editor audience only - the JSON projection never
    // carries it, so JsonNode naturally yields undefined for it).
    annotation?(name: 'aside' | 'note'): string | undefined;
}

/** Backend over the projected Entry JSON (relations are arrays keyed by field
 *  name; scalars are plain values). */
export class JsonNode implements EntryNode {
    constructor(private obj: any) {}
    children(rf: model.RelationField): EntryNode[] {
        const a = this.obj?.[rf.name];
        return Array.isArray(a) ? a.map(o => new JsonNode(o)) : [];
    }
    value(f: model.Field): any { return this.obj?.[(f as any).name]; }
    // Only the PUBLIC aside is projected (workspace TupleVersion.toJSON);
    // asking for the internal note is answered by its absence.
    annotation(name: 'aside' | 'note'): string | undefined {
        return name === 'aside' ? this.obj?.$aside ?? undefined : undefined;
    }
}

// --- Small pure helpers (no config) ------------------------------------------

function view(f: model.Field): model.ViewStyle { return f.style.$view ?? {}; }
function options(f: model.Field): Record<string, string> | undefined {
    return (f.style as any).$options;
}

/** The scalar fields that carry a tuple's displayable content: not the primary
 *  key, not the id link, not the orthography/variant selector. */
function contentScalars(rf: model.RelationField): model.ScalarField[] {
    return rf.scalarFields.filter(f =>
        !(f instanceof model.PrimaryKeyField) &&
        !(f instanceof model.IdField) &&
        !(f instanceof model.VariantField));
}

/** Child relations in presentation order (by $view.order, ties -> schema
 *  order).  Pure ordering - audience/mode visibility is the renderer's
 *  childRelations(). */
function orderedChildRelations(rf: model.RelationField): model.RelationField[] {
    return rf.relationFields
        .map((r, i) => [r, i] as const)
        .sort((a, b) => ((view(a[0]).order ?? 100) - (view(b[0]).order ?? 100)) || (a[1] - b[1]))
        .map(([r]) => r);
}

function isEmptyMarkup(m: Markup): boolean {
    return m === "" || m === undefined || m === null ||
        (Array.isArray(m) && m.every(isEmptyMarkup));
}

function intersperse(items: Markup[], sep: string): Markup[] {
    const out: Markup[] = [];
    items.forEach((it, i) => { if (i) out.push(sep); out.push(it); });
    return out;
}

/** 'borrowed-word' / 'shoebox_date' -> 'Borrowed word' / 'Shoebox date'. */
function humanise(key: string): string {
    const s = key.replace(/[-_]+/g, " ").trim();
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A markdown value is a `['div.lm-markdown', [blocks]]`.  When it's a SINGLE
 *  paragraph (the common plain-text case) return its inline children, so it
 *  reads on the label's line ("Note: text") instead of being bumped to the next
 *  line by the <p> block.  Genuine multi-block markdown returns undefined (the
 *  caller renders it as indented containment). */
function markdownInline(md: Markup): Markup | undefined {
    if (!Array.isArray(md) || md[0] !== "div") return undefined;
    const blocks = (md as any)[2];
    if (!Array.isArray(blocks) || blocks.length !== 1) return undefined;
    const p = blocks[0];
    return (Array.isArray(p) && p[0] === "p") ? p[2] : undefined;
}

const LINE = "lm-me-line";

// --- Renderer ----------------------------------------------------------------

export class EntryRenderer {
    readonly rootPath: string;
    readonly audience: "public" | "internal";
    readonly mode: "read";
    readonly publicKeys: Set<string>;
    readonly renderBoundingGroup?: (id: number) => Markup;
    readonly titleAffordance?: Markup;
    readonly editing?: EditingHooks;
    readonly valueLabel?: (f: model.ScalarField, value: any) => string | undefined;

    constructor(cfg: EntryRenderConfig) {
        this.rootPath = cfg.rootPath;
        this.audience = cfg.audience ?? "public";
        this.mode = cfg.mode ?? "read";
        this.publicKeys = new Set(cfg.publicKeys ?? []);
        this.renderBoundingGroup = cfg.renderBoundingGroup;
        this.titleAffordance = cfg.titleAffordance;
        this.editing = cfg.editing;
        this.valueLabel = cfg.valueLabel;
    }

    /** Child relations in presentation order, minus what this MODE and
     *  AUDIENCE may not see.  The EDITOR shows EVERYTHING (dz: all fields
     *  must be editable).  Read views drop $view.hidden (editorial: status /
     *  todo / notes / categories); the public read additionally drops
     *  audience:'internal' (the reference's editorial note - public_note is
     *  the public one). */
    protected childRelations(rf: model.RelationField): model.RelationField[] {
        return orderedChildRelations(rf).filter(cr => {
            if (this.editing) return true;
            const v = view(cr);
            if (v.hidden) return false;
            return this.audience === "internal" || v.audience !== "internal";
        });
    }

    /** Wrap a tuple's rendered value as an editable surface (edit mode), or
     *  return it plain (read).  `tuple` must carry identity in edit mode. */
    protected surface(rf: model.RelationField, tuple: EntryNode, body: Markup): Markup {
        const decorated = this.annotate(tuple, body);
        const id = this.editing && tuple.identity?.();
        return id ? this.editing!.tupleSurface(rf, id, decorated) : decorated;
    }

    /** Append the tuple's annotations to its rendered value: the public
     *  aside for every audience, the internal note only for the internal one
     *  (the editor).  They ride INSIDE the surface, so an annotation edit
     *  refreshes with the fact fragment like any value change. */
    protected annotate(tuple: EntryNode, body: Markup): Markup {
        const aside = tuple.annotation?.('aside');
        const note = this.audience === 'internal' ? tuple.annotation?.('note') : undefined;
        if (!aside && !note) return body;
        const extra: Markup[] = [];
        if (aside) extra.push(['span', { class: 'lm-me-aside' }, ' ', aside]);
        if (note) extra.push(['span', { class: 'lm-me-internal-note text-muted small' },
                              ' \u{1F512} ', note]);
        // Append into the body's own element so the annotations share the
        // value's line (the body is a block element for most tuple shapes).
        return Array.isArray(body) ? [...body, extra] : [body, extra];
    }

    /** The empty-relation placeholder (edit mode only): a quiet line + an
     *  insert-first menu, so an empty relation still shows its slot and a way
     *  to fill it - no per-relation "+" clutter. */
    protected emptyRelation(rf: model.RelationField, parent: EntryNode): Markup {
        const id = this.editing && parent.identity?.();
        return id ? this.editing!.emptyRelation(rf, id) : "";
    }

    /** Render one entry as a document, entirely from the schema + $view.
     *  `entryRelation` is the 'entry' RelationField; `node` wraps its data. */
    render(entryRelation: model.RelationField, node: EntryNode): Markup {
        return ["div", { class: "lm-meta-entry" },
                this.renderTitle(entryRelation, node),
                this.renderBody(entryRelation, node)];
    }

    /** The <h1> (headwords + glosses collected from the whole tree) - its own
     *  entry point so the editor's title FRAGMENT can re-render just it. */
    renderTitle(entryRelation: model.RelationField, node: EntryNode): Markup {
        const headwords = this.collectTitleValues(entryRelation, node, "headword");
        const glosses = this.collectTitleValues(entryRelation, node, "gloss");
        const title: Markup = ["h1", { class: "entry-scope" },
            headwords.join(" / "),
            glosses.length ? ["span", { class: "entry-gloss-title" }, " : " + glosses.join(" / ")] : "",
            this.titleAffordance ?? ""];
        return this.editing?.titleWrapper ? this.editing.titleWrapper(title) : title;
    }

    /** Every child relation in $view order, minus the hidden (editorial)
     *  relations - and, in READ mode only, minus the headword: title-only is
     *  a read convenience; the editor must still offer the spelling section
     *  (it stays in the title too). */
    protected renderBody(entryRelation: model.RelationField, node: EntryNode): Markup {
        return this.childRelations(entryRelation)
            .filter(cr => !!this.editing || view(cr).titleRole !== "headword")
            .map(cr => this.renderRelation(cr, node));
    }

    // --- scalars -------------------------------------------------------------

    /** A field's $view decoration (emphasis, wrap), applied wherever its value
     *  renders - including inside a compose. */
    protected decorate(f: model.Field, m: Markup): Markup {
        if (isEmptyMarkup(m)) return m;
        const v = view(f);
        let out: Markup = m;
        if (v.emphasis === "italic") out = ["i", {}, out];
        else if (v.emphasis === "bold") out = ["b", {}, out];
        if (v.wrap) out = [v.wrap[0], out, v.wrap[1]];
        return out;
    }

    /** A scalar VALUE (no label), dispatched by field type.  This is where "no
     *  code" pays off - a new field of an existing type just works. */
    protected renderScalarValue(f: model.ScalarField, value: any): Markup {
        if (value === null || value === undefined || value === "") return "";
        if (f instanceof model.AudioField)
            return audio.renderAudio(value, audio.audioPlayIcon, undefined, this.rootPath);
        if (f instanceof model.ImageField)
            return ["img", { src: this.rootPath + value, style: "max-width: 12rem; height: auto;" }];
        if (f.style.$shape === "boundingGroup")   // the reference scan (+ link)
            return this.renderBoundingGroup ? this.renderBoundingGroup(Number(value)) : "";
        // Injected controlled-vocabulary display names (category slugs,
        // part-of-speech codes) beat static $options - the vocab tables are
        // the live authority; undefined falls through.
        const injected = this.valueLabel?.(f, value);
        if (injected !== undefined) return this.decorate(f, injected);
        const opts = options(f);
        if (opts) return this.decorate(f, opts[String(value)] ?? String(value));  // code -> name
        if (f.style.$markdown) {
            const md = markdownToMarkup(String(value));
            const inline = markdownInline(md);
            // Plain text (a single paragraph): render on the label's line.
            // Genuine multi-block markdown: indented containment below the label.
            return inline !== undefined
                ? this.decorate(f, inline)
                : ["div", { class: "lm-me-mdblock" }, md];
        }
        return this.decorate(f, String(value));
    }

    /** A scalar as a label/value line (its own $view.label policy).  The line
     *  is a "block" for the vertical rhythm (see the CSS). */
    protected renderScalarField(f: model.ScalarField, node: EntryNode): Markup {
        const rendered = this.renderScalarValue(f, node.value(f));
        if (isEmptyMarkup(rendered)) {
            // EDIT mode: a value-less scalar still shows as "Prompt: empty"
            // (the empty-relation slot look).  dz: the new-lexeme skeleton's
            // subentry has no part of speech yet, and a surface whose only
            // scalar elides renders as a bare UNLABELLED line - confusing.
            // Read mode keeps eliding empties (documents); the reference
            // scan is structural, never "empty".
            if (!this.editing || f.style.$shape === "boundingGroup") return "";
            return ["div", { class: LINE }, ["b", {}, f.prompt + ": "],
                    ["span", { class: "text-muted fst-italic" }, "empty"]];
        }
        switch (view(f).label ?? "none") {
            case "inline":  return ["div", { class: LINE }, ["b", {}, f.prompt + ": "], rendered];
            case "heading": return ["div", { class: LINE }, ["div", { class: "fw-bold" }, f.prompt + ":"], rendered];
            default:        return ["div", { class: LINE }, rendered];
        }
    }

    // --- tuples --------------------------------------------------------------

    /** The inline VALUE of one tuple.  With $view.compose, lay out the named
     *  parts (scalars and/or child relations) in order, joined by $view.sep -
     *  the way an alternate form reads "form — gloss — (plural)".  Otherwise
     *  just the content scalars. */
    protected tupleInlineValue(rf: model.RelationField, tuple: EntryNode): Markup {
        const v = view(rf);
        if (v.compose) {
            const parts = v.compose.map(name => {
                const f = rf.modelFields.find(mf => mf.name === name);
                if (!f) return "";
                if (f instanceof model.RelationField) {
                    const items = tuple.children(f)
                        .map(t => this.tupleInlineValue(f, t))
                        .filter(m => !isEmptyMarkup(m));
                    return items.length ? intersperse(items, view(f).join ?? " / ") : "";
                }
                return this.renderScalarValue(f as model.ScalarField, tuple.value(f));
            }).filter(m => !isEmptyMarkup(m));
            return intersperse(parts, v.sep ?? " ");
        }
        const parts = contentScalars(rf)
            .map(f => this.renderScalarValue(f, tuple.value(f)))
            .filter(m => !isEmptyMarkup(m));
        return parts.length <= 1 ? (parts[0] ?? "") : intersperse(parts, " ");
    }

    /** One tuple as a block: its content scalars (each with its label policy)
     *  form the editable SURFACE (edit: click-to-edit + the ☰), then its child
     *  relations, recursively (separately editable). */
    protected renderTupleBlock(rf: model.RelationField, tuple: EntryNode): Markup {
        const children = this.childRelations(rf).map(cr => this.renderRelation(cr, tuple));
        return [this.containerScalarSurface(rf, tuple), children];
    }

    /** A container tuple's editable surface: its content scalars only (child
     *  relations are separate fragments OUTSIDE it). */
    protected containerScalarSurface(rf: model.RelationField, tuple: EntryNode): Markup {
        return this.surface(rf, tuple,
            contentScalars(rf).map(f => this.renderScalarField(f, tuple)));
    }

    /** A fields-less container tuple's surface: the heading line carries the ☰
     *  (there is no content line - see the fields-less branch below). */
    protected fieldslessHeading(rf: model.RelationField, tuple: EntryNode): Markup {
        return this.surface(rf, tuple,
            ["div", { class: "fw-bold lm-me-heading" }, rf.prompt + ":"]);
    }

    /** One tuple as a flat-list row (its own line, label policy honoured). */
    protected flatRow(rf: model.RelationField, tuple: EntryNode): Markup {
        const v = view(rf);
        const value = this.tupleInlineValue(rf, tuple);
        if (isEmptyMarkup(value)) return "";
        const body: Markup = (v.label === "inline")
            ? ["div", { class: LINE }, ["b", {}, rf.prompt + ": "], value]
            : ["div", { class: this.editing ? LINE : "lm-me-listitem" }, value];
        return this.surface(rf, tuple, body);
    }

    /** One keyed-bag row ("Key: value", labelled from the humanised key). */
    protected keyedBagRow(rf: model.RelationField, tuple: EntryNode): Markup {
        const keyF = rf.modelFields.find(f => f.name === view(rf).keyField);
        const valF = contentScalars(rf).find(f => f.name !== view(rf).keyField);
        if (!keyF || !valF) return "";
        const key = String(tuple.value(keyF) ?? "");
        const val = this.renderScalarValue(valF, tuple.value(valF));
        if (isEmptyMarkup(val) && !key) return "";
        return this.surface(rf, tuple, ["div", { class: LINE }, ["b", {}, humanise(key) + ": "], val]);
    }

    /** ONE tuple's editable surface, exactly as the walk builds it - the
     *  tuple FRAGMENT route's entry point.  Context-free by construction
     *  (meta-editor-refresh-design.md): everything comes from rf + the tuple;
     *  the sibling-dependent bits (the "1." markers) live OUTSIDE the
     *  surface, and anything that changes them is a shape event that
     *  re-renders the relation wrapper instead. */
    renderTupleSurfaceFor(rf: model.RelationField, tuple: EntryNode): Markup {
        const v = view(rf);
        if (v.keyField) return this.keyedBagRow(rf, tuple);
        // Mirrors renderRelationInner's dispatch: compose is read-only, so an
        // edit-mode composed container is a container here too.
        if ((v.compose && !this.editing) || orderedChildRelations(rf).length === 0)
            return this.flatRow(rf, tuple);
        if (this.editing && contentScalars(rf).length === 0) return this.fieldslessHeading(rf, tuple);
        return this.containerScalarSurface(rf, tuple);
    }

    // --- relations -----------------------------------------------------------

    /** A relation (a section): honours $view label / join / empty / singleton /
     *  compose / keyField.  `parent` is the node whose child tuples these are.
     *  In EDIT mode it stops collapsing / eliding / joining, wraps each tuple as
     *  an editable surface, and appends the add affordance.  With the
     *  relationWrapper hook, the WHOLE rendering (empty or not) is wrapped as
     *  the relation's shape-keyed fragment - this is also the relation
     *  FRAGMENT route's entry point. */
    renderRelation(rf: model.RelationField, parent: EntryNode): Markup {
        const inner = this.renderRelationInner(rf, parent);
        const id = this.editing?.relationWrapper && parent.identity?.();
        return id ? this.editing!.relationWrapper!(rf, id, inner) : inner;
    }

    protected renderRelationInner(rf: model.RelationField, parent: EntryNode): Markup {
        const v = view(rf);
        const editing = !!this.editing;
        const tuples = parent.children(rf);

        // A keyed bag (attr): each tuple is "Key: value", labelled from the key.
        if (v.keyField) return this.renderKeyedBag(rf, tuples, parent);

        // Empty: read elides (or a keep-stub); edit shows a quiet placeholder
        // (the slot + an insert-first menu) - unless the slot is DEMOTED to
        // the parent tuple's ☰ ($view emptyEdit:'menu'; rarely-used fields).
        if (tuples.length === 0) {
            if (!editing) return v.empty === "keep" ? ["div", { class: "lm-me-empty text-muted small" }, rf.prompt] : "";
            return v.emptyEdit === "menu" ? "" : this.emptyRelation(rf, parent);
        }

        // Singleton collapse: READ only (edit keeps the level so a 2nd can be added).
        if (v.singleton === "collapse" && tuples.length === 1 && !editing)
            return this.renderTupleBlock(rf, tuples[0]);

        // FLAT (no child relations) or COMPOSED relation: a list of inline
        // VALUES.  COMPOSE is a READ-mode convenience (like join/collapse):
        // in edit mode a composed relation WITH child relations falls through
        // to the container branch, so the composed-in children (an alternate
        // form's per-orthography texts) stay separately editable.
        if ((v.compose && !editing) || orderedChildRelations(rf).length === 0) {
            // Joined onto one line - READ only (edit needs each tuple editable).
            if (v.join !== undefined && !editing) {
                const items = tuples.map(t => this.tupleInlineValue(rf, t)).filter(m => !isEmptyMarkup(m));
                if (items.length === 0) return "";
                const joined = intersperse(items, v.join);
                return (v.label === "inline")
                    ? ["div", { class: LINE }, ["b", {}, rf.prompt + ": "], joined]
                    : ["div", { class: LINE }, joined];
            }
            // One line per tuple (each editable in edit).  With an inline label,
            // repeat it per line (several long glosses are unreadable joined).
            const lines = tuples.map(t => this.flatRow(rf, t))
                .filter(m => !isEmptyMarkup(m));
            // Non-empty needs no add line: the row ☰ carries Insert before/after.
            // Inline-labelled lists (gloss) stand alone; unlabelled (recordings)
            // get a heading section.
            return v.label === "inline" ? lines : this.section(rf, lines, parent);
        }

        // A FIELDS-LESS container (example): the tuple is pure structure -
        // no content scalars, so no content line.  In edit mode each tuple is
        // its own headed section with the tuple's ☰ ON the heading line (the
        // editor drops Edit/tap-to-edit: there is nothing to edit).  Without
        // this, the tuple renders a blank line whose only occupant is a
        // ragged ☰.  (Read mode needs no per-tuple anchor - the normal
        // section rendering below covers it.)
        if (editing && contentScalars(rf).length === 0) {
            return tuples.map(t =>
                ["div", { class: "lm-me-section" },
                 this.fieldslessHeading(rf, t),
                 ["div", { class: "ms-3" },
                  this.childRelations(rf).map(cr => this.renderRelation(cr, t))]]);
        }

        // CONTAINER relation (has child relations): each tuple is a block.
        // Number only when $view.numbered (senses), as a hanging marker.
        const numbered = v.numbered && tuples.length > 1;
        const items = tuples.map((t, i) => {
            const block = this.renderTupleBlock(rf, t);
            return numbered
                ? ["div", { class: "lm-me-item lm-me-numbered" },
                   ["span", { class: "lm-me-num fw-bold" }, `${i + 1}.`],
                   ["div", { class: "lm-me-num-body" }, block]]
                : ["div", { class: "lm-me-item" }, block];
        });
        return this.section(rf, items, parent);
    }

    /** A keyed-bag relation (attr): filter by audience, label each row by its
     *  humanised key.  Each row is an editable surface in edit mode. */
    protected renderKeyedBag(rf: model.RelationField, tuples: EntryNode[], parent: EntryNode): Markup {
        const keyF = rf.modelFields.find(f => f.name === view(rf).keyField);
        const valF = contentScalars(rf).find(f => f.name !== view(rf).keyField);
        if (!keyF || !valF) return "";
        const rows = tuples.filter(t => {
            if (this.audience === "internal") return true;
            return this.publicKeys.has(String(t.value(keyF)));
        }).map(t => this.keyedBagRow(rf, t)).filter(m => !isEmptyMarkup(m));
        // Empty (edit): the insert-first placeholder; non-empty needs no add line.
        if (rows.length === 0) return this.editing ? this.emptyRelation(rf, parent) : "";
        return rows;
    }

    /** A section: an optional bold heading, then the body indented.  In edit
     *  mode the heading line carries the relationHead affordance (the
     *  document-reference per-book add buttons). */
    protected section(rf: model.RelationField, body: Markup, parent?: EntryNode): Markup {
        const id = this.editing?.relationHead && parent?.identity?.();
        const head: Markup = id ? this.editing!.relationHead!(rf, id) : "";
        return view(rf).label === "heading"
            ? ["div", { class: "lm-me-section" },
               ["div", { class: "fw-bold lm-me-heading" }, rf.prompt + ":", head],
               ["div", { class: "ms-3" }, body]]
            : ["div", { class: "lm-me-section" }, body];
    }

    // --- title ---------------------------------------------------------------

    /** Collect the values of every field marked with the given titleRole,
     *  walking the whole entry tree (headword on spelling, glosses on subentry). */
    protected collectTitleValues(rf: model.RelationField, node: EntryNode, role: string): string[] {
        const out: string[] = [];
        for (const cr of rf.relationFields) {
            const tuples = node.children(cr);
            if (view(cr).titleRole === role) {
                const scalar = contentScalars(cr)[0];
                if (scalar) for (const t of tuples) {
                    const val = t.value(scalar);
                    if (val !== null && val !== undefined && val !== "") out.push(String(val));
                }
            } else {
                for (const t of tuples) out.push(...this.collectTitleValues(cr, t, role));
            }
        }
        return out;
    }
}

// --- Convenience -------------------------------------------------------------

/** Render an entry from projected JSON (the read / export path). */
export function renderEntryMeta(cfg: EntryRenderConfig,
                               entryRelation: model.RelationField, entry: any): Markup {
    return new EntryRenderer(cfg).render(entryRelation, new JsonNode(entry));
}
