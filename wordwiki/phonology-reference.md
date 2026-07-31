# Mi'kmaq phonology reference — for the transliteration/match engine

Started 2026-07-31.  Purpose: a rule inventory of Mi'kmaq phonology/
morphophonology, each fact mapped to (a) which orthography PAIR it bears
on, (b) the MEASURED error cluster it would explain, and (c) whether it's
a candidate for a generation SCORE or a match PERMISSIVENESS relaxation
(§8/§9 of transliteration-workbench.md).  Sources: §1 the in-project
orthography keys + web (orthography-sources.md), §2 wiki.migmaq.org
(Listuguj team), §3 academic (Fidelholtz 1968, Olson, Steeves, Hewson).
NOT a linguistics survey — every entry must earn its place by touching a
pair or a cluster.

## 0. The empirical targets (measured BEFORE the reading — what phonetics must explain)

These are the anchors.  A phonological rule is USEFUL to us iff it
predicts one of these.  Two engines, two tables:

### 0.1 pm-li (Pacifique→Listuguj) error clusters — train miss-miner, rules-v3
The residual after the current letter rules (holdout 29.9%; the big
headroom pair).  Top clusters, with the phenomenon each implicates:

| ×cnt | edit | top contexts | phenomenon (hypothesis) |
|------|------|-------------|-------------------------|
| 261 | insert `'` (length apostrophe) | a_t a_s e_g i_g | VOWEL LENGTH unwritten in Pacifique — the dominant miss; §8.2 says this is where phonetics/scoring would live |
| 79 | u→w | _e g_i g_$ e_g | GLIDE: o/u → w before/after vowels |
| 76 | u→o | q_n g_p q_l g_m | VOWEL QUALITY: o=/u/ but stays o adjacent to uvular q (the rule is there but overshooting) |
| 63 | e→`'` | l_g t_s g_t s_g | SCHWA written as apostrophe |
| 63 | delete u | **w_l ×47** a_g | u-PROTHESIS / w+u collapse (the wtikmatimkewey↔uktikmatimkewey family) |
| 58 | g→q | s_a s_i a_i a_j | UVULAR backing (undergenerated — rule fires only after a) |
| 54 | insert e | t_m n_m g_n g_l | EPENTHESIS (the tem→tm syncope reversed: gold keeps the e) |
| 47 | delete e | g_n s_m p_l t_l | SYNCOPE (over/under-applied) |
| 26 | insert o | l_u u_u i_u | back-vowel / labialization |
| 20 | oq→ug | p_u _u t_u | VOWEL QUALITY by uvular: gold has u+g where rules kept o+q |
| 18 | oqu→ugw | t_e m_a t_a | same + labialization |
| 17 | q→g | o_u a_a a_$ | uvular OVERSHOOT (rules back too much after a) |

Read together: pm-li's misses are dominated by (1) vowel LENGTH (261 —
unrecoverable from Pacifique's orthography without lexical/phonological
knowledge), (2) the o/u/w vowel-quality+glide complex tangled with (3)
UVULARITY (g/q), which itself conditions the vowel quality (oq vs ug).
So uvularity and vowel quality are COUPLED — a phonetic feature model
might untangle what per-letter rules cannot.  NB the §2b normalization
gap: some of these "misses" are the gold rtl REGULARIZING inflection, not
a transcription the rules could reach — the hand-cleaned holdout (§8.5
step 1) must separate these before we score phonetics against them.

### 0.2 li-sf branch table — the MEASURED ambiguous sites (BRANCH_PROBABILITIES)
li-sf's residual IS its branch decisions (the hybrid engine, §6b I5).
The genuinely ambiguous ones (0.15<P<0.85) are the phonetics targets;
the near-deterministic ones (P≈0 or 1) are already solved by context:

