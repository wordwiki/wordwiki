// deno-lint-ignore-file no-explicit-any
/**
 * Metadata-driven, read-only lexeme renderer (EXPERIMENT - slice 1).
 *
 * The public/read renderer in entry-schema.ts is hand-written: one bespoke
 * function per relation, with the presentation (order, labels, joins, the
 * headword+gloss title, the collapse-a-lone-subentry rule) baked into code.
 * This renderer instead WALKS THE SCHEMA (model.RelationField tree) and takes
 * every presentation decision from the field's `$view` metadata (model.ts
 * ViewStyle).  The goal: make the metadata rich enough that a new relation - or
 * a whole new language schema - renders as nicely with NO code change.
 *
 * Slice 1 is deliberately parallel: wordView shows this beside the hand render
 * so we can evolve the metadata until it matches or beats it.  It is NOT yet
 * wired to the editor; `$view` is separate from `$shape` on purpose.
 *
 * The core principle: `$view` is DECLARED INTENT; the render MODE decides how
 * far to honour it.  Read mode (all we do now) collapses singletons and elides
 * empty sections; a future edit mode would keep them (so add affordances show).
 */
import { Markup } from "../liminal/markup.ts";
import * as model from "./model.ts";
import { markdownToMarkup } from "../liminal/markdown.ts";
import { renderStandaloneGroup } from "./render-page-editor.ts";  // REMOVE_FOR_WEB
import * as audio from "./audio.ts";  // REMOVE_FOR_WEB

export interface MetaCtx {
    rootPath: string;
    mode?: "read" | "edit";        // slice 1: read only
    renderInternalNotes?: boolean;
}

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

// --- Scalars -----------------------------------------------------------------

/** Apply a field's $view decoration (emphasis, parenthesise/wrap) to already-
 *  rendered text - wherever the value appears, including inside a compose. */
function decorate(f: model.Field, m: Markup): Markup {
    if (isEmptyMarkup(m)) return m;
    const v = view(f);
    let out: Markup = m;
    if (v.emphasis === "italic") out = ["i", {}, out];
    else if (v.emphasis === "bold") out = ["b", {}, out];
    if (v.wrap) out = [v.wrap[0], out, v.wrap[1]];
    return out;
}

/** A scalar VALUE (no label): dispatched by field type.  This is where "no
 *  code" pays off - a new field of an existing type just works. */
function renderScalarValue(ctx: MetaCtx, f: model.ScalarField, value: any): Markup {
    if (value === null || value === undefined || value === "") return "";
    if (f instanceof model.AudioField)
        return audio.renderAudio(value, audio.audioPlayIcon, undefined, ctx.rootPath);
    if (f instanceof model.ImageField)
        return ["img", { src: ctx.rootPath + value, style: "max-width: 12rem; height: auto;" }];
    if (f.style.$shape === "boundingGroup")   // the reference scan (kept in-column)
        return ["div", { class: "lm-me-scan" }, renderStandaloneGroup(ctx.rootPath, value)];
    const opts = options(f);
    const base: Markup = opts
        ? (opts[String(value)] ?? String(value))   // code -> display name
        : f.style.$markdown ? markdownToMarkup(String(value)) : String(value);
    return decorate(f, base);
}

/** A scalar with its own label policy (used for scalars that sit directly on a
 *  block, e.g. subentry.part_of_speech -> "Part of Speech: noun"). */
function renderScalarField(ctx: MetaCtx, f: model.ScalarField, value: any): Markup {
    const rendered = renderScalarValue(ctx, f, value);
    if (isEmptyMarkup(rendered)) return "";
    // A label/value line is a "block" for the vertical rhythm (see the CSS): a
    // run of them reads tight; other blocks get a gap above.
    switch (view(f).label ?? "none") {
        case "inline":  return ["div", { class: "lm-me-line" }, ["b", {}, f.prompt + ": "], rendered];
        case "heading": return ["div", { class: "lm-me-line" }, ["div", { class: "fw-bold" }, f.prompt + ":"], rendered];
        default:        return ["div", { class: "lm-me-line" }, rendered];
    }
}

// --- Tuples & relations ------------------------------------------------------

/** The inline VALUE of one tuple.  With $view.compose, lay out the named parts
 *  (scalars and/or child relations) in order, joined by $view.sep - the way an
 *  alternate form reads "form — gloss — (plural)".  Otherwise just the content
 *  scalars. */
function tupleInlineValue(ctx: MetaCtx, rf: model.RelationField, tuple: any): Markup {
    const v = view(rf);
    if (v.compose) {
        const parts = v.compose.map(name => {
            const f = rf.modelFields.find(mf => mf.name === name);
            if (!f) return "";
            if (f instanceof model.RelationField) {
                const items = (tuple[name] ?? [])
                    .map((t: any) => tupleInlineValue(ctx, f, t))
                    .filter((m: Markup) => !isEmptyMarkup(m));
                return items.length ? intersperse(items, view(f).join ?? " / ") : "";
            }
            return renderScalarValue(ctx, f as model.ScalarField, tuple[name]);
        }).filter(m => !isEmptyMarkup(m));
        return intersperse(parts, v.sep ?? " ");
    }
    const parts = contentScalars(rf)
        .map(f => renderScalarValue(ctx, f, tuple[f.name]))
        .filter(m => !isEmptyMarkup(m));
    return parts.length <= 1 ? (parts[0] ?? "") : intersperse(parts, " ");
}

