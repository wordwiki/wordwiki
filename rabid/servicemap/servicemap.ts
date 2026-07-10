// The pure service-map renderer: a tally in, a self-contained SVG choropleth
// (plus its summary) out.  No database, no network, no client JS - it just
// projects the committed KW FSA boundaries and shades them by service count, so
// it renders identically on a server, in a test, or in a print/PDF.
//
// The map is deliberately zoomed to Kitchener-Waterloo (the drawn FSAs); the
// wider Region of Waterloo (Cambridge, townships) and out-of-region / no-postal
// counts live in the summary beside it.

import { h, type Markup } from "../../liminal/markup.ts";
import { kwFsaShapes, type FsaShape } from "./boundaries.ts";
import type { ServiceMapTally } from "./fsa.ts";

export interface ServiceMapOptions {
    // 'large' (default): full map with per-FSA numbers, legend, and the whole
    // summary - the yearly fundraising view.  'small': a compact shaded map + a
    // one-line caption, for the bottom of an event.
    size?: 'large' | 'small';
    title?: string;
}

// ColorBrewer "Blues" (5-class) - a clean sequential ramp that prints well and
// reads as reach/coverage.  Index 0 is the lightest non-zero class.
const BLUES = ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'];
const NO_SERVICE_FILL = '#f4f4f4';   // an FSA with zero services
const AREA_STROKE = '#ffffff';       // the hairline between areas
const OUTER_TEXT = '#1a1a1a';

// --- Projection ------------------------------------------------------------

// Web Mercator (matches OSM), in radians-ish units; the absolute scale is
// irrelevant because we fit the projected bounds to the viewport.
function mercator(lon: number, lat: number): [number, number] {
    const x = (lon * Math.PI) / 180;
    const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 360)));
    return [x, y];
}

interface Projected {
    // SVG path data for the whole (multi)polygon, and the label anchor.
    d: string;
    cx: number; cy: number;
    id: string;
}

// Project every shape into a shared SVG coordinate box `width` wide, with
// `pad` px of margin; returns the projected shapes and the box height.
function projectShapes(shapes: FsaShape[], width: number, pad: number):
        { shapes: Projected[]; height: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for(const s of shapes)
        for(const poly of s.polygons)
            for(const ring of poly)
                for(const [lon, lat] of ring) {
                    const [x, y] = mercator(lon, lat);
                    if(x < minX) minX = x; if(x > maxX) maxX = x;
                    if(y < minY) minY = y; if(y > maxY) maxY = y;
                }
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
    const scale = (width - 2 * pad) / spanX;
    const height = spanY * scale + 2 * pad;
    // Mercator y grows northward; SVG y grows down, so flip.
    const px = (x: number) => pad + (x - minX) * scale;
    const py = (y: number) => pad + (maxY - y) * scale;
    const r = (n: number) => Math.round(n * 10) / 10;

    const out: Projected[] = shapes.map(s => {
        let d = '';
        // Area-weighted centroid of the largest outer ring, for the label.
        let bestArea = -1, cx = 0, cy = 0;
        for(const poly of s.polygons) {
            for(let ri = 0; ri < poly.length; ri++) {
                const ring = poly[ri];
                d += 'M' + ring.map(([lon, lat]) => {
                    const [x, y] = mercator(lon, lat);
                    return `${r(px(x))} ${r(py(y))}`;
                }).join('L') + 'Z';
                if(ri === 0) {
                    const c = ringCentroid(ring, px, py);
                    if(c.area > bestArea) { bestArea = c.area; cx = c.x; cy = c.y; }
                }
            }
        }
        return { id: s.id, d, cx: r(cx), cy: r(cy) };
    });
    return { shapes: out, height: Math.round(height) };
}

// Signed-area centroid of a projected ring (in SVG space).
function ringCentroid(ring: [number, number][],
                      px: (x: number) => number, py: (y: number) => number):
        { x: number; y: number; area: number } {
    let a = 0, cx = 0, cy = 0;
    const pts = ring.map(([lon, lat]) => {
        const [mx, my] = mercator(lon, lat);
        return [px(mx), py(my)] as [number, number];
    });
    for(let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        const cross = x0 * y1 - x1 * y0;
        a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
    }
    if(a === 0) { // degenerate - fall back to the vertex mean
        const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        return { x: mx, y: my, area: 0 };
    }
    a *= 0.5;
    return { x: cx / (6 * a), y: cy / (6 * a), area: Math.abs(a) };
}

