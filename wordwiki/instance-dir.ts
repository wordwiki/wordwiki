// deno-lint-ignore-file no-explicit-any
/**
 * Instance-directory verification.
 *
 * A wordwiki "instance" is just the working directory the server runs in
 * (RUN_DIR / cwd): the SQLite db, the content stores and the published site all
 * live there, addressed by cwd-relative paths.  The data store for a store like
 * `content/` can be a real directory (production) OR a symlink to a shared store
 * (a dev instance running in parallel).  The filesystem IS the configuration -
 * there is no separate "shared" flag to get out of sync with it.
 *
 * The catch the server must guard: several stores are silently CREATED EMPTY on
 * first use (the db via Db.open, content/derived via mkdir-on-write), so a
 * mis-pointed instance comes up looking fine but with no data.  So before
 * serving we refuse to start unless the required stores are actually present
 * (a real dir/file, or a resolvable symlink).  We also guard against two live
 * servers writing the same db (the real corruption risk when a symlink
 * accidentally points two instances at one database).
 */

// Stores that MUST be provided (a real dir/file or a resolvable symlink) - we
// refuse to serve rather than silently create them empty.
const REQUIRED_STORES = ['content', 'database/db.db'];
// Stores whose absence is survivable but worth a warning (imports is only read
// to (re)tile scanned pages; existing derived tiles still serve).
const OPTIONAL_STORES = ['imports'];

export type StoreState = 'ok' | 'missing' | 'dangling';

// statSync follows symlinks, so it succeeds for a real path OR a good symlink,
// and throws for an absent path OR a dangling symlink; lstatSync then tells the
// two apart for a clearer message.
export function storeState(path: string): StoreState {
    try { (globalThis as any).Deno.statSync(path); return 'ok'; }
    catch {
        try { if((globalThis as any).Deno.lstatSync(path).isSymlink) return 'dangling'; }
        catch { /* not even a symlink entry */ }
        return 'missing';
    }
}

function readLinkSafe(path: string): string {
    try { return (globalThis as any).Deno.readLinkSync(path); } catch { return '?'; }
}

export interface InstanceCheck { errors: string[]; warnings: string[]; }

// Pure-ish (FS-reading) check of an instance dir.  `instanceDir` is the dir the
// stores are relative to (Deno.cwd() in the running server).  Returns problems
// rather than throwing so the caller decides how to surface them (and so it is
// testable against temp dirs).
export function checkInstanceStores(instanceDir: string): InstanceCheck {
    const errors: string[] = [];
    const warnings: string[] = [];
    const at = (s: string) => `${instanceDir}/${s}`;

    for(const s of REQUIRED_STORES) {
        const state = storeState(at(s));
        if(state === 'dangling')
            errors.push(`${s}: dangling symlink -> ${readLinkSafe(at(s))} (shared store moved/unmounted?)`);
        else if(state === 'missing')
            errors.push(`${s}: missing (provide it - a real dir/file for production, or a symlink to a shared store for a dev instance)`);
    }
    for(const s of OPTIONAL_STORES) {
        const state = storeState(at(s));
        if(state !== 'ok')
            warnings.push(`${s}: ${state} - page-image (re)tiling will fail; existing tiles still serve.`);
    }
    return { errors, warnings };
}

// True iff `pid` is a live wordwiki server process (Linux /proc; the run script
// uses the same check).
function pidIsLiveWordwiki(pid: number): boolean {
    if(!Number.isFinite(pid) || pid <= 0) return false;
    try {
        return (globalThis as any).Deno.readTextFileSync(`/proc/${pid}/cmdline`)
            .includes('wordwiki/wordwiki.ts');
    } catch { return false; }
}

// Take the write-lock for this instance's database, keyed on the db's REALPATH
// (so two instances whose `database/db.db` symlink to one shared file contend on
// the same lock).  Refuses if another LIVE wordwiki in a DIFFERENT instance dir
// already holds it - two writers on one SQLite db corrupt it.  A stale lock
// (dead pid, or this same instance dir being restarted) is reclaimed.  Returns
// the lock path (caller may remove it on clean shutdown; a leftover lock is
// reclaimed on next start, so crash-safety doesn't depend on removal).
export function acquireDbLock(instanceDir: string): string {
    const Deno = (globalThis as any).Deno;
    const dbReal = Deno.realPathSync(`${instanceDir}/database/db.db`);
    const lockPath = `${dbReal}.lock`;
    try {
        const [pidStr, otherDir] = Deno.readTextFileSync(lockPath).split('\n');
        const pid = Number(pidStr);
        if(otherDir && otherDir !== instanceDir && pidIsLiveWordwiki(pid))
            throw new Error(
                `database ${dbReal} is already in use by a running wordwiki ` +
                `(pid ${pid}, instance dir '${otherDir}').\n` +
                `Two servers writing one SQLite db will corrupt it - each instance ` +
                `needs its OWN database/ (only the big read-only stores - content, ` +
                `imports, derived - should be shared via symlink).`);
        // else: stale lock, or this same dir restarting -> reclaim it.
    } catch(e) {
        if(e instanceof Error && e.message.startsWith('database ')) throw e;
        // no/unreadable lock file -> take it.
    }
    Deno.writeTextFileSync(lockPath, `${Deno.pid}\n${instanceDir}\n`);
    return lockPath;
}
