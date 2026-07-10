// Loads the committed KW forward-sortation-area (FSA) boundary geometry.
//
// data/kw-fsa.geojson is the 15 Kitchener-Waterloo N2* FSAs, in WGS84
// (lon/lat), simplified from Statistics Canada's 2021 Census cartographic FSA
// boundary file (see README.md for provenance + licence + the regen script).
// It carries only the CFSAUID (the FSA code); everything else is derived here.
//
// The file is read relative to THIS module (import.meta.url), not the process
// cwd - the rabid server runs from an instance dir, but the source tree (and so
// this data file) is always where the code is.

// A ring is a closed loop of [lon, lat] points; a polygon is an outer ring plus
// optional holes; an FSA is one or more polygons (islands / split areas).
export type Ring = [number, number][];
export type Polygon = Ring[];
export interface FsaShape {
    id: string;          // the FSA code, e.g. "N2G"
    polygons: Polygon[];
}

let _cache: FsaShape[] | undefined;

// The KW FSA shapes, parsed once.  GeoJSON Polygon and MultiPolygon are both
// normalized to a list of polygons so callers have one shape to draw.
export function kwFsaShapes(): FsaShape[] {
    if(_cache) return _cache;
    const text = Deno.readTextFileSync(new URL('./data/kw-fsa.geojson', import.meta.url));
    const gj = JSON.parse(text) as {features: Array<{
        properties: {CFSAUID: string},
        geometry: {type: 'Polygon'|'MultiPolygon', coordinates: any},
    }>};
    _cache = gj.features.map(f => ({
        id: f.properties.CFSAUID,
        polygons: f.geometry.type === 'Polygon'
            ? [f.geometry.coordinates as Polygon]
            : (f.geometry.coordinates as Polygon[]),
    })).sort((a, b) => a.id.localeCompare(b.id));
    return _cache;
}

// The set of FSA codes the MAP draws (the KW N2* areas).  The Region-of-Waterloo
// city summary is broader (Cambridge, townships) and lives in fsa.ts - those are
// counted but not drawn, since the map is deliberately zoomed to KW.
export function kwFsaIds(): Set<string> {
    return new Set(kwFsaShapes().map(s => s.id));
}
