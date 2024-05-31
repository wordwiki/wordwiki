// deno-lint-ignore-file no-unused-vars

import * as fs from "std/fs/mod.ts";

import * as utils from "../utils/utils.ts";
import {unwrap} from "../utils/utils.ts";
import { db, Db, PreparedQuery, assertDmlContainsAllFields, boolnum, defaultDbPath } from "./db.ts";
import * as content from "../utils/content-store.ts";
import {exists as fileExists} from "std/fs/mod.ts"
import {block} from "../utils/strings.ts";
import {ScannedDocument, ScannedDocumentOpt, selectScannedDocument, selectScannedDocumentByFriendlyId, ScannedPage, ScannedPageOpt, selectScannedPagesForDocument} from './schema.ts';
import * as config from "./config.ts";
import {getImageSize} from "./get-image-size.ts";

/**
 * Returns a dir path containing the specified image sliced into tiles
 * of size tileWidth*tileHeight.
 */
export async function getTilesForImage(imagePath: string, tileWidth: number, tileHeight: number): Promise<string> {
    return 'derived/'+
        await content.getDerived(`derived/image-tiles`,
                                 {getTilesForImageCmd},
                                 ['getTilesForImageCmd', imagePath, tileWidth, tileHeight], 'tiles');
}

/**
 *
 */
async function getTilesForImageCmd(targetResultPath: string, sourceImagePath: string, tileWidth: number, tileHeight: number) {

    // --- Make output directory, splatting if it already exists.
    await Deno.mkdir(targetResultPath);

    // --- Exec imagemagick to do the actual tiling
    const { code, stdout, stderr } = await new Deno.Command(
        config.imageMagickPath, {
            args: [
                sourceImagePath, '+gravity',
                '-crop', `${tileWidth}x${tileHeight}`,
                '-quality', '80',
                `${targetResultPath}/tile-%d.jpg`
            ],
        }).output();
    if(code !== 0)
        throw new Error(`failed to tile image ${sourceImagePath}: ${new TextDecoder().decode(stderr)}`);

    // --- Imagemagick generates numbered tiles, we want them named by tile x,y instead.
    const {width, height} = await getImageSize(sourceImagePath);
    const widthInTiles = Math.ceil(width / tileWidth);
    const heightInTiles = Math.ceil(height / tileHeight);
    const totalTiles = widthInTiles*heightInTiles;

    // --- Confirm that we got the expected number of tile files
    const tileFiles = await Array.fromAsync(await Deno.readDir(targetResultPath));
    //console.info(JSON.stringify(tileFiles.map(t=>t.name)));
    if(tileFiles.length !== widthInTiles*heightInTiles)
        throw new Error(`${targetResultPath}: Expected ${widthInTiles*heightInTiles} tiles for image of size ${width}x${height} and tile size of ${tileWidth}x${tileHeight} got ${tileFiles.length} tiles - ${JSON.stringify(tileFiles.map(t=>t.name))}`);

    // --- Rename the tile files to x by y coordinates
    for(let y=0; y<heightInTiles; y++) {
        for(let x=0; x<widthInTiles; x++) {
            const tileNumber = y*widthInTiles+x;
            //console.info('x', x, 'y', y, 'tile #', tileNumber, 'widthInTiles', widthInTiles);
            await Deno.rename(`${targetResultPath}/tile-${tileNumber}.jpg`,
                              `${targetResultPath}/tile-${x}-${y}.jpg`);
        }
    }
}

/**
 *
 */
export async function preWarmDerivedPageImagesCacheForDocument(friendly_document_id: string) {
    const document = selectScannedDocumentByFriendlyId().required({friendly_document_id});
    const pages = selectScannedPagesForDocument().all({document_id: document.document_id});
    // // TODO: do the awaiting in groups to run about 12 at a time or something.
    // for(page of pages) {
    //     getThumbnail(page.image_ref, 128);
    //     getThumbnail(page.image_ref, 1024, 128);
    // }
    // pages.map(page=>getThumbnail(page.page_id, 128));
    for(const page of pages) {
        console.info(`generating derived images for page ${friendly_document_id}.${page.page_number}`);
        await getTilesForImage(
            page.image_ref, config.defaultTileWidth, config.defaultTileHeight);
    }
}

/**
 * Simple CLI.
 */
async function main() {
    const [command, friendly_document_id] = Deno.args;
    if(command !== 'derive' || !friendly_document_id)
        throw new Error('incorrect usage');
    await preWarmDerivedPageImagesCacheForDocument(friendly_document_id);
    // console.info(await getTilesForImage('content/PacifiquesGeography/bc5/bc52a1d5bc64eb191d2b50eb23b7b56624beaad7080e80a27368a1558fa57b13.jpg', 1024, 256));
}

if (import.meta.main)
    await main();
