// deno-lint-ignore-file no-unused-vars, require-await, no-explicit-any, no-unreachable, ban-types

import * as pageEditorModule from './page-editor.ts';
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "../liminal/db.ts";
import { selectLayer, selectLayerByLayerName } from "./scanned-document.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, selectScannedDocumentByFriendlyId, ScannedPage, ScannedPageOpt, selectScannedPage, selectScannedPageByPageNumber, selectBoundingGroup, BoundingBox, boundingBoxFieldNames, Shape, BoundingGroup, boundingGroupFieldNames, selectBoundingBoxesForGroup, maxPageNumberForDocument, updateBoundingBox, getOrCreateNamedLayer, selectBoundingBox} from './scanned-document.ts';
import * as schema from './scanned-document.ts';
import {block} from "../liminal/strings.ts";
import * as utils from "../liminal/utils.ts";
import {range} from "../liminal/utils.ts";
//import { writeAll } from "https://deno.land/std@0.195.0/streams/write_all.ts";
import { renderToStringViaLinkeDOM, asyncRenderToStringViaLinkeDOM, Markup } from '../liminal/markup.ts';
import * as config from './config.ts';
import * as derivedPageImages from './derived-page-images.ts';
import * as templates from './templates.ts';
import {Response, ResponseMarker, forwardResponse} from '../liminal/http-server.ts';
import {route, authenticated, hostOrAdmin} from '../liminal/security.ts';
import * as random from "../liminal/random.ts";
import * as entrySchema from './entry-schema.ts';
// Type-only: erased at runtime, so no import cycle.  The app instance
// arrives via the provider hook below (the templates-provider pattern) -
// a VALUE import of wordwiki.ts from here broke module initialization
// order (three test files died with "Cannot access 'users' before
// initialization").
import type { WordWiki } from './wordwiki.ts';

// Injected by the WordWiki ctor.
let pageEditorAppProvider: (() => WordWiki) | undefined = undefined;
export function setPageEditorAppProvider(p: () => WordWiki): void {
    pageEditorAppProvider = p;
}
function pageEditorApp(): WordWiki {
    return (pageEditorAppProvider
        ?? utils.panic('page-editor app provider not set (WordWiki ctor injects it)'))();
}

type GroupJoinPartial = Pick<BoundingGroup, 'column_number'|'heading_level'|'heading'|'color'>;
type BoxGroupJoin = BoundingBox & GroupJoinPartial;

export const boxesForPageLayer = ()=>db().
    prepare<BoxGroupJoin, {page_id:number, layer_id:number}>(
        block`
/**/      SELECT ${boundingBoxFieldNames.map(n=>'bb.'+n).join()},
/**/             bg.column_number, bg.heading_level, bg.heading, bg.color
/**/         FROM bounding_box AS bb LEFT JOIN bounding_group AS bg USING(bounding_group_id)
/**/         WHERE bb.page_id = :page_id AND
/**/               bb.layer_id = :layer_id
/**/         ORDER BY bb.x, bb.y, bb.bounding_box_id`);


// export interface PageRef {
//     by_page_id: { page_id: number } | undefined;
//     by_document_id: { document_id: string, page_number: number; } | undefined;
//     by_friendly_id: { friendly_document_id: string, page_number: number; } | undefined;
// }



export interface PageRenderConfig {
    title?: string,
    layer_id: number,
    reference_layer_ids: number[],
    locked_bounding_group_id?: number,
    highlight_ref_bounding_box_ids?: number[],
    scale_factor?:number
    total_pages_in_document?: number,
}

export interface PageEditorConfig extends PageRenderConfig {
    is_popup_editor?: boolean,
}

export interface PageViewerConfig extends PageRenderConfig {
}

// TODO: somewhat random set of entry points here - we refactored the
//       PageRenderer, and these shim methods allow code based on the old
//       API to still work.

export async function pageEditor(friendly_document_id: string,
                                 page_number: number=1,
                                 reference_layer_name: string = 'Text'): Promise<any> {

    const document = selectScannedDocumentByFriendlyId().required({friendly_document_id});
    const document_id = document.document_id;
    const taggingLayer = getOrCreateNamedLayer(document_id, 'Tagging', 0);
    const referenceLayer = selectLayerByLayerName().required({document_id, layer_name: reference_layer_name});
    return renderPageEditorByPageNumber(
        document_id, page_number,
        {layer_id: taggingLayer,
         reference_layer_ids: [referenceLayer.layer_id]});
}

export function renderPageEditorByPageNumber(document_id: number,
                                             page_number: number,
                                             cfg: PageEditorConfig): any {
    const document = selectScannedDocument().required({document_id});
    const page = selectScannedPageByPageNumber().required({document_id, page_number});
    return renderPageEditorByPageId(page.page_id, cfg);
}

export function renderPageEditorByPageId(page_id: number,
                                         cfg: PageEditorConfig): any {
    return templates.pageTemplate(renderPageEditorCoreByPageId(page_id, cfg));
}

export function renderPageEditorCoreByPageId(page_id: number,
                                             cfg: PageEditorConfig): templates.PageContent {
    return renderPageEditor(cfg, page_id);
}

/**
 *
 */
export function renderPageEditor(cfg: PageEditorConfig, page_id: number): templates.PageContent {

    const page = selectScannedPage().required({page_id});
    const document_id = page.document_id;
    const document = selectScannedDocument().required({document_id});

    const title = cfg.title || document.title;

    const total_pages_in_document = cfg.total_pages_in_document
        ?? maxPageNumberForDocument().required({document_id: page.document_id}).max_page_number;

    const annotatedPage = renderAnnotatedPage(cfg, page_id).markup;

    const head = [
        // this CSS is loaded on all pages of the site.
        //['link', {href: '/resources/page-editor.css', rel:'stylesheet', type:'text/css'}],
        ['script', {src:'/scripts/wordwiki/page-editor.js'}],
    ];

    const body = [
        ['div', {},
         ['h1', {}, `${document.title} - Page Image #${page.page_number}`],
         cfg.title && ['h2', {}, cfg.title],
         cfg.locked_bounding_group_id && [
             ['div', {},
              ['button', {onclick:`window.opener.postMessage({action: 'reloadBoundingGroup', boundingGroupId: ${cfg.locked_bounding_group_id}}); window.close();`}, 'Done editing reference']],
         ],

         renderPageJumper(page.page_number, total_pages_in_document,
                          (page_number: number) =>
             `/ww/wordwiki.pages.renderPageEditorByPageNumber(${document_id}, ${page_number}, ${JSON.stringify(cfg)})`),
        ], // /div

        (cfg.reference_layer_ids.length === 1
            ? renderTextSearchForm(cfg.reference_layer_ids[0], cfg)
            : []),

        // The page-at-a-time layout (page-editor-change.md): the annotated
        // page beside the page word sidebar.  The single-group popup editor
        // (locked mode) keeps the plain layout - the sidebar is page-level
        // workflow, noise when editing one reference.
        (cfg.locked_bounding_group_id || cfg.is_popup_editor)
            ? annotatedPage
            : [['div', {class: 'pe-layout'},
                ['div', {class: 'pe-main'}, annotatedPage],
                renderPageWordSidebar(page_id, cfg.layer_id),
                // The cursor-following word-summary tooltip (filled by the
                // client from the sidebar rows).
                ['div', {id: 'peHoverTip', class: 'pe-hover-tip', style: 'display:none;'}]],
               // The gesture/key reference (dz: the bindings were
               // undiscoverable - document them on the page itself).
               renderPageEditorHelp()],

        // Array.from(boxesByGroup.keys()).map(bounding_group_id =>
        //     ['p', {},
        //      renderStandaloneGroup('/', bounding_group_id)]
                                           // ),
        //config.bootstrapScriptTag,

    ]; // body

    //console.info('PAGE BODY', JSON.stringify(body, undefined, 2));
    // The scanned-page image + bounding boxes need the full viewport width.
    return {title, head, body, fullBleed: true};
}