| site | taken/total | P | ambiguous? |
|------|-------------|---|-----------|
| cluster a·n·k | 0/64 | .00 | no — solved |
| cluster a·l·t | 41/42 | .98 | no — solved |
| cluster e·n·j | 38/38 | 1.0 | no — solved |
| cluster i·n·k | 0/22 | .00 | no — solved |
| **cluster u·l·t** | 14/56 | .25 | YES (the ult exception) |
| **cluster e·l·t** | 34/41 | .83 | YES |
| **cluster a·n·t** | 22/29 | .76 | YES |
| **cluster e·l·p** | 19/23 | .83 | YES |
| **cluster e·l·k** | 15/20 | .75 | YES |
| **cluster m·n·t** | 16/19 | .84 | YES |
| **schwa s·k** | 6/39 | .15 | YES (î vs apostrophe) |
| **schwa s·t** | 1/18 | .06 | near-solved |
| **ei:vai** | 4/23 | .17 | YES (vai keeps -ei) |
| **ei:other** | 10/18 | .56 | YES (coin flip) |

li-sf's schwa/cluster-apostrophe decisions are the SAME phenomenon as
pm-li's — sonorant-cluster epenthesis and schwa realization — seen from a
different orthography.  A phonological account of "when does a sonorant+
obstruent cluster take a schwa/apostrophe" would inform BOTH engines'
branch scores.  That cross-pair leverage is the case for phonetics.

## 1. Orthography-key phonology (from the in-project scans)
(See orthography-sources.md §1 for the raw keys.  Phonological content:)
- Rand h-after-vowel = soft guttural (German ich) = the uvular/velar
  fricative Listuguj writes q/g in coda — so watson-sf `h` ↔ li q/g.
- Rand/Listuguj initial 'm '/n ' = SYLLABIC nasals (sounded without a
  vowel) — the schwa/syllabicity that surfaces as the apostrophe.
- Editors' guide: schwa apostrophe "not always written"; length applies
  to all vowels — the two underspecifications our engines fight.

## 2. wiki.migmaq.org (Listuguj team) — read 2026-07-31 (28 pages, raw cached this session)

Notation: /k/=g, /q/, /kʷ/=gw, /qʷ/=qw, /t͡ʃ/=j, /ɛ/=e.  **SONORITY
HIERARCHY** (used everywhere): obstruents (p t g gw q qw s j) < m < n < l
< w/y < vowels.  This hierarchy is the engine of the schwa + syllable
rules and is our single most reusable primitive.

