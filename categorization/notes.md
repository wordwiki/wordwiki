# Survey notes — full read of entries.jsonl (8,822 entries, 2026-06-11)

*Updated 2026-07-01 for the v2 pass: the tagging conventions below use v2
category slugs (see scheme.md). Survey/linguistic sections are from the v1
read and remain valid.*

Observations from the complete read-through that drive the scheme design and
the tagging conventions. (Working notes; the reviewable artifact is scheme.md.)

## Corpus shape
- ~7,800 entries have usable English (gloss and/or translation); 714 have
  neither — most of those are Archived or the recent in-process tail.
- 738 Archived (incl. Archived-Incomplete / Not-A-Word): tagged like everything
  else but separated in review views; they don't deserve deep attention.
- The high-entry-id tail (~600 entries, ids > 10^13, recent editor work) is
  full of placeholders: headword `#<id>`, gloss `?`, `TBA`, "crossed out
  entry". These get `flag: needs-human` and no categories.
- Recent entries show editors inventing categories ad hoc: structure vs house,
  clothes vs clothing, number vs numbers, behavior vs behaviour, fishing,
  medicine, paper, Tradition, Speed, `poosition`. The fixed scheme replaces all
  of these.

## Linguistic character (matters for consistent tagging)
- Polysynthetic: one root yields a family of 4-15 derived entries
  (vai/vii/vat/vit forms, plus nominalizations). RULE: a derivational family
  shares its primary category; the verb-class suffix never changes category.
- Directional prefixes are grammatical, not topical: al- (about), el- (toward),
  ejigl- (away), enm- (homeward), wejgw- (toward speaker), pem- (along),
  apaj-/apat- (back), nis- (down), so'q-/toqju- (up), eset- (backward),
  asoqom- (across), saput- (through), gesgij- (over), giwto'q- (around),
  nipi- (at night), naqs- (quickly), mesta- (everywhere/completely).
  "run up the hill" is still movement; "hunt at night" is still hunting.
- Big systematic series seen: metew- (heard X-ing) → hearing; "have such/big/
  small BODYPART" → body; "clean BODYPART" → body+cleaning; nuji- (professional
  X-er) → occupations; house-by-material series (stone/log/birch/thatched ×
  has/lives-in/builds/resembles) → dwellings; numbers-with-classifier forms
  (five-globular-objects) → numbers.
- PTCL part of speech ≈ function words (and, but, perhaps, not-yet) → the
  small-words category, NOT topical categories.

## Old scheme diagnosis (264 values, 10,998 taggings)
- Typo/spelling dupes: behaviour/behavior, spirituality/spiritually/spiritualty,
  appearance/'appearance ', structure/structrue, position/poosition, Water,
  Speed, Tradition, clothes/clothing, body/body part, number/numbers, place.
- Junk: `_` (232), `not classified` (71), `p` (1).
- Verb-gloss-as-category tail: knit, sew, weave, peel, smother, blow air,
  point, settle... — fold into broader action domains.
- Genuinely good big domains worth keeping (renamed): body, motion, water,
  food, time, weather, kinship, fish, bird, tree, plant, game, fire...

## Tagging conventions — v2 (the rules of the pass; accrete new ones here)

### Core rules
- 1-3 categories per entry. Prefer 1 strong over 3 weak.
- **Categories are ORDERED, most pertinent first.** The first category is the
  one whose related-words list best serves a learner on this word's page —
  usually the most specific applicable category. Specific beats broad when
  both apply (basket-making before household; occupations before work;
  calendar before time). The public UI leads with the first category and many
  users see only it.
