/*
  - Tue Mar 19th - Element
  - Wed Mar 20th - Soul
  - 1:35
 */


import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import { selectLayerByLayerName } from "./schema.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, selectScannedDocumentByFriendlyId, ScannedPage, ScannedPageOpt, selectScannedPage, selectScannedPageByPageNumber, BoundingBox, boundingBoxFieldNames, BoundingGroup, boundingGroupFieldNames, maxPageNumberForDocument, updateBoundingBox, getOrCreateNamedLayer, selectBoundingBox} from './schema.ts';
import {block} from "../utils/strings.ts";
import * as utils from "../utils/utils.ts";
import {range} from "../utils/utils.ts";
import { writeAll } from "https://deno.land/std@0.195.0/streams/write_all.ts";
import { renderToStringViaLinkeDOM } from '../utils/markup.ts';

export const routes = ()=> ({
    pageEditor: renderPageEditor,
    updateBoundingBoxShape(bounding_box_id: number,
                           newShape: {x:number, y:number, w:number, h:number}) {
        updateBoundingBox(bounding_box_id, ['x', 'y', 'w', 'h'], newShape);
    },
    //copyRefBoxToNewGroup,
    //}
});

// export function copyRefBoxToNewGroup(ref_box_id): {new_group_id: number, new_box_id: number} {
//     const newGroup = db().insert<BoundingGroup, 'bounding_group_id'>(
//         'bounding_group', {
//             document_id,
//             layer_id,
//             color
//             imported_from_bounding_box_id: ref_box_id,
//             bounding_group_id,
//             document_id,
//                 layer_id,
//                 page_id,
//                 x,
                
//             },
//             const refBox = selectBoundingBox().required({bounding_box_id: ref_box_id});
//             const newBox = db().insert<BoundingBox, 'bounding_box_id'>(
//                 'bounding_box', {
//                     imported_from_bounding_box_id: ref_box_id,
//                     bounding_group_id,
//                     document_id,
//                     layer_id,
//                     page_id,
//                     x,
                    
//                 },
//                 'bounding_box_id');
//             return {new_group_id: 0, new_box_id: 0};
//         })



type GroupJoinPartial = Pick<BoundingGroup, 'column_number'|'heading_level'|'heading'>;
type BoxGroupJoin = BoundingBox & GroupJoinPartial;

export const boxesForPageLayer = ()=>db().
    prepare<BoxGroupJoin, {page_id:number, layer_id:number}>(
        block`
/**/      SELECT ${boundingBoxFieldNames.map(n=>'bb.'+n).join()},
/**/             bg.column_number, bg.heading_level, bg.heading
/**/         FROM bounding_box AS bb LEFT JOIN bounding_group AS bg USING(bounding_group_id)
/**/         WHERE bb.page_id = :page_id AND
/**/               bb.layer_id = :layer_id
/**/         ORDER BY bb.x, bb.y, bb.bounding_box_id`);

export function renderPageEditor(page_id: number,
                                 layer_id: number,
                                 reference_layer_ids: number[],
                                 total_pages_in_document?: number): any {

    const page = selectScannedPage().required({page_id});

    total_pages_in_document ??= maxPageNumberForDocument().required({document_id: page.document_id}).max_page_number;

    const pageImageUrl = '/'+page.image_ref;

    // --- Render user boxes
    const boxes = boxesForPageLayer().all({page_id, layer_id});
    const boxesByGroup = utils.groupToMap(boxes, box=>box.bounding_group_id);
    const blocksSvg = 
        [...boxesByGroup.entries()].
        map(([groupId, boxes])=>renderGroup(page, groupId, boxes));

    // --- We don't render reference boxes that have been imported to user
    //     boxes that are still active on the page.
    const importedFromBoundingBoxIds =
        new Set(boxes.map(b=>b.imported_from_bounding_box_id).filter(b=>b!==null));
    
    // --- Render reference layers
    let refBlocksSvg:any = reference_layer_ids.flatMap(layer_id=> {
        const refBoxes = boxesForPageLayer().all({page_id, layer_id})
            .filter(b=>!importedFromBoundingBoxIds.has(b.bounding_box_id));
        const refBoxesByGroup = utils.groupToMap(refBoxes, box=>box.bounding_group_id);
        return [...refBoxesByGroup.entries()].
            map(([groupId, boxes])=>renderGroup(page, groupId, boxes, true));
    });


    return (
        ['html', {},
         ['head', {},
          ['link', {href: '/resources/page-editor.css', rel:'stylesheet', type:'text/css'}],
          ['script', {src:'/resources/page-editor.js'}]],
         ['body', {},

          ['div', {},
           ['h1', {}, 'PDM Textract preview page', page.page_number],
           renderPageJumper(page.page_number, total_pages_in_document)],
          
          ['div', {id: 'annotatedPage'},
           ['img', {src:pageImageUrl, width:page.width, height:page.height}],
           ['svg', {id: 'scanned-page', width:page.width, height:page.height,
                    onmousedown: 'pageEditorMouseDown(event)',
                    onmousemove: 'pageEditorMouseMove(event)',
                    onmouseup: 'pageEditorMouseUp(event)'},
            refBlocksSvg,
            blocksSvg]]]]);
}

