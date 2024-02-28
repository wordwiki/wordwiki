import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../utils/utils.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, boolnum } from "./db.ts";
import * as content from "../utils/content-store.ts";
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import {block} from "../utils/strings.ts";
//import * as scannedDocument from "./scanned-document.ts";
import {selectScannedDocument, selectScannedDocumentByFriendlyId, selectScannedPage, ScannedPage, scannedPageFieldNames, Layer, selectLayerByLayerName, BoundingBox, BoundingGroup, boundingBoxFieldNames, selectLayer} from  "./schema.ts";
import {awsCmdPath} from './config.ts';

// As of Jan 2024, textract cost is $1.50USD/1000 pages (+S3, transfer etc).
// https://aws.amazon.com/textract/pricing/

// As of Mar 2024 google cloud vision is less useful for the PDM manuscript project -
// You can try it yourself by dragging and dropping a manuscript page image here:
// https://cloud.google.com/vision/docs/drag-and-drop
// We may still want to add a google cloud OCR layer at some point, for example if
// it does a better job of turning mikmaq words into text.

/**
 * Run textract and load the results for all pages in the specified document
 * that do not already have a textract page box loaded.
 *
 * Safe to rerun, correcting errors, until you get a clean load of all pages
 * in a document.
 *
 * Can only be run in an environment with a logged-in aws CLI (which will
 * be used to upload images to s3, then run the though textract).
 */
export async function textractDocument(document_id: number) {

    const friendly_document_id = selectScannedDocument().required({document_id}).friendly_document_id;
                                                                  
    await syncScannedBookToS3(`content/${friendly_document_id}`);
    
    const pages = db().all<ScannedPage, {document_id: number}>(block`
/**/      SELECT ${scannedPageFieldNames.join()}
/**/         FROM scanned_page
/**/         WHERE document_id = :document_id
/**/         ORDER BY page_number`, {document_id});
    
    console.info('begin textractDocument');
    //console.info('pages are', pages);

    const textractPageLayerId = getOrCreateNamedLayer(document_id, 'TextractPage', 1);
    const textractLineLayerId = getOrCreateNamedLayer(document_id, 'TextractLine', 1);
    const textractWordLayerId = getOrCreateNamedLayer(document_id, 'TextractWord', 1);

    console.info('textracting pages ', textractPageLayerId, textractLineLayerId, textractWordLayerId);
    for(const page of pages) {
        if(!haveTextractPageBoxForPage(page.page_id, textractPageLayerId) /*&& page.page_number <= 25*/) {
            const blocks = await textractPage(page.page_id);
            db().transaction(()=>{
                blocks.filter(b=>b.type === 'WORD').map(b=>
                    insertTextractBlock(document_id, textractWordLayerId, page.page_id,
                                        b.x, b.y, b.w, b.h, b.text));
                blocks.filter(b=>b.type === 'LINE').map(b=>
                    insertTextractBlock(document_id, textractLineLayerId, page.page_id,
                                        b.x, b.y, b.w, b.h, b.text));
                blocks.filter(b=>b.type === 'PAGE').map(b=>
                    insertTextractBlock(document_id, textractPageLayerId, page.page_id,
                                        b.x, b.y, b.w, b.h, b.text));
            });
        }
    }
    console.info(db().all<BoundingBox, {}>(
        block`
/**/       SELECT ${boundingBoxFieldNames.join()} FROM bounding_box`, {}));

    // Sample FTS query
    console.info(db().all<{text:string, bounding_box_id: number}, {query: string}>(
        block`
/**/    SELECT bounding_box_id, text FROM bounding_box_fts
/**/        WHERE text match :query`,
        {query: 'pene*'}));
}

function insertTextractBlock(document_id: number, layer_id: number, page_id: number,
                             x: number, y: number, w: number, h: number,
                             text: string): number {
    const bounding_group_id = db().insert<BoundingGroup, 'bounding_group_id'>(
        'bounding_group', {document_id, layer_id}, 'bounding_group_id');
    return db().insert<BoundingBox, 'bounding_box_id'>(
        'bounding_box', {bounding_group_id, document_id, layer_id, page_id,
                         x, y, w, h, text}, 'bounding_box_id');
}

/**
 * Find a named reference layer, creating it if it does not yet exist.
 */
function getOrCreateNamedLayer(document_id: number, layer_name: string, is_reference_layer: boolnum): number {
    const alreadyExistingLayer = selectLayerByLayerName().first({document_id, layer_name});
    if(alreadyExistingLayer) {
        if(alreadyExistingLayer.is_reference_layer !== is_reference_layer)
            throw new Error(`Expected is_reference_layer to be ${is_reference_layer} for layer ${layer_name} in document ${document_id}`);
        else
            return alreadyExistingLayer.layer_id;
    } else {
        return db().insert<Layer, 'layer_id'>(
            'layer', {document_id, layer_name, is_reference_layer}, 'layer_id');
    }
}

/**
 * Sync the content images for a book to s3 (the cleanest way to use the images
 * as a source for textract).
 */
async function syncScannedBookToS3(contentDir: string) {
    console.info(`syncing page images to s3 for ${contentDir}`);
    const { code, stdout, stderr } = await new Deno.Command(
    awsCmdPath, {
        args: [
            's3',
            'sync',
            `${contentDir}/`,
            `s3://mmo-pdm/${contentDir}/`
        ],
    }).output();
    if(code !== 0)
        throw new Error(`failed to sync page images to s3: ${new TextDecoder().decode(stderr)}`);
    console.info('done syncing page images to s3');
}