// --------------------------------------------------------------------------------
// --- Page word sidebar (page-editor-change.md) ------------------------------------
// --------------------------------------------------------------------------------
//
// The editors transcribe the PDM one page at a time and want to interact at
// that level: a narrow side panel of every word with scanned content on the
// current page, in READING ORDER (the transcription/elder-review order),
// with two-way hover sync against the page's tagged groups and a tail of
// groups no word references yet.  The panel doubles as the data source for
// the hover tooltip on the page's grey regions (the client clones the row's
// summary line) - one render of each summary, one source of truth.

interface PageWordRow { entry_id: number; groupIds: number[]; }

/** The words with scanned content on this page: entry + the page's bounding
 *  groups its document references point at, in reading order (same query
 *  shape as editorReports.entriesByBookPage - dz: the sidebar is that
 *  report as a panel). */
function pageWordRows(page_id: number): PageWordRow[] {
    const refs = db().all<{bounding_group_id: number, entry_id: number}, {page_id: number}>(
        block`
/**/     SELECT DISTINCT bg.bounding_group_id AS bounding_group_id, ref.id1 AS entry_id
/**/       FROM dict AS ref
/**/         LEFT JOIN bounding_group AS bg ON ref.attr1 = bg.bounding_group_id
/**/         LEFT JOIN bounding_box AS bb ON bb.bounding_group_id = bg.bounding_group_id
/**/       WHERE ref.valid_to = 9007199254740991 AND
/**/             ref.ty = 'ref' AND
/**/             bb.page_id = :page_id
/**/       ORDER BY bb.y, bb.x, ref.id1`, {page_id});
    const byEntry = new Map<number, PageWordRow>();
    for(const r of refs) {
        let row = byEntry.get(r.entry_id);
        if(!row) byEntry.set(r.entry_id, row = {entry_id: r.entry_id, groupIds: []});
        if(!row.groupIds.includes(r.bounding_group_id)) row.groupIds.push(r.bounding_group_id);
    }
    return [...byEntry.values()];
}

/** The gesture/key reference at the bottom of the page editor (dz
 *  2026-07-09: the bindings were completely undiscoverable).  KEEP IN SYNC
 *  with scannedPageMouseDown / pageWordKeydown / pageContextMenu in
 *  page-editor.ts - this table IS their documentation. */
function renderPageEditorHelp(): any {
    const row = (gesture: string, what: string) =>
        ['tr', {}, ['th', {}, gesture], ['td', {}, what]];
    return ['div', {class: 'pe-help'},
        ['h5', {}, 'Mouse & keys'],
        ['table', {},
         ['tbody', {},
          row('drag on the page', 'draw a box, starting a NEW word group'),
          row('Ctrl+drag', 'draw a box into the currently selected group'),
          row('Shift', 'hold to force box-drawing even on top of existing boxes (add Ctrl to target the selected group)'),
          row('click a grey text box', 'copy it into a NEW word group'),
          row('Ctrl+click a grey text box', 'copy it into the selected group'),
          row('click a colored box', 'select its group (click again to cycle overlapping boxes)'),
          row('Ctrl+click a box in the selected group', 'remove it (a hand-drawn box is deleted; an imported text box reverts to grey)'),
          row('drag a box / its corner circles', 'move / resize it'),
          row('hover a tagged region', 'see the word (tooltip + sidebar highlight)'),
          row('o / e while hovering', 'open / edit the hovered word'),
          row('right-click a tagged region', 'menu: open or edit its word(s), remove the clicked box'),
         ]]];
}

/** The sidebar panel.  Also a ROUTE (PageRoutes) so the client can re-fetch
 *  it after tagging mutations.  Rows carry data-group-ids for the client's
 *  two-way hover sync with the page's `svg#bg_<id>` groups. */
export function renderPageWordSidebar(page_id: number, layer_id: number): any {
    return renderPageWordSidebarCore(pageEditorApp(), page_id, layer_id);
}

/** The app-parameterized core (tests pass their fixture WordWiki - the
 *  getWordWiki() singleton would be a SECOND instance over the test db). */
export function renderPageWordSidebarCore(ww: WordWiki, page_id: number, layer_id: number): any {
    const lane = ww.workingLane()?.orthography;
    const rows = pageWordRows(page_id);
    const entriesById = new Map<number, entrySchema.Entry>(
        ww.store.entries.map((e: entrySchema.Entry)=>[e.entry_id, e]));

    // Tagged groups no word references yet - exactly what page-at-a-time
    // review should surface (orphaned tags), in page position order.
    const referenced = new Set(rows.flatMap(r=>r.groupIds));
    const untagged = loadBookPageScanData(page_id, layer_id).groups
        .filter(g=>!referenced.has(g.bounding_group_id) && g.boxes.length > 0)
        .toSorted((a, b)=>Math.min(...a.boxes.map(x=>x.y)) - Math.min(...b.boxes.map(x=>x.y)))
        .map(g=>g.bounding_group_id);

    const rowProps = (groupIds: number[]) => ({
        'data-group-ids': groupIds.join(' '),
        onmouseenter: 'pageWordRowEnter(event)',
        onmouseleave: 'pageWordRowLeave(event)'});

    const wordRow = (r: PageWordRow) => {
        const e = entriesById.get(r.entry_id);
        // A ref pointing at a deleted/unknown entry renders nothing (the
        // group still shows in the untagged tail? no - it IS referenced;
        // just skip the row rather than crash the editor).
        if(!e) return undefined;
        return ['li', {class: 'pe-word', ...rowProps(r.groupIds)},
                templates.lexemeLink(r.entry_id,
                    entrySchema.renderEntryCompactSummary(e, {orthography: lane}),
                    // No not-public badge here (dz: not worth the clutter
                    // in the tight sidebar).
                    {viewOrthography: lane, newTab: true, badge: false})];
    };

    return ['div', {id: 'pageWordSidebar', class: 'pe-sidebar'},
            ['div', {class: 'pe-sidebar-head'},
             ['button', {id: 'pageWordSidebarToggle', class: 'pe-sidebar-toggle',
                         onclick: 'togglePageWordSidebar()',
                         title: 'Show/hide the page word list'}, '☰'],
             ['span', {class: 'pe-sidebar-title'},
              `Words on this page (${rows.length})`]],
            ['ul', {class: 'pe-sidebar-list'},
             rows.map(wordRow),
             untagged.length > 0
                 ? [['li', {class: 'pe-sidebar-subhead'},
                     `Groups not yet linked to a word (${untagged.length})`],
                    untagged.map(id=>
                        ['li', {class: 'pe-word pe-untagged d-flex align-items-center', ...rowProps([id])},
                         ['span', {class: 'flex-grow-1'}, `Group ${id}`],
                         // Delete this orphaned group (no confirm - dz).
                         ['button', {type: 'button', class: 'btn btn-sm btn-link p-0 ms-1 text-danger pe-group-delete',
                                     title: 'Delete this group',
                                     onclick: `deletePageGroup(${id})`}, '×']])]
                 : undefined]];
}

/**
 *
 */
export function renderPageViewer(cfg: PageViewerConfig, page_id: number, pageJumpUrlFn: (page_number:number)=>string): templates.PageContent {

    const page = selectScannedPage().required({page_id});
    const document_id = page.document_id;
    const document = selectScannedDocument().required({document_id});

    const title = cfg.title || document.title;

    const total_pages_in_document = cfg.total_pages_in_document
        ?? maxPageNumberForDocument().required({document_id: page.document_id}).max_page_number;

    const {markup, groupIds} = renderAnnotatedPage(cfg, page_id);

    const head = [
        //['link', {href: '/resources/page-viewer.css', rel:'stylesheet', type:'text/css'}],
        ['script', {src:'/scripts/wordwiki/page-viewer.js'}],
    ];

    const body = [
        ['div', {},
         ['h1', {}, `${document.title} - Page ${page.page_number}`],
         cfg.title && ['h2', {}, cfg.title],
         renderPageJumper(page.page_number, total_pages_in_document, pageJumpUrlFn),
        ], // /div

        markup,
    
    ]; // body

    //console.info('PAGE BODY', JSON.stringify(body, undefined, 2));
    // The scanned-page image + bounding boxes need the full viewport width.
    return {title, head, body, fullBleed: true};
}

/**
 *
 */
