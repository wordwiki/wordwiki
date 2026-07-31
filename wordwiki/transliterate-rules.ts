// deno-lint-ignore-file no-explicit-any
/**
 * The RULE-LIST interpreter (I4): a transliterator expressed as an ordered
 * list of named rules, applied left-to-right.  The point is the EXPLAIN
 * PLAN - to render "why this output" the rules must be individually named
 * and inspectable, which forces them out of an opaque function into data.
 * One rule list yields BOTH faces from the same source (dz: emit the fast
 * path and the traced path from one table):
 *   - transliterate(word): run the rules, return the output (no recording);
 *   - explain(word):       run the rules, record each step that FIRED.
 *
 * Most rules are declarative regex substitutions (reRule) - directly
 * publishable as a correspondence table.  The fn escape hatch (fnRule) is
 * for the genuinely procedural step; it is still NAMED and its effect shows
 * in the trace's before/after, but its logic is opaque to the published
 * artifact.  The legibility test is the rendered page: a pair whose trace
 * is all fnRules is not yet real rules-as-data.
 *
 * General mechanism - no language specifics.  Rule LISTS live in the
 * language package (e.g. mikmaq/pacifique-transliterate.ts).
 */

/** FNV-1a over a string -> 8 hex chars.  Shared stable-id primitive. */
function fnv8(s: string): string {
    let h = 2166136261;
    for(const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export interface TransliterationRule {
    /** Content-keyed stable id: a hash of the rule's SEMANTICS (pattern +
     *  flags + replacement, or the label for an fn rule) - survives
     *  reordering, so a verdict/feedback fact that pins it stays valid when
     *  the list is edited elsewhere. */
    id: string;
    /** Short human label for the trace + published row, e.g. "tj → j". */
    label: string;
    /** Longer note (the measured justification) for the published artifact. */
    note?: string;
    /** The transform.  The interpreter calls this; a declarative rule's is
     *  derived from its regex. */
    apply(word: string, opts?: {pos?: string}): string;
    /** Present for a regex rule (the publishable form); absent for fnRule. */
    source?: {pattern: string, flags: string, replacement: string};
}

/** A declarative regex-substitution rule.  `replacement` may be a string
 *  (with $1 backrefs) or a function (the escape hatch WITHIN a regex rule,
 *  e.g. a table fold) - a function replacement is still legible as "this
 *  pattern, resolved by <label>". */
export function reRule(label: string, pattern: RegExp,
        replacement: string | ((...m: string[]) => string),
        note?: string): TransliterationRule {
    const replDesc = typeof replacement === 'string' ? replacement : `fn:${label}`;
    return {
        id: fnv8(`re\x00${pattern.source}\x00${pattern.flags}\x00${replDesc}`),
        label, note,
        apply: (w) => w.replace(pattern, replacement as any),
        source: {pattern: pattern.source, flags: pattern.flags, replacement: replDesc},
    };
}

/** A procedural escape-hatch rule: named + trace-visible, but opaque logic. */
export function fnRule(label: string,
        apply: (word: string, opts?: {pos?: string}) => string,
        note?: string): TransliterationRule {
    return {id: fnv8(`fn\x00${label}`), label, note, apply};
}

export interface TraceStep {
    ruleId: string;
    label: string;
    before: string;
    after: string;
}

export interface TransliterationTrace {
    input: string;
    output: string;
    /** The rules that FIRED (before !== after), in application order - the
     *  derivation, like an EXPLAIN plan showing the steps that ran. */
    steps: TraceStep[];
    pairId?: string;
    version?: string;
}

export interface CompiledRules {
    transliterate(word: string, opts?: {pos?: string}): string;
    explain(word: string, opts?: {pos?: string}): TransliterationTrace;
    rules: TransliterationRule[];
    /** Order-sensitive fingerprint of the whole rule list (ids in order) -
     *  changes when a rule changes OR the order changes; the anchor for
     *  "which rules produced this score". */
    rulesFingerprint: string;
}

/** Compile a rule list into the transliterate + explain faces. */
export function compileRules(rules: TransliterationRule[],
        meta: {pairId?: string, version?: string} = {}): CompiledRules {
    const rulesFingerprint = fnv8(rules.map(r => r.id).join('|'));
    return {
        rules, rulesFingerprint,
        transliterate(word, opts) {
            let w = word;
            for(const r of rules) w = r.apply(w, opts);
            return w;
        },
        explain(word, opts) {
            let w = word;
            const steps: TraceStep[] = [];
            for(const r of rules) {
                const before = w;
                w = r.apply(w, opts);
                if(w !== before) steps.push({ruleId: r.id, label: r.label, before, after: w});
            }
            return {input: word, output: w, steps, ...meta};
        },
    };
}

/** Render a trace as text lines (CLI --explain; the review UI renders its
 *  own).  Shows the fired steps as a derivation, each with the rule that
 *  changed the string. */
export function renderTrace(t: TransliterationTrace): string[] {
    const lines = [`explain ${t.pairId ?? ''} ${t.version ?? ''}`.trimEnd(),
                   `  ${t.input}  →  ${t.output}`];
    if(t.steps.length === 0) lines.push('  (no rule fired; output == input)');
    for(const s of t.steps)
        lines.push(`  [${s.ruleId}] ${s.label.padEnd(28)} ${s.before} → ${s.after}`);
    return lines;
}
