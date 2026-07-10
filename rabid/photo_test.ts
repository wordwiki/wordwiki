// Photo upload + on-demand sizing (liminal/photo.ts) and the ImageField
// control (liminal/table.ts).  The PhotoService tests run against temp dirs
// (this is inherently a filesystem feature) and exercise the real ImageMagick
// resize; the field tests are the usual render-to-markup checks.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asAnon, asSystem } from "./testing.ts";
import { findAll, hasText, findByTestId } from "../liminal/testing/markup-assert.ts";
import { PhotoService, ALLOWED_WIDTHS, CROP_FOCUS_LEVELS,
         parsePhotoValue, formatPhotoValue, quantizeFocus, normalizeRotate,
         photoCroppedSrc, photoContainedSrc } from "../liminal/photo.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { rabid, getRabid } from "./rabid.ts";
import { navBar } from "./templates.ts";

// The pixel dimensions of a produced file (via ImageMagick identify).
async function dimsOf(path: string): Promise<[number, number]> {
    const {stdout} = await new Deno.Command('magick',
        {args: ['identify', '-format', '%w %h', path]}).output();
    const [w, h] = new TextDecoder().decode(stdout).trim().split(/\s+/).map(Number);
    return [w, h];
}

// Mean luminance (0..1) of an image - a cheap way to tell two crops of a
// gradient apart by CONTENT (not just by derived-path identity).
async function meanOf(path: string): Promise<number> {
    const {stdout} = await new Deno.Command('magick',
        {args: [path, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']}).output();
    return Number(new TextDecoder().decode(stdout).trim());
}

// Content-address a freshly-generated w×h image whose brightness ramps
// left→right (a horizontal gradient, so a horizontal crop shift changes the
// mean) into the service's photo store, and return its stored path.  gradient:
// is vertical, so we build h×w then rotate 90°.
async function uploadWideGradient(svc: PhotoService, w: number, h: number): Promise<string> {
    const tmp = await Deno.makeTempFile({suffix: '.png'});
    await new Deno.Command('magick',
        {args: ['-size', `${h}x${w}`, 'gradient:black-white', '-rotate', '90', tmp]}).output();
    const bytes = await Deno.readFile(tmp);
    await Deno.remove(tmp);
    return (await svc.upload({imageBytesAsBase64: encodeBase64(bytes)})).photoPath;
}

// Content-address a plain w×h image (solid gray) - a source of a known aspect
// ratio for the framing-picker decision.
async function uploadSolid(svc: PhotoService, w: number, h: number): Promise<string> {
    const tmp = await Deno.makeTempFile({suffix: '.png'});
    await new Deno.Command('magick', {args: ['-size', `${w}x${h}`, 'xc:gray', tmp]}).output();
    const bytes = await Deno.readFile(tmp);
    await Deno.remove(tmp);
    return (await svc.upload({imageBytesAsBase64: encodeBase64(bytes)})).photoPath;
}

// An 8x8 red JPEG and an 8x8 blue PNG (generated with ImageMagick, embedded
// so the tests are hermetic).
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADQXqtf/2Q==';
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURTBAwP///48dLj8AAAABYktHRAH/Ai3eAAAAB3RJTUUH6gYKECAcBlVcHQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNi0xMFQxNjozMjoyOCswMDowMLUgPa8AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDYtMTBUMTY6MzI6MjgrMDA6MDDEfYUTAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA2LTEwVDE2OjMyOjI4KzAwOjAwk2ikzAAAAAtJREFUCNdjYEAFAAAQAAGhxSHBAAAAAElFTkSuQmCC';

async function withTempPhotoService(fn: (svc: PhotoService, root: string) => Promise<void>): Promise<void> {
    const root = await Deno.makeTempDir({prefix: 'photo_test_'});
    try {
        const svc = new PhotoService({
            contentDir: `${root}/content`,
            derivedDir: `${root}/derived`,
            mountPath: 'rabid.photo',
        });
        await fn(svc, root);
    } finally {
        await Deno.remove(root, {recursive: true});
    }
}

test("upload: content-addressed store, dedup, extension by magic, junk refused", async () => {
    await withTempPhotoService(async (svc, root) => {
        const {photoPath} = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});
        assert(photoPath.startsWith('content/photos/'));
        assert(photoPath.endsWith('.jpg'));
        assert(await Deno.stat(`${root}/${photoPath}`));

        // Same bytes -> same path (content addressing).
        const again = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});
        assertEquals(again.photoPath, photoPath);

        // PNG keeps its own extension (sniffed from the bytes, not claimed).
        const png = await svc.upload({imageBytesAsBase64: TINY_PNG_B64});
        assert(png.photoPath.endsWith('.png'));

        await assertRejects(() => svc.upload({imageBytesAsBase64: btoa('not an image')}),
                            Error, 'JPEG or PNG');
        await assertRejects(() => svc.upload({imageBytesAsBase64: ''}), Error);
    });
});

