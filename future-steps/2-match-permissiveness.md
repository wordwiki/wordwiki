# Thread 2 — match permissiveness (the phonology reading's top lever)

## What / why
The phonology reading's verdict (phonology-reference.md §4): of the three
ways to spend phonetic knowledge, MATCH PERMISSIVENESS is cheapest + highest
yield — and it BEATS a generation scorer.  Idea: teach the matcher to treat
allophonic variants as NON-DISTINGUISHING, so cross-orthography words that
differ only by predictable phonology still match.  This directly improves
the pm/rand/clark → MMO joins (the evidence links Thread 3's import button
copies) and lets an mm-li speaker find watson-rand entries.

## Read first
- wordwiki/phonology-reference.md §4.1 (the levers) + §2.0 (F3/F4/F1) — THE
  spec for what to encode.
- wordwiki/transliteration-workbench.md §9 (matching as a first-class driver:
  shared rule DATA, two drivers, permissiveness classes + graded alignment).
- wordwiki/transliterate-match.ts (orthoMatch, grades, dialectSubs, cskel) +
  memory [[transliteration-pairs]] (ORTHOMATCH BUILT / DIALECT WIDENING) +
  [[similarity-engine]].

## Current state (landed)
- The matcher exists: orthoMatch(a,laneA,b,laneB)→{grade: exact|candidate|
  skeleton|none}, transliteratedSkeletons blocking keys, dialectSubs (g↔q
  l↔n), cskel1 single-consonant-edit keys.  The 3-pass similarity engine
  (blocking/judge/escalation) consumes it.
- The pair engine is HARDENED (I1-I5): registry, composition, provenance,
  explain, rule-list interpreter — a solid substrate.
- §9 (permissiveness classes + graded alignment) is DESIGN, not built.

## FIRST MOVE
Encode the VOICING equivalence class first — it's F3, the measured
highest-value, low-risk one, and it IS the Rand/Metallic↔modern axis:
p~b, t~d, k~g, kw~gw, s~z, j~dž are the same phonemes written differently
(Rand/Metallic split the intervocalic voiced allophone; modern doesn't).
- Add it as a named permissiveness class the matcher treats as equal (like
  dialectSubs, but voicing).  Steeves measured it as a TENDENCY (~80-92%),
  so it's PERMISSIVENESS (match-time relaxation), NOT a reversible
  generation rule — don't build a generator.
- MEASURE the lift on the rand↔dict and pm↔rand joins (more same-word
  matches, the referral band shrinks) — measure on the JOINS, not on
  transliteration accuracy.  Use the existing similarity harness.
- Then add uvular (g~q + the [q χ ħ h x ɣ] span) and unwritten
  labialization (final -g~-gw, -q~-qw after u/o) as more classes, and
  length-ignore (grades length-only diffs as a match — recovers the ×261
  pm-li bucket F1).

## Reusable primitives to build (phonology-reference §4.3)
- the SONORITY HIERARCHY (obstruent<m<n<l<w/y<V) — drives schwa + these classes.
- a per-grapheme FEATURE map (place/manner/voice/grave/long) — the substrate
  for the equivalence classes.  Keep it DATA a linguist can read (the I4/I5
  legibility bar).

## Settled decisions — don't reopen
- Phonetics helps MATCH more than generation (§9.3) — build permissiveness,
  NOT a phonetic generation scorer (that evidence was flat: pm-li
  phonology-in-prompt 58.8 vs 60.3).  [phonology §4]
- Voicing first (F3, Rand-family, cheap, measurable).  Length is a match
  problem, not a generation fix (F1).  The ambiguous schwa branches DON'T
  yield to phonetics (F2).
- Don't trigger the deferred full rand binder / full-band judge without dz's
  go (deferred-llm-runs.md).
