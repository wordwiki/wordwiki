# Service map

A self-contained choropleth of Red Raccoon services by postal-code area (FSA —
the first 3 characters of a Canadian postal code, stored in
`service.client_postal`). It renders a zoomed-in Kitchener-Waterloo map shaded by
service volume, with the wider Region of Waterloo (Cambridge, townships),
out-of-region, and "no postal code given" counts summarized alongside. Used for
fundraising, so it aims to be pretty and to add up honestly.

Deliberately **separate from the rest of the system**: the renderer is pure
(a tally in → SVG out), with no database, network, or client JS. It renders the
same on a server, in a test, and in a printed PDF.

## Files

- `data/kw-fsa.geojson` — the 15 KW N2\* FSA boundaries (WGS84, FSA code only),
  simplified from Statistics Canada's 2021 Census cartographic FSA boundary file.
- `build-boundaries.sh` — regenerates the above from StatCan's ArcGIS REST
  service (needs `curl` + `npx`; run only when boundaries/FSA set change).
- `boundaries.ts` — loads/parses the GeoJSON (Polygon + MultiPolygon).
- `fsa.ts` — FSA normalization, the Region-of-Waterloo place table, and
  `tallyPostals()` (raw postal strings → the counts the map + summary need).
- `servicemap.ts` — `renderServiceMap(tally, {size})` → SVG choropleth + summary.
  `size: 'large'` is the yearly fundraising view; `'small'` is the per-event
  footer.
- `servicemap_test.ts` — normalization, bucket, and render-structure tests.

## Usage

```ts
import { tallyPostals } from "./servicemap/fsa.ts";
import { renderServiceMap } from "./servicemap/servicemap.ts";

const postals = services.map(s => s.client_postal);   // from the service table
const tally = tallyPostals(postals);
const markup = renderServiceMap(tally, { size: "large", title: "Services 2025" });
```

## Data & licence

Boundaries and (future) population come from **Statistics Canada, 2021 Census**,
under the [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/reference/licence).
Attribution is rendered on the map. The FSA boundary product is Catalogue no.
92-179-X.

## Review / to-do

- **FSA → place table** in `fsa.ts` (Kitchener/Waterloo/Cambridge/Townships):
  Kitchener + Waterloo are the verified N2\* map FSAs; **the Cambridge and
  especially township FSAs (N0B/N3A/N3B/N1P) need a review against the real
  service area** — those rural FSAs spill beyond the Region. Easy to edit.
- **Per-resident metric** (services per 1,000 residents) is planned: add a
  committed `FSA → population` table (StatCan Census) and a metric toggle.
- Integration (yearly Reports page + per-event footer embed) lives outside this
  directory, in the rabid report/event layers.
