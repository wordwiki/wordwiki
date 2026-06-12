// The markdown -> Markup translation (markdown.ts): formatting comes through
// as our element model, and the two attack channels - raw HTML and hostile
// URL schemes - render as inert text.  Assertions go through the REAL
// serializer (renderToStringViaLinkeDOM - markupToString is debug-only and
// does not escape).
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertStringIncludes } from "./testing/assert.ts";
import { markdownToMarkup } from "./markdown.ts";
import { renderToStringViaLinkeDOM } from "./markup.ts";

const html = (src: string) => renderToStringViaLinkeDOM(markdownToMarkup(src), false);

test("markdown: basic formatting maps onto our element model", () => {
    const out = html('# Title\n\nSome **bold**, *em*, `code` and a\n\n- list\n- of *two*');
    assertStringIncludes(out, '<h1>Title</h1>');
    assertStringIncludes(out, '<strong>bold</strong>');
    assertStringIncludes(out, '<em>em</em>');
    assertStringIncludes(out, '<code>code</code>');
    assertStringIncludes(out, '<li>list</li>');             // tight item: no <p> wrapper
});

test("markdown: GFM - autolinks, strikethrough, task lists", () => {
    const out = html('see https://example.com - ~~old~~\n\n- [x] done thing\n- [ ] open thing');
    assertStringIncludes(out, '<a href="https://example.com"');
    assertStringIncludes(out, '<del>old</del>');
    assertStringIncludes(out, 'type="checkbox"');
    assertStringIncludes(out, 'checked');
    assertStringIncludes(out, 'disabled');
});

test("markdown: raw HTML renders as visible TEXT, never as markup", () => {
    const out = html('hi <script>alert(1)</script> <img src=x onerror=alert(2)>');
    assert(!out.includes('<script>'));
    assert(!out.includes('<img'));
    assertStringIncludes(out, '&lt;script&gt;');
});

test("markdown: hostile URL schemes are refused; safe ones pass", () => {
    const evil = html('[click](javascript:alert(1))');
    assert(!evil.includes('javascript:'));
    assert(!evil.includes('<a '));
    assertStringIncludes(evil, 'click');                     // the text survives
    const fine = html('[ok](https://example.com) and [mail](mailto:dz@example.com) and [rel](/page)');
    assertStringIncludes(fine, 'href="https://example.com"');
    assertStringIncludes(fine, 'href="mailto:dz@example.com"');
    assertStringIncludes(fine, 'href="/page"');
    const data = html('![x](data:text/html;base64,AAAA)');
    assert(!data.includes('data:'));
});

test("markdown: empty/blank input renders nothing", () => {
    assertEquals(markdownToMarkup(''), undefined);
    assertEquals(markdownToMarkup('   \n'), undefined);
    assertEquals(markdownToMarkup(null), undefined);
});