export function renderPageJumper(current_page_num: number, total_pages: number,
                                 pageJumpUrlFn: (page_number:number)=>string): any {
    const targetPageNumbers = Array.from(new Set(
        [1,
         ...[], //[10, 37, 210],  // XXX tmp hack for dmm
         ...range(1, Math.floor(total_pages/100)+1).map(v=>v*100),
         ...range(0, 10).map(v=>Math.floor(current_page_num/100)*100+v*10),
         ...range(0, 10).map(v=>Math.floor(current_page_num/10)*10+v),
         current_page_num-1, current_page_num-2,
         current_page_num+1, current_page_num+2,
         total_pages]))
        .filter(p=>p>=1 && p<=total_pages)
        .toSorted((a, b) => a - b);

    return [
        ['div', {}, 'Pages: ',
         targetPageNumbers.map(n=>
             [['a', {href:pageJumpUrlFn(n),
                     class: n===current_page_num?'current-page-jump':'page-jump'}, n],
              ' '])
        ]
    ];
}

async function samplePageRender(friendly_document_id: string, page_number: number) {
    const markup = await pageEditor(friendly_document_id, page_number);
    console.info(renderToStringViaLinkeDOM(markup));
}

// --------------------------------------------------------------------------------
// --- Serializable scan data (publish-source.md "bundle-ize scan renders") --------
// --------------------------------------------------------------------------------
//
// The scan renders the PUBLISHER needs, split into (a) plain serializable
// DATA structs, (b) db LOADERS that build them, and (c) PURE renderers over
// them.  The publish-source bundle carries the structs, so a from-dump
// publish renders scans with NO db.  The annotated-page render below is a
// true load+pure split (one render code path); the standalone-group render
// keeps its historical sync-with-embedded-tile-promise form for live pages
// and has a MIRRORED pure twin further down (drift is pinned by test).

export interface ScanBox { bounding_box_id: number; x: number; y: number; w: number; h: number; }

/** One page's worth of a bounding group's boxes, with everything the pure
 *  standalone render needs about the page. */
export interface GroupScanPart {
    page_id: number;
    width: number; height: number;       // page dimensions
    tiles_url: string;                   // resolved tile-dir path (site-relative)
    boxes: ScanBox[];
}

export interface GroupScanData {
    bounding_group_id: number;
    parts: GroupScanPart[];              // per page, in render order; [] = empty group
    book_page_path: string;              // site-relative public book page ('' if unresolvable)
    description: string;                 // imageRefDescription ('' if unresolvable)
}

export interface PageScanGroup {
    bounding_group_id: number;
    color: string|null;
    boxes: ScanBox[];
}

export interface BookPageScanData {
    page_id: number; document_id: number; page_number: number;
    width: number; height: number;
    image_url: string;                   // the page image (site-relative, no leading /)
    groups: PageScanGroup[];             // the layer's groups, in query order
}

const scanBox = (b: {bounding_box_id: number, x: number, y: number, w: number, h: number}): ScanBox =>
    ({bounding_box_id: b.bounding_box_id, x: b.x, y: b.y, w: b.w, h: b.h});

/** Load the standalone-scan data for one bounding group (async: resolves -
 *  and generates if missing - the content-addressed image tiles).  The
 *  book-page path / description mirror the old callers' try/catch-to-''. */
export async function loadGroupScanData(bounding_group_id: number): Promise<GroupScanData> {
    const boxes = selectBoundingBoxesForGroup().all({bounding_group_id});
    const boxesByPage = utils.groupToMap(boxes, b=>b.page_id);
    const parts: GroupScanPart[] = [];
    for(const [page_id, pageBoxes] of boxesByPage.entries()) {
        const page = selectScannedPage().required({page_id});
        const tiles_url = await derivedPageImages.getTilesForImage(
            page.image_ref, config.defaultTileWidth, config.defaultTileHeight);
        parts.push({page_id, width: page.width, height: page.height,
                    tiles_url, boxes: pageBoxes.map(scanBox)});
    }
    let book_page_path = ''; let description = '';
    try {
        book_page_path = singlePublicBoundingGroupEditorURL('', bounding_group_id, '');
    } catch { /* '' */ }
    try { description = imageRefDescription(bounding_group_id); } catch { /* '' */ }
    return {bounding_group_id, parts, book_page_path, description};
}

/** Load the annotated-page data for one page+layer (the publisher's shape:
 *  no reference layers, no locked group - those stay live-editor-only). */
export function loadBookPageScanData(page_id: number, layer_id: number): BookPageScanData {
    const page = selectScannedPage().required({page_id});
    const boxes = boxesForPageLayer().all({page_id, layer_id});
    const boxesByGroup = utils.groupToMap(boxes, box=>box.bounding_group_id);
    const groups: PageScanGroup[] = [...boxesByGroup.entries()].map(([groupId, gBoxes]) =>
        ({bounding_group_id: groupId,
          color: gBoxes[0].color ?? null,
          boxes: gBoxes.map(scanBox)}));
    return {page_id, document_id: page.document_id, page_number: page.page_number,
            width: page.width, height: page.height,
            image_url: page.image_ref, groups};
}

export function renderAnnotatedPage(cfg: PageRenderConfig, page_id: number): { markup: Markup, groupIds: number[] } {
    const page = selectScannedPage().required({page_id});

    // --- We don't render reference boxes that have been imported to user
    //     boxes that are still active on the page.
    const boxes = boxesForPageLayer().all({page_id, layer_id: cfg.layer_id});
    const importedFromBoundingBoxIds =
        new Set(boxes.map(b=>b.imported_from_bounding_box_id).filter(b=>b!==null));

    // --- Render reference layers (live editor only; the publisher passes none)
    const refBlocksSvg:any = cfg.reference_layer_ids.flatMap(layer_id=> {
        const refBoxes = boxesForPageLayer().all({page_id, layer_id})
            .filter(b=>!importedFromBoundingBoxIds.has(b.bounding_box_id));
        const refBoxesByGroup = utils.groupToMap(refBoxes, box=>box.bounding_group_id);
        return [...refBoxesByGroup.entries()].
            map(([groupId, boxes])=>renderGroup(
                {width: page.width, height: page.height}, groupId, boxes,
                {isRefLayer: true,
                 highlightBoxIds: new Set(cfg.highlight_ref_bounding_box_ids??[])}));
    });

    return renderAnnotatedPageFromData(cfg, loadBookPageScanData(page_id, cfg.layer_id),
                                       {refBlocksSvg});
}

/** The PURE annotated-page render (the one code path - the live
 *  renderAnnotatedPage above loads the same struct and adds the
 *  live-editor-only reference-layer svg via `extra`). */
export function renderAnnotatedPageFromData(cfg: PageRenderConfig, data: BookPageScanData,
                                            extra: {refBlocksSvg?: any,
                                                    imageHref?: string} = {}): { markup: Markup, groupIds: number[] } {
    const pageImageUrl = extra.imageHref ?? '/'+data.image_url;
    const pageDims = {width: data.width, height: data.height};

    const blocksSvg = data.groups.map(g=>renderGroup(
        pageDims, g.bounding_group_id,
        g.boxes.map(b => ({...b, color: g.color ?? undefined})),
        {lockedGroupId: cfg.locked_bounding_group_id}));

    // --- If the locked bounding group has no boxes in this page,
    //     render it anyway as an empty group
    const emptyLockedGroupSvg =
        (cfg.locked_bounding_group_id && !data.groups.some(g=>g.bounding_group_id === cfg.locked_bounding_group_id))
        ? [renderEmptyGroup(cfg.locked_bounding_group_id)]
        : undefined;

    const scale_factor = cfg.scale_factor ?? 4;
    const annotatedPage =
        ['div', {id: 'annotatedPage'},
         //['img', {src:pageImageUrl, width:page.width, height:page.height}],
         ['svg', {id: 'scanned-page',
                  width:data.width/scale_factor,  // add Math.floor ???
                  height:data.height/scale_factor,
                  viewBox: `0 0 ${data.width} ${data.height}`,
                  onmousedown: 'scannedPageMouseDown(event)',
                  onmousemove: 'scannedPageMouseMove(event)',
                  onmouseup: 'scannedPageMouseUp(event)',
                  'data-document-id': data.document_id,
                  'data-page-id': data.page_id,
                  'data-page-number': data.page_number,
                  'data-layer-id': cfg.layer_id,
                  'data-scale-factor': scale_factor,
                  ...(cfg.locked_bounding_group_id
                      ? {'data-locked-bounding-group-id':
                         `bg_${cfg.locked_bounding_group_id}`}
                      : {}),
                 },
          ['image', {href:pageImageUrl, x:0, y:0, width:data.width, height:data.height}],
          extra.refBlocksSvg,
          blocksSvg,
          emptyLockedGroupSvg]];

    return {markup: annotatedPage, groupIds: data.groups.map(g=>g.bounding_group_id)};
}

