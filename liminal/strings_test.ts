// Misc string utilities (see strings.ts).  Several of these feed the markup
// and template machinery (block`` builds the SQL schemas), so the dedent
// pipeline is pinned carefully; the regressions cover the audit's findings
// (parseBoolean returning true for false, the m-flagged isAllWhitespace,
// indexOf-truthiness in normalizeNewlines, swapped LF/CR entities, window
// in Deno, the aB camel-casing off-by-one).
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertThrows } from "./testing/assert.ts";
import * as s from "./strings.ts";

test("prefix/suffix strip and replace family", () => {
    assertEquals(s.stripOptionalPrefix("foo.bar", "foo."), "bar");
    assertEquals(s.stripOptionalPrefix("foo.bar", "x."), "foo.bar");
    assertEquals(s.stripRequiredPrefix("foo.bar", "foo."), "bar");
    assertThrows(() => s.stripRequiredPrefix("foo.bar", "x."), Error, "prefix");
    assertEquals(s.replaceOptionalPrefix("foo.bar", "foo.", "baz."), "baz.bar");
    assertEquals(s.replaceOptionalPrefix("foo.bar", "x.", "baz."), "foo.bar");
    assertEquals(s.stripOptionalSuffix("file.txt", ".txt"), "file");
    assertEquals(s.stripOptionalSuffix("file.txt", ".md"), "file.txt");
    assertEquals(s.stripRequiredSuffix("file.txt", ".txt"), "file");
    assertThrows(() => s.stripRequiredSuffix("file.txt", ".md"), Error, "suffix");
    assertEquals(s.replaceOptionalSuffix("file.txt", ".txt", ".md"), "file.md");
    // empty affixes are no-ops that succeed
    assertEquals(s.stripRequiredPrefix("abc", ""), "abc");
    assertEquals(s.stripRequiredSuffix("abc", ""), "abc");
});

test("capitalize / uncapitalize / stringCompare / isString / ord", () => {
    assertEquals(s.capitalize("hello"), "Hello");
    assertEquals(s.uncapitalize("Hello"), "hello");
    assertEquals(s.capitalize(""), "");
    assertEquals(s.capitalize("é"), "É");
    assertEquals([s.stringCompare("a", "b"), s.stringCompare("b", "a"), s.stringCompare("a", "a")],
                 [-1, 1, 0]);
    assert(s.isString("x") && s.isString(new String("x")));
    assert(!s.isString(7) && !s.isString(null) && !s.isString(["x"]));
    assertEquals(s.ord("A"), 65);
});

test("splitIntoWords: unicode segmentation, apostrophes, punctuation", () => {
    assertEquals(s.splitIntoWords("The cat sat."), ["The", "cat", "sat"]);
    assertEquals(s.splitIntoWords("don't stop"), ["don't", "stop"]);
    assertEquals(s.splitIntoWords("  (a,b;c)  "), ["a", "b", "c"]);
    assertEquals(s.splitIntoWords(""), []);
});

test("isUpperCaseChar / startsWithUpperCaseChar", () => {
    assert(s.isUpperCaseChar("A") && s.isUpperCaseChar("É"));
    assert(!s.isUpperCaseChar("a") && !s.isUpperCaseChar("7") && !s.isUpperCaseChar("-"));
    assertThrows(() => s.isUpperCaseChar("AB"), Error, "single character");
    assert(s.startsWithUpperCaseChar("Abc"));
    assert(!s.startsWithUpperCaseChar("abc") && !s.startsWithUpperCaseChar(""));
});

test("camelCase and camelCasedToDashedReversibly invert each other", () => {
    assertEquals(s.camelCasedToDashedReversibly("catFood"), "cat-food");
    assertEquals(s.camelCasedToDashedReversibly("ICBMSilo"), "-i-c-b-m-silo");
    assertEquals(s.camelCasedToDashedReversibly("CatFood", true), "cat-food");
    assertEquals(s.camelCase("cat-food"), "catFood");
    assertEquals(s.camelCase("cat-food", true), "CatFood");
    assertEquals(s.camelCase("-i-c-b-m-silo"), "ICBMSilo");
});

