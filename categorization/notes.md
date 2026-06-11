# Survey notes — full read of entries.jsonl (8,822 entries, 2026-06-11)

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

## Tagging conventions (accrete here as decisions come up during the pass)
- 1-3 categories per entry, primary first. Prefer 1 strong over 3 weak.
- Categorize the ROOT meaning; manner/direction/time-of-day prefixes don't
  add categories (exception: genuinely bi-domain words, e.g. "paddle at
  night" is boats; "hunt at night" is hunting).
- Examples are weak evidence: never let an example's incidental content
  (names, days) attract a category.
- Body-part-description verbs ("have big hands", "red-haired") → body.
- "heard X" (metew-) → hearing-and-sounds, plus X's domain when strong.
- Sound-making (holler, cackle, chime) → hearing-and-sounds.
- Occupations: the nuji-/-winu person-nouns → occupations (+domain);
  the underlying activity verb stays in its domain.
- Particles with topical content (time words: apjiw 'always'; place words:
  gigjiw 'near') go in their topical category, not small-words.
- Proper-noun places → places; nationality/people-group nouns → peoples.
- Entries whose only English is `?`/TBA/empty → flag needs-human, cats [].
- Archived entries: tagged normally (cheap), separated in views.

## Conventions accreted during the tagging pass
- scatter/spread/stack/pile (placing things in space) -> position
- decorate (generic) -> making-and-fixing; embroidery/crochet/sewn decoration -> sewing-and-textiles
- rub/smear/massage -> smell-and-taste (touch); medicinal rubbing also health
- laughing/crying -> emotions (+body-actions when strongly physical)
- caring-for/helping/meeting/forgiving -> social-life
- capability words (skilled/awkward/unable) -> character
- hide/conceal -> seeing (visibility); hidden-position also position
- lock/unlock/key -> fastening
- stuck/loose/tipsy/fragile -> condition
- punish -> leadership-and-law; revenge/instigate-harm -> conflict or character
- floating (people/things on water) -> swimming; gliding in air -> movement
- anchors/sails/ferries -> boats
- "in the way"/hinderance -> position
- breakfast/supper words -> food (+time)

## Category-sweep audit (pass 3, 2026-06-11)

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
