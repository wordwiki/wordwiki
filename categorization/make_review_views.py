#!/usr/bin/env python3
"""make_review_views - generate the Markdown views the language team audits.

Reads entries.jsonl + assignments.jsonl (+ scheme.md) and writes review/:

  review/00-overview.md         scheme with member counts, flags, tier counts
  review/by-category/NN-slug.md one file per category: every member with its
                                headword + full English; Archived members
                                separated at the bottom; multi-category
                                members show their other categories
  review/tiers.md               curated top-10 / top-100 / top-1000
  review/needs-human.md         entries flagged for human attention
  review/old-to-new.md          where each old category's members ended up
  review/low-confidence.md      entries tagged with medium/low confidence

All output is Markdown so the team can read it rendered on GitHub or as
HTML.  Regenerate any time with:  python3 make_review_views.py
The files are deterministic so successive runs diff cleanly.
"""
import json, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'review')
import dictq


def load_all():
    entries = dictq.load_jsonl(os.path.join(HERE, 'entries.jsonl'))
    assigns = {}
    for a in dictq.load_jsonl(os.path.join(HERE, 'assignments.jsonl')):
        assigns[a['e']] = a
    scheme = dictq.load_scheme()
    return entries, assigns, scheme


def md(s):
    """Escape the few characters that would format-mangle in Markdown."""
    return s.replace('*', r'\*').replace('_', r'\_').replace('|', r'\|')


def member_line(e, a=None, hide_cat=None):
    out = f"- **{md(dictq.headword(e))}** — {md(dictq.english(e))}"
    if a:
        others = [c for c in a['cats'] if c != hide_cat]
        if others:
            out += f"  *(also: {', '.join(others)})*"
        if a.get('conf'):
            out += f"  *(confidence: {a['conf']})*"
        if a.get('note'):
            out += f"  *(note: {md(a['note'])})*"
    return out + '\n'