test("camel round-trip property on random dash-free identifiers (seeded)", () => {
    let state = 77777;
    const rand = (n: number) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
    const letters = "abcdefgABCDEFG";
    for (let i = 0; i < 2000; i++) {
        const len = 1 + rand(12);
        let id = "";
        for (let j = 0; j < len; j++) id += letters[rand(letters.length)];
        assertEquals(s.camelCase(s.camelCasedToDashedReversibly(id)), id, `round trip of '${id}'`);
    }
});

test("camelCasedToDashedFancily: the documented acronym heuristic", () => {
    assertEquals(s.camelCasedToDashedFancily("catFood"), "cat-food");
    assertEquals(s.camelCasedToDashedFancily("ICBMSilo"), "icbm-silo");
    assertEquals(s.camelCasedToDashedFancily("BigI"), "big-i");
    assertEquals(s.camelCasedToDashedFancily("BigEYE"), "big-eye");
    assertEquals(s.camelCasedToDashedFancily("BigIFood"), "big-i-food");
    assertEquals(s.camelCasedToDashedFancily("BigEYEFood"), "big-eye-food");
    // Regression: `pos-1>0` (vs >=0) meant an upper case SECOND char never
    // started a word.
    assertEquals(s.camelCasedToDashedFancily("aB"), "a-b");
});

test("escapeJsStringLiteral: all specials, and no cross-call regex state", () => {
    assertEquals(s.escapeJsStringLiteral(`a'b"c\nd\re\tf\\g`), `a\\'b\\"c\\nd\\re\\tf\\\\g`);
    assertEquals(s.escapeJsStringLiteral("clean"), "clean");
    // Regression guard: a g-flagged regex shared between .test and .replace
    // keeps lastIndex state; a match late in one call must not make a match
    // EARLY in the next call invisible.
    s.escapeJsStringLiteral("aaaaaa'");
    assertEquals(s.escapeJsStringLiteral("'x"), "\\'x");
});

test("escapeHtmlAttr / escapeHtmlText: entities (incl the LF/CR swap regression)", () => {
    assertEquals(s.escapeHtmlAttr(`<a href='x' & "y">`), "&lt;a href=&#39;x&#39; &amp; &quot;y&quot;&gt;");
    assertEquals(s.escapeHtmlAttr("a\nb"), "a&#10;b");  // LF is 10 (was &#13;)
    assertEquals(s.escapeHtmlAttr("a\rb"), "a&#13;b");  // CR is 13 (was &#10;)
    assertEquals(s.escapeHtmlAttr("clean"), "clean");
    s.escapeHtmlAttr("aaaa<");                          // cross-call state guard
    assertEquals(s.escapeHtmlAttr("<x"), "&lt;x");
    assertEquals(s.escapeHtmlText("a < b & c > d"), "a &lt; b &amp; c > d");
    s.escapeHtmlText("aaaa&");
    assertEquals(s.escapeHtmlText("&x"), "&amp;x");
});

test("encode64 works under Deno (regression: window is gone in Deno 2)", () => {
    assertEquals(s.encode64("hi"), "aGk=");
    assertEquals(s.encode64(""), "");
});

test("isIdentifier (ASCII) and isES2016Identifier (unicode)", () => {
    for (const good of ["abc", "_x", "a1", "A_b2"]) {
        assert(s.isIdentifier(good), good);
        assert(s.isES2016Identifier(good), good);
    }
    for (const bad of ["", "1abc", "a-b", "a b", "a.b"]) {
        assert(!s.isIdentifier(bad), bad);
        assert(!s.isES2016Identifier(bad), bad);
    }
    // Divergence: $ and non-ASCII are legal in ES identifiers, not in ours.
    assert(!s.isIdentifier("$x") && s.isES2016Identifier("$x"));
    assert(!s.isIdentifier("héllo") && s.isES2016Identifier("héllo"));
    assert(s.isES2016Identifier("π"));
    assert(!s.isES2016Identifier(null as unknown as string));
});

