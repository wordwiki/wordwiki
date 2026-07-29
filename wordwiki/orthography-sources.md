# Mi'kmaq orthography sources (research inventory, 2026-07-29)

Collected for the transliteration/comparison research push (language-level
knowledge, not just letter transforms).  Each source: where it is, what it
authoritatively documents, and how it feeds the pair engines.

## 1. In-project sources (captured)

### 1.1 "Ta'n Tala'ql Mi'gmawe'l" — the language editors' pronunciation guide
File: `wordwiki/Ta'n Tala'ql Mi'gmawe'l.html` (from a previous version of this
project; dropped in by dz 2026-07-29).  THE authoritative modern key, made by
the language editors themselves.  Contains a Listuguj / Francis-Smith / IPA /
articulation table with 3-5 example words per phoneme (each with a .wav link —
audio not present in the file drop, only the HTML).

Consonants (Listuguj = FS unless noted):
- p, t, s, m, n, l, w identical in both.
- Listuguj g = FS **k** (velar plosive; IPA g in the table — the editors treat
  voicing as non-contrastive).
- q = q (uvular plosive), gw = FS **kw**, qw = qw (labialized).
- j = j (voiceless palatoalveolar affricate).
- FS **y** (palatal approximant, IPA j) has an EMPTY Listuguj cell — Listuguj
  writes the glide with i/vowel letters (example words: yap ~ atlayg ~
  atnamkewey).  A real many-to-one hazard for li↔sf.
- Vowels i e a o u same letters both systems; IPA e=ε, a=ɑ.
- i' etc.: apostrophe = length, "applies to all vowels" (IPA i:).
- ' alone = schwa (ə), "**not always written**" — the editors' own statement
  of the pm-li normalization headache, in the modern lane itself
  (pans'g, n'mi', esp'pit; note the /edêliadêl/ pronunciation gloss).

### 1.2 Rand 1888 "KEY TO THE PRONUNCIATION" — Rand scan page 6
`wordwiki.pages.pageEditor("Rand", 6)`.  The printed key for the rand
dictionary's own orthography (watson-sf source conventions descend from it):
- Consonants "as in English"; g always hard; **c exactly like k**; ch as in
  church; **h after a vowel in the same syllable = soft guttural** (German
  *ich*) — i.e. the uvular/velar fricative that Listuguj writes q/g.
- Vowel table (English keyword values):
  a *father*, ā *fate*, ă *fat*, â second a in *abaft*, e *me*, ĕ *met*,
  ei = i in *pine*, ĭ *pin*, o *no*, ŏ *not*, u *tube/use*, ŭ *tub*,
  oo *fool/move*, ŏŏ *good/wood*, ow *now*.