def main():
    entries, assigns, scheme = load_all()
    by_id = {e['e']: e for e in entries}
    os.makedirs(os.path.join(OUT, 'by-category'), exist_ok=True)

    members = collections.defaultdict(list)
    for e in entries:
        for c in assigns.get(e['e'], {}).get('cats', []):
            members[c].append(e)

    themes = []
    for slug, (name, theme) in scheme.items():
        if theme not in themes:
            themes.append(theme)

    # --- per-category files -------------------------------------------------
    for i, (slug, (name, theme)) in enumerate(scheme.items(), 1):
        path = os.path.join(OUT, 'by-category', f"{i:02d}-{slug}.md")
        live = [e for e in members[slug] if not dictq.is_archived(e)]
        arch = [e for e in members[slug] if dictq.is_archived(e)]
        with open(path, 'w') as f:
            f.write(f"# {name} (`{slug}`)\n\n")
            f.write(f"Theme: *{theme}* — {len(live)} entries"
                    f" (+{len(arch)} archived)\n\n")
            for e in live:
                f.write(member_line(e, assigns[e['e']], hide_cat=slug))
            if arch:
                f.write("\n## Archived entries (lower priority)\n\n")
                for e in arch:
                    f.write(member_line(e))

    # --- overview -----------------------------------------------------------
    flagged = [a for a in assigns.values() if a.get('flag')]
    tiers = collections.Counter(a['tier'] for a in assigns.values() if a.get('tier'))
    with open(os.path.join(OUT, '00-overview.md'), 'w') as f:
        f.write("# Proposed re-categorization — overview\n\n")
        f.write(f"- **{len(entries)}** entries; **{len(scheme)}** categories in "
                f"**{len(themes)}** themes; every entry tagged with 1–3 categories.\n")
        f.write(f"- **{len(flagged)}** entries flagged *needs-human* "
                f"(placeholders / no English) — see [needs-human](needs-human.md).\n")
        f.write(f"- Learner tiers (cumulative): top-10 = {tiers.get('t10', 0)}, "
                f"top-100 = {tiers.get('t10', 0) + tiers.get('t100', 0)}, "
                f"top-1000 = {sum(tiers.values())} — see [tiers](tiers.md).\n")
        f.write("- Category definitions and criteria: see `scheme.md` "
                "(one level up).\n\n")
        f.write("## Category sizes\n\n")
        f.write("Live members (+archived). Full lists are in `by-category/`.\n")
        theme = None
        i = 0
        for slug, (name, th) in scheme.items():
            i += 1
            if th != theme:
                theme = th
                f.write(f"\n### {theme}\n\n")
            live = sum(1 for e in members[slug] if not dictq.is_archived(e))
            arch = len(members[slug]) - live
            f.write(f"- [{name}](by-category/{i:02d}-{slug}.md) — "
                    f"{live} (+{arch} archived)\n")

    # --- tiers ----------------------------------------------------------------
    rank = {'t10': 0, 't100': 1, 't1000': 2}
    tiered = sorted((rank[a['tier']], by_id[eid]['mm'][0] if by_id[eid]['mm'] else '', eid)
                    for eid, a in assigns.items() if a.get('tier') and eid in by_id)
    with open(os.path.join(OUT, 'tiers.md'), 'w') as f:
        f.write("# Learner priority tiers\n\n")
        f.write("Tiers are **cumulative**: the top-100 includes the top-10, the "
                "top-1000 includes both. These were chosen from the English side "
                "by general language-learning intuition — the team should audit "
                "the top-10 and top-100 especially hard.\n")
        last = None
        titles = {0: 'Top-10 — very first words', 1: 'Top-100 (the further 90)',
                  2: 'Top-1000 (the further 900)'}
        for r, _, eid in tiered:
            if r != last:
                last = r
                f.write(f"\n## {titles[r]}\n\n")
            e = by_id[eid]
            cats = ', '.join(assigns[eid]['cats'])
            f.write(f"- **{md(dictq.headword(e))}** — "
                    f"{md(dictq.english(e)[:90])}  *[{cats}]*\n")

    # --- needs-human ------------------------------------------------------------
    with open(os.path.join(OUT, 'needs-human.md'), 'w') as f:
        f.write("# Entries needing human attention\n\n")
        f.write("These could not be categorized (placeholders, no English, "
                "editor notes, grammatical prefixes). Each needs a decision: "
                "finish the entry, delete it, or leave it uncategorized.\n\n")
        for eid, a in sorted(assigns.items()):
            if not a.get('flag') or eid not in by_id:
                continue
            e = by_id[eid]
            eng = dictq.english(e)[:60]
            f.write(f"- `{eid}` **{md(dictq.headword(e))}**"
                    f"{' — ' + md(eng) if eng else ''}"
                    f"  *({md(a.get('note', ''))})*\n")

    # --- old -> new mapping --------------------------------------------------------
    with open(os.path.join(OUT, 'old-to-new.md'), 'w') as f:
        f.write("# Old categories → new categories\n\n")
        f.write("Where the members of each old hand-made category ended up in "
                "the new scheme (old categories sorted by size).\n\n")
        old_members = collections.defaultdict(list)
        for e in entries:
            for c in e['cat']:
                old_members[c].append(e['e'])
        for old, ids in sorted(old_members.items(), key=lambda kv: -len(kv[1])):
            news = collections.Counter()
            for eid in ids:
                cats = assigns.get(eid, {}).get('cats') or ['(uncategorized)']
                news.update(cats)
            dist = ', '.join(f"{c} ×{n}" for c, n in news.most_common(8))
            more = len(news) - 8
            if more > 0:
                dist += f", +{more} more"
            f.write(f"- **{md(old)}** ({len(ids)} entries) → {dist}\n")

    # --- low confidence ---------------------------------------------------------------
    with open(os.path.join(OUT, 'low-confidence.md'), 'w') as f:
        f.write("# Low-confidence assignments\n\n")
        f.write("Entries tagged with reduced confidence (m = medium, l = low). "
                "Good first targets for a human double-check.\n\n")
        for eid, a in sorted(assigns.items()):
            if not a.get('conf') or eid not in by_id:
                continue
            e = by_id[eid]
            f.write(f"- *({a['conf']})* **{md(dictq.headword(e))}** — "
                    f"{md(dictq.english(e)[:70])}  *[{', '.join(a['cats'])}]*"
                    f"{'  — ' + md(a['note']) if a.get('note') else ''}\n")

    print(f"review views written to {OUT}/")


if __name__ == '__main__':
    main()
