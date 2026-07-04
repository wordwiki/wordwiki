// deno-lint-ignore-file no-explicit-any
// Content-addressed serving of the app's own JS/CSS (see
// prod-caddy-asset-caching.md and liminal.md).
//
// The problem: a plain `/resources/foo.js` is served with an ETag but no
// Cache-Control, so browsers apply heuristic freshness and a changed file is
// silently stale until they decide to revalidate (or the user force-reloads).
//
// The fix: at startup, intern each .js/.css into a liminal CONTENT STORE - the
// same content-addressed mechanism the photo/audio stores use.  The store path
// embeds a hash of the bytes (`/content/assets/ab/abcd….js`) and preserves the
// extension for direct serving.  A changed file gets a new URL, which the
// no-store HTML picks up immediately - no staleness, ever.  In production the
// content store is served directly by Caddy; marking those responses
// `immutable` (prod-caddy-asset-caching.md) then removes even the revalidation
// round-trip (the win on the mobile/remote path).
//
// Templates emit their resource URLs through `assetUrl('/resources/foo.js')`,
// which returns the hashed URL once interned, or the original path unchanged
// (so tests - which never run the ingestion - keep seeing `/resources/…`, and
// anything not interned falls back to the still-mounted `/resources/` dir).
import * as posix from "https://deno.land/std@0.195.0/path/posix.ts";
import * as content from "./content-store.ts";

/** Where the hashed asset store lives, and how its URLs are formed. */
export interface AssetIngestConfig {
    resourceDir: string;        // disk dir holding the source .js/.css
    resourceUrlPrefix: string;  // the URL they are referenced by today, e.g. '/resources/'
    contentRootDir: string;     // disk dir served at contentRootUrl (the store's PARENT)
    contentRootUrl: string;     // the URL contentRootDir is served at, e.g. '/content/'
    storeName?: string;         // sub-store under contentRootDir; default 'assets'
}

// Module-global map: original resource URL -> content-addressed URL.  A single
// server process runs a single app, so a module singleton is safe.  Empty
// until internAssets() runs, so assetUrl() is an identity function in tests.
let assetMap = new Map<string, string>();

/** Resolve a resource URL to its content-addressed URL, or return it as-is. */
export function assetUrl(path: string): string {
    return assetMap.get(path) ?? path;
}

/** The current map (for diagnostics / a debug route). */
export function assetMappings(): ReadonlyMap<string, string> {
    return assetMap;
}

/**
 * Intern every top-level .js/.css in `resourceDir` into the content store and
 * populate the assetUrl map.  Idempotent: the store dedups by hash, so a
 * restart re-hashes the same files and finds them already present.  Best-effort
 * - a failure to intern one file logs and leaves that file on its fallback
 * `/resources/` URL rather than taking the server down.
 */
export async function internAssets(cfg: AssetIngestConfig): Promise<void> {
    const storeName = cfg.storeName ?? 'assets';
    const storeDir = posix.join(cfg.contentRootDir, storeName);
    const urlBase = cfg.contentRootUrl.endsWith('/') ? cfg.contentRootUrl : cfg.contentRootUrl + '/';
    const resourceUrlPrefix = cfg.resourceUrlPrefix.endsWith('/')
        ? cfg.resourceUrlPrefix : cfg.resourceUrlPrefix + '/';

    const map = new Map<string, string>();
    let files: string[];
    try {
        files = [];
        for await (const entry of Deno.readDir(cfg.resourceDir)) {
            if(!entry.isFile) continue;
            const ext = posix.extname(entry.name).toLowerCase();
            if(ext === '.js' || ext === '.css') files.push(entry.name);
        }
    } catch(e) {
        console.warn(`asset ingest: cannot read resource dir ${cfg.resourceDir}: ${e}; ` +
                     `serving assets from ${resourceUrlPrefix} as before`);
        return;
    }

    for(const name of files.sort()) {
        const src = posix.join(cfg.resourceDir, name);
        try {
            const contentId = await content.addFile(storeDir, src);   // 'assets/ab/abcd….js'
            map.set(resourceUrlPrefix + name, urlBase + contentId);
        } catch(e) {
            console.warn(`asset ingest: failed to intern ${src}: ${e}; leaving it on ${resourceUrlPrefix}${name}`);
        }
    }
    assetMap = map;
    console.info(`asset ingest: interned ${map.size} assets into ${storeDir} (served under ${urlBase}${storeName}/)`);
}