test("sizing: derived-store resize on demand, then cached; width allowlist; path checks", async () => {
    await withTempPhotoService(async (svc, root) => {
        const {photoPath} = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});

        const sized = await svc.sizedPhotoPath(photoPath, 96);
        assert(sized.startsWith('derived/sized-photos/'));
        assert(sized.endsWith('.jpg'));
        const stat = await Deno.stat(`${root}/${sized}`);
        assert(stat.size > 0);

        // Same (photo, width) -> same derived path (closure addressing).
        assertEquals(await svc.sizedPhotoPath(photoPath, 96), sized);
        // A different width is a different derived artifact.
        assert(await svc.sizedPhotoPath(photoPath, 256) !== sized);

        // serve() is a 302 to the derived file.
        const resp = await svc.serve(photoPath, 96) as {status: number, headers: Record<string,string>};
        assertEquals(resp.status, 302);
        assertEquals(resp.headers['Location'], '/' + sized);

        // Only the allowlisted widths may mint derived files.
        assert(!ALLOWED_WIDTHS.includes(333));
        await assertRejects(() => svc.sizedPhotoPath(photoPath, 333), Error, 'unsupported photo width');

        // Path discipline: only well-formed ids inside the photos store.
        await assertRejects(() => svc.sizedPhotoPath('content/../etc/passwd', 96), Error);
        await assertRejects(() => svc.sizedPhotoPath('derived/sized-photos/whatever.jpg', 96), Error, 'malformed');
        await assertRejects(() => svc.sizedPhotoPath(
            'content/Recordings/3ab/' + 'a'.repeat(64) + '.jpg', 96), Error);
    });
});

test("photo value: parse/format round-trip; legacy bare paths; focus quantization", () => {
    const bare = `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`;
    // A legacy bare path parses as centred.
    assertEquals(parsePhotoValue(bare), {path: bare, focus: 0.5, rotate: 0});
    // Centred stays a bare path (minimal, back-compatible); off-centre -> JSON.
    assertEquals(formatPhotoValue(bare, 0.5), bare);
    const json = formatPhotoValue(bare, 0.25);
    assert(json.startsWith('{'));
    assertEquals(parsePhotoValue(json), {path: bare, focus: 0.25, rotate: 0});
    // Garbage / missing fields fall back to centred.
    assertEquals(parsePhotoValue('{not json'), {path: '{not json', focus: 0.5, rotate: 0});
    // Focus snaps to the nearest of the five levels.
    assertEquals(quantizeFocus(0.1), 0);
    assertEquals(quantizeFocus(0.6), 0.5);
    assertEquals(quantizeFocus(0.8), 0.75);
    assertEquals(quantizeFocus(NaN), 0.5);
});