/**
 * Determines whether we have already generated the textract 'page' layer
 * bounding box for a particular page.
 *
 * Used to determine if we have imported the textract layers for a particular
 * page (all pages have a page bounding box in the page layer).  (this is hacky,
 * we may eventually want to support some other bounding tech that does not have
 * this property).
 */
function haveTextractPageBoxForPage(page_id: number, layer_id: number): boolean {
    return db().exists<{page_id: number, layer_id: number}>(block`
/**/     SELECT bounding_box_id
/**/         FROM bounding_box 
/**/         WHERE layer_id = :layer_id AND page_id = :page_id`,
/**/         {layer_id, page_id});
}

// async function foo() {

//     const layer_id = db.first(<document_id: number, layer_name: string>, block`
// /**/    SELECT layer_id FROM bounding_box WHERE page_id = 'page_id'
                              
//     db.first(<{bounding_box_id: number}, {page_id: number, layer_name: string}>(
//         `SELECT bounding_box_id FROM bounding_box
// WHERE page_id = :page_id AND layer
// }


/**
 * Returns textract PAGE, LINE and WORD blocks for a specified.
 *
 * Uses a derived content store so the work is cached across runs (keyed
 * by the source image contents).
 */
async function textractPage(page_id: number): Promise<Block[]> {
    
    const page = selectScannedPage().required({page_id});
    const document = selectScannedDocument().required({document_id: page.document_id});
    
    const textractJsonFilename =
        await content.getDerived(`derived/${document.friendly_document_id}-textract`,
                                 {textract: textractPageImpl},
                                 ['textract', page.image_ref], 'json');

    const textractBlocks = extractBlocksFromTextract(
        JSON.parse(await Deno.readTextFile(`derived/${textractJsonFilename}`)) as TextractDocument,
        page.width, page.height);

    //console.info('textract is', textractBlocks);

    return textractBlocks;
}

/**
 * Invoke aws textract on the specified relative image path.
 *
 * The image (at that path) will have been uploaded by
 * 'syncScannedBookToS3'.
 * 
 * Note the textract source image is (as of Mar 2024) restricted to a max size
 * of 5MB.  We are not hitting this limit with our present images, but if it
 * becomes an issue, we will need to make a secondary derived version of the
 * content images that does higher compression on any image that exceeds 5MB.
 *
 * Note: if you change the behaviour of textractPageImpl, you should flush
 * the cache by erasing the correspoinding content-derived directory.
 */
async function textractPageImpl(targetPath: string, imageRef: string) {
    const { code, stdout, stderr } = await new Deno.Command(
        awsCmdPath, {
            args: [
                'textract',
                'detect-document-text',
                '--document',
                `{"S3Object":{"Bucket":"mmo-pdm","Name":"${imageRef}"}}`
            ],
        }).output();

    if(code !== 0)
        throw new Error(`failed to textract ${imageRef}: ${new TextDecoder().decode(stderr)}`);

    const output = new TextDecoder().decode(stdout);

    //console.info('TEXTRACT output is', output);

    return output;
}

/**
 * We reduce the textract output to a list of blocks.
 */
export interface Block {
    x: number;
    y: number;
    w: number;
    h: number;
    type: 'PAGE'|'LINE'|'WORD';
    text: string;
}

/**
 * Extract blocks (PAGE/LINE/WORD) from the textract output.
 *
 * Also converts the coordinate system to pixels.
 */
function extractBlocksFromTextract(textract: TextractDocument, pageWidth: number, pageHeight: number): Block[] {
    
    const textractBlocks = textract.Blocks;
    if(!textractBlocks)
        throw new Error('unable to find Blocks in textract');
    if(!Array.isArray(textractBlocks))
        throw new Error('expected textract blocks to be an array');

    const blocks = textractBlocks.map(b=>{
        const {BlockType: blockType, Geometry: geometry} = b;
        if(typeof blockType !== 'string')
            throw new Error('missing BlockType');
        const {BoundingBox: boundingBox} = geometry;
        const {Left: x, Top: y, Width: w, Height: h} = boundingBox;
        if(typeof x !== 'number' || typeof y !== 'number' ||
            typeof w !== 'number' || typeof h !== 'number') {
            throw new Error('malformed block geometry');
        }
        return {type: b.BlockType,
                x: Math.round(x*pageWidth), y: Math.round(y*pageHeight),
                w: Math.round(w*pageWidth), h: Math.round(h*pageHeight),
                text: b.Text};
    });

    return blocks;
}

/**
 * The following is a partial typing for the textract JSON format
 * to make it easier to work with.
 */
interface TextractDocument {
    Blocks: TextractBlock[];
}

interface TextractBlock {
    BlockType: 'PAGE'|'LINE'|'WORD';
    Text: string,
    Geometry: TextractGeometry;
}

interface TextractGeometry {
    BoundingBox: TextractBoundingBox;
}

interface TextractBoundingBox {
    Width: number;
    Height: number;
    Left: number;
    Top: number;
}

/**
 * Simple CLI.
 */
async function main() {
    const args = Deno.args;
    const command = args[0];
    switch(command) {
        case 'textract': {
            const book = args[1];
            if(!book)
                throw new Error('usage: textract [bookName]');
            console.info(`--- textracting "${book}"`);
            textractDocument(selectScannedDocumentByFriendlyId().
                required({friendly_document_id: book}).document_id);
            break;
        };
        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}

if (import.meta.main)
    await main();
