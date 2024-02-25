//import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";
import * as content from "../utils/content-store.ts";
import {exists as fileExists} from "https://deno.land/std/fs/mod.ts"
import * as config from "./config.ts";

/**
 * Given an imagePath, return its size, persistently caching the result based
 * on the imagePath.
 *
 * We exec imagemagick to get the file size.
 *
 * We want to use image magick to do this because all of our other image
 * processing is done using image magick, and using some other technique
 * to get sizes will introduce weird limitations - for example we presently
 * can process any image kind that image magick supports.
 *
 * This should not be used for image paths that may be overwritten
 * with new content (we are almost always passing in image paths that
 * are already content store ids (md5s of the image contents) - so not
 * an issue for our usage)
 */
export async function getImageSize(imagePath: string): Promise<{width: number, height: number}> {
    const size_json_file = 'derived/'+
        await content.getDerived(`derived/image-sizes`,
                                 {getImageSizeCmd},
                                 ['getImageSizeCmd', imagePath], 'json');
    const size: {width: number, height: number} =
        JSON.parse(new TextDecoder("utf-8").decode(await Deno.readFile(size_json_file)));
    if(typeof(size?.width) !== 'number' || typeof(size?.height) !== 'number')
        throw new Error(`invalid derive image size for image ${imagePath} - got ${JSON.stringify(size)}`);
    return size;
}

/**
 * Content store function to get the size of an image.
 */
async function getImageSizeCmd(targetResultPath: string, sourceImagePath: string) {
    if(!fileExists(sourceImagePath))
        throw new Error(`expected source image ${sourceImagePath} to exist`);
    const size = await getImageSizeUncached(sourceImagePath);
    return JSON.stringify(size);
}

/**
 * Given an imagePath, return its size.
 *
 * A bit pokey because it execs image magick.
 *
 * Use getImageSize() to run this behind our persistent cache.
 */
export async function getImageSizeUncached(imagePath: string): Promise<{width: number, height: number}> {
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
    if(typeof size?.width !== 'number' || typeof size?.height !== 'number') {
        throw new Error(`Failed to parse image size for ${imagePath} - missing fields in '${sizeJson}'`);
    }

    return size;
}