function renderGroup(page: {width: number, height: number},
                     groupId: number,
                     boxes: Array<ScanBox & {color?: string|null}>,
                     opts: {
                         lockedGroupId?: number,
                         isRefLayer?: boolean,
                         highlightBoxIds?: Set<number> } = {}): any {

    const isRefLayer = opts.isRefLayer ?? false;
    const lockedGroupId = opts.lockedGroupId;
    const highlightBoxIds = opts.highlightBoxIds ?? new Set<number>();

    utils.assert(boxes.length > 0, 'Cannot render an empty group');
    const group = boxes[0];

    // --- Group frame contains all boxes + a margin.
    const groupMargin = 10;
    const groupX = Math.max(Math.min(...boxes.map(b=>b.x)) - groupMargin, 0);
    const groupY = Math.max(Math.min(...boxes.map(b=>b.y)) - groupMargin, 0);
    const groupLeft = Math.min(Math.max(...boxes.map(b=>b.x+b.w)) + groupMargin, page.width);
    const groupBottom = Math.min(Math.max(...boxes.map(b=>b.y+b.h)) + groupMargin, page.height);

    //const stroke = (isRefLayer ? 'grey' : group.color) ?? 'yellow';

    // --- Compute group color based on whether we are in locked group mode, are
    //     a ref group etc.
    let stroke: string = 'purple';
    switch(true) {
        case isRefLayer: stroke = 'grey'; break;
        case lockedGroupId !== undefined && groupId === lockedGroupId: stroke = 'green'; break;
        case lockedGroupId !== undefined && groupId !== lockedGroupId: stroke = 'yellow'; break;
        case group.color !== undefined && group.color !== null: stroke = group.color; break;
        default: stroke = 'yellow'; break;
    }
    //console.info('stroke color', stroke);

    return (
        ['svg', {class:`group ${isRefLayer?'ref':''}`, id:`bg_${groupId}`, stroke},
         ['rect', {class:"group-frame", x:groupX, y:groupY,
                   width:groupLeft-groupX,
                   height:groupBottom-groupY}],
         boxes.map(b=>renderBox(b, isRefLayer, highlightBoxIds))
        ]);
}

function renderEmptyGroup(groupId: number): any {
    const groupMargin = 10;
    const groupX = 0;
    const groupY = 0;
    const groupLeft = 0;
    const groupBottom = 0;
    const stroke = 'yellow';
    return (
        ['svg', {class:`group`, id:`bg_${groupId}`, stroke},
         ['rect', {class:"group-frame", x:groupX, y:groupY,
                   width:groupLeft-groupX,
                   height:groupBottom-groupY}],
        ]);
}

function renderBox(box: ScanBox,
                   isRefLayer: boolean=false,
                   highlightBoxIds:Set<number>=new Set()): any {
    const boxClass = ['box',
                      isRefLayer?'ref':'',
                      highlightBoxIds.has(box.bounding_box_id)?'highlight':''].join(' ');
    return ['svg', {class:boxClass,
                    x:box.x, y:box.y, width:box.w, height:box.h,
                    id: `bb_${box.bounding_box_id}`},
            ['rect', {class:"frame", x:0, y:0, width:'100%', height:'100%'}],
            //['rect', {class:"frame2", x:0, y:0, width:'100%', height:'100%'}],
            ['circle', {class:"grabber", cx:0, cy:0, r:12}],
            ['circle', {class:"grabber", cx:0, cy:'100%', r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:0, r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:'100%', r:12}]];
}


// --------------------------------------------------------------------------------
// --- RPCs -----------------------------------------------------------------------
// --------------------------------------------------------------------------------

export function updateBoundingBoxShape(bounding_box_id: number, shape: Shape) {
    db().transaction(()=>
        updateBoundingBox(bounding_box_id, ['x', 'y', 'w', 'h'], shape));
}

// TERRIBLE TERRIBLE TERRIBLE
export async function createNewEmptyBoundingGroupForFriendlyDocumentId(friendly_document_id: string): Promise<{group_id: number, layer_id: number, reference_layer_id: number, first_page_id: number}> {
    return db().transaction(()=>{

        // XXX copying these colors form pageeditor.ts is BAD.
        const groupColors = [
            'crimson', 'palevioletred', 'darkorange', 'gold', 'darkkhaki',
            'seagreen', 'steelblue', /*'dodgerblue',*/ 'peru', /*'tan',*/ 'rebeccapurple'];
        // --- Create new layer in the specified document id.
        const document = selectScannedDocumentByFriendlyId().required({friendly_document_id});
        const document_id = document.document_id;
        const layer_id = schema.getOrCreateNamedLayer(document.document_id, 'Tagging', 0);
        const reference_layer_id = schema.getOrCreateNamedLayer(document.document_id, 'Text', 1);
        const color = groupColors[random.randomInt(0, groupColors.length-1)];
        const bounding_group_id = db().insert<BoundingGroup, 'bounding_group_id'>(
            'bounding_group', {document_id, layer_id, color}, 'bounding_group_id');

        console.info('new bounding group id is', bounding_group_id);

        const first_page_id = selectScannedPageByPageNumber().required({document_id, page_number: 1}).page_id;
        return {group_id: bounding_group_id, layer_id, reference_layer_id, first_page_id};
    });
}


export function newBoundingBoxInNewGroup(page_id: number, layer_id: number,
                                         shape: {x:number, y:number, w:number, h:number},
                                         color: string): {bounding_group_id: number, bounding_box_id: number} {
    return db().transaction(()=>{

        const page = selectScannedPage().required({page_id});
        const layer = selectLayer().required({layer_id});
        utils.assert(page.document_id === layer.document_id);
        const document_id = page.document_id;

        const bounding_group_id = db().insert<BoundingGroup, 'bounding_group_id'>(
            'bounding_group', {
                document_id,
                layer_id,
                color,
            }, 'bounding_group_id');

        const bounding_box_id = db().insert<BoundingBox, 'bounding_box_id'>(
            'bounding_box', {bounding_group_id, document_id, layer_id, page_id,
                             x: shape.x, y: shape.y, w: shape.w, h: shape.h}, 'bounding_box_id');

        return {bounding_group_id, bounding_box_id};
    });
}

export function newBoundingBoxInExistingGroup(page_id: number,
                                              bounding_group_id: number,
                                              shape: Shape): {bounding_box_id: number} {
    return db().transaction(()=>{

        if(typeof bounding_group_id !== 'number')
            throw new Error('invalid bounding_group_id parameter in call to newBoundingBoxInExistingGroup');

        const group = selectBoundingGroup().required({bounding_group_id});

        const bounding_box_id = db().insert<BoundingBox, 'bounding_box_id'>(
            'bounding_box', {
                bounding_group_id,
                document_id: group.document_id,
                layer_id: group.layer_id, page_id,
                x: shape.x, y: shape.y, w: shape.w, h: shape.h}, 'bounding_box_id');

        return {bounding_box_id};
    });
}

export function copyRefBoxToNewGroup(ref_box_id: number, layer_id: number, color: string): {bounding_group_id: number, bounding_box_id: number} {
    return db().transaction(()=>{

        if(typeof ref_box_id !== 'number')
            throw new Error('invalid ref_box_id parameter in call to copyRefToNewGroup');

        const refBox = selectBoundingBox().required({bounding_box_id: ref_box_id});

        const bounding_group_id = db().insert<BoundingGroup, 'bounding_group_id'>(
            'bounding_group', {
                document_id: refBox.document_id,
                layer_id,
                color,
            }, 'bounding_group_id');

        const bounding_box_id = db().insert<BoundingBox, 'bounding_box_id'>(
            'bounding_box', {
                imported_from_bounding_box_id: refBox.bounding_box_id,
                bounding_group_id,
                document_id: refBox.document_id,
                layer_id, page_id: refBox.page_id,
                x: refBox.x, y: refBox.y, w: refBox.w, h: refBox.h}, 'bounding_box_id');

        return {bounding_group_id, bounding_box_id};
    });
}