/** One tuple as a block: its content scalars (each with its label policy) then
 *  its child relations, recursively.  `bare` drops nothing extra - it just
 *  documents that the caller is collapsing a wrapper level around it. */
function renderTupleBlock(ctx: MetaCtx, rf: model.RelationField, tuple: any): Markup {
    const scalars = contentScalars(rf).map(f => renderScalarField(ctx, f, tuple[f.name]));
    const children = orderedChildRelations(rf).map(cr =>
        renderRelation(ctx, cr, tuple[cr.name] ?? []));
    return [scalars, children];
}

/** A relation (a section): honours $view label / join / empty / singleton. */
export function renderRelation(ctx: MetaCtx, rf: model.RelationField, tuples: any[]): Markup {
    const v = view(rf);
    tuples = tuples ?? [];

    // Empty: read mode elides (default); 'keep' would leave a stub (editor).
    if (tuples.length === 0)
        return v.empty === "keep" ? ["div", { class: "lm-me-empty text-muted small" }, rf.prompt] : "";

    // Singleton collapse: render the lone member's content with no wrapper/label
    // (the subentry "1." level disappears when there's only one sense).
    if (v.singleton === "collapse" && tuples.length === 1)
        return renderTupleBlock(ctx, rf, tuples[0]);

    const heading = (body: Markup): Markup =>
        v.label === "heading"
            ? ["div", { class: "lm-me-section" },
               ["div", { class: "fw-bold lm-me-heading" }, rf.prompt + ":"], ["div", { class: "ms-3" }, body]]
            : ["div", { class: "lm-me-section" }, body];

    // FLAT (no child relations) or COMPOSED relation: a list of inline VALUES -
    // never numbered.  Joined onto one line when $view.join is set (glosses,
    // pronunciation), else one value per line (recordings, alternate forms).
    // A compose consumes its child relations into the phrase, so it lists here
    // rather than falling through to the numbered-container path.
    if (v.compose || orderedChildRelations(rf).length === 0) {
        const items = tuples.map(t => tupleInlineValue(ctx, rf, t)).filter(m => !isEmptyMarkup(m));
        if (items.length === 0) return "";
        if (v.join !== undefined) {
            const joined = intersperse(items, v.join);
            return (v.label === "inline")
                ? ["div", { class: "lm-me-line" }, ["b", {}, rf.prompt + ": "], joined]
                : ["div", { class: "lm-me-line" }, joined];
        }
        // One value per line.  With an inline label, REPEAT it per line: for
        // multiple long values (several glosses, esp. with parentheticals) a
        // slash-run is unreadable and hides how many there are; a repeated
        // "Gloss:" is no heavier than one line for the common single value.
        if (v.label === "inline")
            return items.map(it => ["div", { class: "lm-me-line" }, ["b", {}, rf.prompt + ": "], it]);
        return heading(items.map(it => ["div", { class: "lm-me-item" }, it]));
    }

    // CONTAINER relation (has child relations): each tuple is a block, numbered
    // when there is more than one (senses, examples).
    const numbered = tuples.length > 1;
    return heading(tuples.map((t, i) =>
        ["div", { class: "lm-me-item" },
            numbered ? ["span", { class: "fw-bold me-1" }, `${i + 1}.`] : "",
            renderTupleBlock(ctx, rf, t)]));
}

// --- Title (headword : glosses) ----------------------------------------------

/** Collect the values of every field marked with the given titleRole, walking
 *  the whole entry tree (headword lives on spelling, glosses on subentry). */
function collectTitleValues(rf: model.RelationField, data: any, role: string): string[] {
    const out: string[] = [];
    for (const cr of rf.relationFields) {
        const tuples: any[] = data[cr.name] ?? [];
        if (view(cr).titleRole === role) {
            const scalar = contentScalars(cr)[0];
            if (scalar) for (const t of tuples) {
                const val = t[scalar.name];
                if (val !== null && val !== undefined && val !== "") out.push(String(val));
            }
        } else {
            for (const t of tuples) out.push(...collectTitleValues(cr, t, role));
        }
    }
    return out;
}

// --- Entry -------------------------------------------------------------------

/** Render one entry as a read-only document, entirely from the schema + $view.
 *  `entryRelation` is the 'entry' RelationField of the dict schema; `entry` is
 *  the current projected Entry data. */
export function renderEntryMeta(ctx: MetaCtx, entryRelation: model.RelationField, entry: any): Markup {
    const headwords = collectTitleValues(entryRelation, entry, "headword");
    const glosses = collectTitleValues(entryRelation, entry, "gloss");
    const title = ["h1", { class: "entry-scope" },
        headwords.join(" / "),
        glosses.length ? ["span", { class: "entry-gloss-title" }, " : " + glosses.join(" / ")] : ""];

    // Body: every child relation in $view order, minus the headword (title-only)
    // and the hidden (editorial) relations.
    const body = orderedChildRelations(entryRelation)
        .filter(cr => view(cr).titleRole !== "headword")
        .map(cr => renderRelation(ctx, cr, entry[cr.name] ?? []));

    return ["div", { class: "lm-meta-entry" }, title, body];
}
