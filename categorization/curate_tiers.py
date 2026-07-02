#!/usr/bin/env python3
"""curate_tiers - turn cumulative tier NOMINATIONS into exact curated tiers.

During the tagging pass entries were *nominated* for learner tiers
(t10/t100/t1000, cumulative).  This script holds the curated decision -
exactly which entries form the top-10 and top-100 - and emits correction
records (to stdout, append to assignments.jsonl) so that:

  - the T10 list below      -> tier t10     (exactly 10)
  - the T100 list below     -> tier t100    (90 entries; top-100 = T10+T100)
  - every other nominated   -> tier t1000   (the top-1000 pool)

Per the working-files policy, dictq.py stays read-only and this transform
is a named, versioned, re-runnable program.  Selection rationale: top-10 =
first conversational words (hello/thanks/yes/no/goodbye/I/you/what/where/
water); top-100 adds pronouns, core verbs, question words, 1-2-3, close
family, everyday nouns and adjectives, and culturally central words
(lnu, Mi'gmaw, Listuguj, gwitn, plamu, waltes was left t1000).
The Mi'gmaq team should audit these lists - they are English-side intuition.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))

T10 = [
    119977,  # pusu'l - Hello! / Greetings!
    155791,  # wela'lin - thank you
    16093,   # e'e - yes
    79075,   # moqwa' - no
    14747,   # atiu - goodbye
    91368,   # ni'n - me / I
    45740,   # gi'l - you
    51819,   # goqwei - what
    132426,  # tami - where?
    121590,  # samqwan - water
]

T100 = [
    # kept from the t10 nominations
    12378, 25604, 26535, 29018, 37483, 38737, 44405, 45721, 47347, 58964,
    59365, 61712, 61918, 75495, 76026, 76589, 81352, 87370, 87917, 89754,
    90781, 92732, 110434, 118271, 122513, 132893, 134004, 139007, 141324,
    145227, 158617, 158977, 159436, 166535, 166615, 115529,
    5345889051516321,
    # promoted from the t100 nominations
    86643,   # negm - he/she
    46604,   # ginu - we (inclusive)
    77503,   # mimajuinu - person
    76654,   # mijua'ji'j - baby/child
    62502,   # lpa'tuj - boy
    25627,   # e'pite'ji'j - young girl
    94121,   # nugumi - granny!
    37559,   # gelusit - speak
    36646,   # geitoq - know
    63412,   # maja'sit - leave/go
    43495,   # getgwi'g - run
    25080,   # epa'sit - sit down
    97511,   # nutg - hear
    136205,  # teluet - says
    10562,   # apoqonmuatl - help
    22466,   # elugwet - work
    76764,   # mila'sit - play
    136247,  # teluisit - is named
    129826,  # si'st - three
    132448,  # ta'n - when/where
    79391,   # ms't - all
    118731,  # pugwelg - many/lots
    9963,    # apje'jg - small
    73216,   # mesgi'g - big
    151230,  # waqame'g - clean
    70462,   # megwe'g - red
    65904,   # maqtawe'g - black
    150195,  # wape'g - white
    26349,   # epteg - hot
    134222,  # tegig - cold
    45554,   # gigpesaq - it is raining
    152700,  # wastew - snow
    81428,   # na'gweg - day
    137628,  # tepgig - night
    147412,  # ulagu - yesterday
    91480,   # nipg - summer
    40353,   # gesig - winter
    148473,  # unji - head
    145386,  # ugpugugw - eye
    129323,  # sipu - river
    78297,   # miti's - tree
    65130,   # maqamigew - land
    79732,   # mui'n - bear
    115576,  # plamu - salmon
    165984,  # wi'sis - animal
    112736,  # pipnaqan - bread
    117851,  # p'tewei - tea
    61547,   # Listuguj
    131574,  # suliewei - money
    53706,   # gwitn - canoe
    42260,   # gesnugwat - sick
    48410,   # gispnet - tired
    133667,  # taqawaje'g - sad
]


# v2 (2026-07-01): the v1 T1000_PROMOTE list is retired - every one of its
# 71 entries was independently re-nominated during the v2 tagging pass, so
# promotion is a no-op.  The v2 pass over-nominated per instructions
# (1052 cumulative), so v2 curation instead DEMOTES 52 nominations to bring
# the cumulative top-1000 to exactly 1000 (10 + 90 + 900).  Selection:
# archived or unrecorded entries; mid-decade numerals (30/40/50/60 - the
# 1-10/100/1000 backbone stays); the weaker member of duplicate-gloss or
# spelling-variant pairs; derived forms whose base word is already tiered;
# narrow compounds.  The Mi'gmaq team should audit this list too.
T1000_DEMOTE = [
    99136,   # oti - friend (ARCHIVED)
    130658,  # soppei - couch (ARCHIVED)
    5605210604508289,  # gtantaqan - hunting (no recording)
    7192904760486449,  # jipaltimgewei - fear (no recording; dup of jipalatl family)
    88394,   # nesisga'q - thirty
    89546,   # newisga'q - forty
    82583,   # nanisga'q - fifty
    13379,   # as'gom te'sisga'q - sixty
    4708,    # amalgewaqan - dance event (amalgat kept)
    8495,    # apaja's'g - come back vii (apaja'sit kept)
    13697,   # asiteglulatl - reply (asitematl kept)
    14472,   # a't - that (ala, na kept)
    20079,   # eli'satl - sew vta (eli'sewet kept)
    19633,   # eliatl - make vta (eltoq kept)
    23954,   # enmiaq - goes home vii (enmiet kept)
    29772,   # etltemit - crying (atgitemit kept)
    33949,   # gaqtugwawig - it thunders (gaqtugwaw kept)
    12027,   # apugjig - soon (geget kept)
    35233,   # geggung - have it vti (geggunatl kept)
    35306,   # gegina'muatl - teach vta (gegina'muet kept)
    37438,   # gelt'g - frozen vti (geljit kept)
    50360,   # glitaw - strawberry NS variant (atuomgomin kept)
    51117,   # gneg - far (amaseg kept)
    59408,   # jiptug - perhaps (etug kept)
    60705,   # lasguaw - snowshoe loanword (aqam kept)
    75577,   # m'gegn - hide (mimugwasit kept)
    24946,   # enqa's'g - stop vii (naqa'sit kept)
    86437,   # na tmg - first of all (amgwes, tmg kept)
    92594,   # niwe'g - dry (gispateg kept)
    93179,   # nnu'tesing - spelling variant (lnu'tesing kept)
    93379,   # npo'qon - spelling variant (mpo'qon kept)
    98492,   # oqo - because (muta kept)
    99060,   # oqwa't - arrive/dock (iga't, pegising kept)
    115051,  # pittaq - spelling variant (pita'q kept)
    48769,   # gi's sa'q - long ago compound (sa'q kept)
    128762,  # sipeliw - seldom (awisiw kept)
    130884,  # soqtamit - chew (alisqotg kept)
    139347,  # tetaqe'g - hurry (nenaqa'sit kept)
    142981,  # toqosi'p - and then (toqojiw kept)
    143807,  # tugwa'latl - wake someone vta (tugwiet kept)
    86477,   # na tujiw - at that time compound (tujiw kept)
    148915,  # u't - this (ula kept, t100)
    53154,   # gutan - town variant (utan kept)
    154673,  # we'jiatl - find vta (we'jitoq kept)
    16615,   # egwitamet - fish (wesget kept)
    29046,   # etlenmit - laughing (wesgewe'g kept)
    29560,   # etloqsatl - cooking vta (wissugwatiget kept)
    120028,  # pusu'l puna'ne - Happy New Year phrase (pusu'l kept, t10)
    51874,   # goqwei ugjit - what for phrase (goqwei kept, t10)
    105166,  # pe'l tmg - first of all phrase
    9913,    # apita'taqan - baking powder (narrow)
    26329,   # eptaqano'guom - china cabinet (narrow)
]


def main():
    assigns = {}
    with open(os.path.join(HERE, 'assignments.jsonl')) as f:
        for line in f:
            if line.strip():
                a = json.loads(line)
                assigns[a['e']] = a

    t10, t100, demote = set(T10), set(T100), set(T1000_DEMOTE)
    assert len(t10) == 10, len(t10)
    assert len(t10 | t100) == 100, len(t10 | t100)
    assert not (t10 & t100)
    assert not (demote & (t10 | t100))

    n = 0
    for eid, a in sorted(assigns.items()):
        final = ('t10' if eid in t10 else
                 't100' if eid in t100 else
                 't1000' if a.get('tier') and eid not in demote else None)
        if final != a.get('tier'):
            rec = dict(a)
            if final is None:
                rec.pop('tier', None)
            else:
                rec['tier'] = final
            print(json.dumps(rec, ensure_ascii=False))
            n += 1
    print(f"{n} tier corrections emitted", file=sys.stderr)
    missing = (t10 | t100) - set(assigns)
    if missing:
        print(f"WARNING: curated ids not in assignments: {missing}", file=sys.stderr)


if __name__ == '__main__':
    main()