export function copyRefBoxToExistingGroup(bounding_group_id: number, ref_box_id: number): {bounding_box_id: number} {
    return db().transaction(()=>{

        if(typeof ref_box_id !== 'number')
            throw new Error('invalid ref_box_id parameter in call to copyRefBoxToExistingGroup');

        const group = selectBoundingGroup().required({bounding_group_id});
        //console.info('target group layer id is', group.layer_id);
        const refBox = selectBoundingBox().required({bounding_box_id: ref_box_id});

        const bounding_box_id = db().insert<BoundingBox, 'bounding_box_id'>(
            'bounding_box', {
                imported_from_bounding_box_id: refBox.bounding_box_id,
                bounding_group_id,
                document_id: refBox.document_id,
                layer_id: group.layer_id, page_id: refBox.page_id,
                x: refBox.x, y: refBox.y, w: refBox.w, h: refBox.h}, 'bounding_box_id');

        return {bounding_box_id};
    });
}

export function copyBoxToExistingGroup(target_bounding_group_id: number, src_box_id: number): {bounding_box_id: number} {
    return db().transaction(()=>{

        if(typeof src_box_id !== 'number')
            throw new Error('invalid src_box_id parameter in call to copyBoxToExistingGroup');

        // const group = selectBoundingGroup().required({bounding_group_id: target});
        // console.info('target group layer id is', group.layer_id);
        const srcBox = selectBoundingBox().required({bounding_box_id: src_box_id});

        const bounding_box_id = db().insert<BoundingBox, 'bounding_box_id'>(
            'bounding_box', {
                imported_from_bounding_box_id: srcBox.bounding_box_id,
                bounding_group_id: target_bounding_group_id,
                document_id: srcBox.document_id,
                layer_id: srcBox.layer_id,
                page_id: srcBox.page_id,
                x: srcBox.x,
                y: srcBox.y,
                w: srcBox.w,
                h: srcBox.h}, 'bounding_box_id');

        return {bounding_box_id};
    });
}

export function removeBoxFromGroup(bounding_box_id: number) {
    return db().transaction(()=>{

        if(typeof bounding_box_id !== 'number')
            throw new Error('invalid box_id parameter in call to removeBoxFromGroup');

        // Consider removing empty groups as well (but need to figure out how
        // our binding onto dict stuff works first).

        db().execute('DELETE FROM bounding_box WHERE bounding_box_id=:bounding_box_id',
                     {bounding_box_id});
    });
}

/** Delete a whole bounding GROUP - its boxes and the group row (the ×
 *  beside an unlinked group in the page word sidebar).  Guarded: refuses
 *  if any current dict reference still points at the group, so a
 *  word-linked group can never be silently orphaned (the sidebar only
 *  offers this on UNLINKED groups, but the guard makes the verb safe on
 *  its own). */
export function deleteBoundingGroup(bounding_group_id: number): {deleted: boolean} {
    return db().transaction(()=>{
        if(typeof bounding_group_id !== 'number')
            throw new Error('invalid bounding_group_id in call to deleteBoundingGroup');
        const referenced = db().first<{n: number}>(
            block`
/**/       SELECT COUNT(*) AS n FROM dict
/**/         WHERE ty = 'ref' AND valid_to = 9007199254740991
/**/               AND attr1 = :bounding_group_id`, {bounding_group_id})?.n ?? 0;
        if(referenced > 0)
            throw new Error(`bounding group ${bounding_group_id} is referenced by a word - `+
                            `remove the reference before deleting the group`);
        db().execute('DELETE FROM bounding_box WHERE bounding_group_id=:bounding_group_id',
                     {bounding_group_id});
        db().execute('DELETE FROM bounding_group WHERE bounding_group_id=:bounding_group_id',
                     {bounding_group_id});
        return {deleted: true};
    });
}

export function migrateBoxToGroup(bounding_group_id: number, bounding_box_id: number): {} {
    return db().transaction(()=>{

        // TODO add more paranoia here.

        updateBoundingBox(bounding_box_id, ['bounding_group_id'], {bounding_group_id});

        return {};
    });
}


/**
 *
 */
export function singleBoundingGroupEditorURL(bounding_group_id: number, title: string) {
    const bounding_group = schema.selectBoundingGroup().required({bounding_group_id});
    const document_id = bounding_group.document_id;
    const layer_id = bounding_group.layer_id;
    const bounding_boxes = selectBoundingBoxesForGroup().all({bounding_group_id});
    // XXX Note: if a entry has bounding boxes on muiltiple pages, we are
    //     picking the first page by page_id, not page number.
    // XXX this is wrong.
    const page_id =
        bounding_boxes.length > 0
        ? bounding_boxes.map(b=>b.page_id).toSorted((a,b)=>a-b)[0]
        : schema.selectScannedPageByPageNumber().required({document_id, page_number: 1}).page_id;

    const reference_layer_id = getOrCreateNamedLayer(document_id, 'Text', 1);
    //const title = 'TITLE'; // XXX
    const pageEditorConfig: PageEditorConfig = {
        layer_id,
        reference_layer_ids: [reference_layer_id],
        title,
        is_popup_editor: true,
        locked_bounding_group_id: bounding_group_id,
    };
    return `/ww/wordwiki.pages.renderPageEditorByPageId(${page_id}, ${JSON.stringify(pageEditorConfig)})`;

}

/**
 *
 */
/** The EDITOR's page for the page containing a bounding group (dz
 *  2026-07-09: links inside the editor - the word view / lexeme editor
 *  scan images and their captions - go to the editor version of the page,
 *  not the public site's).  With the page word sidebar, landing here IS
 *  the page-at-a-time workspace. */
export function pageEditorURLForBoundingGroup(bounding_group_id: number): string {
    const bounding_group = schema.selectBoundingGroup().required({bounding_group_id});
    const document_id = bounding_group.document_id;
    const bounding_boxes = selectBoundingBoxesForGroup().all({bounding_group_id});
    // Same first-page pick as the sibling URL helpers (and the same XXX:
    // multi-page groups pick by page_id, not page number).
    const page_id =
        bounding_boxes.length > 0
        ? bounding_boxes.map(b=>b.page_id).toSorted((a,b)=>a-b)[0]
        : schema.selectScannedPageByPageNumber().required({document_id, page_number: 1}).page_id;
    const document = schema.selectScannedDocument().required({document_id});
    const page = schema.selectScannedPage().required({page_id});
    return `/ww/wordwiki.pages.pageEditor(${JSON.stringify(document.friendly_document_id)}, ${page.page_number})`;
}

export function singlePublicBoundingGroupEditorURL(rootPath: string,
                                                   bounding_group_id: number,
                                                   title: string) {
    const bounding_group = schema.selectBoundingGroup().required({bounding_group_id});
    const document_id = bounding_group.document_id;
    const layer_id = bounding_group.layer_id;
    const bounding_boxes = selectBoundingBoxesForGroup().all({bounding_group_id});

    // XXX Note: if a entry has bounding boxes on muiltiple pages, we are
    //     picking the first page by page_id, not page number.
    // XXX this is wrong.
    const page_id =
        bounding_boxes.length > 0
        ? bounding_boxes.map(b=>b.page_id).toSorted((a,b)=>a-b)[0]
        : schema.selectScannedPageByPageNumber().required({document_id, page_number: 1}).page_id;

    const document = schema.selectScannedDocument().required({document_id});
    
    const page = schema.selectScannedPage().required({page_id});
    const page_number = page.page_number;
    
    return `${rootPath}books/${document.friendly_document_id}/page-${String(page_number).padStart(4, '0')}/index.html`;
}

/**
 *
 */
