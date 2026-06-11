// deno-lint-ignore-file no-explicit-any
/**
 * The publish-target grammar (parsePublishTarget): targets are the site's
 * own URLs, tolerant of the forms people will actually paste.
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertThrows } from "../liminal/testing/assert.ts";
import { parsePublishTarget } from "./publish.ts";

test("publish targets: the grammar", () => {
    // Top-level pages, in every spelling people will try.
    for(const t of ['', '/', 'index.html', '/index.html', 'home',
                    'https://mikmaqonline.org/index.html'])
        assertEquals(parsePublishTarget(t), {kind: 'home'}, `for '${t}'`);
    assertEquals(parsePublishTarget('404.html'), {kind: '404'});
    assertEquals(parsePublishTarget('all-words'), {kind: 'all-words'});
    assertEquals(parsePublishTarget('about-us.html'), {kind: 'about-us'});

    // Categories.
    assertEquals(parsePublishTarget('categories'), {kind: 'categories-all'});
    assertEquals(parsePublishTarget('categories.html'), {kind: 'categories-all'});
    assertEquals(parsePublishTarget('categories/water.html'),
                 {kind: 'category', slug: 'water'});

    // Books: whole site of a book, or one page in both spellings.
    assertEquals(parsePublishTarget('books'), {kind: 'books-all'});
    assertEquals(parsePublishTarget('books/PDM'), {kind: 'book', book: 'PDM'});
    assertEquals(parsePublishTarget('books/PDM/page-0101/'),
                 {kind: 'book-page', book: 'PDM', page: 101});
    assertEquals(parsePublishTarget('books/PDM/101'),
                 {kind: 'book-page', book: 'PDM', page: 101});

    // Entries: bare public id, or the full path as copied from the browser.
    assertEquals(parsePublishTarget('entries'), {kind: 'entries-all'});
    assertEquals(parsePublishTarget('entries/samqwan'),
                 {kind: 'entry-public-id', publicId: 'samqwan'});
    assertEquals(parsePublishTarget('entries/s/samqwan/samqwan.html'),
                 {kind: 'entry-public-id', publicId: 'samqwan'});
    assertEquals(parsePublishTarget('entry:121590'),
                 {kind: 'entry-id', entryId: 121590});

    // Unknowns explain themselves.
    assertThrows(() => parsePublishTarget('nonsense/abc'), Error, 'unrecognized publish target');
    assertThrows(() => parsePublishTarget('books/PDM/page-x'), Error, 'unrecognized');
});
