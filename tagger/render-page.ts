import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import { selectLayerByLayerName } from "./schema.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, selectScannedDocumentByFriendlyId, ScannedPage, ScannedPageOpt, selectScannedPage, selectScannedPageByPageNumber, BoundingBox, boundingBoxFieldNames, BoundingGroup, boundingGroupFieldNames} from './schema.ts';
import {block} from "../utils/strings.ts";
import * as utils from "../utils/utils.ts";
import { writeAll } from "https://deno.land/std@0.195.0/streams/write_all.ts";

async function test() {
    const pdm = selectScannedDocumentByFriendlyId().required({friendly_document_id: 'PDM'});
    const pdmWordLayer = selectLayerByLayerName().required({document_id: pdm.document_id, layer_name: 'TextractWord'});
    console.time('bondingBoxesForPage');
    //for(let page_number=1; page_number<100; page_number++) {
    const page_number = 10;
    const pdmSamplePage = selectScannedPageByPageNumber().required(
        {document_id: pdm.document_id, page_number});
    const page = renderPage(pdmSamplePage.page_id, pdmWordLayer.layer_id, undefined);
    //}
    console.timeEnd('bondingBoxesForPage');

    console.info(page);
    
    const output = new TextEncoder().encode(page);
    const file = await Deno.open('test.html', {write: true, create: true});
    try {
        await writeAll(file, output);
    } finally {
        file.close();
    }

    
}

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


export function renderGroup(groupId: number, boxes: BoxGroupJoin[]): string {
    utils.assert(boxes.length > 0, 'Cannot render an empty group');
    const group: GroupJoinPartial = boxes[0];
    return block`
/**/      <svg class="group WORD" id="${groupId}" onclick="activate_group()">
/**/           ${boxes.map(b=>renderBox(b))}
/**/      </svg>`;
}

export function renderBox(box: BoxGroupJoin): string {
    return block`
/**/       <rect class="segment" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" />`;
}



export function renderPage(page_id: number,
                           layer_id: number,
                           reference_layer_id?: number) {

    const page = selectScannedPage().required({page_id});

    const boxes = boxesForPageLayer().all({page_id, layer_id});

    
    //console.info('data', boxes);

    const pageImageUrl = page.image_ref;
    
    const boxesByGroup = utils.groupToMap(boxes, box=>box.bounding_group_id);

    const blocksSvg = 
        [...boxesByGroup.entries()].
        map(([groupId, boxes])=>renderGroup(groupId, boxes)).join('');

    
    const html = `<!DOCTYPE html>
<head>

    <style>

     #annotatedPage {
         position:relative; display:inline-block;
     }

     #annotatedPage svg {
        position:absolute; top:0; left:0;
     }

     .group.WORD > rect.segment {
         fill-opacity: 10%;
stroke-width:3;
         stroke:green;
     }

     .group.LINE > rect.segment {
         stroke:blue;
         stroke-width:6;
     }

     .group:hover > rect.segment {
stroke:red !important;
     }

     .group.active > rect.segment {
         stroke-width:3;
         stroke:purple;
     }

    </style>

    <script>
     function activate_group() {
         const group_elem = event.currentTarget;

         console.info('activate group', group_elem.id);

         const current_active_group_elem = document.querySelector('#annotatedPage svg .group.active');
         if(current_active_group_elem) {
             console.info('deactivating group', current_active_group_elem.id);
             current_active_group_elem.classList.remove('active');
         }
         
         group_elem.classList.add('active');
     }
    </script>

</head>

<body>

    <div>
    <h1>PDM Textract preview page ${page.page_number}</h1>
    <a href="./page-${String(page.page_number-1).padStart(5, '0')}.html">PREV</a> / 
    <a href="./page-${String(page.page_number+1).padStart(5, '0')}.html">NEXT</a>

    </div>
    <div id="annotatedPage">
        
         <img src="${pageImageUrl}" width="${page.width}" height="${page.height}">
         <svg width="${page.width}" height="${page.height}">
${blocksSvg}
        </svg>
    </div>
    <div>
       <a href="./page-${String(page.page_number-1).padStart(5, '0')}.html">PREV</a> / 
       <a href="./page-${String(page.page_number+1).padStart(5, '0')}.html">NEXT</a>
    </div>
</body>`;

    return html;
}



if (import.meta.main) {
    await test();

}
