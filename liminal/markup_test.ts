// markup.ts: JS-value markup -> HTML via the JSDON/linkedom path - this is
// THE html emitter for every served page (liminal.ts request handling) and
// the published dictionary (publish.ts), so the escaping behavior here is
// the system's XSS protection.  Tests pin what linkedom does (including its
// quirks) so a dependency bump that changes escaping fails loudly, and cover
// the audit's guards: raw-text breakout, tag/attr name injection, and
// null/undefined attr elision.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertRejects, assertThrows, assertStringIncludes } from "./testing/assert.ts";
import * as m from "./markup.ts";

const render = (mk: unknown) => m.renderToStringViaLinkeDOM(mk, false);
const arender = (mk: unknown) => m.asyncRenderToStringViaLinkeDOM(mk, false);

test("text content is entity-escaped (the core XSS protection)", () => {
    assertEquals(render(['div', {}, '<script>alert(1)</script>']),
                 '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
    assertEquals(render(['div', {}, 'a < b & c > d']),
                 '<div>a &lt; b &amp; c &gt; d</div>');
});

test("attribute values: double-quoted, with the dangerous char escaped (pins linkedom)", () => {
    assertEquals(render(['div', {title: 'a"b'}]), '<div title="a&quot;b"></div>');
    // Inside double quotes these are HTML-valid as-is - pinned so a linkedom
    // upgrade that changes the policy is noticed:
    assertEquals(render(['div', {title: "a'b<c>"}]), `<div title="a'b<c>"></div>`);
    assertEquals(render(['div', {title: 'a\nb'}]), '<div title="a\nb"></div>');
    // KNOWN WART: linkedom does not escape & in attr values, so a value
    // containing entity-like text ('&quot;') round-trips wrong (the browser
    // decodes it).  Safe (no injection) but lossy - pinned as documentation.
    assertEquals(render(['div', {title: 'A &quot; B'}]), '<div title="A &quot; B"></div>');
});

test("attrs: null/undefined mean ABSENT; ''/false/numbers stringify (elision regression)", () => {
    // Historically {cat: undefined} rendered as cat="" (a PRESENT empty
    // attr) - so {required: cond ? '' : undefined} was ALWAYS required.
    assertEquals(render(['div', {cat: undefined}]), '<div></div>');
    assertEquals(render(['div', {cat: null}]), '<div></div>');
    assertEquals(render(['div', {cat: ''}]), '<div cat=""></div>');
    assertEquals(render(['input', {disabled: false}]), '<input disabled="false">');  // pinned: callers pass '' or undefined
    assertEquals(render(['img', {width: 7}]), '<img width="7">');
});

test("raw text elements: JS/CSS unescaped, but a '</script' breakout throws", async () => {
    assertEquals(render(['script', {}, 'if (a < b && c) f();']),
                 '<script>if (a < b && c) f();</script>');
    assertEquals(render(['style', {}, '.a > .b { color: red }']),
                 '<style>.a > .b { color: red }</style>');
    // The breakout: text content terminates the element early and the rest
    // parses as html.  All live script content is static; the guard keeps
    // it safe when someone embeds dynamic data.
    assertThrows(() => render(['script', {}, 'x("</script><img onerror=alert(1) src=x>")']),
                 Error, 'raw-text breakout');
    assertThrows(() => render(['script', {}, 'x("</SCRIPT>")']), Error, 'breakout');  // case-insensitive
    assertThrows(() => render(['style', {}, '} </style><script>']), Error, 'breakout');
    await assertRejects(() => arender(['script', {}, Promise.resolve('</script>')]), Error, 'breakout');
});

test("escapable raw text elements (textarea/title) ARE escaped", () => {
    // linkedom serializes textarea content RAW, so we pre-escape (per spec
    // they are escapable raw text: entities decode inside them).  This is
    // load-bearing: record editors render stored USER VALUES into
    // textareas, so without it a value containing '</textarea><img
    // onerror=...>' broke out - a live stored-XSS vector.
    // (minimal escaping: & and < - a raw '>' cannot terminate the element)
    assertEquals(render(['textarea', {}, '<b>&amp;</b>']),
                 '<textarea>&lt;b>&amp;amp;&lt;/b></textarea>');
    assertEquals(render(['textarea', {}, '</textarea><img src=x onerror=alert(1)>']),
                 '<textarea>&lt;/textarea>&lt;img src=x onerror=alert(1)></textarea>');
    assertEquals(render(['title', {}, 'a </title> b']), '<title>a &lt;/title> b</title>');
});

test("tag and attr names are validated (they are emitted unescaped)", () => {
    assertThrows(() => render(['div><img src=x onerror=alert(1)>', {}, 'x']), Error, 'tag name');
    assertThrows(() => render(['div', {'a b=c onclick=alert(1)': 'v'}]), Error, 'attribute name');
    assertThrows(() => render(['', {}, 'x']), Error, 'tag name');
    // ... while the naming conventions in live use all pass:
    for (const name of ['data-foo', 'aria-label', 'hx-on::after-request', 'xlink:href', '@click', 'stroke-width'])
        assertStringIncludes(render(['div', {[name]: 'v'}]), `${name}="v"`);
    assertStringIncludes(render(['feGaussianBlur', {}, '']), '<feGaussianBlur>');
});

test("content structure: fragments flatten, null/undefined elide, primitives stringify", () => {
    assertEquals(render(['ul', {}, [[['li', {}, 'a']], [['li', {}, 'b']]]]),
                 '<ul><li>a</li><li>b</li></ul>');
    assertEquals(render(['div', {}, null, undefined, 'x']), '<div>x</div>');
    assertEquals(render(['div', {}, 1, ' ', 2.5, ' ', 10n, ' ', true]), '<div>1 2.5 10 true</div>');
    assertEquals(render([['b', {}, 'x'], ['i', {}, 'y']]), '<b>x</b><i>y</i>');  // top-level fragment
    assertEquals(render('plain'), 'plain');
});

test("void elements and document wrapping", () => {
    assertEquals(render(['br', {}]), '<br>');
    assertEquals(m.renderToStringViaLinkeDOM(['html', {}, ['body', {}, 'hi']], true),
                 '<!DOCTYPE html><html><body>hi</body></html>');
});

test("function tags render under the function's name", () => {
    function myWidget() {}
    assertEquals(render([myWidget, {}, 'x']), '<myWidget>x</myWidget>');
});

test("async renderer awaits promises in content (nested) and attr values", async () => {
    assertEquals(await arender(['div', {}, Promise.resolve(['b', {}, 'deep'])]),
                 '<div><b>deep</b></div>');
    assertEquals(await arender(['div', {}, [Promise.resolve('a'), Promise.resolve([' ', 'b'])]]),
                 '<div>a b</div>');
    assertEquals(await arender(['div', {title: Promise.resolve('t')}]), '<div title="t"></div>');
    assertEquals(await arender(['div', {title: Promise.resolve(Promise.resolve('t'))}]),
                 '<div title="t"></div>');                                  // chained promise
    assertEquals(await arender(['div', {title: Promise.resolve(undefined)}]), '<div></div>');  // -> absent
    // awaited promise results are still escaped
    assertEquals(await arender(['div', {}, Promise.resolve('<x>')]), '<div>&lt;x&gt;</div>');
});

test("sync renderer marks unawaited promises rather than emitting [object Promise]", () => {
    assertEquals(render(['div', {}, Promise.resolve('x')]), '<div>*** UNRESOLVED PROMISE ***</div>');
});

test("isElemMarkup / getElemId / flattenMarkup / createElement", () => {
    assert(m.isElemMarkup(['div', {}, 'x']) && m.isElemMarkup(['div', {}]));
    assert(!m.isElemMarkup(['div']) && !m.isElemMarkup(['div', null]) && !m.isElemMarkup('div') && !m.isElemMarkup([]));
    assertEquals(m.getElemId(['div', {id: 'a'}, 'x']), 'a');
    assertEquals(m.getElemId(['div', {}, 'x']), undefined);
    assertEquals(m.getElemId(null), undefined);
    assertEquals(m.flattenMarkup([1, [2, [3, ['b', {}, 4]]]]), [1, 2, 3, ['b', {}, 4]]);
    assertEquals(m.createElement('div', {a: 1}, 'x'), ['div', {a: 1}, 'x']);
    assertEquals(m.createElement('div', null as any, 'x'), ['div', {}, 'x']);
    assertEquals(m.createElement(undefined, null as any, 'x', 'y'), ['x', 'y']);  // fragment
    assertThrows(() => m.createElement(undefined, {a: 1} as any), Error, 'fragment');
});