// --- Colour scale ----------------------------------------------------------

interface Scale {
    // The upper bound (inclusive) of each of the 5 non-zero classes.
    breaks: number[];
    fill: (count: number) => string;
    // Human labels per class, e.g. "1–12", for the legend.
    legend: { color: string; label: string }[];
}

// Quantile breaks over the NON-ZERO counts (zeros get their own class), so the
// classes carry roughly equal numbers of areas even under a skewed spread.
function quantileScale(counts: number[]): Scale {
    const nonzero = counts.filter(c => c > 0).sort((a, b) => a - b);
    const n = BLUES.length;
    if(nonzero.length === 0) {
        return {
            breaks: [], fill: () => NO_SERVICE_FILL,
            legend: [{ color: NO_SERVICE_FILL, label: 'no services' }],
        };
    }
    // Class upper bounds at the 1/n..n/n quantiles (deduped, so sparse data
    // collapses to fewer visible classes rather than empty ones).
    const q = (p: number) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))];
    const rawBreaks = [];
    for(let i = 1; i <= n; i++) rawBreaks.push(q(i / n));
    rawBreaks[rawBreaks.length - 1] = nonzero[nonzero.length - 1];
    const breaks: number[] = [];
    for(const b of rawBreaks) if(breaks.length === 0 || b > breaks[breaks.length - 1]) breaks.push(b);

    const fill = (count: number) => {
        if(count <= 0) return NO_SERVICE_FILL;
        for(let i = 0; i < breaks.length; i++) if(count <= breaks[i]) return BLUES[i];
        return BLUES[breaks.length - 1];
    };
    const legend: { color: string; label: string }[] = [];
    let lo = 1;
    for(let i = 0; i < breaks.length; i++) {
        const hi = breaks[i];
        legend.push({ color: BLUES[i], label: lo === hi ? `${lo}` : `${lo}–${hi}` });
        lo = hi + 1;
    }
    return { breaks, fill, legend };
}

// --- Rendering -------------------------------------------------------------

const pct = (n: number, total: number) => total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';

