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

// --- Cover-cropping (aspect-ratio + framing) --------------------------------
//
// serveCropped() produces a photo filled to an EXACT (width,height) - the crop
// gives every card/thumb consistent pixels + aspect ratio.  The overflow is
// trimmed; a per-photo FOCUS positions the crop window along the trimmed axis.
// Like ALLOWED_WIDTHS, both axes of the cache are bounded so a client can't mint
// unlimited derivatives:
//
//  - ALLOWED_CROP_SIZES bounds the (width,height) set;
//  - CROP_FOCUS_LEVELS bounds the focus positions (serveCropped quantizes any
//    requested focus onto this set).

// The focus positions the crop picker offers, along the TRIMMED axis (0 = flush
// top/left, 1 = flush bottom/right).  Five levels.
export const CROP_FOCUS_LEVELS = [0, 0.25, 0.5, 0.75, 1];

// Snap an arbitrary focus to the nearest allowed level (bounds the cache, and
// makes the picker's choices the only reachable crops).
export function quantizeFocus(v: number): number {
    if(typeof v !== 'number' || !isFinite(v)) return 0.5;
    return CROP_FOCUS_LEVELS.reduce((best, lvl) =>
        Math.abs(lvl - v) < Math.abs(best - v) ? lvl : best, CROP_FOCUS_LEVELS[0]);
}

// Named display aspect ratios, and the allowlisted (thumb, detail) pixel sizes
// each renders at.  A photo field declares its aspect; the field's thumbnail and
// the detail-page image pick thumb/detail from here, and the crop picker frames
// candidates at the detail size.
export type PhotoAspect = 'square' | 'portrait' | 'landscape' | 'wide';
// The detail size is 960px on its display axis - ~3x the ~320px (.lm-photo-detail
// is 20rem) presentation slot, so the image stays crisp on 2x/3x (retina/phone)
// screens rather than being upscaled to fuzz.  Thumbs stay small (their slots
// are ≤160px).  The stored original is capped at ~1600px (LM_PHOTO_MAX_DIM), so
// these downscale from it for an aspect-matching photo.
export const PHOTO_ASPECT_SIZES:
        Record<PhotoAspect, {thumb: readonly [number, number], detail: readonly [number, number]}> = {
    square:    {thumb: [256, 256], detail: [960, 960]},    // 1:1
    portrait:  {thumb: [192, 256], detail: [960, 1280]},   // 3:4
    landscape: {thumb: [256, 192], detail: [960, 720]},    // 4:3
    wide:      {thumb: [384, 256], detail: [960, 640]},    // 3:2
};

// The bounded set of (width,height) a cropped derivative may be produced at -
// the crop analogue of ALLOWED_WIDTHS (derived from PHOTO_ASPECT_SIZES, plus a
// tiny square).  Grow deliberately as display slots need new sizes.
export const ALLOWED_CROP_SIZES: ReadonlyArray<readonly [number, number]> = [
    [96, 96],
    ...Object.values(PHOTO_ASPECT_SIZES).flatMap(s => [s.thumb, s.detail]),
];
function isAllowedCropSize(w: number, h: number): boolean {
    return ALLOWED_CROP_SIZES.some(([aw, ah]) => aw === w && ah === h);
}

// The serveCropped() URL for a photo VALUE at (width,height) - a free function
// (needs only the service's mount path, not an instance) so ImageField, which
// holds just the path string, can build crop URLs too.
export function photoCroppedSrc(mountPath: string, value: string, width: number, height: number): string {
    const {path, focus} = parsePhotoValue(value);
    return `/${mountPath}.serveCropped(${JSON.stringify(path)},${width},${height},${quantizeFocus(focus)})`;
}

// The crop-picker's options for a value at (width,height): the same photo framed
// at each focus level, the current one flagged, and the field value to store on
// pick.  Free function for the same reason as photoCroppedSrc.
export function photoCropCandidates(mountPath: string, value: string, width: number, height: number):
        Array<{focus: number, selected: boolean, src: string, value: string}> {
    const {path, focus} = parsePhotoValue(value);
    const current = quantizeFocus(focus);
    return CROP_FOCUS_LEVELS.map(level => ({
        focus: level,
        selected: level === current,
        src: `/${mountPath}.serveCropped(${JSON.stringify(path)},${width},${height},${level})`,
        value: formatPhotoValue(path, level),
    }));
}

// A photo field value is EITHER a bare content path (a centred crop - the
// default, and every legacy value) OR, once an off-centre crop is chosen, a JSON
// object {p,f} carrying the content path plus a single normalized focus.
//
// `focus` (0..1) positions the crop window along WHICHEVER axis the cover-crop
// trims - the overflow axis (vertical for a photo taller than the slot,
// horizontal for a wider one).  A cover-crop only ever trims one axis, so one
// scalar frames every case; the picker offers five positions along it.
export interface PhotoValue { path: string; focus: number; }

export function parsePhotoValue(value: string): PhotoValue {
    if(typeof value === 'string' && value.startsWith('{')) {
        try {
            const o = JSON.parse(value);
            if(o && typeof o.p === 'string')
                return {path: o.p, focus: typeof o.f === 'number' ? o.f : 0.5};
        } catch { /* fall through to bare-path */ }
    }
    return {path: value, focus: 0.5};
}

