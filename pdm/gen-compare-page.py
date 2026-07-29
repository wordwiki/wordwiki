#!/usr/bin/env python3
"""Generate the self-contained hand-vs-machine segmentation comparison page
(resources/pdm-segment-compare.html): per pilot page, both layers rendered
side by side, images inlined as data URIs (mailable, the eval-page pattern).
Run from the mmo/ instance dir after a pdm-import."""
import sqlite3, subprocess, base64, html, sys, tempfile, os

PAGES = [4, 40, 67, 101, 172, 209, 250, 324, 435, 550]
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
db = sqlite3.connect('file:database/db.db?mode=ro', uri=True)

def render(pid, ref, layer, label):
    bs = list(db.execute("""SELECT b.bounding_group_id, b.x, b.y, b.w, b.h
      FROM bounding_box b JOIN layer l ON l.layer_id=b.layer_id
      WHERE b.page_id=? AND l.layer_name=?""", (pid, layer)))
    groups = len(set(b[0] for b in bs))
    draw = ['-font', FONT]
    for g, x, y, w, h in bs:
        c = ['red','blue','green','purple','brown','orange'][g % 6]
        draw += ['-stroke', c, '-fill', 'none', '-draw', f'rectangle {x},{y} {x+w},{y+h}']
    with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as f:
        out = f.name
    subprocess.run(['convert', ref, '-strokewidth', '6', *draw, '-resize', '700x',
                    '-quality', '82', out], check=True)
    data = base64.b64encode(open(out, 'rb').read()).decode()
    os.unlink(out)
    return groups, f'data:image/jpeg;base64,{data}'

parts = ["""<!DOCTYPE html><html><head><meta charset="utf-8">
<title>PDM segmentation: hand vs machine</title>
<style>
 body { font-family: system-ui, sans-serif; margin: 1.5em; max-width: 1500px; }
 .page { margin-bottom: 2.5em; }
 .pair { display: flex; gap: 12px; }
 .pair figure { margin: 0; flex: 1; }
 .pair img { width: 100%; border: 1px solid #ccc; }
 figcaption { font-weight: 600; padding: 4px 0; }
 .note { color: #555; max-width: 60em; }
</style></head><body>
<h1>PDM segmentation — hand tagging vs machine visual entries</h1>
<p class="note">Left: the researchers' hand groups (per-WORD overlapping
evidence sets — each MMO word's group shares the stem ink).  Right: the
machine's VISUAL entries (one group per block as Pacifique wrote it; the
per-word split happens at import-to-MMO time).  A ~2:1 hand:machine group
ratio is therefore expected, not under-detection.  The interactive
comparison is the page editor with the Tagging / Tagging:pdm layers.</p>"""]
for pn in PAGES:
    row = db.execute("SELECT page_id, image_ref FROM scanned_page WHERE document_id=1 AND page_number=?", (pn,)).fetchone()
    if not row: continue
    pid, ref = row
    hg, himg = render(pid, ref, 'Tagging', 'hand')
    mg, mimg = render(pid, ref, 'Tagging:pdm', 'machine')
    parts.append(f"""<div class="page"><h2>Page {pn}</h2>
<div class="pair">
 <figure><figcaption>Hand — {hg} groups</figcaption><img src="{himg}"></figure>
 <figure><figcaption>Machine — {mg} visual entries</figcaption><img src="{mimg}"></figure>
</div></div>""")
parts.append('</body></html>')
open('resources/pdm-segment-compare.html', 'w').write('\n'.join(parts))
print('wrote resources/pdm-segment-compare.html')
