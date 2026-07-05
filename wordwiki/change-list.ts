// deno-lint-ignore-file no-explicit-any
/**
 * The change list - ONE event-log component, reused everywhere a fact's
 * history is shown (publication-model.md / lexeme-editor.ts review).
 *
 * The hierarchical lexeme tree is already at the edge of what the dictionary's
 * users can hold; nesting a second (per-fact version) list inside it tipped it
 * over (see the design notes).  So a change list is deliberately FLAT and
 * deliberately UNIFORM: the user learns one shape and reads it the same way in
 * every context - the history of a single fact, of a whole lexeme, of the whole
 * dictionary, or of just the threads one person is part of.  Only the SET of
 * events differs between contexts; the rendering never does.
 *
 * Each line is an event, and reads left-to-right as a log: WHEN, WHO, then what
 * happened.  When+who lead (and are rigidly columnar) because they are the
 * critical, regular information that says "this is an activity log"; who is an
 * initialism and the date is compact so the columns stay narrow.
 *
 * The component is pure layout: callers pre-render each event's value to markup
 * (they hold the schema; this module does not), so the same renderer serves any
 * relation.  Builders live in lexeme-editor.ts.
 */
import { Markup } from "../liminal/markup.ts";
import * as timestamp from "../liminal/timestamp.ts";

export type ChangeKind =
    | "baseline"    // the accepted (published) value the thread starts from
    | "added"       // a new fact proposed
    | "changed"     // a value edited
    | "deleted"     // a fact removed
    | "commented"   // a discussion note (never published)
    | "reverted"    // rolled back / rejected to a prior value
    | "approved";   // a pending change accepted (published)

export interface ChangeEvent {
    when: number;              // valid_from of the version
    whoInitials: string;       // the actor as an initialism (the column stays narrow)
    whoName: string;           // the full name, for the hover title
    authorUsername?: string;   // the raw change_by_username (the feed's approval filter keys on it)
    automated?: boolean;       // a batch import/migration identity
    // What the event is ABOUT, shown as a scannable column (when showSubject):
    // the field, and - in a multi-lexeme (global) list - the lexeme headword.
    field?: string;            // the field/relation (e.g. "Spelling")
    lexeme?: string;           // the lexeme headword (omit in a single-lexeme list)
    kind: ChangeKind;
    // A single-value event (baseline / added / deleted / approved): the rendered
    // value.  The KIND is shown by a word chip (see renderChangeEvent), not a verb.
    value?: Markup;
    // A change (changed / reverted): before -> after, rendered as two ALIGNED
    // rows so the difference is visible in place (no hunting for the prior
    // value, which in a merged log may be far away).
    from?: Markup;
    to?: Markup;
    // A note: for a 'commented' event it IS the content (rendered inline next to
    // who/when); otherwise it is a rationale/reason on a sub-line.
    note?: string;
    actions?: Markup;          // an optional trailing affordance (e.g. the fact's ☰)
}

export interface ChangeListOpts {
    // Show the per-event subject column (the lexeme/field the event concerns).
    // On for multi-fact lists (a lexeme / the whole dictionary); off for a
    // single fact, whose identity is already established by its surroundings.
    showSubject?: boolean;
}

// The kind chip's text - none for baseline/changed (a quiet value / a from-to
// already says what they are).
const CHIP: Record<ChangeKind, string | undefined> = {
    baseline: undefined, changed: undefined,
    added: "added", deleted: "deleted", approved: "approved",
    reverted: "reverted", commented: "comment",
};

export function renderChangeList(events: ChangeEvent[], opts: ChangeListOpts = {}): Markup {
    return ["div", {class: "lm-changelist"},
        events.length === 0
            ? ["div", {class: "lm-cl-empty text-muted small"}, "No changes."]
            : events.map(e => renderChangeEvent(e, opts))];
}

/** A group of events under one heading - the SAME event lines, bucketed (one
 *  level, not a tree).  Used by the lexeme review: one group per pending fact,
 *  so "what needs approving" reads as a short list of headed blocks rather than
 *  a long flat log.  The header (the subject + its actions) is pre-rendered by
 *  the caller; within a group the per-line subject is dropped (it is the
 *  header). */