export function renderGroup(page: ScannedPage,
                            groupId: number, boxes: BoxGroupJoin[], refLayer: boolean=false): any {
    utils.assert(boxes.length > 0, 'Cannot render an empty group');
    const group: GroupJoinPartial = boxes[0];

    // --- Group frame contains all boxes + a margin.
    const groupMargin = 10;
    const groupX = Math.max(Math.min(...boxes.map(b=>b.x)) - groupMargin, 0);
    const groupY = Math.max(Math.min(...boxes.map(b=>b.y)) - groupMargin, 0);
    const groupLeft = Math.min(Math.max(...boxes.map(b=>b.x+b.w)) + groupMargin, page.width);
    const groupBottom = Math.min(Math.max(...boxes.map(b=>b.y+b.h)) + groupMargin, page.height);
    const stroke = refLayer ? 'Grey' : 'Yellow';  // TODO XXX FIX
    return (
        ['svg', {class:`group ${refLayer?'ref':''}`, id:`bg_${groupId}`},
         ['rect', {class:"group-frame", x:groupX, y:groupY,
                   width:groupLeft-groupX,
                   height:groupBottom-groupY,
                   stroke}],
         boxes.map(b=>renderBox(b, refLayer))
        ]);
}

export function renderBoxOld(box: BoxGroupJoin): any {
    return ['rect', {class:"segment", x:box.x, y:box.y, width:box.w, height:box.h}];
}

export function renderBox(box: BoxGroupJoin, refLayer: boolean=false): any {
    return ['svg', {class:`box ${refLayer?'ref':''}`, x:box.x, y:box.y, width:box.w, height:box.h, id: `bb_${box.bounding_box_id}`},
            ['rect', {class:"frame", x:0, y:0, width:'100%', height:'100%'}],
            ['circle', {class:"grabber", cx:0, cy:0, r:12}],
            ['circle', {class:"grabber", cx:0, cy:'100%', r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:0, r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:'100%', r:12}]];
}

export function renderPageJumper(current_page_num: number, total_pages: number): any {
    const targetPageNumbers = Array.from(new Set(
        [1,
         ...range(1, Math.floor(total_pages/100)+1).map(v=>v*100),
         ...range(0, 10).map(v=>Math.floor(current_page_num/100)*100+v*10),
         ...range(0, 10).map(v=>Math.floor(current_page_num/10)*10+v),
         current_page_num-1, current_page_num-2,
         current_page_num+1, current_page_num+2,
         total_pages]))
        .filter(p=>p>=1 && p<=total_pages)
        .toSorted((a, b) => a - b);
    
    return targetPageNumbers.map(n=>
        [['a', {href:`./${n}.html`,
                class: n===current_page_num?'current-page-jump':'page-jump'}, n],
         ' ']);
}

export async function friendlyRenderPageEditor(friendly_document_id: string,
                                               page_number: number,
                                               layer_name: string = 'TextractWord'): Promise<any> {
    const pdm = selectScannedDocumentByFriendlyId().required({friendly_document_id});
    //const
    const pdmTaggingLayer = getOrCreateNamedLayer(pdm.document_id, 'Tagging', 0);
    const pdmWordLayer = selectLayerByLayerName().required({document_id: pdm.document_id, layer_name});
    const pdmSamplePage = selectScannedPageByPageNumber().required(
        {document_id: pdm.document_id, page_number});
    const totalPagesInDocument = maxPageNumberForDocument().required({document_id: pdm.document_id}).max_page_number;
    console.info('max_page_number', totalPagesInDocument);
    return renderPageEditor(pdmSamplePage.page_id, pdmTaggingLayer, [pdmWordLayer.layer_id], totalPagesInDocument);
}

if (import.meta.main) {
    const friendly_document_id = Deno.args[0] ?? 'PDM';
    const page_number = parseInt(Deno.args[1] ?? '1');
    const markup = await friendlyRenderPageEditor(friendly_document_id, page_number);
    console.info(renderToStringViaLinkeDOM(markup));
}