test("cover-crop: EXACT target dimensions, size allowlist, path discipline", async () => {
    await withTempPhotoService(async (svc, root) => {
        const {photoPath} = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});

        // A square crop is produced at EXACTLY the requested pixels.
        const sq = await svc.croppedPhotoPath(photoPath, 256, 256, 0.5);
        assert(sq.startsWith('derived/cropped-photos/'));
        assertEquals(await dimsOf(`${root}/${sq}`), [256, 256]);
        // A non-square (landscape) size crops to exactly that too.
        const land = await svc.croppedPhotoPath(photoPath, 960, 720, 0.5);
        assertEquals(await dimsOf(`${root}/${land}`), [960, 720]);

        // Same (size,focus) -> same file (closure-addressed); off-list focus
        // quantizes onto the level set (0.1 -> 0).
        assertEquals(await svc.croppedPhotoPath(photoPath, 256, 256, 0.5), sq);
        assertEquals(await svc.croppedPhotoPath(photoPath, 256, 256, 0.1),
                     await svc.croppedPhotoPath(photoPath, 256, 256, 0));

        // Only allowlisted sizes may be minted; path discipline carries over.
        await assertRejects(() => svc.croppedPhotoPath(photoPath, 300, 300, 0.5),
                            Error, 'unsupported crop size');
        await assertRejects(() => svc.croppedPhotoPath('content/../etc/passwd', 256, 256, 0.5), Error);
    });
});

test("cover-crop: focus positions along the TRIMMED axis (differing PIXELS, not just paths)", async () => {
    await withTempPhotoService(async (svc, root) => {
        // A WIDE source (400x100) cropped to a square/portrait slot overflows
        // HORIZONTALLY, so focus must pan left↔right.  The gradient ramps
        // left→right, so the two extremes must differ in mean brightness.
        const wide = await uploadWideGradient(svc, 400, 100);
        const left  = await svc.croppedPhotoPath(wide, 256, 256, 0);
        const mid   = await svc.croppedPhotoPath(wide, 256, 256, 0.5);
        const right = await svc.croppedPhotoPath(wide, 256, 256, 1);
        const [mL, mM, mR] = [await meanOf(`${root}/${left}`),
                              await meanOf(`${root}/${mid}`),
                              await meanOf(`${root}/${right}`)];
        // Monotonic along the pan (either direction, depending on gradient
        // orientation) - and, crucially, the ends are far apart (the old
        // vertical-only offset left these IDENTICAL for a wide photo).
        assert((mL < mM && mM < mR) || (mL > mM && mM > mR),
               `expected a monotonic pan, got ${mL}, ${mM}, ${mR}`);
        assert(Math.abs(mR - mL) > 0.2, `crop ends should differ a lot, got ${Math.abs(mR - mL)}`);
    });
});

test("cropCandidates: one per focus level, current flagged, srcs cover-crop", async () => {
    await withTempPhotoService(async (svc) => {
        const {photoPath} = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});
        const value = formatPhotoValue(photoPath, 0.25);
        const cands = svc.cropCandidates(value, 256, 256);
        assertEquals(cands.length, CROP_FOCUS_LEVELS.length);
        // Exactly the current level is flagged; each candidate carries the value
        // to store on pick, and a serveCropped src at the requested size.
        assertEquals(cands.filter(c => c.selected).map(c => c.focus), [0.25]);
        for(const c of cands) {
            assertStringIncludes(c.src, 'rabid.photo.serveCropped');
            assertStringIncludes(c.src, '256,256');
        }
        assertEquals(parsePhotoValue(cands[0].value), {path: photoPath, focus: 0, rotate: 0});
    });
});