export function imageRefDescription(bounding_group_id: number): string {
    const bounding_group = schema.selectBoundingGroup().required({bounding_group_id});
    const document_id = bounding_group.document_id;
    const layer_id = bounding_group.layer_id;
    const bounding_boxes = selectBoundingBoxesForGroup().all({bounding_group_id});

    // XXX Note: if a entry has bounding boxes on muiltiple pages, we are
    //     picking the first page by page_id, not page number.
    // XXX this is wrong.
    const page_id =
        bounding_boxes.length > 0
        ? bounding_boxes.map(b=>b.page_id).toSorted((a,b)=>a-b)[0]
        : schema.selectScannedPageByPageNumber().required({document_id, page_number: 1}).page_id;

    const document = schema.selectScannedDocument().required({document_id});
    
    const page = schema.selectScannedPage().required({page_id});
    const page_number = page.page_number;
    
    return `${document.title}, Page Image #${page_number}`;
}




export function forwardToSingleBoundingGroupEditorURL(bounding_group_id: number, title: string): Response {
    const editorURL = singleBoundingGroupEditorURL(bounding_group_id, title);
    //console.info({editorURL});
    return forwardResponse(editorURL);
}


// --------------------------------------------------------------------------------
// --- Standalone group render ----------------------------------------------------
// --------------------------------------------------------------------------------

/**
 *
 */
export function renderTextSearchForm(layer_id: number, cfg: PageEditorConfig,
                                     searchText: string=''): any {
    // The action passes the whole `query` binding (the searchPage(query)
    // convention): strict routeterp treats EVERY member access as a route
    // capability, so a `query.searchText` expression throws
    // RouteUndeclaredError ("not found") - destructure server-side instead.
    return [
        ['form', {class:'row row-cols-lg-auto g-3 align-items-center', name: 'search', method: 'get', action:`/ww/wordwiki.pages.renderTextSearchResults(${layer_id}, ${JSON.stringify(cfg)}, query)`},

         ['div', {class:'col-12'},
          ['label', {class:'visually-hidden', for:'searchText'}, 'Search'],
          ['div', {class: 'input-group'},
           ['input', {type:'text', class:'form-control',
                      id:'searchText', name:'searchText', placeholder:'Search',
                      value:searchText}]]],

         ['div', {class:'col-12'},
          ['button', {type:'submit', class:'btn btn-primary'}, 'Search']],

        ] // form
    ];
}

export function renderTextSearchForm2(layer_id: number, cfg: PageEditorConfig,
                                     searchText: string=''): any {
    return [
        // As in renderTextSearchForm: pass `query` whole, never `query.member`.
        ['form', {class:'form-inline', name: 'search', method: 'get', action:`/ww/wordwiki.pages.renderTextSearchResults(${layer_id}, ${JSON.stringify(cfg)}, query)`},
         ['label', {class:'sr-only', for:'searchText'}, 'Search'],
         ['input', {type:'text', class:'form-control mb-2 mr-sm-2',
                    id:'searchText', name:'searchText', placeholder:'Search',
                    value:searchText}],
         ['button', {type:'submit', class:'btn btn-primary mb-2'}, 'Search'],
        ] // form
    ];
}

/**
 *
 */
// Third arg is the whole query-args object (see renderTextSearchForm's action
// comment); a legacy plain-string third arg still works.
export function renderTextSearchResults(layer_id: number, cfg: PageEditorConfig,
                                        query?: {searchText?: string} | string) {
    const searchText = (typeof query === 'string' ? query : query?.searchText) ?? '';

    //console.info('CFG', JSON.stringify(cfg, undefined, 2));

    const layer = schema.selectLayer().required({layer_id});
    const document = schema.selectScannedDocument().required(
        {document_id: layer.document_id});

    const title = `Search for '${searchText}' in layer ${layer.layer_name} of ${document.title}`;
    const head:any = [];

    function renderItem(bounding_box_id: number, page_id: number, text: string): any {
        const itemCfg: PageEditorConfig = Object.assign(
            {},
            cfg,
            {highlight_ref_bounding_box_ids: [bounding_box_id]});

        const href=`/ww/wordwiki.pages.renderPageEditorByPageId(${page_id}, ${JSON.stringify(itemCfg)})`;
        return [
            ['li', {},
             ['a', {href},
              text, ['br', {}],
              renderStandaloneBoxes('/', [
                  selectBoundingBox().required({bounding_box_id})])]]];
    }

    let renderedResults: any = undefined;
    if(searchText.length < 2) {
        renderedResults = ['p', {}, 'Search string must be at least 2 characters long'];
    } else {
        const results = db().all<any, {searchText:string, layer_id: number}>(`SELECT * FROM bounding_box_fts WHERE text MATCH :searchText AND layer_id = :layer_id ORDER BY rank LIMIT 500`, {searchText, layer_id});

        if(results.length === 0) {
            renderedResults = ['p', {}, `No results found for search '${searchText}'`];
        } else {
            renderedResults =
                ['code', {}, JSON.stringify(results, undefined, 2)];
            renderedResults =
                ['ul', {},
                 results.map(({bounding_box_id, page_id, text})=>
                     renderItem(bounding_box_id, page_id, text))
                ]; // ul
        }
    }

    const body= [
        ['h2', {}, title],
        renderTextSearchForm(layer_id, cfg, searchText??''),
        renderedResults,
    ];

    return templates.pageTemplate({title, head, body});
}

// A bit of extra typing for svg markup with a declared size.
export type SizedSvgMarkup =  ['svg',
                               {width:number, height:number,
                                x?: number, y?:number,
                                [index: string]: any},
                               ...any];

/**
 *
 */
export function renderStandaloneGroupAsHtml(rootPath: string,
                                            bounding_group_id: number,
                                            scale_factor:number=4,
                                            box_stroke:string = 'green'): any {
    const boxes = selectBoundingBoxesForGroup().all({bounding_group_id});
    if(boxes.length === 0) {
        //console.info('STANDALONE GROUP IS EMPTY');
        return ['div', {}, 'Empty Group'];
    }
    const boxesByPage = utils.groupToMap(boxes, b=>b.page_id);
    return Array.from(boxesByPage.values()).map(
        boxes=>['div', {}, renderStandaloneBoxes(rootPath, boxes, scale_factor, box_stroke)]);
}

export async function renderStandaloneGroupAsSvgResponse(rootPath: string,
                                                         bounding_group_id: number,
                                                         scale_factor:number=4,
                                                         box_stroke:string = 'green'): Promise<Response> {
    const svgMarkup = renderStandaloneGroup(rootPath, bounding_group_id, scale_factor, box_stroke);
    svgMarkup[1].xmlns="http://www.w3.org/2000/svg";
    const svgText = await asyncRenderToStringViaLinkeDOM(svgMarkup, false);
    const body = block`
/**/<?xml version="1.0"?>
/**/<?xml-stylesheet href="/resources/page-editor.css" ?>
/**/${svgText}`;
    //console.info('SVG BODY', body);
    return {
        marker: ResponseMarker,
        status: 200,
        headers: {"content-type": "image/svg+xml;charset=utf-8",
                  "date": (new Date() as any).toGMTString(),
                  //"Cache-Control": "public, max-age=120"},
                  "Cache-Control": "no-store"},
        body
    };
}

/**
 *
 *
 * ISSUE: the entire standalone group is a single click target now - so
 *        for group spanning pages it is hard for the user to find all
 *        the parts of the group (does not come up much at present)
 */
export function renderStandaloneGroup(rootPath: string='',
                                      bounding_group_id: number,
                                      scale_factor:number=4,
                                      box_stroke:string = 'green'): SizedSvgMarkup {
    const boxes = selectBoundingBoxesForGroup().all({bounding_group_id});
    if(boxes.length === 0) {
        return renderWarningMessageAsSvg('Empty Group');
    }

    // --- Do per-page tiled SVG renderings
    //     (TODO: consider breaking up a single page render if there is a big
    //     space between clusters on the same page)
    const boxesByPage = utils.groupToMap(boxes, b=>b.page_id);
    const svgsByPage = Array.from(boxesByPage.values()).map(
        boxes=>renderStandaloneBoxes(rootPath, boxes, scale_factor, box_stroke));

    // --- Layout the group renderings in a larger SVG
    //     (we are using SVG instead of html for this because when embedding
    //     on client-rendered pages, it is nicer to have the group served as a SVG).
    const margin = 10;
    const totalHeight = svgsByPage.reduce((total, svg)=>total+svg[1].height+margin*2, 0);
    const maxWidth = Math.max(...svgsByPage.map(svg=>svg[1].width))+margin*2;

    const groupSvgs: SizedSvgMarkup[] = [];
    let y = 0;
    for(const s of svgsByPage) {
        s[1].y = y+margin;
        s[1].x = margin;
        y += s[1].height + margin;
        groupSvgs.push(s);
    }

    return ['svg', {width:maxWidth, height:totalHeight,
                    viewBox: `0 0 ${maxWidth} ${totalHeight}`
                   },
            groupSvgs,
           ]; // svg

    throw new Error();
}