### 2.0 STRATEGIC FINDINGS (the phonetics-payoff verdict, from the phonology itself)
Read against §0's targets, the wiki SPLITS the payoff exactly along the
§9.3 line — phonetics helps MATCH more than GENERATION:
- **F1 (sobering, generation).  The ×261 pm-li LENGTH bucket is
  phonetically IRRECOVERABLE.**  Vowel length is phonemic, unmarked in
  Pacifique, and NO phonological rule predicts it (minimal pairs like
  epit/e'pit differ only in length).  So the biggest pm-li miss bucket is
  a LEXICAL / COGNATE problem, not a phonetic-score win → it yields to
  MATCHING a known-length Listuguj cognate, not to a better generation
  rule.  Direct support for §9.3.
- **F2 (sobering, generation).  The orthography writes the UNPREDICTABLE
  schwa; sonority predicts the PREDICTABLE (unwritten) one.**  So the
  sonority epenthesis rule (2.1) predicts exactly the EASY cases - which
  are already the near-deterministic li-sf branches (P≈0/1) - while the
  AMBIGUOUS branches (P≈0.5: u·l·t, e·l·t, s·k) are unpredictable BY
  CONSTRUCTION.  Phonetic scoring likely does NOT rescue the ambiguous
  schwa branches.  Tempers the branch-score hope.
- **F3 (encouraging, MATCH).  Voicing allophony (2.4) IS the Rand/Metallic
  ↔ modern correspondence backbone.**  Orthographic p/t/g/j/s each cover
  a voiced+voiceless allophone pair; Rand & Metallic SPLIT them (b/d/g/z/dž
  intervocalic).  So Rand-b = modern-p etc. is a PERMISSIVENESS collapse
  for matching + a clean generation rule for the Rand-family pairs.  High
  value, low risk.
- **F4 (encouraging, MATCH).  Unwritten labialization + uvular variance
  (2.3, 2.2) are permissiveness rules.**  Final -g/-oq after u/o may be
  phonemic [kʷ]/[qʷ] (unwritten); /q/ ranges over [q ʔ χ ħ h ʕ] and across
  dialects [x ɣ].  Matching should treat these as equivalent - not a
  generation decision.
- **F5 (mixed, generation).  Uvular backing + glide environments (2.2,
  2.6) ARE better-conditioned rules** than pm-li's current heuristics -
  addressable, but "lexically inconsistent" (jagej keeps k), so a SCORE
  (probability) not a hard rule.  The one place phonetics may lift pm-li
  GENERATION (the ×58 g→q, ×79 u→w, ×76 u→o clusters).
Verdict: put phonetics into MATCH PERMISSIVENESS first (F3/F4, cheap,
high-yield); try phonetic SCORING only on the uvular/glide pm-li clusters
(F5); do NOT expect it to solve length (F1) or the ambiguous schwa
branches (F2).

### 2.1 Schwa + epenthesis [Schwa, Writing Schwa, Syllables]
- 6th vowel, NEVER long, can't be a bare-V syllable, CAN bear stress.
  Realizations: [ə], [ɨ] near coronals t/n/s, [ʉ] rare.  ([ʌ] is /a/, not
  schwa.)
- WRITTEN (apostrophe) only where NOT predictable by rule; predictable
  epenthetic schwa is unwritten.  (→ F2.)
- EPENTHESIS by sonority: word-initial CC → schwa before the MORE sonorous
  C (lmu'j→[əl.muːtʃ]); equal sonority → before the first (sgu'l→[əsː.kuːl]).
  Medial VCCV → schwa between iff C1 LESS sonorous than C2 (oqnisgwa'tu:
  q<n inserts; sgw equal → none; l/m/n count EQUAL to each other).
  Word-final CC# → insert iff C2 MORE sonorous than C1 (sign→[si.gən]).
  3+ Cs → before the most sonorous, iterate.  Geminates → schwa AFTER.
  Separate default vowel **i** is inserted BETWEEN morphemes/words (not ə).
- DELETION: a stress-skipped schwa may optionally delete (§2.7).
- MAPS TO: li-sf cluster/schwa branches; pm-li ×54 insert-e (t_m n_m =
  the tem→tm syncope the gold DIDN'T apply), ×63 e→apostrophe, ×47 delete-e.
  Rand's ŭ effectively RECORDS epenthetic-schwa positions the modern
  lanes drop (a cross-lane length/schwa oracle).

### 2.2 Uvular /k/ vs /q/ + backing [Consonants, Pronunciation of Q]
- Separate phonemes.  BACKING k→q usually after /a/ AND /o/ (wiki adds
  /o/ - pm-li's rule only has /a/); MOST when k is pre-consonant
  (alaqteget) or word-final (ala'q); LEAST intervocalically.  Lexically
  leaky (jagej keeps /k/ after a).  Animate plural -k→-q after the linking
  /a/ (ga'ta+g → gata'q).
- /o/ LOWERS to [ɔ] before /q/,/qʷ/ (elaptoq).
- /q/ allophones Listuguj: [q ʔ χ ħ h], intervocalic voiced [ʕ], final
  affricated [q͡χ]; OTHER dialects/NF: [x], intervocalic [ɣ].
- MAPS TO: pm-li ×58 g→q (undergenerated - add /o/ + pre-C/final
  weighting), ×17 q→g (overshoot - intervocalic backs LEAST, explains the
  o_u/a_a overshoot contexts), ×76 u→o & ×20 oq→ug (the /o/-before-/q/
  lowering couples vowel quality to uvularity - the measured coupling in
  §0.1 is now phonologically grounded).

### 2.3 Labialization /k/,/q/ → /kʷ/,/qʷ/ [Consonants, Pronunciation of Q]
- After /u/, sometimes /o/ (after /o/ → /qʷ/).  Usually written (gw/qw)
  but SOMETIMES NOT, especially word-finally: alug=[alukʷ], final -oq
  =[ɔqʷ].  Rich allophone set mirroring §2.2 + [w].
- MAPS TO: pm-li ×18 oqu→ugw, ×26 insert-o; and a MATCH permissiveness
  rule (final -g/-gw, -q/-qw equivalent after u/o - F4).

### 2.4 Voicing allophony [Obstruents, Consonants]
- Default voiceless UNASPIRATED (incl. word-initial - English hears b/d/g).
  Obstruent BETWEEN VOWELS → voiced: p→b t→d k→g kʷ→gʷ s→[z]/[s̬] j→dž
  (apita't→[abidaːtʰ]).  /q,qʷ/ voice only for some speakers.  j is the
  ONLY obstruent that may voice word-initially.
- Final plosives p/t/k/kʷ ASPIRATED (q/qʷ affricate instead); absent in
  Wagmatcook/Eskasoni.  Sonorant LEFT of an obstruent DEVOICES (m̥ n̥ l̥/ɬ).
- Geminates BLOCK intervocalic voicing (eteg [d] vs etteg [tt]).
- MAPS TO: the Rand/Metallic family (F3) - Rand b/d/ch/h = these voiced
  allophones; watson-sf/rand ↔ modern p↔b t↔d correspondences ARE this
  rule.  Strong MATCH permissiveness + Rand-pair generation rule.

### 2.5 Length [Sound Length]
- Vowel length PHONEMIC (a'/e'/i'/o'/u'), all 5 full vowels, schwa never;
  minimal pairs (epit/e'pit).  Consonant geminates (all Cs, written
  doubled) block intervocalic voicing + always split syllables.
  Non-contrastive phonetic lengthening of m/n/l next to Cs (optional).
- MAPS TO: pm-li ×261 (IRRECOVERABLE for generation - F1); geminate/voicing
  interaction is a Rand-pair cue (Rand doubles or not).

### 2.6 Glides /i/→[j], /u/→[w] [W and I, Vowels]
- [j],[w] are ALLOPHONES of /i/,/u/ (not phonemes).  /i/→[j] only after
  a/e/aː/eː.  /u/→[w] between vowels, initial-before-V, final-after-V,
  post-V-before-C.  Constraints: u NEVER →w before a vowel word-medially
  (stays uV); [w] only between a SHORT vowel and a C (never after long V).
  Consonantal-i orthography = "i after a vowel = /j/".
- e,o are pure monophthongs; diphthongs spelled ei, ow.  /ɛ/ tenses to
  [e] in open syllables.
- MAPS TO: pm-li ×79 u→w, ×76 (partly), the go→gw/gu heuristics (2.6
  gives exact environments to replace them - F5 generation candidate).

### 2.7 Stress [Stress]
- Weight: light = CV/V(short,non-schwa)/C+syllabic-sonorant; heavy = long
  vowel OR closed syllable.  **CəC is LIGHT** (schwa weightless).  Rules:
  (1) stress every heavy; (2) in light runs, every 2nd right-to-left; (3)
  always stress word-initial; (4) last stress = primary.  Word-final short
  vowel counts heavy.
- SCHWA INVISIBLE to stress-counting (agnutmuatl); becomes visible only
  word-initial/final or after CC.
- RELEVANCE: mostly indirect (stress conditions schwa deletion 2.1, which
  conditions what's written).  A stress model is a heavy lift for uncertain
  payoff - defer unless the taxonomy demands it.

### 2.8 Syllable structure [Syllables]
- Max 1-C onset (sole lexical exception plamu; bilinguals allow more).
  Onset clusters must RISE in sonority (else prothetic schwa: lmu'j→əl.).
  Codas fall/equal sonority (+ extra s / one final extra C).  Syllabic
  m/n/l fill nuclei.  Maximal Onset + Syllable Contact Law (coda ≥ next
  onset sonority; rising contact repaired by schwa).
- MAPS TO: the prothetic-schwa cases = pm-li ×63 delete-u (w_l ×47:
  u-prothesis family), the wsf-wli roundtrip lossy set (aqn/u-prothesis).

### 2.9 Morphophonemics [Plural Nouns, Possession, Obviation, Consonants]
- ANIMATE plural /-g/ allomorphs: -g+length after V (tmtmu→tmtmu'g),
  plain -g after n/l, -ig after mono-s / after t WITH t→j palatalization
  (e'pit→e'pijig), -ug after m (jin'm→jin'mug), -aq after labials p/gw &
  replacing aw/ow (guow→guaq), gemination after g, -g→place-assimilated qq
  after q (samqwano'q→samqwano'qq), + k→q backing (ga'ta→gata'q).
  Irregular -aq class (muin→muinaq) = Fidelholtz's underlying stem-final
  /a/.
- INANIMATE plural /-l/: plain -l; l→n assimilation after n (written nn);
  -al replacing final ew (guntew→guntal); -ul after gw.
- **t→j palatalization** before /i/ (general).  **l,t→n** adjacent to /n/
  (general).  Possession prefixes n(t)-/g(t)-/ugt- with obstruent deletion
  between identical sonorants.  VTA (V)' = lengthen stem-final V / schwa if
  C-final / drop if none.  Future = stem VOWEL REDUCTION (teluisit/tluisitew).
- MAPS TO: the MMO alternate-forms generator (workbench §5 - agoqomaw→
  agoqomaq IS -g→-q backing+labial; apaqt loc); pm-li inflected-form
  mismatches; the §2b normalization gap (gold rtl regularizes THESE).

### 2.10 Other-orthography correspondences [Spelling] — corroborates orthography-sources.md §3.1
Adds precision: H&F/FS/Lexicon all = {k for g, y for consonantal i,
schwa=ɨ}, differing only in length (apostrophe / accents áéíóú / colon).
Metallic = phonetic (splits the voicing allophones, à è ì ò ù length, ê
schwa).  Pacifique = {length unwritten, u→o, o→ô, q→g, j→tj, w→u, schwa
unwritten}.  Rand vowel map (Listuguj→Rand): a→ă a'→a/â e→ĕ e'→ā i→ĭ
i'→e o→ŏ o'→o/ō u→ŏŏ u'→oo/u ə→**ŭ** (Rand records schwa positions - a
cross-lane oracle for the unwritten schwa, per F2/2.1).

## 3. Academic layer — read 2026-07-31 (Fidelholtz 1968, Olson, Steeves 2022, Hewson 1991; PDFs cached this session)

Corroborates the wiki's F1-F5 and adds a THIRD lever (morphology) the wiki
only hinted at.  Notation: Fidelholtz uses Pacifique letters (voiced
intervocalic obstruents b d g z ǧ ǥ); he is single-speaker LISTUGUJ, the
same dialect as our target — his underlying-form logic is the most direct
predictor of inflected spellings.

### 3.1 Fidelholtz 1968 — the formal rule system (deepest source; ~60 ordered SPE rules AA-MF)
The load-bearing rules for us (his labels):
- **(AA) voicing**: obstruent → voiced between voiced segments; voiceless
  initially/finally/before-obstruent.  = wiki 2.4, F3.
- **(BA) glide formation**: u→w, i→y between vowels / before V or #; u,i
  stay vocalic between consonants; u→w feeds i→y.  = wiki 2.6, F5 — now
  formally exact.
- **(BB) final-vowel shortening + short-vowel DROP**: Micmac has NO
  word-final long vowels; final SHORT vowels delete.  ⇒ sg↔pl stems differ
  (jǝ'nǝ sg / jǝ'niǝg pl).  NEW: constrains length at word edges (a small
  bite out of F1's length problem).
- **(DI) uvularization**: g→uvular q after a grave non-diffuse vowel
  (a,o); intervocalic uvular = spirant; labialized after u/w before obs/#.
  = wiki 2.2, F5.
- **(EA) schwa insertion**: breaks clusters (between C2-C3 of a 3-C
  cluster; word-initial before two obstruents).  CRUCIAL REFINEMENT: the
  inserted vowel COPIES the quality of a following diffuse vowel (matching
  i/u), else plain ə.  ⇒ pm-li's insert-o (×26) and insert-e (×54) are
  epenthetic-vowel QUALITY COPY, not always schwa.  Minority of schwas are
  underlying (irreducible).
- **(BI) t→j / __i** palatalization; **(DM) l→n / __n**; **(DJ)
  contraction** (drop stem's first vowel, usly e, in future/imperative:
  gelitasi→litasites); **(CB) t-insertion** between prefix + vowel-initial
  ALIENABLE stem (nǝtawǝti 'my road') — the possession alternation.
- Plural/possession morphophonemics (his ch. + appendix): animate -g(⟸-q)
  / inanimate -l, both feeding final-V drop, t→j, uvularization; two
  possessive systems (inalienable vowel-copy across junction vs alienable
  t-insertion + word-boundary #).
Weakness he admits: STRESS + unstressed-vowel deletion "problematical".

### 3.2 Olson — stress (SUPERSEDES Fidelholtz), and the schwa crux
- Weight-based moraic trochees, R→L, primary = rightmost; heavy = long V
  OR coda C (glides count as coda).  = wiki 2.7.  Explicitly REFUTES
  Fidelholtz's "2nd mora from end" and Bragg's "long vowels attract
  stress".  USE OLSON where stress matters.
- BUT: stress is fully predictable from segments and NEED NOT BE WRITTEN —
  so orthography conversion can IGNORE stress.  Confirms §2.7's "defer
  stress" call: it only matters via schwa visibility.
- Schwa visible/invisible (moraic or not) MAPS ONTO Listuguj's
  written(unpredictable)/unwritten(predictable) apostrophe schwa — the
  SAME crux as F2.  Both Fidelholtz and Olson name Li↔Francis-Smith schwa
  as the single hardest conversion.

### 3.3 Steeves — voicing is a MEASURED TENDENCY, not obligatory (matters for F3)
- NF (2 speakers), consonant-focused, NO Mi'kmaq vowel/length acoustics
  (don't trust any formant/length numbers).  Adds /kʷ/; corrects the
  uvular fricative to [χ] (uvular) vs [ɣ] (voiced velar intervocalic).
- KEY: intervocalic voicing measured NON-OBLIGATORY — voiceless stops
  appear intervocalically ~8-22%, voiced obstruents appear outside V_V.
  ⇒ the Rand↔modern voicing correspondence (F3) is a SCORE / PERMISSIVENESS,
  NOT a deterministic reversible rule.  Strengthens "use it for MATCH",
  cautions "don't expect perfect generation".
- Dialect/lexeme-specific: -l plural → geminate-nasal is COMPLETE in
  Listuguj (Quinn) but INCOMPLETE in NF (sunl not sunː) — a per-lexeme
  match-permissiveness caveat, not a hard rule.

### 3.4 Hewson 1991 — verb morphology + the *-aw contraction (the MMO alt-forms link)
- Verb finals AI/II/TA/TI + theme signs (-m/-tu for TI; -a'l TA; etc.).
  II 3sg -k → -q after -a finals (= uvularization again).  AI 3sg -t after
  V, -k after C.
- THE MMO LINK: PA TA final *-aw contracts with a short vowel →long→short:
  1>3 aw-ak→aq, 2>3 aw-at→at, 3>3' aw-a:t→uat→wat; before a long vowel no
  contraction, -aw→-u→[w].  Gives wela'taq / wela'tat / wela'tuatl —
  STRUCTURALLY the 1-3/1-2/3-1 triple of the MMO alternate forms (workbench
  §5: agase'wa'latl → agase'wa'l'g / agase'wa'lul / agase'wa'lit).  ⇒ the
  MMO alt-forms are GENERATABLE by these morphophonemic rules; a generator
  validated on the 6,896 hand examples = the "measured morphology engine".

### 3.5 Cross-source verdict
AGREE (build on): voicing (voiceless underlying, voiced intervocalic —
tendency); glide u/i↔w/y by position; no final long vowels + final short
drop; schwa has no long form; k→q after a/grave.  DISAGREE: stress
(Olson wins; but irrelevant to orthography); schwa framing (Fidelholtz
epenthesis-with-quality-copy vs Olson moraic-visibility — compatible, both
name Li↔FS schwa as the crux); uvular symbol [χ]/[x]/[ɣ] (phonetic detail).

## 4. Synthesis → engine (2026-07-31, both reads in)

The reading resolves the phonetics-payoff question (§8.4 was "mixed
evidence; measure it").  The answer: phonetic knowledge splits into THREE
levers with very different cost/yield, and the naive "phonetic SCORING for
generation" idea is the WEAKEST of the three.

### 4.1 The three levers (ranked by yield/cost)
1. **MATCH PERMISSIVENESS — cheap, high yield, low risk. DO FIRST.**
   Named equivalence classes the matcher treats as non-distinguishing,
   grounded in the allophony:
   - voicing pairs p~b t~d k~g s~z j~dž (2.4/3.1-AA; a TENDENCY per
     Steeves 3.3 → permissiveness, not a rule).  This IS the Rand/Metallic
     ↔ modern axis (F3).
   - uvular/velar variance g~q + the [q χ ħ h x ɣ ʔ] span (2.2/3.3).
   - unwritten labialization: final -g~-gw, -q~-qw after u/o (2.3, F4).
   - length apostrophe optional in the source (the ×261 bucket, F1):
     matcher ignores length differences (graded lower), which is exactly
     what recovers pm-li's biggest bucket WITHOUT recovering length.
   These plug into the §9 match driver as permissiveness classes + grades;
   several already exist ad-hoc (dialectSubs g↔q l↔n, cskel).  Feeds the
   pm/rand/clark → MMO join (the import-to-MMO evidence links).
2. **MORPHOLOGICAL NORMALIZATION — high yield, higher cost. THE pm-li
   normalization gap + the MMO alt-forms generator.**  Fidelholtz's ordered
   rules (final-V drop, t→j, contraction, plural allomorphy, possession
   t-insertion) + Hewson's *-aw contraction PREDICT inflected forms.  This
   is the workbench §2 "morphological bucket (b)" and §5 "measured
   morphology engine" — now with a real rule system.  Two uses: (a)
   NORMALIZE pm-li gold rtl before scoring (separates "rules wrong" from
   "gold regularized inflection" — the poisoned-measurement fix, §8.5
   step-1 prerequisite); (b) GENERATE MMO alt-forms, validated on the 6,896
   hand examples.  COST: needs morphological analysis (stem + affix
   segmentation), a bigger machine than letter rules — not a quick probe.
3. **PHONETIC SCORING for generation — modest yield, only where the rule
   is conditioned-but-leaky.**  Only the uvular-backing (×58 g→q, ×17 q→g)
   and glide (×79 u→w, ×76 u→o, ×20 oq→ug) pm-li clusters (F5).  The
   sonority/schwa branches (F2) and length (F1) do NOT yield here.  A
   feature-conditioned SCORE (not a hard rule; "lexically leaky") over the
   sonority hierarchy + grave-vowel context.

### 4.2 What the pm-li error taxonomy (the gated next step) will now measure
Re-bucket the hand-cleaned holdout misses into: (a) LENGTH (→ lever 1,
match not generation); (b) UVULAR/GLIDE conditioned (→ lever 3, phonetic
score); (c) MORPHOLOGICAL normalization (→ lever 2, or exclude as gold-
regularized); (d) irreducible.  PREDICTION from the clusters (§0.1):
length dominates (a), so the taxonomy likely says "the pm-li generation
ceiling is real; spend the phonetics on MATCH + MORPHOLOGY, not on a
generation scorer."  If so, the branchRule/score engine (§8) is DEFERRED
in favour of (i) match permissiveness classes and (ii) a morphological
normalizer — a different build than we'd have started speculatively.

### 4.3 Reusable primitives to encode (when we build)
- the SONORITY HIERARCHY (obstruent<m<n<l<w/y<V) — drives schwa +
  syllable + permissiveness.
- a FEATURE map per grapheme (place, manner, voice, grave/diffuse, long) —
  the substrate for both permissiveness classes and F5 scoring.
- Fidelholtz's ordered morphophonemic rules AA/BA/BB/BI/DI/DJ/EA + Hewson
  *-aw — the morphological normalizer/generator (lever 2).
Keep the I4/I5 legibility bar: encode these as DATA (feature tables +
named ops) a linguist can read, not closures.  This is where the §8.2
match/produce/score decomposition earns out — permissiveness classes and
feature-scored branches are exactly (match, produce, score) with a
phonetic score/scorer.

### 4.4 Open items / caveats
- Length recovery (F1) may partly come from CROSS-LANE cognates: Rand's ŭ
  records schwa positions, and a Listuguj cognate carries length — a
  MATCH-time disambiguation, not phonetics.  Worth a measurement.
- Steeves: voicing is only ~80-92% intervocalically → permissiveness, not
  reversible generation.  Don't over-trust.
- Stress: predictable, need not be written, IGNORE for conversion (Olson).
- Raw sources cached this session only (scratchpad/migmaq/, scratchpad/
  phon/); re-fetchable via the agent prompts if needed.  The rules above
  are the durable record.