test("ImageField: photo control in the volunteer form; photo renders on detail pages", async () => {
    await withTestDb(async ({ bob }) => {
        // The edit form has the hidden path input + the file picker wired to
        // the client upload fn (camera/library on phones via accept=image/*).
        const form = await asUser(bob, () =>
            renderRoute(`rabid.volunteer.renderForm(rabid.volunteer.getById(${bob}))`));
        const inputs = findAll(form, (m: any) =>
            Array.isArray(m) && m[0] === 'input' && (m[1] as any)?.name === 'photo');
        assertEquals((inputs[0] as any[])[1].type, 'hidden');
        const fileInputs = findAll(form, (m: any) =>
            Array.isArray(m) && m[0] === 'input' && (m[1] as any)?.type === 'file');
        assertEquals(fileInputs.length, 1);
        assertStringIncludes((fileInputs[0] as any[])[1].accept, 'image/*');
        assertStringIncludes((fileInputs[0] as any[])[1].onchange, "lmPhotoFieldChange");
        assertStringIncludes((fileInputs[0] as any[])[1].onchange, "rabid.photo");

        // With a photo set, the detail page shows it via the (authenticated)
        // serve route - rendering builds the URL only, no fs/imagemagick.
        const fakePath = `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`;
        asSystem(() => rabid.volunteer.update(bob, {photo: fakePath}));
        const detail = await asUser(bob, () => renderRoute(`rabid.volunteer.detailPage(${bob})`));
        const imgs = findAll(detail, (m: any) => Array.isArray(m) && m[0] === 'img');
        assertEquals(imgs.length, 1);
        assertStringIncludes((imgs[0] as any[])[1].src, 'rabid.photo.serve');
        assertStringIncludes((imgs[0] as any[])[1].src, fakePath);
    });
});

// The above tests call svc.upload()/serve() directly; the actual browser bug
// was that those methods lacked @route decorators, so the STRICT route
// interpreter treated them as undeclared members and returned 404 "not found"
// (surfaced as "Photo upload failed: not found").  This test dispatches through
// the real interpreter - the exact path production uses - so the decorators
// can never silently go missing again.
test("route dispatch: upload (POST) + serve (GET) go through the strict interpreter", async () => {
    await withTestDb(async ({ bob }) => {
        // Upload as an authenticated POST rpc, exactly as lmPhotoFieldChange does.
        const {photoPath} = await asUser(bob, () =>
            invoke('rabid.photo.upload($arg0)', {imageBytesAsBase64: TINY_JPEG_B64}));
        assert(typeof photoPath === 'string' && photoPath.startsWith('content/photos/'),
               `expected a content path, got ${photoPath}`);

        // The <img> serve route, dispatched as a GET, 302s to the derived file.
        const resp = await asUser(bob, () =>
            renderRoute(`rabid.photo.serve(${JSON.stringify(photoPath)},96)`)) as
                {status: number, headers: Record<string,string>};
        assertEquals(resp.status, 302);
        assertStringIncludes(resp.headers['Location'], '/derived/sized-photos/');

        // The authenticated gate holds: an anonymous caller cannot upload.
        await assertRejects(() => asAnon(() =>
            invoke('rabid.photo.upload($arg0)', {imageBytesAsBase64: TINY_JPEG_B64})), Error);
    });
});

test("photo editor: add mode is a plain uploader; edit mode is crop+remove (no upload)", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const fileInputs = (m: any) => findAll(m, (n: any) =>
            Array.isArray(n) && n[0] === 'input' && n[1]?.type === 'file');

        // ADD mode (no photo): the upload form (a file picker), no crop tiles.
        const add = await asUser(alice, () =>
            renderRoute(`rabid.volunteer.renderPhotoEditForm(${carol},"photo")`));
        assertEquals(fileInputs(add).length, 1);
        assertEquals(findByTestId(add, 'crop-candidates'), undefined);

        // EDIT mode (a real square photo in the portrait slot -> aspect differs):
        // crop tiles + Remove, and NO upload control.
        const {photoPath} = await asUser(alice, () =>
            invoke('rabid.photo.upload($arg0)', {imageBytesAsBase64: TINY_JPEG_B64}));
        asSystem(() => rabid.volunteer.update(carol, {photo: photoPath}));
        const edit = await asUser(alice, () =>
            renderRoute(`rabid.volunteer.renderPhotoEditForm(${carol},"photo")`));
        assertEquals(fileInputs(edit).length, 0, 'edit mode has no upload control');
        assert(hasText(edit, 'Remove photo'));
        const tiles = findAll(edit, (m: any) =>
            Array.isArray(m) && m[0] === 'img' && String(m[1]?.class).includes('lm-crop-choice'));
        assertEquals(tiles.length, CROP_FOCUS_LEVELS.length);
        for(const t of tiles) assertStringIncludes((t as any[])[1].src, 'rabid.photo.serveCropped');
        // Tiles dispatch setPhotoFocus with PRIMITIVE args (no embedded JSON,
        // which broke the route parser) - guard against a regression.
        assert(JSON.stringify(edit).includes('setPhotoFocus'));
    });
});