/**
 *
 */
export function renderStandaloneBoxes(rootPath: string,
                                      boxes: BoundingBox[],
                                      scale_factor:number=4,
                                      box_stroke:string = 'green'): SizedSvgMarkup {

    // --- If no boxes in group, render as empty.
    if(boxes.length === 0) {
        return renderWarningMessageAsSvg('Empty Group');
    }

    // --- This is handled at the 'renderStandaloneGroup' level
    const page_id = boxes[0].page_id;
    boxes.forEach(b=>b.page_id === page_id
        || utils.panic('all boxes in a group must be on a single page'));

    // --- Load page TODO FACTOR THIS OUT OF HERE (repeated loads of page are boring)
    const page = selectScannedPage().required({page_id});

    // --- Group frame contains all boxes + a margin
    //     (note that margin is reduced if there is not enough space)
    const groupMargin = 75;
    const groupX = Math.max(Math.min(...boxes.map(b=>b.x)) - groupMargin, 0);
    const groupY = Math.max(Math.min(...boxes.map(b=>b.y)) - groupMargin, 0);
    const groupRight = Math.min(Math.max(...boxes.map(b=>b.x+b.w)) + groupMargin, page.width);
    const groupBottom = Math.min(Math.max(...boxes.map(b=>b.y+b.h)) + groupMargin, page.height);
    const groupWidth = groupRight-groupX;
    const groupHeight = groupBottom-groupY;
    //console.info({groupX, groupY, groupRight, groupBottom, groupWidth, groupHeight});

    const groupSvg =
        ['svg', {class:`group`, stroke: box_stroke},
         ['rect', {class:"group-frame", x:groupX, y:groupY,
                   width:groupRight-groupX,
                   height:groupBottom-groupY}],

         boxes.map(box=>
             ['svg', {class:`box`, x:box.x-groupX, y:box.y-groupY, width:box.w, height:box.h, id: `bb_${box.bounding_box_id}`},
              ['rect', {class:"frame", x:0, y:0, width:'100%', height:'100%'}]
             ])
        ];

    const image = renderTiledImage(rootPath, page.image_ref, page.width, page.height,
        -groupX, -groupY, groupWidth, groupHeight);

    return ['svg', {width:groupWidth/scale_factor, height:groupHeight/scale_factor,
                    viewBox: `0 0 ${groupWidth} ${groupHeight}`,
                    'data-page-id': page_id,
                    'data-scale-factor': scale_factor,
                   },
            image,
            groupSvg,
           ]; // svg
}

/** PURE twin of renderStandaloneGroup over bundle data.  MIRRORS the
 *  function above - the live one must stay sync (its callers embed the
 *  tile promise in markup), so the two cannot share one body; the
 *  render-equivalence test in publish-source_test.ts pins them together.
 *  Change BOTH or the test fails. */
export function renderStandaloneGroupFromData(rootPath: string,
                                              data: GroupScanData,
                                              scale_factor:number=4,
                                              box_stroke:string = 'green'): SizedSvgMarkup {
    if(data.parts.length === 0) {
        return renderWarningMessageAsSvg('Empty Group');
    }

    // --- Do per-page tiled SVG renderings
    const svgsByPage = data.parts.map(
        part=>renderStandaloneBoxesFromPart(rootPath, part, scale_factor, box_stroke));

    // --- Layout the group renderings in a larger SVG
    const margin = 10;
    const totalHeight = svgsByPage.reduce((total, svg)=>total+svg[1].height+margin*2, 0);
    const maxWidth = Math.max(...svgsByPage.map(svg=>svg[1].width))+margin*2;

    const groupSvgs: SizedSvgMarkup[] = [];
    let y = 0;
    for(const s of svgsByPage) {
        s[1].y = y+margin;
        s[1].x = margin;
        y += s[1].height + margin;
        groupSvgs.push(s);
    }

    return ['svg', {width:maxWidth, height:totalHeight,
                    viewBox: `0 0 ${maxWidth} ${totalHeight}`
                   },
            groupSvgs,
           ]; // svg
}

/** PURE twin of renderStandaloneBoxes over one GroupScanPart (see
 *  renderStandaloneGroupFromData's mirror note). */
export function renderStandaloneBoxesFromPart(rootPath: string,
                                              part: GroupScanPart,
                                              scale_factor:number=4,
                                              box_stroke:string = 'green'): SizedSvgMarkup {
    const boxes = part.boxes;
    if(boxes.length === 0) {
        return renderWarningMessageAsSvg('Empty Group');
    }

    // --- Group frame contains all boxes + a margin
    //     (note that margin is reduced if there is not enough space)
    const groupMargin = 75;
    const groupX = Math.max(Math.min(...boxes.map(b=>b.x)) - groupMargin, 0);
    const groupY = Math.max(Math.min(...boxes.map(b=>b.y)) - groupMargin, 0);
    const groupRight = Math.min(Math.max(...boxes.map(b=>b.x+b.w)) + groupMargin, part.width);
    const groupBottom = Math.min(Math.max(...boxes.map(b=>b.y+b.h)) + groupMargin, part.height);
    const groupWidth = groupRight-groupX;
    const groupHeight = groupBottom-groupY;

    const groupSvg =
        ['svg', {class:`group`, stroke: box_stroke},
         ['rect', {class:"group-frame", x:groupX, y:groupY,
                   width:groupRight-groupX,
                   height:groupBottom-groupY}],

         boxes.map(box=>
             ['svg', {class:`box`, x:box.x-groupX, y:box.y-groupY, width:box.w, height:box.h, id: `bb_${box.bounding_box_id}`},
              ['rect', {class:"frame", x:0, y:0, width:'100%', height:'100%'}]
             ])
        ];

    const image = renderTiledImageFromTiles(rootPath, part.tiles_url, part.width, part.height,
        -groupX, -groupY, groupWidth, groupHeight);

    return ['svg', {width:groupWidth/scale_factor, height:groupHeight/scale_factor,
                    viewBox: `0 0 ${groupWidth} ${groupHeight}`,
                    'data-page-id': part.page_id,
                    'data-scale-factor': scale_factor,
                   },
            image,
            groupSvg,
           ]; // svg
}

export function renderWarningMessageAsSvg(message: string, width:number=240, height:number=30): SizedSvgMarkup {
    return ['svg', {width, height, viewBox:`0 0 ${width} ${height}`, xmlns:'http://www.w3.org/2000/svg'},
            ['text', {x:0, y:20, class: 'warning'}, message]];
}

export async function renderTiledImage(rootPath: string, srcImagePath: string,
                                       srcImageWidth: number, srcImageHeight: number,
                                       x: number, y: number, w: number, h: number,
                                       maxTileWidth=config.defaultTileWidth,
                                       maxTileHeight=config.defaultTileHeight): Promise<any> {
    const tilesPath = await derivedPageImages.getTilesForImage(srcImagePath, maxTileWidth, maxTileHeight);
    return renderTiledImageFromTiles(rootPath, tilesPath, srcImageWidth, srcImageHeight,
                                     x, y, w, h, maxTileWidth, maxTileHeight);
}

/** The PURE tile grid over an already-resolved tiles path (the one code
 *  path - renderTiledImage above resolves then delegates; the publish
 *  bundle carries resolved tiles_url values). */
