import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import { selectLayerByLayerName } from "./schema.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, selectScannedDocumentByFriendlyId, ScannedPage, ScannedPageOpt, selectScannedPage, selectScannedPageByPageNumber, BoundingBox, boundingBoxFieldNames, BoundingGroup, boundingGroupFieldNames} from './schema.ts';
import {block} from "../utils/strings.ts";
import * as utils from "../utils/utils.ts";
import { writeAll } from "https://deno.land/std@0.195.0/streams/write_all.ts";
import { renderToStringViaLinkeDOM } from '../utils/markup.ts';

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

export function renderPage(page_id: number,
                           layer_id: number,
                           reference_layer_id?: number): any {

    const page = selectScannedPage().required({page_id});
    const boxes = boxesForPageLayer().all({page_id, layer_id});

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
           ['a', {href:`./${page.page_number-1}.html`}, 'PREV'], '/',
           ['a', {href:`./${page.page_number+1}.html`}, 'NEXT']],
          ['div', {id: 'annotatedPage'},
           ['img', {src:pageImageUrl, width:page.width, height:page.height}],
           ['svg', {width:page.width, height:page.height,
                    onmousedown: 'pageEditorMouseDown(event)',
                    onmousemove: 'pageEditorMouseMove(event)',
                    onmouseup: 'pageEditorMouseUp(event)'},
            blocksSvg]]]]);
}

export function renderGroup(groupId: number, boxes: BoxGroupJoin[]): any {
    utils.assert(boxes.length > 0, 'Cannot render an empty group');
    const group: GroupJoinPartial = boxes[0];
    return (
        ['svg', {class:"group WORD", id:groupId},
         boxes.map(b=>renderBox(b))
        ]);
}

export function renderBoxOld(box: BoxGroupJoin): any {
    return ['rect', {class:"segment", x:box.x, y:box.y, width:box.w, height:box.h}];
}

export function renderBox(box: BoxGroupJoin): any {
    return ['svg', {class:"box", x:box.x, y:box.y, width:box.w, height:box.h},
            ['rect', {class:"frame", x:0, y:0, width:'100%', height:'100%'}],
            ['circle', {class:"grabber", cx:0, cy:0, r:12}],
            ['circle', {class:"grabber", cx:0, cy:'100%', r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:0, r:12}],
            ['circle', {class:"grabber", cx:'100%', cy:'100%', r:12}]];
}

export async function friendlyRenderPage(friendly_document_id: string,
                                         page_number: number,
                                         layer_name: string = 'TextractWord'): Promise<any> {
    const pdm = selectScannedDocumentByFriendlyId().required({friendly_document_id});
    const pdmWordLayer = selectLayerByLayerName().required({document_id: pdm.document_id, layer_name});
    const pdmSamplePage = selectScannedPageByPageNumber().required(
        {document_id: pdm.document_id, page_number});
    return renderPage(pdmSamplePage.page_id, pdmWordLayer.layer_id, undefined);
}

if (import.meta.main) {
    const friendly_document_id = Deno.args[0] ?? 'PDM';
    const page_number = parseInt(Deno.args[1] ?? '1');
    const markup = await friendlyRenderPage(friendly_document_id, page_number);
    console.info(renderToStringViaLinkeDOM(markup));
}
