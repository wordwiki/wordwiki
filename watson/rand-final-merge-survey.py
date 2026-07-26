#!/usr/bin/env python3
"""Verify the Final-files (Ng/Lk) account against the data
(rand-final-merge-design.md): disjointness from the queue, Ng<->Lk
pairing via Ng.lsf == Lk.lx, content divergence on paired entries, and
the 33,276 arithmetic.  Parses the SFM files directly (no db needed).

    python3 watson/rand-final-merge-survey.py
"""
import re
from collections import Counter

W = __file__.rsplit('/', 1)[0] + '/'

def records(path):
    txt = open(W + path, encoding='utf-8').read().replace('\r', '')
    recs, cur = [], None
    for line in txt.split('\n'):
        m = re.match(r'\\([A-Za-z_+][A-Za-z0-9_]*) ?(.*)$', line)
        if m:
            name, content = m.group(1), m.group(2)
            if name == 'lx':
                cur = []
                recs.append(cur)
            if cur is not None: cur.append([name, content])
        elif cur is not None and cur:
            cur[-1][1] += '\n' + line
    return [r for r in recs if any(c for _, c in r)]   # drop the blank template

def field(r, n): return next((c for k, c in r if k == n and c), None)
def fields(r, n): return [c for k, c in r if k == n and c]

big = records('Rand Mig Eng Dictt 29097')
ng = records('Ng20726')
lk = records('Lk20726')
print(f"records: queue {len(big)}, ng {len(ng)}, lk {len(lk)}")

big_lx = Counter(field(r, 'lx') for r in big)
ng_lx = {field(r, 'lx') for r in ng}
ng_lsf = {field(r, 'lsf') for r in ng if field(r, 'lsf')}
lk_lx = {field(r, 'lx') for r in lk}
print(f"queue distinct lx: {len(big_lx)} (duplicate-headword rows: {sum(n-1 for n in big_lx.values() if n > 1)})")
print(f"disjointness: ng.lx in queue {len(ng_lx & set(big_lx))}; lk.lx in queue {len(lk_lx & set(big_lx))}")
print(f"ng with lsf: {len(ng_lsf)}; paired (lk.lx == ng.lsf): {len(lk_lx & ng_lsf)}; "
      f"lk unpaired {len(lk_lx - ng_lsf)}; ng.lsf unpaired {len(ng_lsf - lk_lx)}")

ng_by_lsf = {}
for r in ng:
    k = field(r, 'lsf')
    if k and k not in ng_by_lsf: ng_by_lsf[k] = r
CONTENT = ['ps', 'pn', 'ge', 'de', 'xv', 'xe', 'so', 'nt']
same = diff = 0
diff_fields = Counter(); newer = Counter()
for r in lk:
    m = ng_by_lsf.get(field(r, 'lx'))
    if not m: continue
    d = [f for f in CONTENT if fields(r, f) != fields(m, f)]
    if d:
        diff += 1
        for f in d: diff_fields[f] += 1
        ndt, ldt = field(m, 'dt') or '', field(r, 'dt') or ''
        newer['lk' if ldt > ndt else 'ng' if ndt > ldt else 'same-dt'] += 1
    else:
        same += 1
print(f"paired content-identical: {same}; DIVERGED: {diff}")
print("diverging fields:", diff_fields.most_common())
print("newer side on diverged:", dict(newer))
print(f"33,276 - {len(big)} - {len(ng)} = {33276 - len(big) - len(ng)} (in neither Final)")