export function renderTiledImageFromTiles(rootPath: string, tilesPath: string,
                                       srcImageWidth: number, srcImageHeight: number,
                                       x: number, y: number, w: number, h: number,
                                       maxTileWidth=config.defaultTileWidth,
                                       maxTileHeight=config.defaultTileHeight): any {
    const srcImageWidthInTiles = Math.ceil(srcImageWidth / maxTileWidth);
    const srcImageHeightInTiles = Math.ceil(srcImageHeight / maxTileHeight);

    const tiles:any[] = [];
    for(let yidx=0; yidx<srcImageHeightInTiles; yidx++) {
        for(let xidx=0; xidx<srcImageWidthInTiles; xidx++) {

            const tileX = xidx*maxTileWidth;
            const tileY = yidx*maxTileHeight;
            const tileWidth = xidx < srcImageWidthInTiles-1
                ? maxTileWidth
                : srcImageWidth % maxTileWidth;
            const tileHeight = yidx < srcImageHeightInTiles-1
                ? maxTileHeight
                : srcImageHeight % maxTileHeight;

            if(intersect({left: tileX, right: tileX+tileWidth,
                          top: tileY, bottom: tileY+tileHeight},
                         {left: -x, right: -x+w,
                          top: -y, bottom: -y+h})) {
                const tileUrl = `${rootPath}${tilesPath}/tile-${xidx}-${yidx}.jpg`
                const tile = ['image',
                              {href: tileUrl,
                               x: x+tileX,
                               y: y+tileY,
                               width:tileWidth,
                               height:tileHeight}];
                tiles.push(tile);
            }
        }
    }

    return tiles;
}

interface Rect {
    left: number,
    right: number,
    top: number,
    bottom: number;
}

function intersect(a: Rect, b: Rect): boolean {
    return (a.left <= b.right &&
        b.left <= a.right &&
        a.top <= b.bottom &&
        b.top <= a.bottom)
}

export async function renderTiledImageOff(srcImagePath: string,
                                       srcImageWidth: number, srcImageHeight: number,
                                       x: number, y: number, w: number, h: number,
                                       tileWidth=config.defaultTileWidth,
                                       tileHeight=config.defaultTileHeight): Promise<any> {
    return ['image', {href:`/${srcImagePath}`, x, y, width:srcImageWidth, height:srcImageHeight}];
}

// --------------------------------------------------------------------------------
// --- Text search of layer -------------------------------------------------------
// --------------------------------------------------------------------------------

function sampleTextSearch(search: string, layer_id: number = 5) {
    //SELECT * FROM email WHERE email MATCH 'fts5' ORDER BY rank;
    // Want document id in here as well.
    const results = db().all<any, {search:string, layer_id: number}>(`SELECT * FROM bounding_box_fts WHERE text MATCH :search AND layer_id = :layer_id ORDER BY rank`, {search, layer_id});
    console.info(JSON.stringify(results, undefined, 2));

}

// ---------------------------------------------------------------------------------
// --- Routes ----------------------------------------------------------------------
// ---------------------------------------------------------------------------------


/**
 * The scanned-document / page-editor URL routes, namespaced under
 * `wordwiki.pages` (e.g. /ww/wordwiki.pages.renderPageEditorByPageId(...)) so
 * the strict route interpreter's member-access @route gate covers them.  These
 * USED to be merged into the root route scope as bare top-level functions -
 * which routeterp does NOT gate (an Identifier callee in scope is trusted by
 * being in scope), so under the strict policy they would have been reachable by
 * anonymous users.  Wrapping them as members closes that hole.
 *
 * Thin delegators to the module functions above (implementations unchanged, and
 * still called internally - e.g. the PUBLIC /page/<Book>/<N>.html viewer calls
 * pageEditor() directly in requestHandler, bypassing this gate by design).
 *
 * Split by sensitivity:
 *   - VIEW / render routes are `authenticated`: the lexeme editor embeds the
 *     source-scan view (renderPageEditorByPageId, renderStandaloneGroupAsSvg…,
 *     forwardToSingleBoundingGroupEditorURL) for ANY logged-in contributor.
 *   - MUTATION routes are `hostOrAdmin` + mutates (POST-only): reshaping the
 *     scanned-document bounding boxes is a curator task.  NOTE this TIGHTENS the
 *     old blanket "any authenticated user" reachability - relax a method to
 *     `authenticated` if ordinary editors turn out to need box editing.
 */
export class PageRoutes {
    // --- view / render: any authenticated user (GET-reachable) ---
    @route(authenticated) pageEditor(...a: Parameters<typeof pageEditor>) { return pageEditor(...a); }
    @route(authenticated) renderStandaloneGroupAsSvgResponse(...a: Parameters<typeof renderStandaloneGroupAsSvgResponse>) { return renderStandaloneGroupAsSvgResponse(...a); }
    @route(authenticated) renderPageEditorByPageNumber(...a: Parameters<typeof renderPageEditorByPageNumber>) { return renderPageEditorByPageNumber(...a); }
    @route(authenticated) renderPageEditorByPageId(...a: Parameters<typeof renderPageEditorByPageId>) { return renderPageEditorByPageId(...a); }
    @route(authenticated) renderTextSearchResults(...a: Parameters<typeof renderTextSearchResults>) { return renderTextSearchResults(...a); }
    @route(authenticated) renderPageWordSidebar(...a: Parameters<typeof renderPageWordSidebar>) { return renderPageWordSidebar(...a); }
    @route(authenticated) forwardToSingleBoundingGroupEditorURL(...a: Parameters<typeof forwardToSingleBoundingGroupEditorURL>) { return forwardToSingleBoundingGroupEditorURL(...a); }

    // --- mutation: host/admin, POST-only (GET-CSRF closed via mutates) ---
    @route(hostOrAdmin, {mutates: true}) updateBoundingBoxShape(...a: Parameters<typeof updateBoundingBoxShape>) { return updateBoundingBoxShape(...a); }
    @route(hostOrAdmin, {mutates: true}) createNewEmptyBoundingGroupForFriendlyDocumentId(...a: Parameters<typeof createNewEmptyBoundingGroupForFriendlyDocumentId>) { return createNewEmptyBoundingGroupForFriendlyDocumentId(...a); }
    @route(hostOrAdmin, {mutates: true}) newBoundingBoxInNewGroup(...a: Parameters<typeof newBoundingBoxInNewGroup>) { return newBoundingBoxInNewGroup(...a); }
    @route(hostOrAdmin, {mutates: true}) newBoundingBoxInExistingGroup(...a: Parameters<typeof newBoundingBoxInExistingGroup>) { return newBoundingBoxInExistingGroup(...a); }
    @route(hostOrAdmin, {mutates: true}) copyRefBoxToNewGroup(...a: Parameters<typeof copyRefBoxToNewGroup>) { return copyRefBoxToNewGroup(...a); }
    @route(hostOrAdmin, {mutates: true}) copyRefBoxToExistingGroup(...a: Parameters<typeof copyRefBoxToExistingGroup>) { return copyRefBoxToExistingGroup(...a); }
    @route(hostOrAdmin, {mutates: true}) copyBoxToExistingGroup(...a: Parameters<typeof copyBoxToExistingGroup>) { return copyBoxToExistingGroup(...a); }
    @route(hostOrAdmin, {mutates: true}) removeBoxFromGroup(...a: Parameters<typeof removeBoxFromGroup>) { return removeBoxFromGroup(...a); }
    @route(hostOrAdmin, {mutates: true}) deleteBoundingGroup(...a: Parameters<typeof deleteBoundingGroup>) { return deleteBoundingGroup(...a); }
    @route(hostOrAdmin, {mutates: true}) migrateBoxToGroup(...a: Parameters<typeof migrateBoxToGroup>) { return migrateBoxToGroup(...a); }
}




// --------------------------------------------------------------------------------
// --- CLI ------------------------------------------------------------------------
// --------------------------------------------------------------------------------

if (import.meta.main) {
    switch(Deno.args[0]) {
        case 'render':
            await samplePageRender(String(Deno.args[1] ?? 'PDM'), Number.parseInt(Deno.args[1] ?? '1'));
            break;
        case 'search':
            sampleTextSearch(String(Deno.args[1] ?? 'seal'));
            break;
        default: {
            throw new Error('unknown command');
        }
    }
}
