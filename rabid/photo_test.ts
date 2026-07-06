// Photo upload + on-demand sizing (liminal/photo.ts) and the ImageField
// control (liminal/table.ts).  The PhotoService tests run against temp dirs
// (this is inherently a filesystem feature) and exercise the real ImageMagick
// resize; the field tests are the usual render-to-markup checks.
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "../liminal/testing/assert.ts";
import { withTestDb, renderRoute, invoke, asUser, asAnon, asSystem } from "./testing.ts";
import { findAll, hasText } from "../liminal/testing/markup-assert.ts";
import { PhotoService, ALLOWED_WIDTHS, CROP_FOCUS_LEVELS,
         parsePhotoValue, formatPhotoValue, quantizeFocus } from "../liminal/photo.ts";
import { rabid } from "./rabid.ts";

// The pixel dimensions of a produced file (via ImageMagick identify).
async function dimsOf(path: string): Promise<[number, number]> {
    const {stdout} = await new Deno.Command('magick',
        {args: ['identify', '-format', '%w %h', path]}).output();
    const [w, h] = new TextDecoder().decode(stdout).trim().split(/\s+/).map(Number);
    return [w, h];
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
    assertEquals(parsePhotoValue(bare), {path: bare, fx: 0.5, fy: 0.5});
    // Centred stays a bare path (minimal, back-compatible); off-centre -> JSON.
    assertEquals(formatPhotoValue(bare, 0.5, 0.5), bare);
    const json = formatPhotoValue(bare, 0.5, 0.25);
    assert(json.startsWith('{'));
    assertEquals(parsePhotoValue(json), {path: bare, fx: 0.5, fy: 0.25});
    // Garbage / missing fields fall back to centred.
    assertEquals(parsePhotoValue('{not json'), {path: '{not json', fx: 0.5, fy: 0.5});
    // Focus snaps to the nearest of the five levels.
    assertEquals(quantizeFocus(0.1), 0);
    assertEquals(quantizeFocus(0.6), 0.5);
    assertEquals(quantizeFocus(0.8), 0.75);
    assertEquals(quantizeFocus(NaN), 0.5);
});

test("cover-crop: EXACT target dimensions, focus levels, size allowlist, dedup", async () => {
    await withTempPhotoService(async (svc, root) => {
        const {photoPath} = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});

        // A square crop is produced at EXACTLY the requested pixels.
        const sq = await svc.croppedPhotoPath(photoPath, 256, 256, 0.5);
        assert(sq.startsWith('derived/cropped-photos/'));
        assertEquals(await dimsOf(`${root}/${sq}`), [256, 256]);
        // A non-square (landscape) size crops to exactly that too.
        const land = await svc.croppedPhotoPath(photoPath, 512, 384, 0.5);
        assertEquals(await dimsOf(`${root}/${land}`), [512, 384]);

        // Different focus level -> different derived artifact; same -> same file.
        assert(await svc.croppedPhotoPath(photoPath, 256, 256, 0) !== sq);
        assertEquals(await svc.croppedPhotoPath(photoPath, 256, 256, 0.5), sq);
        // An off-list focus quantizes onto the level set (0.1 -> 0).
        assertEquals(await svc.croppedPhotoPath(photoPath, 256, 256, 0.1),
                     await svc.croppedPhotoPath(photoPath, 256, 256, 0));

        // Only allowlisted sizes may be minted; path discipline carries over.
        await assertRejects(() => svc.croppedPhotoPath(photoPath, 300, 300, 0.5),
                            Error, 'unsupported crop size');
        await assertRejects(() => svc.croppedPhotoPath('content/../etc/passwd', 256, 256, 0.5), Error);
    });
});

test("cropCandidates: one per focus level, current flagged, srcs cover-crop", async () => {
    await withTempPhotoService(async (svc) => {
        const {photoPath} = await svc.upload({imageBytesAsBase64: TINY_JPEG_B64});
        const value = formatPhotoValue(photoPath, 0.5, 0.25);
        const cands = svc.cropCandidates(value, 256, 256);
        assertEquals(cands.length, CROP_FOCUS_LEVELS.length);
        // Exactly the current level is flagged; each candidate carries the value
        // to store on pick, and a serveCropped src at the requested size.
        assertEquals(cands.filter(c => c.selected).map(c => c.fy), [0.25]);
        for(const c of cands) {
            assertStringIncludes(c.src, 'rabid.photo.serveCropped');
            assertStringIncludes(c.src, '256,256');
        }
        assertEquals(parsePhotoValue(cands[0].value), {path: photoPath, fx: 0.5, fy: 0});
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

test("sale rows and detail lead with the bike photo when present", async () => {
    await withTestDb(async ({ alice, bob }) => {
        const fakePath = `content/photos/3ab/3ab${'1'.repeat(61)}.jpg`;
        const id = asSystem(() => rabid.sale.insert({
            sale_time: '2026-06-13 14:00:00', sale_recorded_by: alice,
            sale_kind: 'bike', description: 'Blue commuter', photo: fakePath,
            amount: 80, payment_method: 'cash', notes: undefined,
        }));
        const row = await asUser(bob, () => renderRoute(`rabid.sale.renderSaleRowById(${id})`));
        const rowImgs = findAll(row, (m: any) => Array.isArray(m) && m[0] === 'img');
        assertEquals(rowImgs.length, 1);
        assertStringIncludes((rowImgs[0] as any[])[1].src, 'rabid.photo.serve');

        const detail = await asUser(bob, () => renderRoute(`rabid.sale.detailPage(${id})`));
        assert(hasText(detail, 'Blue commuter'));
        const detailImgs = findAll(detail, (m: any) => Array.isArray(m) && m[0] === 'img');
        assertEquals(detailImgs.length, 1);
    });
});