export interface ChangeGroup {
    header: Markup;
    events: ChangeEvent[];
    // Attributes for the group's wrapper element (must include the lm-cl-group
    // class).  The caller uses this to make each group its OWN reloadable htmx
    // fragment, so an action that touches one fact re-renders just its group -
    // not the whole page.  Defaults to a plain lm-cl-group div.
    attrs?: Record<string, any>;
    // Show each line's subject.  Off (the default) for single-fact review
    // groups, whose field is the header; on for groups spanning facts (a feed
    // clump is one LEXEME's session, so its lines need their field).
    showSubject?: boolean;
}

/** One group: its header + its event lines.  Rendered both inline (the list)
 *  and on its own (the per-group reload fragment), so the two never drift. */
export function renderChangeGroup(g: ChangeGroup): Markup {
    return ["div", g.attrs ?? { class: "lm-cl-group" },
        ["div", { class: "lm-cl-group-header" }, g.header],
        ["div", { class: "lm-cl-group-body" },
         g.events.map(e => renderChangeEvent(e, { showSubject: g.showSubject ?? false }))]];
}

export function renderGroupedChangeList(groups: ChangeGroup[],
                                        emptyMessage = "Nothing to show."): Markup {
    // The empty message is ALWAYS present and hidden by CSS while any group
    // exists - so when the last group's fragment removes itself (an approval),
    // the message appears without re-rendering the whole list.
    return ["div", {class: "lm-changelist lm-changelist-grouped"},
        groups.map(g => renderChangeGroup(g)),
        ["div", {class: "lm-cl-empty text-muted small"}, emptyMessage]];
}

function renderChangeEvent(e: ChangeEvent, opts: ChangeListOpts): Markup {
    // The subject column: the FIELD leads (so same-field runs scan down the
    // page without a structural grouping), with the lexeme headword as a quiet
    // qualifier (redundant in a single-lexeme list, identifying in a global one).
    const subject = opts.showSubject
        ? ["span", {class: "lm-cl-subject"},
           e.field ? ["span", {class: "lm-cl-field"}, e.field] : "",
           e.lexeme ? ["span", {class: "lm-cl-lexeme"}, " · ", e.lexeme] : ""]
        : "";

    // A word chip names the KIND for the events that aren't self-evident (a
    // plain change reads from its from/to; a baseline is just the quiet value).
    const chipText = CHIP[e.kind];
    const chip = chipText
        ? ["span", {class: `lm-cl-chip lm-cl-chip-${e.kind}`}, chipText, " "] : "";

    let body: Markup;
    if(e.kind === "commented") {
        // The comment text is the content, inline next to its chip.
        body = ["span", {class: "lm-cl-comment"}, e.note ?? ""];
    } else if(e.from !== undefined || e.to !== undefined) {
        // before -> after on two aligned rows (the value column lines up so the
        // difference reads at a glance).
        const line = (label: string, value: Markup, extra: string) =>
            ["div", {class: "lm-cl-dline"},
             ["span", {class: "lm-cl-dlabel"}, label],
             ["span", {class: `lm-cl-dval ${extra}`}, value ?? ["span", {class: "text-muted"}, "(empty)"]]];
        body = ["div", {class: "lm-cl-detail"},
            line("from", e.from as Markup, "lm-cl-from"),
            line("to", e.to as Markup, "lm-cl-to")];
    } else {
        body = e.value ?? "";
    }

    const note = (e.note && e.kind !== "commented")
        ? ["div", {class: "lm-cl-note"}, e.note] : "";

    return ["div", {class: `lm-cl-row lm-cl-${e.kind} ${opts.showSubject ? "lm-cl-withsubject" : ""}`},
        ["span", {class: "lm-cl-when"}, timestamp.formatTimestampCompact(e.when)],
        ["span", {class: "lm-cl-who", title: e.whoName},
         e.automated ? "sys" : e.whoInitials],
        subject,
        ["span", {class: "lm-cl-what"}, chip, body, note],
        e.actions ? ["span", {class: "lm-cl-actions"}, e.actions] : ""];
}

/** A person as an initialism for the who-column: the first+last initials of the
 *  name when known, else the first two letters of the code; automated
 *  identities collapse to "sys".  (Exported for the builders + tests.) */
export function initials(username: string | null | undefined, name?: string | null): string {
    if(!username) return "—";
    if(username.startsWith("~")) return "sys";
    const base = (name && name.trim()) ? name.trim() : username;
    const parts = base.split(/\s+/).filter(Boolean);
    if(parts.length >= 2)
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return base.slice(0, 2).toUpperCase();
}
