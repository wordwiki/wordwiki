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
    // lm-editable click-to-edit + the row's ☰ menu.
    tupleSurface: (rf: model.RelationField, id: TupleIdentity, body: Markup) => Markup;
    // The add affordance for a relation under `parentId` (shown even when the
    // relation is empty, so there is always a way to add the first item).
    relationAdd: (rf: model.RelationField, parentId: TupleIdentity) => Markup;
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
 *  order), minus the ones hidden from the read view. */
function orderedChildRelations(rf: model.RelationField): model.RelationField[] {
    return rf.relationFields
        .map((r, i) => [r, i] as const)
        .filter(([r]) => !view(r).hidden)
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

    constructor(cfg: EntryRenderConfig) {
        this.rootPath = cfg.rootPath;
        this.audience = cfg.audience ?? "public";
        this.mode = cfg.mode ?? "read";
        this.publicKeys = new Set(cfg.publicKeys ?? []);
        this.renderBoundingGroup = cfg.renderBoundingGroup;
        this.titleAffordance = cfg.titleAffordance;
        this.editing = cfg.editing;
    }

    /** Wrap a tuple's rendered value as an editable surface (edit mode), or
     *  return it plain (read).  `tuple` must carry identity in edit mode. */
    protected surface(rf: model.RelationField, tuple: EntryNode, body: Markup): Markup {
        const id = this.editing && tuple.identity?.();
        return id ? this.editing!.tupleSurface(rf, id, body) : body;
    }

    /** The add affordance for a relation under `parent` (edit mode only). */
    protected relationAdd(rf: model.RelationField, parent: EntryNode): Markup {
        const id = this.editing && parent.identity?.();
        return id ? this.editing!.relationAdd(rf, id) : "";
    }

    /** Render one entry as a document, entirely from the schema + $view.
     *  `entryRelation` is the 'entry' RelationField; `node` wraps its data. */
    render(entryRelation: model.RelationField, node: EntryNode): Markup {
        const headwords = this.collectTitleValues(entryRelation, node, "headword");
        const glosses = this.collectTitleValues(entryRelation, node, "gloss");
        const title = ["h1", { class: "entry-scope" },
            headwords.join(" / "),
            glosses.length ? ["span", { class: "entry-gloss-title" }, " : " + glosses.join(" / ")] : "",
            this.titleAffordance ?? ""];

        // Every child relation in $view order, minus the headword (title-only)
        // and the hidden (editorial) relations.
        const body = orderedChildRelations(entryRelation)
            .filter(cr => view(cr).titleRole !== "headword")
            .map(cr => this.renderRelation(cr, node));

        return ["div", { class: "lm-meta-entry" }, title, body];
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
        if (isEmptyMarkup(rendered)) return "";
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
        const scalars = contentScalars(rf).map(f => this.renderScalarField(f, tuple));
        const children = orderedChildRelations(rf).map(cr => this.renderRelation(cr, tuple));
        return [this.surface(rf, tuple, scalars), children];
    }

    // --- relations -----------------------------------------------------------

    /** A relation (a section): honours $view label / join / empty / singleton /
     *  compose / keyField.  `parent` is the node whose child tuples these are.
     *  In EDIT mode it stops collapsing / eliding / joining, wraps each tuple as
     *  an editable surface, and appends the add affordance. */
    renderRelation(rf: model.RelationField, parent: EntryNode): Markup {
        const v = view(rf);
        const editing = !!this.editing;
        const tuples = parent.children(rf);

        // A keyed bag (attr): each tuple is "Key: value", labelled from the key.
        if (v.keyField) return this.renderKeyedBag(rf, tuples, parent);

        // Empty: read elides (or a keep-stub); edit shows the add affordance so
        // there is always a way to add the first item.
        if (tuples.length === 0) {
            if (!editing) return v.empty === "keep" ? ["div", { class: "lm-me-empty text-muted small" }, rf.prompt] : "";
            const add = this.relationAdd(rf, parent);
            return v.label === "heading" ? this.section(rf, add) : add;
        }

        // Singleton collapse: READ only (edit keeps the level so a 2nd can be added).
        if (v.singleton === "collapse" && tuples.length === 1 && !editing)
            return this.renderTupleBlock(rf, tuples[0]);

        // FLAT (no child relations) or COMPOSED relation: a list of inline VALUES.
        if (v.compose || orderedChildRelations(rf).length === 0) {
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
            const lines = tuples.map(t => {
                const value = this.tupleInlineValue(rf, t);
                if (isEmptyMarkup(value)) return "";
                const body: Markup = (v.label === "inline")
                    ? ["div", { class: LINE }, ["b", {}, rf.prompt + ": "], value]
                    : ["div", { class: editing ? LINE : "lm-me-listitem" }, value];
                return this.surface(rf, t, body);
            }).filter(m => !isEmptyMarkup(m));
            const withAdd = editing ? [lines, this.relationAdd(rf, parent)] : lines;
            // Inline-labelled lists (gloss) stand alone; unlabelled lists
            // (recordings) get a heading section.
            return v.label === "inline" ? withAdd : this.section(rf, withAdd);
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
        return this.section(rf, editing ? [items, this.relationAdd(rf, parent)] : items);
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
        }).map(t => {
            const key = String(t.value(keyF) ?? "");
            const val = this.renderScalarValue(valF, t.value(valF));
            if (isEmptyMarkup(val) && !key) return "";
            return this.surface(rf, t, ["div", { class: LINE }, ["b", {}, humanise(key) + ": "], val]);
        }).filter(m => !isEmptyMarkup(m));
        return this.editing ? [rows, this.relationAdd(rf, parent)] : rows;
    }

    /** A section: an optional bold heading, then the body indented. */
    protected section(rf: model.RelationField, body: Markup): Markup {
        return view(rf).label === "heading"
            ? ["div", { class: "lm-me-section" },
               ["div", { class: "fw-bold lm-me-heading" }, rf.prompt + ":"], ["div", { class: "ms-3" }, body]]
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
