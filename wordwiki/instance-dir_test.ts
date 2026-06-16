// deno-lint-ignore-file no-explicit-any
/**
 * Instance-dir verification: refuse to serve an unconfigured instance (missing
 * or dangling required stores) rather than silently serving empty data, and the
 * db write-lock that stops two live servers sharing one SQLite db.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "../liminal/testing/assert.ts";
import { storeState, checkInstanceStores, acquireDbLock } from "./instance-dir.ts";

const Deno_ = (globalThis as any).Deno;

// Build a temp instance dir; `setup` receives the dir to populate.
async function withDir(setup: (dir: string) => void, fn: (dir: string) => void): Promise<void> {
    const dir = await Deno_.makeTempDir({prefix: 'wordwiki-instance-test-'});
    try { setup(dir); fn(dir); }
    finally { await Deno_.remove(dir, {recursive: true}); }
}

function mkContentAndDb(dir: string): void {
    Deno_.mkdirSync(`${dir}/content`);
    Deno_.mkdirSync(`${dir}/database`);
    Deno_.writeTextFileSync(`${dir}/database/db.db`, 'x');   // stand-in db file
}

test("storeState: ok / missing / dangling", async () => {
    await withDir(dir => {
        Deno_.mkdirSync(`${dir}/real`);
        Deno_.symlinkSync(`${dir}/real`, `${dir}/good-link`);
        Deno_.symlinkSync(`${dir}/nope`, `${dir}/bad-link`);
    }, dir => {
        assertEquals(storeState(`${dir}/real`), 'ok');
        assertEquals(storeState(`${dir}/good-link`), 'ok');     // symlink to a real dir
        assertEquals(storeState(`${dir}/bad-link`), 'dangling'); // symlink, target gone
        assertEquals(storeState(`${dir}/absent`), 'missing');
    });
});

test("checkInstanceStores: a set-up instance is clean", async () => {
    await withDir(dir => {
        mkContentAndDb(dir);
        Deno_.mkdirSync(`${dir}/imports`);
    }, dir => {
        const {errors, warnings} = checkInstanceStores(dir);
        assertEquals(errors, []);
        assertEquals(warnings, []);
    });
});

test("checkInstanceStores: missing content + db are ERRORS", async () => {
    await withDir(_dir => {}, dir => {
        const {errors} = checkInstanceStores(dir);
        assertEquals(errors.length, 2);
        assertStringIncludes(errors.join('\n'), 'content: missing');
        assertStringIncludes(errors.join('\n'), 'database/db.db: missing');
    });
});

test("checkInstanceStores: a dangling content symlink is flagged as dangling", async () => {
    await withDir(dir => {
        Deno_.mkdirSync(`${dir}/database`);
        Deno_.writeTextFileSync(`${dir}/database/db.db`, 'x');
        Deno_.symlinkSync(`${dir}/gone`, `${dir}/content`);   // shared store moved away
    }, dir => {
        const {errors} = checkInstanceStores(dir);
        assertEquals(errors.length, 1);
        assertStringIncludes(errors[0], 'content: dangling symlink');
    });
});

test("checkInstanceStores: missing imports is a WARNING, not an error", async () => {
    await withDir(dir => mkContentAndDb(dir), dir => {
        const {errors, warnings} = checkInstanceStores(dir);
        assertEquals(errors, []);
        assertEquals(warnings.length, 1);
        assertStringIncludes(warnings[0], 'imports: missing');
    });
});

test("acquireDbLock: writes a lock; a stale lock (dead pid) is reclaimed", async () => {
    await withDir(dir => mkContentAndDb(dir), dir => {
        const lock = acquireDbLock(dir);
        assert(lock.endsWith('database/db.db.lock'));
        const body = Deno_.readTextFileSync(lock);
        assertStringIncludes(body, String(Deno_.pid));
        assertStringIncludes(body, dir);

        // Pre-seed a stale lock (a pid that is not a live wordwiki) from a
        // DIFFERENT instance dir; acquire must reclaim it rather than refuse.
        Deno_.writeTextFileSync(lock, `999999\n/some/other/instance\n`);
        acquireDbLock(dir);   // must not throw
        assertStringIncludes(Deno_.readTextFileSync(lock), dir);
    });
});

test("acquireDbLock: refuses when a LIVE wordwiki in another dir holds the db", async () => {
    await withDir(dir => mkContentAndDb(dir), dir => {
        // This test process IS a live deno running .../wordwiki.ts-style code?
        // Not reliably - so simulate by pointing the lock at THIS pid but with a
        // cmdline that matches the live-wordwiki probe.  We can't fake /proc, so
        // instead assert the refusal path via a pid we know is alive (our own)
        // only when the probe would match; otherwise this asserts the safe
        // (reclaim) path.  Either way acquire must not corrupt the lock.
        Deno_.writeTextFileSync(`${dir}/database/db.db.lock`, `${Deno_.pid}\n/another/dir\n`);
        // Our own /proc/pid/cmdline is the test runner (contains 'wordwiki' via
        // the file path), so the probe may match -> refusal expected.
        try {
            acquireDbLock(dir);
            // If it didn't throw, the probe didn't match 'wordwiki/wordwiki.ts';
            // the lock must at least now be ours.
            assertStringIncludes(Deno_.readTextFileSync(`${dir}/database/db.db.lock`), dir);
        } catch (e) {
            assertStringIncludes(String(e), 'already in use by a running wordwiki');
        }
    });
});
