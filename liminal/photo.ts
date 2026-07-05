// deno-lint-ignore-file no-explicit-any
/**
 * Photo upload + presentation sizing on top of the content store
 * (liminal/content-store.ts), following the wordwiki audio.ts pattern:
 *
 *  - Uploaded ORIGINALS are content-addressed into a base store
 *    (<contentDir>/photos): the stored field value is a server-relative path
 *    like 'content/photos/3ab/3ab….jpg' (the hash names make these unguessable
 *    capability URLs, and the owner-controlled extension lets the http server
 *    serve them directly as files).
 *
 *  - Presentation sizes are made ON DEMAND through the DERIVED store
 *    (<derivedDir>/sized-photos): the content key is the hash of the
 *    generating closure ['resizePhoto', <source ref>, <width>], so each
 *    (photo, width) pair is computed once, then served as a plain file
 *    forever after.  The <img> src points at the serve() route, which
 *    resolves/creates the derived file and 302s to it - so a render never
 *    awaits ImageMagick unless that exact size has never been requested.
 *
 * Permissions: serve() runs through the app's normal authenticated route
 * dispatch - THAT is the permission gate ("clearing the path").  The 302
 * target lives in a statically-served dir, where the sha256 path itself is
 * the capability.
 *
 * Privacy note: the client-side downscale (lmPhotoFieldChange in
 * resources/liminal-scripts.js) re-encodes through a canvas, which strips
 * EXIF (incl. GPS) and bakes in orientation; the server-side resize ALSO
 * passes -auto-orient -strip as a second line of defense for originals that
 * arrive by other means.
 */

import * as fs from "https://deno.land/std@0.195.0/fs/mod.ts";
import * as content from "./content-store.ts";
import * as server from "./http-server.ts";
import type {Markup} from "./markup.ts";
import { route, authenticated } from "./security.ts";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

// The only presentation widths serve() will produce: an open set would let
// any client mint unlimited derived files (each distinct width is a new
// cache entry on disk).
export const ALLOWED_WIDTHS = [96, 256, 512, 1024, 1600];

// Decoded upload cap.  The client downscales to ≤1600px JPEG (well under
// 1MB) before uploading; the cap only bounds a misbehaving client.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface PhotoServiceConfig {
    contentDir: string;    // fs dir served statically at /content/
    derivedDir: string;    // fs dir served statically at /derived/
    mountPath: string;     // route path of this instance (e.g. 'rabid.photo')
    magickPath?: string;   // ImageMagick CLI (default 'magick')
}

export class PhotoService {

    constructor(public config: PhotoServiceConfig) {}

    get mountPath(): string { return this.config.mountPath; }
    private get magick(): string { return this.config.magickPath ?? 'magick'; }

    // ------------------------------------------------------------------------
    // --- Upload (an authenticated rpc route) ---------------------------------
    // ------------------------------------------------------------------------

    // The client sends the (already client-side downscaled) image as base64
    // JSON, like wordwiki's uploadRecording.  Only JPEG/PNG are accepted -
    // the normal path produces JPEG (canvas re-encode); the magic check stops
    // arbitrary files from being parked in a publicly-served dir.
    @route(authenticated, {mutates: true})
    async upload(args: {imageBytesAsBase64?: string}): Promise<{photoPath: string}> {
        const b64 = args?.imageBytesAsBase64;
        if(typeof b64 !== 'string' || b64.length === 0)
            throw new Error('missing/malformed imageBytesAsBase64 in photo upload');
        const bytes = decodeBase64(b64);
        if(bytes.length > MAX_UPLOAD_BYTES)
            throw new Error('uploaded photo is too large');

        const extension = sniffImageExtension(bytes);
        if(!extension)
            throw new Error('expected uploaded photo to be a JPEG or PNG');

        const contentRef = await content.addFileAsData(
            `${this.config.contentDir}/photos`, bytes, extension);
        return {photoPath: 'content/' + contentRef};
    }

