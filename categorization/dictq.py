#!/usr/bin/env python3
"""dictq - accruing query/report tool over the categorization working files.

READ-ONLY by design: this tool never writes the .jsonl files.  Scripts that
transform assignments live beside it as separate, versioned programs, so
every change to the data has a named, repeatable cause.

Data files (same directory, override with --entries/--assign):
  entries.jsonl      the English-side dump (dump_entries.py)
  assignments.jsonl  new categorization {e, cats[], conf, tier?, note?}
                     (absent until the tagging pass starts)

Subcommands accrue as the categorization work needs them; each exists so a
report used to make a decision can be re-run later by anyone.

  stats                    coverage + status/category overview
  cats [--min N]           existing (old) categories by frequency
  members CAT [--old]      entries in a NEW category (--old: in an old one)
  grep REGEX               search the English side (gloss/translation/example)
  entry ID [ID...]         full record(s), pretty-printed
  batch START COUNT        compact tagging view of an entry-order slice
  family STEM              all entries whose headword starts with STEM
                           (tag derivational families as a unit)
  order-audit [--ratio R]  multi-cat entries whose FIRST category is much
                           bigger than their second (specific-first check)
"""
import json, argparse, re, sys, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))

def load_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]

def load(args):
    entries = load_jsonl(args.entries)
    assigns = {}
    if os.path.exists(args.assign):
        for a in load_jsonl(args.assign):
            assigns[a['e']] = a   # later lines win: corrections are appends
    return entries, assigns

def load_scheme(path=os.path.join(HERE, 'scheme.md')):
    """Parse the category scheme out of scheme.md (single source of truth).
    Returns {slug: (name, theme)} in document order."""
    scheme, theme = {}, None
    rx = re.compile(r'^- \*\*(.+?)\*\* \(`([a-z0-9-]+)`\)')
    with open(path) as f:
        for line in f:
            if line.startswith('## '):
                theme = line[3:].strip()
            m = rx.match(line)
            if m:
                scheme[m.group(2)] = (m.group(1), theme)
    return scheme

def headword(e):
    return e['mm'][0].split(' (')[0] if e['mm'] else f"#{e['e']}"

def english(e):
    return ' | '.join(e['gl'] + e['tr'])

def is_archived(e):
    return any(s.startswith('Archived') for s in e['st'])

# --- subcommands -------------------------------------------------------------

def cmd_stats(args):
    entries, assigns = load(args)
    n = len(entries)
    def count(pred): return sum(1 for e in entries if pred(e))
    print(f"entries: {n}   archived: {count(is_archived)}")
    print(f"with gloss: {count(lambda e: e['gl'])}   with translation: {count(lambda e: e['tr'])}"
          f"   with NEITHER: {count(lambda e: not e['gl'] and not e['tr'])}")
    print(f"with old category: {count(lambda e: e['cat'])}   with recording: {count(lambda e: e['rec'])}")
    st = collections.Counter(s for e in entries for s in e['st'])
    print("statuses:", dict(st.most_common()))
    if assigns:
        tagged = [e for e in entries if e['e'] in assigns]
        cats = collections.Counter(c for a in assigns.values() for c in a['cats'])
        conf = collections.Counter(a.get('conf', '?') for a in assigns.values())
        tiers = collections.Counter(a.get('tier') for a in assigns.values() if a.get('tier'))
        print(f"\nNEW assignments: {len(assigns)} entries tagged ({n - len(tagged)} to go), "
              f"{len(cats)} categories in use")
        print("confidence:", dict(conf.most_common()), "  tiers:", dict(tiers.most_common()))

def cmd_cats(args):
    entries, assigns = load(args)
    if assigns and not args.old:
        counts = collections.Counter(c for a in assigns.values() for c in a['cats'])
    else:
        counts = collections.Counter(c for e in entries for c in e['cat'])
    for cat, c in counts.most_common():
        if c >= args.min:
            print(f"{c:5}  {cat}")
    tail = sum(1 for c in counts.values() if c < args.min)
    if tail:
        print(f"(+ {tail} categories below --min {args.min})")

