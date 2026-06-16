# Audio trim — threshold tuning (notes for a future Claude)

**Why this exists:** wordwiki now auto-trims leading/trailing silence + the
start/end click off recordings (see the trim pipeline below). The single tunable
that matters is the **silence threshold**. dz is not a language speaker and can't
hear a bad cut, so the call is made *by ear* by the Mi'gmaq language staff using
a throwaway listening page. **They will ask for variants** (different words,
different thresholds, etc.). This file is how you rebuild it fast.

The page: `/ww/wordwiki.audio.trimTuningPage()` (login required). It plays each
sample word **Original** beside the clip trimmed at several thresholds, with the
removed-amount under each player. Two sections: the worst offenders, and a random
typical sample.

---

## The trim pipeline (context — already built & committed)

Delivery is a chain of **content-addressed derived stores** (`content-store.ts`
`getDerived`), all in `wordwiki/audio.ts`:

```
source .wav (as given, archival, NEVER modified)
   └─ getTrimmedRecordingPath  → derived/trimmed-audio/<hash>.wav   (SoX: silence trim + edge fade; full fidelity)
        └─ getCompressedRecordingPath → derived/compressed-audio/<hash>.mp3  (lame; lossy delivery, derived FROM trimmed)
```

Key facts you must keep true:

- **Params ride INSIDE the getDerived closure** (`['trimAudioCmd', audioPath, params]`).
  The closure JSON is the cache key, so changing a param mints a *new* artifact;
  the function body is NOT hashed. If you ever hardcode a param instead of passing
  it, changing it silently returns the stale file. (The mp3 step has this latent
  bug today — no params in its closure — fine because lame settings are fixed.)
- **Non-destructive / archival**: the source is never touched, and every param
  variant coexists under its own hash. So threshold choice is low-stakes and
  reversible — re-tuning just generates new trimmed/mp3 artifacts; nothing is lost.
- **Safety net**: `trimAudioCmd` falls back to copying the source verbatim if SoX
  fails or yields an empty file.
- **Two SoX passes**: silence trim, then fade — `fade` can't compute a fade-out
  length downstream of `silence` in one chain.
- `RECORDING_TRIM_PARAMS` in `audio.ts` is the live default: `{threshold, minDuration, fade}`.
  **Applying the staff's decision = set `RECORDING_TRIM_PARAMS.threshold`** to the
  chosen value and commit. That's it.

Commits: `adad3ee` (pipeline + audit), `cbafda6` / later (the tuning page).

---

## The audit tool — `wordwiki/audio-trim-audit.ts`

Validates the trim against the **~30k hand-trimmed recordings** in
`~/mmo/content/Recordings`. dz's oracle: those clips were already hand-trimmed,
so a correctly-tuned auto-trim should remove **~0** from them. A clip where it
removes a lot = it cut audio a human kept. The real safety signal is the **peak
amplitude of the removed region** (≈0 = silence, good; near full-scale = speech, bad).

Run (from the repo dir, `~/wordwiki`):

```
deno run --allow-all wordwiki/audio-trim-audit.ts --sample 5000 --threshold 0.3% --top 25 --csv /tmp/audit.csv
```

Options: `--sample N` (0 = all 30k, slow), `--threshold 0.1%`, `--min-duration 0.1`,
`--concurrency 12`, `--top N`, `--csv path`. CSV columns:
`path,durSrc,removedHead,removedTail,removed,headPeak,tailPeak,peak` (peak = col 8).

### Findings so far (so you don't re-derive them)

- **0.1%** (a reasonable default): ~94% of hand-trimmed clips lose only silence
  (removed-region peak ≤0.03); worst cut ~0.16 (−16 dB, a soft onset); **zero loud cuts**.
- **0.03%**: very conservative — 99% pure silence, 0.7% suspect.
- **0.3%**: too aggressive — ~1% of clips lose a **loud** onset (removed-region
  peak 0.6–0.89, i.e. −1 to −4 dB). This is the scary end.
- The behaviour is a **cliff**, not a slope. Example `pgesign` (0.928 s):
  0.03–0.2% remove ~13–16 ms (silence); **0.3% removes 353 ms** (eats the onset).
  So the real decision is usually around **0.2% vs 0.3%**.

---

## The tuning page — where it lives

All in `wordwiki/audio.ts`, in the block fenced by
`// THROWAWAY: audio-trim threshold listening test` … (delete the whole block):

- `AudioRoutes.trimTuningPage()` — the `@route(authenticated)` method (one line in
  the `AudioRoutes` class). Reachable at `/ww/wordwiki.audio.trimTuningPage()`.