test("photo editor: Remove clears the field (primitive-args route)", async () => {
    await withTestDb(async ({ alice, carol }) => {
        asSystem(() => rabid.volunteer.update(carol, {photo: `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`}));
        await asUser(alice, () => getRabid().dispatch(
            `rabid.volunteer.removePhoto(${carol},"photo")`, {httpMethod: 'POST'}));
        assertEquals(asSystem(() => rabid.volunteer.getById(carol)).photo, '');
    });
});

test("photo editor: picking a framing tile reframes only that field", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const path = `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`;
        asSystem(() => rabid.volunteer.update(carol, {photo: path}));
        const before = asSystem(() => rabid.volunteer.getById(carol));
        // Dispatch the EXACT expression a crop tile builds (primitive args) as a
        // POST through the interpreter - the path that broke in the browser when
        // the value was embedded as JSON.
        await asUser(alice, () => getRabid().dispatch(
            `rabid.volunteer.setPhotoFocus(${carol},"photo",1)`, {httpMethod: 'POST'}));
        const after = asSystem(() => rabid.volunteer.getById(carol));
        assertEquals(parsePhotoValue(after.photo!), {path, focus: 1, rotate: 0});   // reframed
        assertEquals(after.name, before.name);                           // untouched
    });
});

test("photo editor rejects a non-photo field", async () => {
    await withTestDb(async ({ alice, carol }) => {
        await asUser(alice, () => assertRejects(() =>
            renderRoute(`rabid.volunteer.renderPhotoEditForm(${carol},"name")`), Error, "not a photo field"));
    });
});

test("photoButton: 'Add Photo' with no photo, 'Edit Photo' once set", async () => {
    await withTestDb(async ({ alice, carol }) => {
        const bare = await asUser(alice, () => renderRoute(`rabid.volunteer.detailPage(${carol})`));
        assert(hasText(bare, 'Add Photo'));
        assert(JSON.stringify(bare).includes('renderPhotoEditForm'), 'opens the unified editor');
        asSystem(() => rabid.volunteer.update(carol, {photo: `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`}));
        const withPhoto = await asUser(alice, () => renderRoute(`rabid.volunteer.detailPage(${carol})`));
        assert(hasText(withPhoto, 'Edit Photo'));
    });
});

test("needsFramingPicker: hidden when the aspect ~matches, shown when it differs", async () => {
    await withTempPhotoService(async (svc) => {
        // A 3:4 portrait source into the 3:4 portrait slot -> no meaningful trim.
        const p34 = await uploadSolid(svc, 600, 800);
        assertEquals(await svc.needsFramingPicker(p34, 960, 1280), false);
        // The same source into a 3:2 slot -> big trim -> show the picker.
        assertEquals(await svc.needsFramingPicker(p34, 960, 640), true);
        // Within tolerance: 5:4 source into a 4:3 slot trims ~6% (<10%) -> hidden.
        const p54 = await uploadSolid(svc, 1000, 800);
        assertEquals(await svc.needsFramingPicker(p54, 960, 720), false);
        // A wide source into the portrait slot -> shown.
        const wide = await uploadWideGradient(svc, 400, 100);
        assertEquals(await svc.needsFramingPicker(wide, 960, 1280), true);
        // An unreadable source -> conservative "show".
        assertEquals(await svc.needsFramingPicker(
            `content/photos/3ab/3ab${'0'.repeat(61)}.jpg`, 960, 1280), true);
    });
});

