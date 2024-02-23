import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";

import * as utils from "../utils/utils.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import * as content from "../utils/content-store.ts";
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import {block} from "../utils/strings.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, ScannedPage, ScannedPageOpt} from './schema.ts';
import * as config from "./config.ts";

/**
 * Create a new scanned document based on the supplied fields and importing
 * the specified page files.
 */
export async function importScannedDocument(fields: ScannedDocumentOpt, pageFiles: string[]) {
    const document_id = db().insert<ScannedDocumentOpt, 'document_id'>(
        'scanned_document', fields, 'document_id');
    console.info('document_id is', document_id);
    console.info(selectScannedDocument().required({document_id}));
    for(let page_number=1; page_number<pageFiles.length+1; page_number++)
        await importScannedPage(document_id, unwrap(fields.friendly_document_id),
                                page_number, pageFiles[page_number-1]);
}

/**
 * Import a scanned page into the content store (converting image to jpg etc).
 * (details of image conversion should be configurable)
 */
async function importScannedPage(document_id: number, friendly_document_id: string, page_number: number, import_path: string): Promise<number> {

    const sourceImagePath = `imports/${friendly_document_id}/${import_path}`;
    if(!fileExists(sourceImagePath))
        throw new Error(`expected source image ${sourceImagePath} to exist`);
    //console.info('source image path is', sourceImagePath);

    const pageImagesRoot = `content/${friendly_document_id}`;
    const image_ref = 'content/'+
            await content.getDerived(pageImagesRoot, {importPageImage},
                                     ['importPageImage', sourceImagePath], 'jpg');


    const size_json_file = 'derived/'+
        await content.getDerived(`derived/${friendly_document_id}-sizes`,
                                 {getImageSizeCmd},
                                 ['getImageSizeCmd', sourceImagePath], 'json');
    const {width, height} = JSON.parse(new TextDecoder("utf-8").decode(
        await Deno.readFile(size_json_file)));
    if(!width || !height)
        throw new Error(`invalid derive image size for image ${import_path} derived to ${image_ref}`);
    
    const pageId = db().insert<ScannedPage, 'page_id'>(
        'scanned_page', {document_id, page_number, import_path,
                         image_ref, width, height}, 'page_id');

    console.info('imported pageId is', pageId);
    
    return pageId;
}

/**
 * Content store function to do the actual image conversion.
 * (things like quality should be in the parameter list, and thereby in the
 * content store closure)
 */
async function importPageImage(targetImagePath: string, sourceImagePath: string) {
    //const sourceImagePath = contentRoot+'/'+sourceImageRef;
    if(!fileExists(sourceImagePath))
        throw new Error(`expected source image ${sourceImagePath} to exist`);

    const quality = 80;
    const { code, stdout, stderr } = await new Deno.Command(
        config.imageMagickPath, {
            args: [
                sourceImagePath,
                "-quality", String(quality),
                targetImagePath
            ],
        }).output();

    if(code !== 0)
        throw new Error(`failed to convert image ${sourceImagePath} to ${targetImagePath}: ${new TextDecoder().decode(stderr)}`);

    console.info(`done convert image ${sourceImagePath} to ${targetImagePath}`);
}

/**
 * Content store function to get the size of an image.
 *
 */
async function getImageSizeCmd(targetResultPath: string, sourceImagePath: string) {
    //const sourceImagePath = contentRoot+'/'+sourceImageRef;
    if(!fileExists(sourceImagePath))
        throw new Error(`expected source image ${sourceImagePath} to exist`);
    const size = await getImageSize(sourceImagePath);
    return JSON.stringify(size);
}

/**
 * Given an imagePath, return its size.
 *
 * A bit pokey because it execs image magick.
 */
async function getImageSize(imagePath: string): Promise<{width: number, height: number}> {
    const { code, stdout, stderr } = await new Deno.Command(
        config.imageMagickPath, {
            args: [
                imagePath, '-ping', '-format', '{"width":%w, "height":%h}', 'info:'
            ],
        }).output();

    if(code !== 0)
        throw new Error(`failed to get image size for ${imagePath}: ${new TextDecoder().decode(stderr)}`);

    const sizeJson = new TextDecoder().decode(stdout);
    let size;
    try {
        size = JSON.parse(sizeJson);
    } catch(e) {
        throw new Error(`Failed to parse image size for ${imagePath} - '${sizeJson}' - ${e}`);
    }
    if(!size.width || !size.height) {
        throw new Error(`Failed to parse image size for ${imagePath} - missing fields in '${sizeJson}'`);
    }

    return size;
}