def cmd_members(args):
    entries, assigns = load(args)
    for e in entries:
        cats = e['cat'] if args.old else (assigns.get(e['e'], {}).get('cats', []))
        if args.cat in cats:
            mark = ' [ARCHIVED]' if is_archived(e) else ''
            print(f"{e['e']:6}  {headword(e):30} {english(e)[:110]}{mark}")

def cmd_grep(args):
    entries, assigns = load(args)
    rx = re.compile(args.regex, re.I)
    for e in entries:
        hay = ' ; '.join(e['gl'] + e['tr'] + e['ex'])
        if rx.search(hay):
            a = assigns.get(e['e'])
            newcats = f"  -> {','.join(a['cats'])}" if a else ''
            print(f"{e['e']:6}  {headword(e):28} {hay[:100]}{newcats}")

def cmd_entry(args):
    entries, assigns = load(args)
    by_id = {e['e']: e for e in entries}
    for eid in args.ids:
        e = by_id.get(eid)
        if not e:
            print(f"#{eid}: not found"); continue
        print(json.dumps(e, ensure_ascii=False, indent=1))
        if eid in assigns:
            print("assigned:", json.dumps(assigns[eid], ensure_ascii=False))

def load_v1(path=os.path.join(HERE, 'assignments-v1.jsonl')):
    """Frozen v1 assignments, shown in the batch view as evidence for the v2
    pass (like the old hand categories: informative, never authoritative)."""
    v1 = {}
    if os.path.exists(path):
        for a in load_jsonl(path):
            v1[a['e']] = a
    return v1

def cmd_batch(args):
    entries, assigns = load(args)
    v1 = load_v1()
    for e in entries[args.start:args.start + args.count]:
        if args.untagged_only and e['e'] in assigns:
            continue
        if args.terse:
            # survey view: glosses (or first translation), old cats squeezed
            gist = '; '.join(e['gl']) or (e['tr'][0] if e['tr'] else '?')
            arch = '!A' if is_archived(e) else ''
            print(f"{e['e']}|{headword(e)}|{'/'.join(e['pos'])}|{gist[:90]}|{','.join(e['cat'])}{arch}")
            continue
        pos = '/'.join(e['pos']) or '-'
        old = ','.join(e['cat']) or '-'
        arch = ' ARCHIVED' if is_archived(e) else ''
        # first example translation as clearly-marked WEAK evidence (helps
        # thin/polysemous glosses; never keyword-matched)
        ex = f" ex:{e['ex'][0][:70]}" if e['ex'] else ''
        prev = v1.get(e['e'])
        v1s = f"|v1:{','.join(prev['cats'])}" if prev and prev.get('cats') else ''
        print(f"{e['e']}|{headword(e)}|{pos}|{english(e)[:160]}|old:{old}{v1s}{arch}{ex}")

def cmd_family(args):
    """All entries whose headword starts with STEM, with their assignments -
    derivational families share a primary category, so tag them as a unit."""
    entries, assigns = load(args)
    v1 = load_v1()
    for e in entries:
        if not headword(e).startswith(args.stem):
            continue
        a = assigns.get(e['e'])
        new = f" -> {','.join(a['cats'])}" if a and a.get('cats') else ''
        prev = v1.get(e['e'])
        v1s = f" v1:{','.join(prev['cats'])}" if prev and prev.get('cats') else ''
        mark = ' [ARCHIVED]' if is_archived(e) else ''
        print(f"{e['e']:6}  {headword(e):30} {english(e)[:90]}{new}{v1s}{mark}")

def cmd_order_audit(args):
    """Specific-first check: list multi-category entries whose FIRST category
    has more than --ratio times the members of their second.  Broad-before-
    specific is sometimes right, so hits are re-look flags, not errors."""
    entries, assigns = load(args)
    counts = collections.Counter(c for a in assigns.values() for c in a['cats'])
    by_id = {e['e']: e for e in entries}
    hits = 0
    for eid, a in assigns.items():
        cats = a.get('cats', [])
        if len(cats) < 2 or eid not in by_id:
            continue
        if counts[cats[0]] > args.ratio * counts[cats[1]]:
            e = by_id[eid]
            print(f"{eid:6}  {headword(e):28} [{', '.join(f'{c}({counts[c]})' for c in cats)}]"
                  f"  {english(e)[:60]}")
            hits += 1
    print(f"{hits} entries with first category >{args.ratio}x its second")

