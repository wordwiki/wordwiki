# Prod Caddy: immutable caching for content-addressed assets

**Status:** TODO — apply on the production Linode Caddy when the asset
content-store work lands (JS/CSS interned into a content store and served from
`/content/…` with a hash in the path).  Until then this changes nothing.

**Who serves what:** in dev (and via the `.pj/Caddyfile` reverse-proxy) the deno
HTTP server serves everything.  In **production** a Caddy in front of the app
serves several directories directly off disk — including the content stores
under `/content/` (photos, converted audio, and — after the pending work — the
hashed `.js`/`.css`).  This note is only about that prod Caddy.

## Why

Everything under `/content/` is **content-addressed**: the path contains a hash
of the bytes, so a changed file gets a new URL.  That already fixes staleness
(the page, served `no-store`, always points at the current hash).  What it does
*not* do by itself is stop the browser from re-validating the cached copy on
every load — a conditional request per asset.  Over the mobile/remote path to
the Linode that's a real per-load latency tax (one round-trip per asset).

Sending `immutable` on these responses tells the browser "never revalidate this
URL" — so a warm cache makes **zero** asset requests.  It is safe precisely
because the URLs are content-addressed: they never change meaning.

## What to add

In the production Caddyfile, on the block that serves `/content/` (whether it's
a `file_server` off disk or a `reverse_proxy` to the app), add a
`Cache-Control` header:

```caddy
# Content stores are content-addressed (the hash is in the path), so their
# bytes never change under a given URL — cache them forever, never revalidate.
handle /content/* {
    header Cache-Control "public, max-age=31536000, immutable"
    # ... keep the existing file_server / reverse_proxy directive here ...
}
```

If `/content/` is already its own handle/route, just add the one `header` line
inside it.

### Do NOT put `immutable` on:
- **`/resources/*`** — these are the plain, un-hashed source assets (the
  fallback path for anything not interned, e.g. `test-agent.js`).  They are
  mutable; leave them alone, or at most give them `Cache-Control: no-cache`
  (revalidate-always) so an edit is never silently stale.
- **HTML pages** — already sent `no-store` by the app; don't override.

## Verify (after applying)

From a machine hitting the public host:

```sh
# A hashed asset must carry immutable + a long max-age:
curl -sI https://<prod-host>/content/assets/<somehash>.js \
  | grep -i cache-control
# expect: cache-control: public, max-age=31536000, immutable

# A page must still be no-store:
curl -sI https://<prod-host>/ | grep -i cache-control
# expect: cache-control: no-store
```

Then, in a browser devtools Network tab, a second page load should show the
`.js`/`.css` served "(from disk cache)" with **no** network request — not even a
304.

## Notes
- If the prod Caddy already sets cache headers on `/content/` for the existing
  photos/audio, the hashed `.js`/`.css` under the same prefix inherit it — check
  first; this may already be done.
- `reload` Caddy after editing (`caddy reload` / `systemctl reload caddy`), not
  a full restart, to avoid dropping connections.
