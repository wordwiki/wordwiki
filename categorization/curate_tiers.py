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


# Promotions into the top-1000 pool (entries never nominated during the
# tagging pass).  Chosen from Completed, recorded, short-gloss entries in
# core learner categories to bring the cumulative top-1000 to exactly 1000.
T1000_PROMOTE = [
    14729,   # atie'wit - say goodbye
    29976,   # etna - well! / okay then!
    16034,   # awti'j - path, trail
    16280,   # egsitpugwatalg - eat breakfast
    23954,   # enmiaq - goes home
    4708,    # amalgewaqan - dance (event)
    8921,    # a'papi'j - thread / string
    33949,   # gaqtugwawig - thunder
    33786,   # gaqsit - burn
    37188,   # geljit - frozen
    39389,   # gesga't - lost
    41162,   # gesipiaq - itchy
    43072,   # getapa't - sink
    2534,    # alawe'ji'j - pill
    852,     # a'jijgopilaqan - bandage
    12053,   # apugsign - lynx
    9780,    # apistanewj - marten
    11299,   # ap'tapegiejit - turkey
    6527,    # amlmaw - mackerel
    7206,    # anagwe'j - flounder
    3605,    # aloqoman - grape
    34569,   # gawaqtejg - gooseberry
    2509,    # alawei - pea
    32086,   # galgunawei - biscuit / hardtack
    26329,   # eptaqano'guom - cupboard
    1893,    # alapilaqan - knapsack
    36794,   # gejigiaq - corner
    16126,   # egel - occasionally
    15932,   # awisiw - seldom
    36813,   # gejigow - recently
    5628,    # amgwes - first / first time
    16172,   # egimatl - count / read
    13697,   # asiteglulatl - reply
    35375,   # gegna'sit - dress up
    23009,   # emisqe'g - naked / bare
    8472,    # antawe's - woodpecker
    10155,   # apji'jgmuj - black duck
    32454,   # gapsgu'j - little waterfall
    26208,   # epsimgeweia'sit - becomes feverish
    31285,   # ewnasgwiet - dizzy
    37070,   # gelgwisge'g - sprained
    13246,   # asga'sit - limp
    11945,   # aptu'n - cane / walking stick
    2788,    # algusuet - climb about
    1843,    # alapegit - crawl about
    2115,    # alaqsing - fly around
    34637,   # gawasga's'g - turns around
    13832,   # asoqoma'sit - cross over
    8495,    # apaja's'g - come back / return
    14898,   # atlasmu'teget - take a rest
    3215,    # alje'mat - play ball
    4460,    # alu'sat - skinny / lean
    22036,   # eluatl - resemble
    35003,   # gawigsaw - thorn / thistle
    17272,   # ejigliwsit - move away (residence)
    35209,   # geggunawet - godparent
    3046,    # alisqotg - chew
    8316,    # ansuite'tg - regret
    38225,   # gepmite'lmatl - honor / respect
    37463,   # gelulatl - speak to
    24946,   # enqa's'g - stop
    26073,   # epsatl - heat / warm up
    11968,   # apua'latl - thaw / warm
    9889,    # apita't - bloated / swell
    8786,    # apangitatimg - pay day
    30658,   # ewi'gat - build a house
    9913,    # apita'taqan - baking powder / yeast
    29743,   # etlte'g - play (musical instrument) / strum
]


def main():
    assigns = {}
    with open(os.path.join(HERE, 'assignments.jsonl')) as f:
        for line in f:
            if line.strip():
                a = json.loads(line)
                assigns[a['e']] = a

    t10, t100, t1000p = set(T10), set(T100), set(T1000_PROMOTE)
    assert len(t10) == 10, len(t10)
    assert len(t10 | t100) == 100, len(t10 | t100)
    assert not (t10 & t100)
    assert not (t1000p & (t10 | t100))

    n = 0
    for eid, a in sorted(assigns.items()):
        final = ('t10' if eid in t10 else
                 't100' if eid in t100 else
                 't1000' if a.get('tier') or eid in t1000p else None)
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
