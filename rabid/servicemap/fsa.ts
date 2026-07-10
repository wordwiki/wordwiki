// Postal-code (FSA) normalization + Region-of-Waterloo classification, and the
// tally that turns a pile of raw client postal codes into the numbers the map
// and its summary render.
//
// The intake stores only the FSA (first 3 of a Canadian postal code) in
// service.client_postal, so most of this is classification, not parsing.

import { kwFsaIds } from "./boundaries.ts";

// --- Normalization ---------------------------------------------------------

// A raw postal string -> its 3-char FSA (uppercased, spaces/punctuation
// stripped), or null if it isn't a well-formed Canadian FSA (ANA: letter,
// digit, letter).  Handles full postal codes ("N2G 1H6") and bare FSAs ("n2g").
export function normalizeFsa(raw: string | null | undefined): string | null {
    if(raw == null) return null;
    const s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if(s.length < 3) return null;
    const fsa = s.slice(0, 3);
    return /^[A-Z][0-9][A-Z]$/.test(fsa) ? fsa : null;
}

// Ontario FSAs start with one of these letters (K/L/M/N/P) - used only to split
// the out-of-region bucket into "elsewhere in Ontario" vs "rest of Canada".
const ONTARIO_FIRST_LETTERS = new Set(['K', 'L', 'M', 'N', 'P']);

// --- Region-of-Waterloo place classification -------------------------------
//
// The single source of truth for which FSA belongs to which place.  KITCHENER +
// WATERLOO are exactly the 15 N2* FSAs the MAP draws (verified against the
// boundary file); CAMBRIDGE and TOWNSHIPS are summarized numerically only (the
// map stays zoomed on KW).
//
// REVIEW NEEDED against the real service area, especially the townships: N0B,
// N3A and N3B are large rural FSAs that spill beyond the Region of Waterloo, so
// only the ones your clients actually come from should live here.  This table
// is deliberately easy to edit.

const KITCHENER = ['N2A', 'N2B', 'N2C', 'N2E', 'N2G', 'N2H', 'N2M', 'N2N', 'N2P', 'N2R'];
const WATERLOO  = ['N2J', 'N2K', 'N2L', 'N2T', 'N2V'];
const CAMBRIDGE = ['N1R', 'N1S', 'N1T', 'N3C', 'N3E', 'N3H'];
// Region townships (Woolwich, Wilmot, Wellesley, North Dumfries).  Best-guess -
// see the REVIEW note above.
const TOWNSHIPS = ['N3A', 'N3B', 'N0B', 'N1P'];

// The rollup buckets shown in the city summary, in fundraising order (the three
// cities, then the townships as one line).
export const REGION_PLACES = ['Kitchener', 'Waterloo', 'Cambridge', 'Townships'] as const;
export type RegionPlace = typeof REGION_PLACES[number];

const PLACE_OF_FSA: Record<string, RegionPlace> = {};
for(const f of KITCHENER) PLACE_OF_FSA[f] = 'Kitchener';
for(const f of WATERLOO)  PLACE_OF_FSA[f] = 'Waterloo';
for(const f of CAMBRIDGE) PLACE_OF_FSA[f] = 'Cambridge';
for(const f of TOWNSHIPS) PLACE_OF_FSA[f] = 'Townships';

// Which Region place an FSA belongs to, or null if it's outside the Region.
export function regionPlaceOfFsa(fsa: string): RegionPlace | null {
    return PLACE_OF_FSA[fsa] ?? null;
}

// --- Tally -----------------------------------------------------------------

export interface OutsideBucket { label: string; count: number; }

export interface ServiceMapTally {
    // FSA -> service count for the FSAs the map DRAWS (KW N2*).  Every drawn FSA
    // is present (0 if it had no services), so the map can shade all areas.
    mapCounts: Record<string, number>;
    // The Region-of-Waterloo city rollup, in REGION_PLACES order (cities first,
    // townships last).  Kitchener + Waterloo equal the map areas; Cambridge +
    // Townships are the extra numeric context.
    regionByPlace: { place: RegionPlace; count: number }[];
    // Valid FSAs outside the Region, split Ontario / rest-of-Canada.
    outside: OutsideBucket[];
    // Blank or unparseable postal codes ("not given").
    missing: number;
    // Grand total (everything above sums to this).
    total: number;
    // Convenience subtotals.
    inRegionTotal: number;
    outsideTotal: number;
}

// Turn raw client postal strings into the full tally.  One pass; every input
// lands in exactly one bucket so the parts sum to the total (honest denominators
// for the fundraising percentages).
export function tallyPostals(rawPostals: Iterable<string | null | undefined>): ServiceMapTally {
    const mapIds = kwFsaIds();
    const mapCounts: Record<string, number> = {};
    for(const id of mapIds) mapCounts[id] = 0;

    const placeCounts = new Map<RegionPlace, number>(REGION_PLACES.map(p => [p, 0]));
    let ontarioOutside = 0, restOfCanada = 0, missing = 0, total = 0;

    for(const raw of rawPostals) {
        total++;
        const fsa = normalizeFsa(raw);
        if(fsa == null) { missing++; continue; }
        if(fsa in mapCounts) mapCounts[fsa]++;   // a drawn KW FSA
        const place = regionPlaceOfFsa(fsa);
        if(place != null) {
            placeCounts.set(place, placeCounts.get(place)! + 1);
        } else if(ONTARIO_FIRST_LETTERS.has(fsa[0])) {
            ontarioOutside++;
        } else {
            restOfCanada++;
        }
    }

    const regionByPlace = REGION_PLACES.map(place => ({ place, count: placeCounts.get(place)! }));
    const inRegionTotal = regionByPlace.reduce((s, r) => s + r.count, 0);
    const outside: OutsideBucket[] = [];
    if(ontarioOutside > 0) outside.push({ label: 'Elsewhere in Ontario', count: ontarioOutside });
    if(restOfCanada > 0)   outside.push({ label: 'Rest of Canada', count: restOfCanada });
    const outsideTotal = ontarioOutside + restOfCanada;

    return { mapCounts, regionByPlace, outside, missing, total, inRegionTotal, outsideTotal };
}
