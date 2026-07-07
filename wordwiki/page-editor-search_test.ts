/**
 * The reference-page editor's text search (render-page-editor.ts).  The form
 * action must pass the WHOLE `query` binding, never `query.searchText`:
 * strict routeterp treats every member access as a route capability, so a
 * `query.member` expression in a route URL throws RouteUndeclaredError and
 * the search dies with {"error":"not found"} (the route-undeclared pattern's
 * data-access cousin - bitten 2026-07-07).
 */
import { test } from "../liminal/testing/test.ts";
import { assertEquals, assertStringIncludes } from "../liminal/testing/assert.ts";
import { markupToString } from "../liminal/markup.ts";
import { renderTextSearchForm, renderTextSearchForm2 } from "./render-page-editor.ts";

const cfg = {layer_id: 11, reference_layer_ids: [4], title: 'T',
             is_popup_editor: true, locked_bounding_group_id: 221719};

test("page-editor search form: action passes `query` whole (no member access)", () => {
    for(const form of [renderTextSearchForm(4, cfg), renderTextSearchForm2(4, cfg)]) {
        const html = markupToString(form);
        assertStringIncludes(html, ", query)");
        assertEquals(html.includes("query."), false);
    }
});