def cmd_scheme(args):
    scheme = load_scheme()
    entries, assigns = load(args)
    counts = collections.Counter(c for a in assigns.values() for c in a['cats'])
    theme = None
    for slug, (name, th) in scheme.items():
        if th != theme:
            theme = th
            print(f"\n{theme}")
        print(f"  {counts.get(slug, 0):5}  {name} ({slug})")
    print(f"\n{len(scheme)} categories")

def cmd_tiers(args):
    """List tier nominations. Tiers are CUMULATIVE: t10 entries are also in
    t100 and t1000; t100 entries are also in t1000."""
    entries, assigns = load(args)
    want = args.tier
    rank = {'t10': 1, 't100': 2, 't1000': 3}
    for e in entries:
        a = assigns.get(e['e'])
        if not a or not a.get('tier'):
            continue
        if want and rank[a['tier']] > rank[want]:
            continue
        print(f"{a['tier']:5} {e['e']:6}  {headword(e):28} {english(e)[:80]}"
              f"  [{','.join(a['cats'])}]")

def cmd_validate(args):
    scheme = load_scheme()
    entries, assigns = load(args)
    bad = 0
    for a in assigns.values():
        for c in a['cats']:
            if c not in scheme:
                print(f"UNKNOWN CATEGORY {c!r} on entry {a['e']}"); bad += 1
        if not a['cats'] and not a.get('flag'):
            print(f"entry {a['e']}: no categories and no flag"); bad += 1
        if a.get('tier') not in (None, 't10', 't100', 't1000'):
            print(f"entry {a['e']}: bad tier {a.get('tier')!r}"); bad += 1
    missing = [e['e'] for e in entries if e['e'] not in assigns]
    print(f"{len(assigns)} assigned, {len(missing)} unassigned, {bad} problems")
    if missing and args.show_missing:
        print("first unassigned:", missing[:20])

# --- main --------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--entries', default=os.path.join(HERE, 'entries.jsonl'))
    p.add_argument('--assign', default=os.path.join(HERE, 'assignments.jsonl'))
    sub = p.add_subparsers(dest='cmd', required=True)

    sub.add_parser('stats').set_defaults(fn=cmd_stats)
    s = sub.add_parser('cats'); s.add_argument('--min', type=int, default=1)
    s.add_argument('--old', action='store_true'); s.set_defaults(fn=cmd_cats)
    s = sub.add_parser('members'); s.add_argument('cat')
    s.add_argument('--old', action='store_true'); s.set_defaults(fn=cmd_members)
    s = sub.add_parser('grep'); s.add_argument('regex'); s.set_defaults(fn=cmd_grep)
    s = sub.add_parser('entry'); s.add_argument('ids', type=int, nargs='+'); s.set_defaults(fn=cmd_entry)
    s = sub.add_parser('batch'); s.add_argument('start', type=int); s.add_argument('count', type=int)
    s.add_argument('--untagged-only', action='store_true')
    s.add_argument('--terse', action='store_true'); s.set_defaults(fn=cmd_batch)

    s = sub.add_parser('family'); s.add_argument('stem'); s.set_defaults(fn=cmd_family)
    s = sub.add_parser('order-audit'); s.add_argument('--ratio', type=float, default=3.0)
    s.set_defaults(fn=cmd_order_audit)

    s = sub.add_parser('tiers'); s.add_argument('tier', nargs='?', choices=['t10', 't100', 't1000'])
    s.set_defaults(fn=cmd_tiers)
    sub.add_parser('scheme').set_defaults(fn=cmd_scheme)
    s = sub.add_parser('validate'); s.add_argument('--show-missing', action='store_true')
    s.set_defaults(fn=cmd_validate)

    args = p.parse_args()
    args.fn(args)

if __name__ == '__main__':
    main()