- `TRIM_TUNING_THRESHOLDS`, `TRIM_TUNING_MIN_DURATION`, `TRIM_TUNING_FADE` — the axis.
- `TRIM_TUNING_SECTIONS: TuningSection[]` — the data. Each section = `{heading, blurb, clips}`,
  each clip = `{word, entryId, src}` (src is the content-store-relative path).
- `renderTrimTuningPage()` — builds one bordered table per section: row = word
  (linked to its lexeme entry), columns = Original + each threshold; each cell is
  an `<audio preload=none>` + a removed-amount caption (`−353 ms`) + a hover title
  (`0.93 s → 0.58 s`). Variants are generated on demand via `getTrimmedRecordingPath`
  and cached (generated concurrently via `mapPool` on first render; the
  removed-amount readout reads durations straight from the WAV header via
  `wavDurationSeconds`, no `soxi` spawn, so even a 100+-row page renders fast).

Audio is served as static files: `<audio src="/content/…">` (original) and
`<audio src="/derived/trimmed-audio/…">` (variants) both resolve (the data dir is
served at `/`). The **server cwd is `~/mmo`** (the data dir), so the relative
content paths in `src`/SoX/soxi resolve directly.

---

## RECIPE: rebuild / make a variant of the page

1. **Find offenders** (the words an aggressive threshold hurts most) — run the
   audit at the most aggressive candidate threshold and dump a CSV:
   ```
   deno run --allow-all wordwiki/audio-trim-audit.ts --sample 5000 --threshold 0.3% --csv /tmp/audit.csv
   ```
   Top offenders = highest `peak` (col 8):
   ```
   tail -n +2 /tmp/audit.csv | sort -t, -k8 -gr | head -20 \
     | awk -F, '{sub("/home/dziegler/mmo/","",$1); print $1}'
   ```

2. **Pick a random/typical sample** (skip the offenders so it's the common case):
   ```
   tail -n +2 /tmp/audit.csv | sort -t, -k8 -gr | tail -n +61 | shuf | head -30 \
     | awk -F, '{sub("/home/dziegler/mmo/","",$1); print $1}'
   ```

3. **Resolve each recording path → headword + entry id** (the page labels rows and
   links to the lexeme). Recordings are `dict` rows `ty='rec'`, `attr1`=the content
   path, `id1`=entry; the word is the entry's first `spl` (spelling). Build a quoted
   IN-list of the paths from step 1/2, then (read-only DB at `~/mmo/database/db.db`):
   ```
   sqlite3 -readonly -separator '|' ~/mmo/database/db.db "
   SELECT r.attr1, r.id1,
     (SELECT s.attr1 FROM dict s WHERE s.ty='spl' AND s.id1=r.id1
        AND s.valid_to=9007199254740991 ORDER BY s.order_key LIMIT 1) AS word
   FROM dict r
   WHERE r.ty='rec' AND r.valid_to=9007199254740991 AND r.attr1 IN ('content/Recordings/…', …)
     AND (SELECT s.attr1 FROM dict s WHERE s.ty='spl' AND s.id1=r.id1
            AND s.valid_to=9007199254740991 LIMIT 1) IS NOT NULL;"
   ```
   (`9007169...` = END_OF_TIME = the current live version. `'rec'` already excludes
   example-sentence recordings, which are `'erc'`.)

4. **Paste** the `{word, entryId, src}` rows into the relevant section of
   `TRIM_TUNING_SECTIONS` in `audio.ts`. Adjust `TRIM_TUNING_THRESHOLDS` if staff
   want a different set (e.g. zoom in on `['0.15%','0.2%','0.25%','0.3%']`). To
   compare a *different* axis (e.g. `minDuration`), change the cell loop in
   `renderTrimTuningPage` to vary that param instead of `threshold`.

5. **Ship it**: `deno check wordwiki/audio.ts`, then restart — `./wordwiki.sh`
   (it cleanly stops the running server itself; never pkill). First page load
   generates the new variants (cached after). Visit `/ww/wordwiki.audio.trimTuningPage()`.

---

## When the staff decide

- Set `RECORDING_TRIM_PARAMS.threshold` (and minDuration/fade if they tuned those)
  in `wordwiki/audio.ts`. Commit.
- **Delete the throwaway block** (everything under the `// THROWAWAY:` fence) and
  the `trimTuningPage()` method line in `AudioRoutes`. `deno check` to confirm
  nothing else referenced it.
- The audit tool (`audio-trim-audit.ts`) can stay — it's the general validator for
  any future threshold change.

## Still TODO on the pipeline (separate from tuning)

The **export prewarm + enumeration** (dz's "3rd leg"): a pass that materialises
trimmed+mp3 for every current recording (the derived store is lazy) and lists all
three content-ids (source, trimmed, mp3) per recording in the data export — so the
trim is durable beyond the running editor. Not built yet; do it after the
threshold settles, since prewarming bakes in the chosen params.