    // ------------------------------------------------------------------------
    // --- Sized presentation (the <img> src route) -----------------------------
    // ------------------------------------------------------------------------

    /**
     * Resolve (creating on first request) the width-bounded version of a
     * stored photo and 302 to it.  This route IS the permission gate for
     * photos: <img> tags point here (authenticated dispatch), the redirect
     * target is the capability-URL file.
     */
    @route(authenticated)
    async serve(photoPath: string, width: number): Promise<server.Response> {
        return server.forwardResponse('/' + await this.sizedPhotoPath(photoPath, width));
    }

    // 'content/photos/3ab/….jpg' + width -> 'derived/sized-photos/….jpg'
    async sizedPhotoPath(photoPath: string, width: number): Promise<string> {
        const contentRef = this.verifiedContentRef(photoPath);
        if(!ALLOWED_WIDTHS.includes(width))
            throw new Error(`unsupported photo width ${width} (allowed: ${ALLOWED_WIDTHS.join(', ')})`);
        const sourceFsPath = `${this.config.contentDir}/${contentRef}`;
        const derivedRef = await content.getDerived(
            `${this.config.derivedDir}/sized-photos`,
            // The fs layout stays OUT of the closure key (it would tie the
            // derived hashes to the deployment dirs); the fn rebinds the ref
            // to this service's dirs at run time.
            {resizePhoto: (target: string, _ref: string, w: number) =>
                this.resizePhotoCmd(target, sourceFsPath, w)},
            ['resizePhoto', contentRef, width],
            'jpg');
        return 'derived/' + derivedRef;
    }

    // A stored photo field value is exactly 'content/photos/<3hex>/<sha256>.<ext>'
    // (verifyContentId enforces the shape, so no '..' or stray paths can reach
    // the filesystem).  Returns the ref relative to contentDir.
    private verifiedContentRef(photoPath: string): string {
        if(typeof photoPath !== 'string' || !photoPath.startsWith('content/'))
            throw new Error(`malformed photo path '${photoPath}'`);
        const contentRef = photoPath.slice('content/'.length);
        const parsed = content.parseContentId(contentRef);  // throws if malformed
        if(parsed.contentStore !== 'photos')
            throw new Error(`photo path '${photoPath}' is not in the photos store`);
        return contentRef;
    }

    private async resizePhotoCmd(targetPath: string, sourceFsPath: string, width: number) {
        if(!await fs.exists(sourceFsPath))
            throw new Error(`expected source photo '${sourceFsPath}' to exist`);
        const { code, stderr } = await new Deno.Command(this.magick, {
            args: [sourceFsPath,
                   '-auto-orient', '-strip',              // bake rotation, drop EXIF/GPS
                   '-resize', `${width}x${width}>`,       // bound longest side, never enlarge
                   '-quality', '82',
                   targetPath],
        }).output();
        if(code !== 0)
            throw new Error(`failed to resize ${sourceFsPath} to ${width}px: ${new TextDecoder().decode(stderr)}`);
    }

    // ------------------------------------------------------------------------
    // --- Render helper --------------------------------------------------------
    // ------------------------------------------------------------------------

    // Synchronous <img> markup for a stored photo path: the src is the serve()
    // route, so rendering never waits on the resizer.
    img(photoPath: string, width: number, attrs: Record<string, any> = {}): Markup {
        return ['img', {src: this.imgSrc(photoPath, width), loading: 'lazy', alt: '', ...attrs}];
    }

    imgSrc(photoPath: string, width: number): string {
        return `/${this.mountPath}.serve(${JSON.stringify(photoPath)},${width})`;
    }
}

// JPEG: FF D8 FF;  PNG: 89 'PNG'.
function sniffImageExtension(bytes: Uint8Array): string|undefined {
    if(bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF)
        return 'jpg';
    if(bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47)
        return 'png';
    return undefined;
}
