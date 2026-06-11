#!/usr/bin/env python3
"""Dump the English side of every dictionary entry to entries.jsonl.

Reads the dict assertion table directly (CURRENT assertions only:
valid_to = END_OF_TIME) and projects the fields a categorizer needs.
One compact JSON object per line, ordered by entry_id (deterministic,
diffable).  Read-only over the db.

Output record shape:
  e:    entry_id
  mm:   spellings ["text (variant)" if variant else "text", ...]
  st:   statuses ["Completed", ...]
  pos:  parts of speech (one per subentry, in order)
  gl:   glosses
  tr:   translations
  ex:   example translations (the English side of examples)
  cat:  existing categories
  rec:  recording count (a learner-value signal)
  pic:  picture count

Usage: python3 dump_entries.py [db-path] [out-path]
"""
import json, sqlite3, sys, collections

DB = sys.argv[1] if len(sys.argv) > 1 else __import__('os').path.expanduser('~/mmo/database/db.db')
OUT = sys.argv[2] if len(sys.argv) > 2 else __import__('os').path.dirname(__file__) + '/entries.jsonl'
END_OF_TIME = 9007199254740991

conn = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
rows = conn.execute(
    "SELECT id1, ty, attr1, attr2, variant, order_key, id2 FROM dict "
    "WHERE valid_to = ? ORDER BY id1, order_key", (END_OF_TIME,)).fetchall()

entries = collections.defaultdict(lambda: collections.defaultdict(list))
for id1, ty, attr1, attr2, variant, order_key, id2 in rows:
    if id1 is None:
        continue
    entries[id1][ty].append((attr1, attr2, variant))

def texts(e, ty, with_variant=False):
    out = []
    for a1, _a2, variant in e.get(ty, []):
        if a1 is None or a1 == '':
            continue
        if with_variant and variant:
            out.append(f'{a1} ({variant})')
        else:
            out.append(a1)
    return out

with open(OUT, 'w') as f:
    n = 0
    for entry_id in sorted(entries):
        e = entries[entry_id]
        if 'ent' not in e:   # orphan current assertions under a deleted entry
            continue
        rec = {
            'e': entry_id,
            'mm': texts(e, 'spl', with_variant=True),
            'st': texts(e, 'sta'),
            'pos': texts(e, 'sub'),
            'gl': texts(e, 'gls'),
            'tr': texts(e, 'tra'),
            'ex': texts(e, 'etr'),
            'cat': texts(e, 'cat'),
            'rec': len(e.get('erc', [])),
            'pic': len(e.get('pic', [])),
        }
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        n += 1
print(f'{n} entries -> {OUT}', file=sys.stderr)