- Categorize the ROOT meaning; manner/direction/time-of-day prefixes don't
  add categories (exception: genuinely bi-domain words, e.g. "paddle at
  night" is boats; "hunt at night" is hunting).
- A derivational family shares its primary category; the verb-class suffix
  never changes the category. Tag family-at-a-time (dictq.py family STEM).
- Examples are weak evidence: never let an example's incidental content
  (names, days) attract a category.
- v1 assignments (shown in the batch view) are good evidence but were made
  against the v1 scheme — re-decide, don't copy, wherever a v1 category was
  split, renamed, or dissolved (see the mapping in v2-instructions.md).
- Entries whose only English is `?`/TBA/empty → flag needs-human, cats [].
- Archived entries: tagged normally (cheap), separated in views.

### Faith / traditional stories / spirits (elder-reviewed; get these right)
- God, Creator, Great Spirit (Nisgam, Gisu'lgw, Gjinisgam, Mestagisiteget),
  Jesus, Virgin Mary, saints, angels, heaven, hell, purgatory, devil/Satan,
  soul, holy/blessed, sin-as-concept, resurrection, salvation, end of the
  world → faith. NEVER traditional-stories or spirits.
- Mass, prayer, sacraments, confession, communion, Lent, priests/nuns/bishops,
  churches, altars, holy water, church weddings → church-rituals.
- Glusgap, jenu, gu'gwes, little people (pugulatmu'j, wiglatmu'j,
  tmigalmji'j), horned serpent, Thunderer, Tune'l, wild man, mi'gmuessu
  → traditional-stories. These are core cultural figures, not entertainment:
  never describe them as "legendary"/"mythical" in notes or review text
  (entry glosses are the editors', not ours to change).
- Generic storytelling craft (a'tugwaqan 'story', a'tugwet 'tells a story',
  storyteller words) → stories-and-writing; a story ABOUT the figures above
  or naming them → traditional-stories.
- Ghosts, apparitions, spirit/shadow, shamans (puowin), spells/hexes/charms,
  fortune-telling, premonitions, stage magic and illusions → spirits.
- mjijaqamij-family (spirit|soul|shadow) → faith first, spirits second.
- Death words: dying, the dead, mourning, consoling, wakes/vigils, coffins,
  hearses, graves, pallbearers → death-and-mourning first; funeral masses and
  church burial rites also church-rituals.

### Dissolved-customs homes (elder-reviewed)
- Quills, quillwork, quill boxes, beads, beadwork, wampum-as-bead
  → quillwork-and-beadwork. Wampum-as-record/treaty → leadership-and-law.
- Tobacco, pipes, cigarettes, snuff, chewing, lighting up, smoking
  → tobacco-and-smoking (everyday and traditional alike).
- Waltes and its gear → games. Council fire, clan, totem → leadership-and-law.
- Mi'gmaq hieroglyphics → stories-and-writing. Sweetgrass → plants.
- Marriage-permission words (asking parents) → family.
- Feasts → social-life (+food or church-rituals by sense).
- Dancing/singing native style → music-and-dance. Moccasins → clothing.

### Split-category boundaries
- Body: the parts themselves → body-parts; "have such/big/small X", bearded,
  freckled, bald, skinny, naked, left-handed → body-descriptions;
  "clean BODYPART" → cleaning + body-parts.
- Motion: deictic/path (go, come, return, leave, follow, flee, wander, going
  about) → going-and-coming; manner (run, jump, crawl, climb, tiptoe,
  stagger, slide, glide, spin, shake) and speed (hurry, rush, slow, stop)
  → ways-of-moving.
- People's postures (sit, stand, lie, lean, kneel) → posture; things
  placed/sitting/standing somewhere, scatter/spread/stack/pile, hidden
  things, things in the way → putting-and-placing. (-pit/-teg with an
  inanimate subject is usually putting-and-placing; a person holding a pose
  is posture.)
- Emotions: love, liking, happiness, comfort, laughing → love-and-joy;
  fear, anger, sadness, crying, worry, longing/homesickness, jealousy,
  shame, surprise → fear-anger-sadness.
- Health: being sick, pain, wounds, bleeding, disease names → sickness;
  healing, medicine, remedies, nursing, recovering → healing (doctor the
  person → occupations + healing); death/mourning per the faith section.
- Water as stuff/state (wet, dry(ing), soak, drip, splash, pour, ice,
  freeze-over, thaw) → water; bodies of water and their behaviour (sea,
  river, lake, tide, current, wave, shore, spring, flowing) → sea-and-rivers.
- Character traits (lazy, brave, stingy, polite, conceited, boastful,
  skilled/awkward/unable) → character; lying, cheating, stealing, deceiving,
  tricking → wrongdoing.

### Accreted during the v2 tagging pass (2026-07-01)
- want-words and need-words ("wants to...", "has need for") → thinking (conf m).
- nuta'q / "missing, lacking, short of" → amounts.
- Dogs and cats (incl. puppies, kittens, house dogs) → farm-animals (domestic),
  not animals; wild canids/felids stay in animals.
- drunk/tipsy/intoxicated → condition (m); "likes to drink" → character (m).
- nuji- occupation nouns → [occupations, domain] — EXCEPT fortuneteller and
  magician/illusionist → [spirits, occupations] (the spirits page serves them).
- Speak-X-language family (lnui'sit, wenjui'sit...) → [talking,
  peoples-and-nations], talking first.
- Wakes/vigils (ni'pa'pit, nipapultimg) → death-and-mourning; funeral mass
  → [death-and-mourning, church-rituals] (death first, per the death rule).
- The aniaps- penance family → church-rituals (m where the gloss is the
  secular "suffers the consequences").
- House-by-material series (stone/log/birch/thatched/spruce-bark ×
  has/lives-in/builds/resembles) → dwellings, one cat.
- Rainbow → [sky, weather]; northern lights → sky; wind/gales → weather.
- -pit/-teg "in the way / hindrance" entries → putting-and-placing
  (animate posture readings keep posture too).
- Grammatical-prefix notes and no-English placeholders → cats [],
  flag needs-human (never guessed).

### Carried over from v1 (still in force, v2 slugs)
- Body-part-description verbs ("have big hands", "red-haired") → body-descriptions.
- "heard X" (metew-) → hearing, plus X's domain when strong.
- Sound-making (holler, cackle, chime) → hearing.
- Occupations: the nuji-/-winu person-nouns → occupations (+domain);
  the underlying activity verb stays in its domain.
- Particles with topical content (time words: apjiw 'always'; place words:
  gigjiw 'near') go in their topical category, not small-words.
- Proper-noun places → places; nationality/people-group nouns → peoples-and-nations.
- decorate (generic) → making-and-fixing; embroidery/crochet/sewn decoration
  → sewing-and-textiles; quill/bead decoration → quillwork-and-beadwork.
- rub/smear/massage → smell-and-taste (touch); medicinal rubbing also healing.
- caring-for/helping/meeting/forgiving → social-life.
- hide/conceal (make unseen) → seeing; hidden-position also putting-and-placing.
- lock/unlock/key → fastening.
- stuck/loose/tipsy/fragile → condition.
- punish → leadership-and-law; revenge/instigate-harm → conflict.
- floating (people/things on water) → swimming; gliding in air → ways-of-moving.
- anchors/sails/ferries → boats.
- breakfast/supper words → food (+time).

## Category-sweep audit — v1, historical (pass 3, 2026-06-11)

Each audited category was re-read as a complete member list
(`dictq.py members CAT`) looking for misfits. Fully swept: all 6 Places &
Little Words categories, learning-and-teaching, basket-making, sky,
insects, swimming, peoples-and-nations, leadership-and-law, conflict,
appearance, thinking, stories-and-writing, family, people, social-life,
character, emotions, smell-and-taste, hearing, seeing, talking, work,
occupations, making-and-fixing, good-and-bad, condition, amounts, customs,
ceremony, spirit-world, games, music-and-dance, age, time — i.e. every
category whose boundary needs judgment (38 of 85, ~6,400 of ~12,600
membership rows). Result: 6 corrections appended (rate ~0.1%), no
systematic drift found.

The remaining categories are concrete object/action classes (body parts,
animals, birds, numbers, colors, foods, weather, the physical-action verbs)
tagged under the explicit conventions above; their membership is
self-evident from the gloss, and the team review views are the final check
on them.
