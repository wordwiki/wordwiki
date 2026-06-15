// deno-lint-ignore-file no-explicit-any
/**
 * Value diffs for the change list: render an old value -> new value so the
 * DIFFERENCE is what draws the eye.
 *
 * There is no single nicest way to show a difference - a one-letter change in a
 * lexeme wants the letter highlighted, while a rewritten English sentence wants
 * whole changed words marked, and two unrelated values are clearest shown
 * plainly.  So this is a small FAMILY of differs (character / word / plain
 * replace); diffValues() runs the applicable ones and keeps the "nicest" -
 * the most content in common with the least fragmentation.  Adding a strategy
 * (a numeric differ, an elided-context differ for long text, ...) is just
 * another candidate.
 *
 * Pure: in -> two Markup values (the old with deletions struck, the new with
 * insertions highlighted), so the change-list renderer drops them straight into
 * its from/to rows.
 */
import { Markup } from "../liminal/markup.ts";

type Op = "eq" | "del" | "ins" | "elide";
interface Seg { op: Op; text: string; }

export type DiffStrategy = "char" | "word" | "replace";
export interface ValueDiff {
    from: Markup;
    to: Markup;
    strategy: DiffStrategy;
    // Long unchanged runs were collapsed to "…" (only context around the
    // changes is kept) - so a tiny edit in a long gloss reads as "…the X…".
    elided: boolean;
}

// Elided-context: chars of unchanged text to keep on each side of a change, and
// the shortest unchanged run worth collapsing.  (Tunable.)
const CONTEXT_CHARS = 24;
const MIN_ELIDE_RUN = 2 * CONTEXT_CHARS + 12;

// A fact's value needs at least this fraction in common before a diff beats
// just showing the two values side by side (below it, a "diff" is all-red /
// all-green noise).
const MIN_COMMON_RATIO = 0.34;

/** Diff two text values, picking the nicest strategy for THIS difference. */
export function diffValues(from: string, to: string): ValueDiff {
    if(from === to)
        return { from: plain(from), to: plain(to), strategy: "replace", elided: false };

    const candidates: { strategy: DiffStrategy; segs: Seg[] }[] =
        [{ strategy: "char", segs: lcsDiff(charTokens(from), charTokens(to)) }];
    // Word-level only earns its place when there is prose (whitespace) to split.
    if(/\s/.test(from) || /\s/.test(to))
        candidates.push({ strategy: "word", segs: lcsDiff(wordTokens(from), wordTokens(to)) });

    const maxLen = Math.max(from.length, to.length) || 1;
    const viable = candidates.filter(c => commonChars(c.segs) / maxLen >= MIN_COMMON_RATIO);
    // Nicest = fewest change runs (least fragmented); tie-break to more in common.
    viable.sort((x, y) =>
        changeRuns(x.segs) - changeRuns(y.segs) || commonChars(y.segs) - commonChars(x.segs));

    const chosen = viable[0];
    if(!chosen) return { from: plain(from), to: plain(to), strategy: "replace", elided: false };

    // Elided-context pass: collapse long unchanged runs (self-gating - a no-op
    // unless something is long enough to be worth hiding).
    const { segs, elided } = elideContext(chosen.segs);
    return {
        from: renderSide(segs, "from"),
        to: renderSide(segs, "to"),
        strategy: chosen.strategy,
        elided,
    };
}

// --- strategies -----------------------------------------------------------------

const charTokens = (s: string): string[] => [...s];                 // code points
const wordTokens = (s: string): string[] => s.split(/(\s+)/).filter(t => t.length);

// A standard LCS diff over a token array, coalescing runs of the same op.
function lcsDiff(a: string[], b: string[]): Seg[] {
    const n = a.length, m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for(let i = n - 1; i >= 0; i--)
        for(let j = m - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

    const out: Seg[] = [];
    const push = (op: Op, text: string) => {
        const last = out[out.length - 1];
        if(last && last.op === op) last.text += text; else out.push({ op, text });
    };
    let i = 0, j = 0;
    while(i < n && j < m) {
        if(a[i] === b[j]) { push("eq", a[i]); i++; j++; }
        else if(dp[i + 1][j] >= dp[i][j + 1]) { push("del", a[i]); i++; }
        else { push("ins", b[j]); j++; }
    }
    while(i < n) push("del", a[i++]);
    while(j < m) push("ins", b[j++]);
    return out;
}

const commonChars = (segs: Seg[]): number =>
    segs.reduce((n, s) => n + (s.op === "eq" ? s.text.length : 0), 0);
const changeRuns = (segs: Seg[]): number => segs.filter(s => s.op !== "eq").length;

// --- elided context -------------------------------------------------------------

// Replace each long UNCHANGED run with a context window + "…", keeping context
// only on the side(s) that abut a change (so the start/end of a long value that
// is far from any edit just disappears).
function elideContext(segs: Seg[]): { segs: Seg[]; elided: boolean } {
    let elided = false;
    const out: Seg[] = [];
    segs.forEach((s, idx) => {
        if(s.op !== "eq" || s.text.length <= MIN_ELIDE_RUN) { out.push(s); return; }
        const keepStart = idx > 0;                  // a change precedes -> show its tail context
        const keepEnd = idx < segs.length - 1;      // a change follows  -> show its head context
        if(!keepStart && !keepEnd) { out.push(s); return; }   // whole value unchanged
        elided = true;
        const head = keepStart ? takeFirst(s.text, CONTEXT_CHARS) : "";
        const tail = keepEnd ? takeLast(s.text, CONTEXT_CHARS) : "";
        if(head) out.push({ op: "eq", text: head });
        out.push({ op: "elide", text: "…" });
        if(tail) out.push({ op: "eq", text: tail });
    });
    return { segs: out, elided };
}

// First/last n chars, snapped back to a word boundary (so we don't cut a word);
// falls back to a raw cut when there is no whitespace (a single long token).
function takeFirst(text: string, n: number): string {
    if(text.length <= n) return text.trimEnd();
    const cut = text.slice(0, n).replace(/\s+\S*$/, "");
    return (cut || text.slice(0, n)).trimEnd();
}
function takeLast(text: string, n: number): string {
    if(text.length <= n) return text.trimStart();
    const cut = text.slice(text.length - n).replace(/^\S*\s+/, "");
    return (cut || text.slice(text.length - n)).trimStart();
}

// One side of the diff: the "from" keeps equal + deleted text (deletions
// struck); the "to" keeps equal + inserted text (insertions highlighted).
function renderSide(segs: Seg[], side: "from" | "to"): Markup {
    const dropOp: Op = side === "from" ? "ins" : "del";
    const markOp: Op = side === "from" ? "del" : "ins";
    const markClass = side === "from" ? "lm-diff-del" : "lm-diff-ins";
    const parts = segs.filter(s => s.op !== dropOp).map(s =>
        s.op === "elide" ? ["span", { class: "lm-diff-elide" }, " … "]
        : s.op === markOp ? ["span", { class: markClass }, s.text]
        : s.text);
    return parts.length ? parts : ["span", { class: "text-muted" }, "(empty)"];
}

function plain(s: string): Markup {
    return s === "" ? ["span", { class: "text-muted" }, "(empty)"] : s;
}