export function renderServiceMap(tally: ServiceMapTally, opts: ServiceMapOptions = {}): Markup {
    const size = opts.size ?? 'large';
    const small = size === 'small';
    const shapes = kwFsaShapes();
    const width = small ? 280 : 620;
    const { shapes: projected, height } = projectShapes(shapes, width, small ? 6 : 14);
    const scale = quantileScale(shapes.map(s => tally.mapCounts[s.id] ?? 0));

    const svg = ['svg',
        { xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${width} ${height}`,
          width: String(width), height: String(height), role: 'img',
          'aria-label': 'Services by postal-code area in Kitchener-Waterloo',
          style: 'max-width:100%; height:auto; display:block;' },
        ...projected.map(p => {
            const count = tally.mapCounts[p.id] ?? 0;
            return ['path', { d: p.d, fill: scale.fill(count), stroke: AREA_STROKE,
                              'stroke-width': small ? '0.6' : '1', 'stroke-linejoin': 'round' }];
        }),
        // Per-FSA numbers only on the large map (they'd be illegible when small).
        ...(small ? [] : projected.flatMap(p => {
            const count = tally.mapCounts[p.id] ?? 0;
            const dark = count > (scale.breaks[Math.max(0, scale.breaks.length - 2)] ?? Infinity);
            const textColor = dark ? '#ffffff' : OUTER_TEXT;
            return [
                ['text', { x: String(p.cx), y: String(p.cy - 1), 'text-anchor': 'middle',
                           'font-size': '9', 'font-weight': '600', fill: textColor,
                           'font-family': 'system-ui, sans-serif' }, p.id],
                ['text', { x: String(p.cx), y: String(p.cy + 9), 'text-anchor': 'middle',
                           'font-size': '10', fill: textColor,
                           'font-family': 'system-ui, sans-serif' }, String(count)],
            ];
        })),
    ];

    if(small) return renderSmall(svg, scale, tally, opts.title);
    return renderLarge(svg, scale, tally, opts.title);
}

// --- Large: map + full summary (the yearly fundraising view) ----------------

function renderLarge(svg: Markup, scale: Scale, t: ServiceMapTally, title?: string): Markup {
    const legend = ['div', { style: 'display:flex; flex-wrap:wrap; gap:0.5rem 0.9rem; margin-top:0.5rem;' },
        ['span', { style: 'font-size:0.8rem; color:#555;' }, 'Services per area:'],
        ...scale.legend.map(l =>
            ['span', { style: 'display:inline-flex; align-items:center; gap:0.3rem; font-size:0.8rem;' },
                ['span', { style: `display:inline-block; width:0.9rem; height:0.9rem; border:1px solid #ccc;`
                                 + `background:${l.color};` }],
                l.label]),
    ];

    const summaryRow = (label: string, count: number, opts: { bold?: boolean; muted?: boolean } = {}) =>
        ['tr', { style: opts.muted ? 'color:#777;' : undefined },
            ['td', { style: `padding:0.15rem 0.6rem 0.15rem 0; ${opts.bold ? 'font-weight:600;' : ''}` }, label],
            ['td', { style: `text-align:right; ${opts.bold ? 'font-weight:600;' : ''}` }, String(count)],
            ['td', { style: 'text-align:right; padding-left:0.6rem; color:#999; font-size:0.85em;' },
                pct(count, t.total)]];

    const summary = ['div', { style: 'min-width:16rem;' },
        ['table', { style: 'border-collapse:collapse; font-size:0.9rem; width:100%;' },
            ['tbody', {},
                ...t.regionByPlace.map(r => summaryRow(r.place, r.count)),
                summaryRow('In Region of Waterloo', t.inRegionTotal, { bold: true }),
                ...t.outside.map(o => summaryRow(o.label, o.count, { muted: true })),
                summaryRow('No postal code given', t.missing, { muted: true }),
                ['tr', {}, ['td', { colspan: '3', style: 'border-top:1px solid #ddd; height:0.4rem;' }]],
                summaryRow('Total services', t.total, { bold: true }),
            ]],
        legend,
    ];

    return ['div', { class: 'lm-servicemap', style: 'display:flex; flex-wrap:wrap; gap:1.5rem; align-items:flex-start;' },
        title ? ['h3', { style: 'width:100%; margin:0 0 0.3rem;' }, title] : undefined,
        ['div', { style: 'flex:1 1 340px; min-width:280px;' }, svg],
        summary,
        ['div', { style: 'width:100%; font-size:0.7rem; color:#999; margin-top:0.5rem;' },
            'Boundaries: Statistics Canada 2021 Census (Open Licence). Kitchener-Waterloo shown; '
            + 'Cambridge, townships and out-of-region counts summarized at right.'],
    ];
}

// --- Small: map + one-line caption (the per-event footer) -------------------

function renderSmall(svg: Markup, scale: Scale, t: ServiceMapTally, title?: string): Markup {
    const gradient = ['span', { style: 'display:inline-flex; align-items:center; gap:0.15rem;' },
        ['span', { style: 'font-size:0.7rem; color:#777;' }, 'fewer'],
        ...scale.legend.map(l =>
            ['span', { style: `display:inline-block; width:0.7rem; height:0.7rem; background:${l.color}; `
                             + 'border:1px solid #ccc;' }]),
        ['span', { style: 'font-size:0.7rem; color:#777;' }, 'more'],
    ];
    const bits: string[] = [];
    if(t.outsideTotal > 0) bits.push(`${t.outsideTotal} outside the region`);
    if(t.missing > 0) bits.push(`${t.missing} no postal code`);
    return ['div', { class: 'lm-servicemap lm-servicemap-small', style: 'max-width:300px;' },
        title ? ['div', { style: 'font-size:0.85rem; font-weight:600; margin-bottom:0.2rem;' }, title] : undefined,
        svg,
        ['div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-top:0.25rem;' },
            gradient],
        bits.length
            ? ['div', { style: 'font-size:0.72rem; color:#777; margin-top:0.15rem;' },
                `${t.inRegionTotal} in-region · ${bits.join(' · ')}`]
            : undefined,
    ];
}
