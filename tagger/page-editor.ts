/*
  - Tue Mar 19th - Element
  - Wed Mar 20th - Soul
 */


import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import { selectLayerByLayerName } from "./schema.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, selectScannedDocumentByFriendlyId, ScannedPage, ScannedPageOpt, selectScannedPage, selectScannedPageByPageNumber, BoundingBox, boundingBoxFieldNames, BoundingGroup, boundingGroupFieldNames, maxPageNumberForDocument, updateBoundingBox} from './schema.ts';
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
});

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
/**/         ORDER BY bb.bounding_box_id`);

export function renderPageEditor(page_id: number,
                                 layer_id: number,
                                 reference_layer_id: number|undefined,
                                 total_pages_in_document?: number): any {

    const page = selectScannedPage().required({page_id});
    const boxes = boxesForPageLayer().all({page_id, layer_id});

    total_pages_in_document ??= maxPageNumberForDocument().required({document_id: page.document_id}).max_page_number;

    const pageImageUrl = '/'+page.image_ref;
    
    const boxesByGroup = utils.groupToMap(boxes, box=>box.bounding_group_id);

    const blocksSvg = 
        [...boxesByGroup.entries()].
        map(([groupId, boxes])=>renderGroup(groupId, boxes));

    return (
        ['html', {},
         ['head', {},
          ['link', {href: '/resources/page-tagger.css', rel:'stylesheet', type:'text/css'}],
          ['script', {src:'/resources/page-tagger.js'}]],
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
            blocksSvg]]]]);
}

export function renderGroup(groupId: number, boxes: BoxGroupJoin[]): any {
    utils.assert(boxes.length > 0, 'Cannot render an empty group');
    const group: GroupJoinPartial = boxes[0];
    return (
        ['svg', {class:"group WORD", id:`bg_${groupId}`},
         boxes.map(b=>renderBox(b))
        ]);
}

export function renderBoxOld(box: BoxGroupJoin): any {
    return ['rect', {class:"segment", x:box.x, y:box.y, width:box.w, height:box.h}];
}

export function renderBox(box: BoxGroupJoin): any {
    return ['svg', {class:"box", x:box.x, y:box.y, width:box.w, height:box.h, id: `bb_${box.bounding_box_id}`},
            ['rect', {class:"frame", x:0, y:0, width:'100%', height:'100%'}],
            ['circle', {class:"grabber", cx:0, cy:0, r:12}],
            ['circle', {class:"grabber", cx:0, cy:'100%', r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:0, r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:'100%', r:12}]];
}

export function renderPageJumper(current_page_num: number, total_pages: number): any {
    const targets = Array.from(new Set(
        [1,
         ...range(1, Math.floor(total_pages/100)+1).map(v=>v*100),
         ...range(0, 10).map(v=>Math.floor(current_page_num/100)*100+v*10),
         ...range(0, 10).map(v=>Math.floor(current_page_num/10)*10+v),
         current_page_num-1, current_page_num-2,
         current_page_num+1, current_page_num+2,
         total_pages]))
        .filter(p=>p>=1 && p<=total_pages)
        .toSorted();

    console.info(targets);
    
    return targets.map(n=>
        [['a', {href:`./${n}.html`,
                class: n===current_page_num?'current-page-jump':'page-jump'}, n],
         ' ']);
}

export async function friendlyRenderPageEditor(friendly_document_id: string,
                                               page_number: number,
                                               layer_name: string = 'TextractWord'): Promise<any> {
    const pdm = selectScannedDocumentByFriendlyId().required({friendly_document_id});
    const pdmWordLayer = selectLayerByLayerName().required({document_id: pdm.document_id, layer_name});
    const pdmSamplePage = selectScannedPageByPageNumber().required(
        {document_id: pdm.document_id, page_number});
    const totalPagesInDocument = maxPageNumberForDocument().required({document_id: pdm.document_id}).max_page_number;
    console.info('max_page_number', totalPagesInDocument);
    return renderPageEditor(pdmSamplePage.page_id, pdmWordLayer.layer_id, undefined, totalPagesInDocument);
}

if (import.meta.main) {
    const friendly_document_id = Deno.args[0] ?? 'PDM';
    const page_number = parseInt(Deno.args[1] ?? '1');
    const markup = await friendlyRenderPageEditor(friendly_document_id, page_number);
    console.info(renderToStringViaLinkeDOM(markup));
}