test("clearDerivedStore drops the derived sizes; original untouched; regenerable", async () => {
    await withTempPhotoService(async (svc, root) => {
        const {photoPath} = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});
        const sized = await svc.sizedPhotoPath(photoPath, 96);
        const cropped = await svc.croppedPhotoPath(photoPath, 256, 256, 0.5);
        assert(await Deno.stat(`${root}/${sized}`));
        assert(await Deno.stat(`${root}/${cropped}`));

        const {cleared} = await svc.clearDerivedStore();
        assertEquals(cleared.sort(), ['cropped-photos', 'sized-photos']);
        await assertRejects(() => Deno.stat(`${root}/${sized}`));      // derived gone
        await assertRejects(() => Deno.stat(`${root}/${cropped}`));
        assert(await Deno.stat(`${root}/${photoPath}`));               // original untouched

        // Regenerates on demand.
        assert(await Deno.stat(`${root}/${await svc.sizedPhotoPath(photoPath, 96)}`));
    });
});

test("the photo-cache rebuild menu item shows only to admins", () => {
    assert(hasText(navBar(false, /*isAdmin*/ true), 'Rebuild photo sizes'));
    assert(!hasText(navBar(false, /*isAdmin*/ false), 'Rebuild photo sizes'));
});

test("sale detail leads with the bike photo; the compact row stays image-free (document line)", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const fakePath = `content/photos/3ab/3ab${'1'.repeat(61)}.jpg`;
        const id = asSystem(() => {
            const event_id = rabid.event.insert({
                event_kind: 'shopTime', description: 'Shop day', location_description: '',
                location_url: '', is_remote_event: 0, volunteer_only: 0,
                start_time: '2026-06-13 10:00:00', end_time: '2026-06-13 20:00:00',
                total_cash_collected: 0, notes: '',
            });
            return rabid.sale.insert({
                event_id, sale_time: '2026-06-13 14:00:00', sale_recorded_by: alice,
                sale_kind: 'bike', description: 'Blue commuter', photo: fakePath,
                amount: 80, payment_method: 'cash', notes: undefined,
            });
        });
        // The compact document row carries no inline thumbnail (a 3rem image would break
        // the document line rhythm); the photo shows on the detail page.
        const row = await asUser(bob, () => renderRoute(`rabid.sale.renderSaleRowById(${id})`));
        const rowImgs = findAll(row, (m: any) => Array.isArray(m) && m[0] === 'img');
        assertEquals(rowImgs.length, 0);
        assert(hasText(row, 'Blue commuter'));

        const detail = await asUser(bob, () => renderRoute(`rabid.sale.detailPage(${id})`));
        assert(hasText(detail, 'Blue commuter'));
        const detailImgs = findAll(detail, (m: any) => Array.isArray(m) && m[0] === 'img');
        assertEquals(detailImgs.length, 1);
    });
});

test("photo value: rotation round-trips + normalizes; cropped/contained srcs carry it", () => {
    // Round-trip + normalise to quarter turns.
    assertEquals(parsePhotoValue(formatPhotoValue('content/x.jpg', 0.5, 90)).rotate, 90);
    assertEquals(parsePhotoValue(formatPhotoValue('content/x.jpg', 0.5, 450)).rotate, 90);
    assertEquals(normalizeRotate(-90), 270);
    // A centred, unrotated photo stays a bare path (back-compatible).
    assertEquals(formatPhotoValue('content/x.jpg', 0.5, 0), 'content/x.jpg');
    // Rotation survives an off-centre crop, and both srcs include it as the last arg.
    const v = formatPhotoValue('content/x.jpg', 0.25, 270);
    assertEquals(parsePhotoValue(v).rotate, 270);
    assertStringIncludes(photoCroppedSrc('rabid.photo', v, 512, 384), ',270)');
    const cs = photoContainedSrc('rabid.photo', formatPhotoValue('content/x.jpg', 0.5, 90), 1024, 1024);
    assertStringIncludes(cs, 'serveContained');
    assertStringIncludes(cs, ',90)');
});