- Doubling (aa, āā, ee) or ō = the sound **prolonged**.
- Accent: default on the **penult**; marked when elsewhere; a prolonged vowel
  (aa, āā, ee, ō, oo') always takes the accent; nn word-final = prolonged n;
  **'m, 'n word-initial = sounded without a vowel** (the syllabic nasals —
  cf. Listuguj initial apostrophe-consonant words).

### 1.3 Clark 1902 "Alphabet" — Clark scan page 8
`wordwiki.pages.pageEditor("Clark", 8)`.  Clark's simplified re-transcription
key (the clark dictionary lane):
- a *hat*, ā *hate*, â *law*, e *ever*, ē *easy*, i *hit*, ī *hide*,
  o *not*, ō *note*, ô *hotel* (as *moobin*), oo *food*, u *tub*, ū *bugle*.
- NOTE the English keyword values differ from Rand 1888: Clark a = Rand ă,
  Clark e = Rand ĕ, Clark i = Rand ĭ, Clark ī = Rand ei, Clark o = Rand ŏ,
  Clark ō = Rand o, Clark u = Rand ŭ, Clark ū = Rand u.  A mechanical
  clark↔rand diacritic mapping EXISTS but the letter values are shifted —
  this is the measured "not a mechanical reversal" from the clark import,
  now explained by the two keys.
- Consonants as in English; **kw the one "explosive"**; **tc = ch** (Powell's
  Smithsonian alphabet); **no c, its place taken by k** (vs Rand 1888 which
  kept c=k).
- Clark's preface (scan pages 9-12): Rand's manuscript was "in a chaotic
  condition, written hurriedly, in **three alphabets**"; Clark normalized it,
  cross-checking with Baraga (Ojibwe) and Lacombe (Cree) dictionaries; he
  warns of errors "not to be explained away by differences in dialect".
  => The clark lane is a normalization of THREE underlying Rand-era systems;
  residual inconsistency in clark is expected and measurable.

### 1.4 Rand 1875 First Reading Book key — RandFirstReadingBook scan page 7
`wordwiki.pages.pageEditor("RandFirstReadingBook", 7)` (printed page 6):
- "In Micmac there are **no silent letters**, and each letter is invariably
  sounded **one way**: the consonants c and g being always hard; ch as in
  church; and the rest exactly as in English."
- Vowel scale identical in spirit to the 1888 key: a *father*, ā *fate*,
  â *abaft*, ă *fat*, e *me*, ĕ *met*, ĭ *pin*, o *note*, ŏ *not*, u *bugle*,
  ŭ *tub*, oo *fool/move*, ŏŏ *good/wood*, ei *pine/height*, ow *cow*,
  āoo = dipthong (footnote: coon-dāoo 'a stone', kāoo-che 'I am cold').
- Same doubling/penult-accent rules stated.  (o = *note* here vs o = *no* in
  1888 — same value, different keyword.)
- The book itself is a graded SPELLING DRILL corpus (syllable lists visible
  on scan p7's facing page: ān, ās, āk, āt, ăp, dā...) — a phonotactics
  gold-mine: every attested syllable shape in Rand's system, in order.

### 1.5 Pacifique's Geography (Etudes Historiques et Geographiques)
No orthography key in the front matter (checked scan pages 1-8; it is the
historical-studies volume).  Value here: "Le Pays des Micmacs" chapters
(printed pp. 175-294) = hundreds of PLACE NAMES in Pacifique's orthography
with French glosses — a proper-noun corpus for the pm lane where many
targets are independently known (modern place names, rand's place-name list
in Clark's appendix).  Pacifique's actual orthography exposition is in his
1939 grammar (see web sources).

### 1.6 The PDM manuscript itself
The hand rtr/rex/rtl/rse/rne tags on the gold pages (the researchers' own
readings) are the largest in-project pm↔li corpus (~1,000 headword pairs
extracted by pdmRefCorpus in mikmaq/transliterate-pairs.ts; the full tag set
is richer — inflected forms inside rex runs).

## 2. Derived observations for the pair engines

- Rand/Clark keys pin the SOURCE VALUES of the diacritic vowels — the
  wsf/wli lanes' letter semantics are now documented, not inferred.
- Rand h-after-vowel = guttural: watson-sf 'h' should map toward Listuguj
  q/g in coda position, not be dropped.
- Rand 'm/'n initial syllabics ↔ Listuguj apostrophe-initial words: a direct
  rule candidate for wsf→mmli.
- The FS y ↔ Listuguj (no letter) cell is an attested many-to-one: li→sf
  needs glide INSERTION knowledge (vowel-context), sf→li deletion.
- The editors' own "' not always written" for schwa legitimizes candidate
  patterns (optional schwa) over single-answer transforms — pmLiPattern's
  optional-apostrophe approach matches the editors' description of the
  modern lane itself.
- Clark = normalization of three Rand-era alphabets → treat clark-internal
  inconsistency as data (cluster by which underlying alphabet a page/entry
  came from?), not noise.

## 3. Web sources (2026-07-29 research pass; two agent sweeps, cross-verified)

### 3.1 Correspondence tables (the seeds for pair rules)

- **Mi'gmaq Wiki "Spelling"** — https://wiki.migmaq.org/index.php?title=Spelling
  — THE best extant correspondence source (snapshot it; it is a wiki).
  Pairwise tables Listuguj-vs-each: FS (g=k, cons. i=y, '=ɨ, length
  apostrophe/acute), Lexicon (as FS but length = colon), **Metallic**
  (writes allophonic voicing p/b t/d k/g kw/gw ch/j; graves à è ì ò ù for
  length; ê schwa; y glide), **Pacifique** (length unmarked; li u=pac o;
  li o=pac ô; q=g; j=tj; w=u; schwa unwritten), **Rand** (j=ch; g=c/k;
  p=b~p; q=h; t=t/d; cons i=y; a=ă, a'=a/â, e=ĕ, e'=ā, i=ĭ, i'=e, o=ŏ,
  o'=o/ō, u=ŏŏ, u'=oo/u, schwa=ŭ — "differences in Rand's vowels are too
  numerous to list").  Also Hewson&Francis system: doubled consonant =
  consonant+apostrophe.
- **Wikipedia "Mi'kmaq language"** (writing systems section; mirrored on
  Wikiversity/Wikibooks) — the 5-way IPA table (FS/Listuguj/Lexicon/
  Pacifique/Rand).  Convenient seed but weakly cited; at least one dubious
  Pacifique cell (x→"s"); our §1 primary keys outrank it where they
  conflict.
- **wiki.migmaq.org phonology pages** (Consonants, Schwa, Writing_Schwa,
  Sound Length, Stress, plus morphology: Plural Nouns, Possession,
  VAI/VII/VTA/VTI, Preverbs, Obviation) — rule-level statements we need:
  velar/uvular /k kʷ/ vs /q qʷ/; obstruents voiced between vowels;
  **k→q backing "usually after /a/ and /o/", lexically inconsistent**;
  **k,q→kw,qw labialization after /u/**; schwa = the only always-short
  vowel, epenthetic, stress-invisible, optionally deleted; Listuguj i
  doubles as glide /j/ after a vowel (no y).  These are exactly the
  alternations visible in the MMO alt forms (§2: agoqomaw→agoqomaq,
  apaqt→apagtug/apaqtuk).

### 3.2 Pacifique primary texts (digitized, free)

- **Leçons grammaticales 1939 — BAnQ serves the FULL SCAN as a plain
  PDF, no login**: https://collections.banq.qc.ca/bitstream/52327/2636114/1/5013302.pdf
  (33.8 MB, 262 pp).  Embedded OCR layer is garbage — treat as page
  images; fits our scan→extract pipeline.  IMPORT CANDIDATE #1.
- **Hewson & Francis 1990 translation** ("The Micmac Grammar of Father
  Pacifique") — archive.org borrowable (micmacgrammaroff0000paci); an
  unofficial full PDF exists (vdoc.pub; gray legality — the borrowable
  copy or the in-print CBU 2016 edition are the clean paths).  **A
  Rosetta stone: Pacifique's forms retranscribed into modern orthography
  throughout** (e.g. oigo£g → wi'kue'k; non-syllabic o→w; tj→j;
  Pacifique e covers modern e'/e/i; final -l triply ambiguous
  [l]/[el]/[e'l] because schwa/length/syllabics are unwritten).
- **Le Messager Micmac** — Canadiana serial oocihm.8_06792: 48 digitized
  issues (1908-1920) of running Pacifique-orthography text.  Bulk pm
  corpus for phonotactics/language-model priors.
- **Prayer books/catechisms** (bulk pm text): Paroissien 1903
  (oocihm.79655, full PDF download), catéchisme 1910 (archive.org
  cihm_72699), Sacred History 1911/21, hymns 1906, almanac 1902 — all
  free scans.
- **Pacifique's own manuscript dictionary** (fonds Capucins, BAnQ
  Rimouski; vols on BAnQ numérique, e.g. item 3216687) — the same
  material family as our PDM scans.
- Études historiques et géographiques: NO verified scan (BAnQ catalog
  record exists; manual browser check needed).  We have our own scan
  in-project anyway (§1.5).

### 3.3 Rand/Clark digitizations + the three-alphabets question

- Rand 1888 dictionary: archive.org dictionaryoflang00rand (best scan,
  ~99% OCR).  Rand 1875 First Reading Book: firstreadingbook00rand —
  **bound with the 1871 Micmac Matthew** (one scan, two texts).  Clark
  1902: NOT on archive.org; Canadiana oocihm.72690 (free full view +
  PDF).  Rand/Clark Place-Names 1919: oocihm.81895.
- **Rand's three alphabets, confirmed** (Clark, *Rand and the Micmacs*
  1899 — archive.org cihm_00663 / Gutenberg #50454): (1) Pitman
  SHORTHAND (the ~1000-page manuscript word-lists Clark transcribed);
  (2) Pitman's English Phonotypic Alphabet (earliest imprints: 1853
  Matthew); (3) the later English-values Roman orthography with
  breve/macron diacritics (1871 NT, 1875 reader, 1888 dictionary — our
  §1 keys).  Large scripture corpus in (3) free on archive.org/
  Canadiana (index: onlinebooks.library.upenn.edu, Rand author page).
- No dedicated academic paper on Rand's orthographies exists; the
  community wiki tables are the only published Rand→modern mappings.

### 3.4 Phonology/morphology scholarship

- **Fidelholtz 1968, *Micmac Morphophonemics*, MIT PhD, 799 pp** —
  dspace.mit.edu/handle/1721.1/13001.  The deep generative treatment of
  schwa/stress/voicing alternations.  (His 1976 orthography-design paper
  for the 7th Algonquian Conf. is NOT freely available.)
- Erin Olson (McGill), Listuguj stress/schwa paper (Algonquian Papers,
  free PDF via ojs.library.carleton.ca).  Same research group as
  wiki.migmaq.org.
- Hewson: "Verbal Derivation in Micmac" (JAPLA, free), "Some Micmac
  Etymologies" (free); his 1994 Maillard analysis is paywalled.
- Steeves, Newfoundland Mi'kmaq phonetics thesis (Memorial, free PDF) —
  dialect variation data.
- Maillard/Bellenger 1864 Grammaire — archive.org grammairedelalan00mail
  (free): French-based values, ȣ ligature for ou, italic h = aspiration.
  ("Abbé Legoyne" from Rand's preface is likely garbled; the real chain
  of Roman-orthography documenters is Maillard → Rand → Pacifique.)
- Hieroglyphics (komqwejwi'kasikl): Kauder 1866 (archive.org), Pacifique
  1921 re-edition (manueldeprires00kaud), Yale 1825 ms with interlinear
  Roman transliteration (openly downloadable).  Out of scope for pairs;
  recorded for completeness.

### 3.5 Prior-art software — mine these

- **OrthoConverter** https://mikmawconjugator.com/convert — existing
  converter between FS/Listuguj/Pacifique/Rand/Lexicon/Metallic.
- **Conjugator** (same author, open source Go:
  github.com/wilmil123/conjugator) — procedural verb-paradigm
  generation (the alternate-forms generator problem, §2 of the
  alternate-forms discussion).  Author's documented finding:
  FS↔Listuguj converts losslessly; **Pacifique input is excluded
  because schwa is unrepresented** — independent confirmation that
  pm→modern is the lossy direction requiring reconstruction (our
  candidate-pattern approach).
- mikmaqonline.org's Pacifique Dictionary Manuscripts transliteration
  effort, as described on the public site, IS this project — noted here
  because outside observers see it as the reference effort for
  pm→Listuguj.

### 3.5b CAPTURED 2026-07-29 (external-container fetch; mikmaq-fetch-results/, gitignored)

The browser-bridge fetch run landed these locally (NOT committed — raw
drop; import deliberately via the scan pipeline):
- **Hewson & Francis 1990 grammar** — full 588-page PDF ("The Micmac
  Grammar of Father Pacifique …").  Image-only scans (no text layer);
  MINING ITS RULES = next step, needs page extraction / the scan
  pipeline (this container has no pdf splitter/OCR).  THE pm→modern
  Rosetta stone.
- **Pacifique, Le pays des Micmacs / Études historiques** — 382-page PDF
  (banq-paysdesmicmacs_5012884.pdf).  The one work we previously had no
  verified scan of, now captured (we also have our own PacifiquesGeography
  scan in-project).
- **1853 Micmac Gospel of Matthew** — 131-page PDF.  The only accessible
  specimen of Rand's Pitman-phonotypic alphabet (his #2 of three).
- **BONUS: Pacifique's own MANUSCRIPT DICTIONARY, vols III & IV** —
  396 page-images @ 3000px (BAnQ IIIF; vol3/ 202 + vol4/ 194).  Pacifique's
  handwritten dictionary — the SAME manuscript family as the PDM scans.
  Potential future dictionary-import material; IIIF re-fetch recipe in
  RESULTS.md.  (BAnQ formally collaborates with the project; official
  high-res masters come later by courier.)
- Sci-Hub Hewson 1994 (Maillard): NOT obtained (bot-wall + safety
  classifier blocked automation both in- and out-of-container); dz getting
  a paper copy via U. Waterloo library.

### 3.6 Import shortlist (free full scans, priority order)

1. Pacifique Leçons grammaticales 1939 (BAnQ direct PDF) — the core pm
   reference; re-read via our pipeline.
2. Hewson & Francis 1990 (clean path: borrow/buy) — the pm→modern rule
   statement + aligned examples.
3. Le Messager Micmac serial (Canadiana) — bulk pm running text.
4. Paroissien 1903 + catéchisme 1910 — more pm text, cleanly printed.
5. Clark, *Rand and the Micmacs* 1899 — the three-alphabets testimony.
6. Maillard 1864 Grammaire — the 18th-c. layer, if we ever bind
   Maillard-era texts.
7. Snapshot of wiki.migmaq.org Spelling + phonology pages.

### 3.7 Gaps

- Fidelholtz 1976 (orthography design), Hewson 1994 (Maillard), Metallic
  dictionary front matter: not freely accessible; Metallic conventions
  known only second-hand (wiki).
- No Listuguj education-directorate orthography guide on the open web;
  wiki.migmaq.org is the de-facto documentation.
- HathiTrust items unverified (automated fetches blocked).
