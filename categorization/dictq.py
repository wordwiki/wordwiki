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

def cmd_batch(args):
    entries, assigns = load(args)
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
        ex = f"  ex: {e['ex'][0][:80]}" if e['ex'] and not e['gl'] and not e['tr'] else ''
        print(f"{e['e']}|{headword(e)}|{pos}|{english(e)[:130]}|old:{old}{arch}{ex}")

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

    args = p.parse_args()
    args.fn(args)

if __name__ == '__main__':
    main()
