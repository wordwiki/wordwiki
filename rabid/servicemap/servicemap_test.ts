// The service-map core is db-free, so these are plain unit tests: normalization,
// the bucket tally (every input lands in exactly one bucket -> honest totals),
// and a structural smoke test of the rendered SVG.
import { test } from "../../liminal/testing/test.ts";
import { assert, assertEquals } from "../../liminal/testing/assert.ts";
import { markupToString } from "../../liminal/markup.ts";
import { normalizeFsa, tallyPostals } from "./fsa.ts";
import { renderServiceMap } from "./servicemap.ts";
import { kwFsaIds } from "./boundaries.ts";

test("normalizeFsa: full codes, bare FSAs, junk, blanks", () => {
    assertEquals(normalizeFsa("N2G 1H6"), "N2G");
    assertEquals(normalizeFsa("n2g1h6"), "N2G");
    assertEquals(normalizeFsa("  n2g "), "N2G");
    assertEquals(normalizeFsa("N2L"), "N2L");
    assertEquals(normalizeFsa(""), null);
    assertEquals(normalizeFsa(null), null);
    assertEquals(normalizeFsa("N2"), null);       // too short
    assertEquals(normalizeFsa("NN2"), null);      // not letter-digit-letter
    assertEquals(normalizeFsa("123"), null);
});

test("tallyPostals: every input lands in exactly one bucket; parts sum to total", () => {
    const raw = ["N2G", "N2G", "N2L", "N1R", "N3A", "K1A", "V6B", "", "junk"];
    const t = tallyPostals(raw);

    // The map FSAs are 0-filled and incremented.
    assertEquals(t.mapCounts["N2G"], 2);
    assertEquals(t.mapCounts["N2L"], 1);
    assertEquals(t.mapCounts["N2A"], 0);          // present even with no services

    // Region rollup, in the fixed order.
    assertEquals(t.regionByPlace.map(r => [r.place, r.count]),
        [["Kitchener", 2], ["Waterloo", 1], ["Cambridge", 1], ["Townships", 1]]);
    assertEquals(t.inRegionTotal, 5);

    // Out-of-region split, blanks, and the grand total.
    assertEquals(t.outside.find(o => o.label === "Elsewhere in Ontario")?.count, 1);
    assertEquals(t.outside.find(o => o.label === "Rest of Canada")?.count, 1);
    assertEquals(t.outsideTotal, 2);
    assertEquals(t.missing, 2);                   // "" + "junk"
    assertEquals(t.total, 9);
    assertEquals(t.inRegionTotal + t.outsideTotal + t.missing, t.total);
});

test("tallyPostals: N1P is Cambridge; N0B is its own partly-in-Region rural bucket", () => {
    const t = tallyPostals(["N1P", "N0B", "N0B", "N2G", "K1A"]);
    // N1P classifies as Cambridge (data-derived: 100% inside the Cambridge CSD).
    assertEquals(t.regionByPlace.find(r => r.place === "Cambridge")?.count, 1);
    // N0B is NOT counted as outside-Ontario, nor folded into townships.
    assertEquals(t.edge.find(o => o.label.includes("N0B"))?.count, 2);
    assertEquals(t.regionByPlace.find(r => r.place === "Townships")?.count, 0);
    assertEquals(t.outside.find(o => o.label === "Elsewhere in Ontario")?.count, 1); // just K1A
    // Everything still adds up: region + edge + outside + missing = total.
    const edgeTotal = t.edge.reduce((s, o) => s + o.count, 0);
    assertEquals(t.inRegionTotal + edgeTotal + t.outsideTotal + t.missing, t.total);
});

test("tallyPostals: mapCounts covers exactly the drawn FSAs", () => {
    const t = tallyPostals([]);
    assertEquals(new Set(Object.keys(t.mapCounts)), kwFsaIds());
    assert(Object.values(t.mapCounts).every(v => v === 0));
});

test("renderServiceMap large: one path per drawn FSA + the summary numbers", () => {
    const t = tallyPostals(["N2G", "N2G", "N2L", "K1A", ""]);
    const html = markupToString(renderServiceMap(t, { size: "large", title: "Test map" }));
    assert(html.includes("<svg"), "renders an inline svg");
    const paths = (html.match(/<path\b/g) ?? []).length;
    assertEquals(paths, kwFsaIds().size, "one filled path per drawn FSA");
    assert(html.includes("Test map"));
    assert(html.includes("In Region of Waterloo"));
    assert(html.includes("Total services"));
    assert(html.includes("No postal code given"));
    assert(html.includes("Statistics Canada"), "carries the licence attribution");
});

test("renderServiceMap small: an svg + a compact caption, no per-FSA numbers", () => {
    const t = tallyPostals(["N2G", "K1A", "K1A", "", ""]);
    const html = markupToString(renderServiceMap(t, { size: "small" }));
    assert(html.includes("<svg"));
    assert(html.includes("in-region"));
    assert(html.includes("outside the region"));
    assert(html.includes("no postal code"));
    // The small map omits the per-area <text> labels (illegible at that size).
    assert(!html.includes("<text"), "no per-FSA text labels on the small map");
});