export function formatPhotoValue(path: string, focus: number): string {
    // Centred photos stay a bare path (minimal + back-compatible); only carry
    // JSON once an off-centre crop is chosen.
    return focus === 0.5 ? path : JSON.stringify({p: path, f: focus});
}

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

    // ------------------------------------------------------------------------
    // --- Cover-cropped presentation (exact width×height, framed by focus) -----
    // ------------------------------------------------------------------------

    /**
     * Resolve (creating on first request) a cover-cropped version of a stored
     * photo at EXACTLY width×height, framed vertically by focusY, and 302 to it.
     * Like serve(), this route is the permission gate; the request bounds the
     * cache by allowlisting the size and quantizing the focus.
     */
    @route(authenticated)
    async serveCropped(photoPath: string, width: number, height: number, focus: number): Promise<server.Response> {
        return server.forwardResponse('/' + await this.croppedPhotoPath(photoPath, width, height, focus));
    }

    async croppedPhotoPath(photoPath: string, width: number, height: number, focus: number): Promise<string> {
        const contentRef = this.verifiedContentRef(photoPath);
        if(!isAllowedCropSize(width, height))
            throw new Error(`unsupported crop size ${width}x${height} ` +
                `(allowed: ${ALLOWED_CROP_SIZES.map(([w, h]) => `${w}x${h}`).join(', ')})`);
        const f = quantizeFocus(focus);   // collapse onto the bounded level set
        const sourceFsPath = `${this.config.contentDir}/${contentRef}`;
        const derivedRef = await content.getDerived(
            `${this.config.derivedDir}/cropped-photos`,
            {coverCrop: (target: string, _ref: string, w: number, h: number, ff: number) =>
                this.coverCropCmd(target, sourceFsPath, w, h, ff)},
            ['coverCrop', contentRef, width, height, f],
            'jpg');
        return 'derived/' + derivedRef;
    }

    // Fill the source to cover w×h, then crop the overflow.  A cover-crop only
    // ever trims ONE axis (the other is exact), and `focus` (0..1) positions the
    // window along that trimmed axis - applying it to both offsets is correct
    // because the non-trimmed axis has zero overflow, so its offset stays 0.
    // Needs the source's post-orient dimensions; that identify runs once per
    // derivative (getDerived memoizes the result), never per request.
    private async coverCropCmd(targetPath: string, sourceFsPath: string, w: number, h: number, focus: number) {
        if(!await fs.exists(sourceFsPath))
            throw new Error(`expected source photo '${sourceFsPath}' to exist`);
        const [W, H] = await this.imageDims(sourceFsPath);
        const s = Math.max(w / W, h / H);
        const scaledW = Math.max(w, Math.round(W * s));
        const scaledH = Math.max(h, Math.round(H * s));
        const offX = Math.min(scaledW - w, Math.max(0, Math.round((scaledW - w) * focus)));
        const offY = Math.min(scaledH - h, Math.max(0, Math.round((scaledH - h) * focus)));
        const { code, stderr } = await new Deno.Command(this.magick, {
            args: [sourceFsPath, '-auto-orient', '-strip',
                   '-resize', `${scaledW}x${scaledH}!`,       // exact cover dims
                   '-crop', `${w}x${h}+${offX}+${offY}`, '+repage',
                   '-quality', '88', targetPath],
        }).output();
        if(code !== 0)
            throw new Error(`failed to crop ${sourceFsPath} to ${w}x${h}@focus=${focus}: ${new TextDecoder().decode(stderr)}`);
    }

    // Post-auto-orient pixel dimensions, so the crop math matches what
    // -auto-orient actually produces (an EXIF-rotated original swaps w/h).
    private async imageDims(sourceFsPath: string): Promise<[number, number]> {
        const { code, stdout, stderr } = await new Deno.Command(this.magick, {
            args: [sourceFsPath, '-auto-orient', '-format', '%w %h', 'info:'],
        }).output();
        if(code !== 0)
            throw new Error(`failed to read dimensions of ${sourceFsPath}: ${new TextDecoder().decode(stderr)}`);
        const [w, h] = new TextDecoder().decode(stdout).trim().split(/\s+/).map(Number);
        if(!(w > 0 && h > 0))
            throw new Error(`bad dimensions '${new TextDecoder().decode(stdout)}' for ${sourceFsPath}`);
        return [w, h];
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
                   '-quality', '88',
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

    // Cover-cropped <img> at an EXACT (width,height), framed by the value's
    // focus - the src is the serveCropped() route, so rendering never blocks on
    // ImageMagick.  `value` is a photo field value (bare path or {p,fx,fy}).
    croppedImg(value: string, width: number, height: number, attrs: Record<string, any> = {}): Markup {
        return ['img', {src: this.croppedImgSrc(value, width, height), loading: 'lazy', alt: '', ...attrs}];
    }

    croppedImgSrc(value: string, width: number, height: number): string {
        return photoCroppedSrc(this.mountPath, value, width, height);
    }

    // Cover-cropped <img> at a named aspect's thumb/detail size - the convenient
    // form for display sites (they name the aspect, not raw pixels).
    aspectImg(value: string, aspect: PhotoAspect, kind: 'thumb'|'detail',
              attrs: Record<string, any> = {}): Markup {
        const [w, h] = PHOTO_ASPECT_SIZES[aspect][kind];
        return this.croppedImg(value, w, h, attrs);
    }

    // The crop-picker's options (see photoCropCandidates).
    cropCandidates(value: string, width: number, height: number):
            Array<{focus: number, selected: boolean, src: string, value: string}> {
        return photoCropCandidates(this.mountPath, value, width, height);
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