test("whitespace helpers", () => {
    assertEquals(s.removeEndOfLineSpaces("a  \nb\t\nc"), "a\nb\nc");
    assertEquals(s.removeTrailingNewlines("a\n\n\n"), "a");
    assertEquals(s.normalizeToOneEndingNewline("abc"), "abc\n");
    assertEquals(s.normalizeToOneEndingNewline("abc\n"), "abc\n");
    assertEquals(s.normalizeToOneEndingNewline("abc\n\n\n"), "abc\n");
    assertEquals(s.expandTabs("\ta"), "        a");
    assertEquals(s.countLeadingSpaces("   x"), 3);
    assertEquals(s.countLeadingSpaces("    "), 4);   // all-space string
    assertEquals(s.countLeadingSpaces(""), 0);
    assertEquals(s.stripLeadingSpaces("    x", 2), "  x");
    assertEquals(s.stripLeadingSpaces("  x", 10), "x");
});

test("isAllWhitespace: no m-flag false positives (regression)", () => {
    assert(s.isAllWhitespace("") && s.isAllWhitespace(" \t\r\n "));
    // With the old /m flag these all counted as whitespace (the ^$ matched
    // around the empty line).
    assert(!s.isAllWhitespace("abc\n"));
    assert(!s.isAllWhitespace("abc\n\ndef"));
    assert(!s.isAllWhitespace("\n x \n"));
    // ... and agrees with its non-m twin on a spread of cases.
    for (const v of ["", " ", "\n", "a", "abc\n", " a ", "\t\t", "x\n\ny"])
        assertEquals(s.isAllWhitespace(v), s.isWhitespaceString(v), JSON.stringify(v));
});

test("normalizeNewlines: legacy conventions, including a LEADING \\r (regression)", () => {
    assertEquals(s.normalizeNewlines("a\r\nb\rc\nd"), "a\nb\nc\nd\n");
    assertEquals(s.normalizeNewlines("\r\nhello"), "\nhello\n");  // indexOf('\r') === 0 case
    assertEquals(s.normalizeNewlines("\rhello"), "\nhello\n");
    assertEquals(s.normalizeNewlines("plain"), "plain\n");
    assertEquals(s.normalizeNewlines("done\n"), "done\n");
});

test("dedentString: first-line indent rule, blank-line trimming, line prefix", () => {
    assertEquals(s.dedentString("\n    a\n      b\n    c\n\n"), "a\n  b\nc\n");
    assertEquals(s.dedentString("  a"), "a\n");
    assertEquals(s.dedentString("   \n  \n"), "");          // nothing but whitespace
    assertEquals(s.dedentString("\ta"), "a\n");             // tabs expand first
    assertEquals(s.dedentString("/**/  a\n/**/  b", "/**/"), "a\nb\n");
});

test("dedent / block template tags merge substitutions then dedent", () => {
    const who = "world";
    assertEquals(s.dedent`
        hello ${who}
          indented
    `, "hello world\n  indented\n");
    // the /**/ line-prefix convention puts /**/ at column 0 (it exists to
    // defeat editor auto-indent in embedded SQL blocks - see schema usage)
    assertEquals(s.block`
/**/   select *
/**/     from t where x = ${7}`,
                 "select *\n  from t where x = 7\n");
    assertEquals(s.mergeTemplate(["a", "b", "c"], [1, 2]), "a1b2c");
});

test("indentString pins its current shape (indents every split line, adds a final newline)", () => {
    assertEquals(s.indentString("a\nb", "> "), "> a\n> b\n");
    // NOTE: input ending in \n yields an indented empty last line - callers
    // rely on indentString for display, where this has been harmless.
    assertEquals(s.indentString("a\n", "> "), "> a\n> \n");
});

test("parseBoolean: false means false (regression - all falsy forms returned true)", () => {
    for (const t of ["1", "true", "t", "yes", "y", "TRUE", "Yes", "Y"])
        assertEquals(s.parseBoolean(t), true, t);
    for (const f of ["0", "false", "f", "no", "n", "FALSE", "No", "N"])
        assertEquals(s.parseBoolean(f), false, f);
    for (const u of ["", "2", "maybe", "on", "off"])
        assertEquals(s.parseBoolean(u), undefined, u);
});

test("escapeRegExp: escaped specials match literally", () => {
    const nasty = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    assert(new RegExp(`^${s.escapeRegExp(nasty)}$`).test(nasty));
    assertEquals(s.escapeRegExp("plain"), "plain");
});
