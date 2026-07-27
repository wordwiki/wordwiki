#!/usr/bin/env python3
"""The RAND <-> MMO orthography & pos survey (rand-orthography-survey.md).

Read-only over an instance db holding both the MMO `dict` table and the
imported `rand` table (sfm-import + transform pipeline).  Re-run after a
new Watson drop / re-import to refresh the doc's numbers.

    python3 watson/rand-orthography-survey.py [path/to/db.db]
"""
import sys, sqlite3, re, difflib
from collections import Counter, defaultdict

EOT = 9007199254740991
DB = sys.argv[1] if len(sys.argv) > 1 else 'mmo/database/db.db'
db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)

mmo = {t.replace('’', "'") for (t,) in db.execute(
    "SELECT attr1 FROM dict WHERE ty='spl' AND valid_to=? AND variant='mm-li' AND attr1 IS NOT NULL", (EOT,))}
# (Watson's lanes moved to their own orthography rows 2026-07-26:
#  watson-li / watson-sf, no longer sharing mm-li/mm-sf.)
rand = {t for (t,) in db.execute(
    "SELECT attr1 FROM rand WHERE ty='spl' AND valid_to=? AND variant='watson-li' AND attr1 IS NOT NULL", (EOT,))}
print(f"MMO li distinct: {len(mmo)};  RAND li distinct: {len(rand)}")
print(f"exact matches (MMO ’ normalized): {len(rand & mmo)}")

def skel(t): return re.sub(r"[''`’\-\s]", '', t.lower())
mmo_by_skel = defaultdict(list)
for t in mmo: mmo_by_skel[skel(t)].append(t)

# --- candidate mechanical rules -------------------------------------------------
for name, fn in [("` -> '", lambda t: t.replace('`', "'")),
                 ("` -> ' + casefold", lambda t: t.replace('`', "'").lower())]:
    pool = {m.lower() for m in mmo} if 'casefold' in name else mmo
    print(f"rule [{name}]: exact {sum(1 for t in rand if fn(t) in pool)}")

# --- the residue: length vs schwa marking ---------------------------------------
V = set('aeiou')
mmo_len = mmo_schwa = rand_len = rand_schwa = 0
near = 0
for t in rand:
    r = t.replace('`', "'")
    if r in mmo: continue
    for m in mmo_by_skel.get(skel(r), []):
        near += 1
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, r, m).get_opcodes():
            if op == 'insert' and m[j1:j2] == "'":
                if (m[j1-1:j1] or ' ') in V: mmo_len += 1
                else: mmo_schwa += 1
            if op == 'delete' and r[i1:i2] == "'":
                if (r[i1-1:i1] or ' ') in V: rand_len += 1
                else: rand_schwa += 1
        break
print(f"near pairs differing after mark rules: {near}")
print(f"MMO-only marks:  length {mmo_len}, schwa {mmo_schwa}")
print(f"RAND-only marks: length {rand_len}, schwa {rand_schwa}")
print(f"RAND spellings containing `: {sum('`' in t for t in rand)}")

# --- part of speech ----------------------------------------------------------------
paras = [p for (p,) in db.execute(
    "SELECT attr1 FROM rand WHERE ty='sub' AND valid_to=? AND attr1 IS NOT NULL AND attr1<>''", (EOT,))]
subs = db.execute("SELECT COUNT(*) FROM rand WHERE ty='sub' AND valid_to=?", (EOT,)).fetchone()[0]
pns = db.execute("SELECT COUNT(*) FROM rand WHERE ty='sub' AND valid_to=? AND attr2 IS NOT NULL AND attr2<>''",
                 (EOT,)).fetchone()[0]
tok1 = Counter(p.split()[0] for p in paras if p.split())
tok2 = Counter(p.split()[1] for p in paras if len(p.split()) > 1)
print(f"\nRAND senses {subs}; with paradigm {len(paras)}; with English pn {pns}")
print("class tokens:", tok1.most_common(8))
print("pos tokens:  ", tok2.most_common(8))
mmo_pos = Counter(t for (t,) in db.execute(
    "SELECT attr1 FROM dict WHERE ty='sub' AND valid_to=? AND attr1 IS NOT NULL AND attr1<>''", (EOT,)))
tot, rtot = sum(mmo_pos.values()), sum(tok2.values())
for pos in ['vai', 'vii', 'vat', 'vit', 'ni', 'na']:
    print(f"  {pos:4} MMO {100*mmo_pos.get(pos,0)/tot:5.1f}%  RAND {100*tok2.get(pos,0)/rtot:5.1f}%")
