# Similarity pass 1a (language rules v3): 'rand' -> 'dict'

- pairs: 99651
- same-word: 4006 (4.0%)
- related: 15415 (15.5%)
- unrelated: 70376 (70.6%)
- ambiguous: 9854 (9.9%)
- REFERRAL BAND (ambiguous -> the LLM judge, if funded): 9854 pairs
- spelling grades (orthoMatch): exact 4778 / candidate 1 / skeleton 1125 / none 93747

## Rule firings
- single-common-token: 70376
- possible-synonym: 9926
- near-skel-only: 5138
- exact-skel+disjoint-defs: 3728
- weak-root-family: 2252
- exact-skel+def-overlap: 1977
- root-family: 1855
- near-skel+def-overlap: 1290
- multi-def-overlap: 1046
- rare-def-only: 653
- dialect-sub+def-overlap: 346
- cskel+missing-defs: 335
- exact-skel+missing-defs: 203
- lexicon-root: 194
- cskel+def-overlap: 190
- same-stem: 130
- diminutive: 12

## same-word (sample)
- **pesgunateg_te'sinsga'q** -> **pesgunateg_te'sinsga'q** [high; exact-skel+def-overlap]
- **piliganelsegnigniganig** -> **piliganlsegni'ganiganig** [medium; near-skel+def-overlap]
- **elsegnignji'jganuapt'g** -> **elsegeni'ganji'jiganuapt'g** [medium; cskel+def-overlap]
- **wejgwimaqamigewa'sit** -> **wejgwimaqamigewa'sit** [high; exact-skel+def-overlap]
- **elsegnignjijignmig** -> **elsegeni'ganji'jiganamu'g** [medium; cskel+def-overlap]
- **elsegnignji'jiganamu'g** -> **elsegeni'ganji'jiganamu'g** [medium; near-skel+def-overlap]
- **ugumuljinte'sijig** -> **ugumuljin te'sijig** [high; exact-skel+def-overlap]
- **elsegnignji'jigana'q** -> **elsegeni'ganji'jigana'q** [medium; near-skel+def-overlap]
- **elsegnignjijiganig** -> **elsegeniganji'jiganig** [medium; near-skel+def-overlap]
- **masgwesimanaqsi** -> **masgwe'simanaqsi** [high; exact-skel+def-overlap]
- **t`pgwantimg** -> **T'pgwantimg** [high; exact-skel+def-overlap]
- **wejgwinisaqa'sit** -> **wejgwinisaqa'sit** [high; exact-skel+def-overlap]
- **tetmns`gani'gan** -> **tetmns'gani'gan** [high; exact-skel+def-overlap]
- **nipinigatne'get** -> **nipinigatne'get** [high; exact-skel+def-overlap]
- **wejgwinisaqa'sit** -> **wejgwinisaqa'sit** [high; exact-skel+def-overlap]
- **tetmns`ganigana'q** -> **tetmnsegani'gana'q** [medium; near-skel+def-overlap]
- **newtugwalugwet** -> **newtugwa'lugwet** [high; exact-skel+def-overlap]
- **ewlamugwa'teget** -> **ewlamugwa'teget** [high; exact-skel+def-overlap]
- **wejgwimusga'sit** -> **wejgwimusga'sit** [high; exact-skel+def-overlap]
- **wejgwimusga'sit** -> **wejgwimusga'sit** [high; exact-skel+def-overlap]
- **tetmns`ganmit** -> **tetmns'ganmit** [high; exact-skel+def-overlap]
- **oqol'mgwetesing** -> **oqolomgwetesing** [high; dialect-sub+def-overlap; ɨ<->o]
- **tmgwatignej** -> **tmgwatignej** [high; exact-skel+def-overlap]
- **tmgwatignej** -> **tmgwatignej** [high; exact-skel+def-overlap]
- **telipgitgatg** -> **telipgitqatg** [high; exact-skel+def-overlap]

## related (sample)
- **pemnigalalt** -> **pemn'galatl** [low; weak-root-family; possibly shared root]
- **atlasmugt'g** -> **atlasmu'teget** [medium; root-family; shared root]
- **piliganelsegnignigigan** -> **piliganlsegni'ganiganig** [medium; root-family; shared root]
- **elawika'teket** -> **elawigatas'g** [medium; root-family; shared root]
- **elawiga'teget** -> **elawigatas'g** [medium; root-family; shared root]
- **pemuns`g** -> **pemsing** [low; weak-root-family; possibly shared root]
- **tetmns`gani'ge'g** -> **tetmnsegani'gat** [medium; root-family; shared root]
- **masgwe'igana'q** -> **masgwi'gan** [medium; root-family; shared root]
- **wegnmgosit** -> **plamu** [low; multi-def-overlap; shared meaning]
- **espisegn'g** -> **espesegnas'g** [low; weak-root-family; possibly shared root]
- **pgawigana'q** -> **pgawi'guoma'q** [medium; root-family; shared root]
- **eligpete'g** -> **weligpa't** [low; multi-def-overlap; shared meaning]
- **pugtewa'teget** -> **pugtewigtug** [medium; root-family; shared root]
- **gelapaqte'get** -> **gelapaqta'tl** [high; same-stem; same stem, different form]
- **tmgwalignejue'get** -> **tmgeligenejue'get** [low; multi-def-overlap; shared meaning]
- **apsuinui'sgw** -> **aniapsuinu'sgw** [low; multi-def-overlap; shared meaning]
- **asoqomapt'g** -> **asoqomapegit** [medium; root-family; shared root]
- **asoqmaptɨk** -> **asoqomapegit** [medium; root-family; shared root]
- **asoqomapt'g** -> **asoqomapegit** [medium; root-family; shared root]
- **tetmns`gano'guomit** -> **tetmnsegani'gat** [medium; root-family; shared root]
- **gasgigweteiwatl** -> **gasgigweta'tl** [medium; root-family; shared root]
- **sugmsugwet** -> **asoqomasugwet** [low; multi-def-overlap; shared meaning]
- **wegwatesg** -> **waqatasg** [low; multi-def-overlap; shared meaning]
- **tetmns`gano'guomit** -> **tetmns'ganmit** [medium; root-family; shared root]
- **tetmns`ganmit** -> **tetmnsegani'gat** [medium; root-family; shared root]

## ambiguous (sample)
- **gesgmaplgigwa'teget** -> **gesgmaplgigwa'teget** [low; exact-skel+disjoint-defs]
- **sngatigna'teget** -> **sngatigna'teget** [low; exact-skel+disjoint-defs]
- **newtigatalugwet** -> **newtigata'lugwet** [low; exact-skel+disjoint-defs]
- **wejgwimusga'sit** -> **wejgwimusga'sit** [low; exact-skel+disjoint-defs]
- **pugwelijipuji'juig** -> **pugwelijipu'ji’juig** [low; exact-skel+disjoint-defs]
- **naqsipgising** -> **naqsipgising** [low; exact-skel+disjoint-defs]
- **getlamite'lmatl** -> **getlamite'lmatl** [low; exact-skel+disjoint-defs]
- **gelgwisga'tas`g** -> **gelgwisgetesg** [low; near-skel-only]
- **newtugwalugwet** -> **newtugwa'lugwet** [low; exact-skel+disjoint-defs]
- **newtugwalugwet** -> **newtugwa'lugwet** [low; exact-skel+disjoint-defs]
- **newtugwalugwet** -> **newtugwa'lugwet** [low; exact-skel+disjoint-defs]
- **gesmtesguatl** -> **gesmtesguatl** [low; exact-skel+disjoint-defs]
- **wesgitpega'sit** -> **wesgitpega'sit** [low; exact-skel+disjoint-defs]
- **geltaqpilatl** -> **geltaqpilatl** [low; exact-skel+disjoint-defs]
- **glmuejuapsgw** -> **glmuejuapsgw** [low; exact-skel+disjoint-defs]
- **ligpete'gnapi** -> **ligpete'gnapi** [low; exact-skel+disjoint-defs]
- **negapigwa'latl** -> **negapigwa'latl** [low; exact-skel+disjoint-defs]
- **getlamite'lmuatl** -> **getlamite'lmatl** [low; near-skel-only]
- **paltemg'tesg** -> **paltemgetesg** [low; near-skel-only]
- **esnipitgmat'g** -> **esnpitgmatg** [low; near-skel-only]
- **tmignatgw** -> **tmi'gnatgw** [low; exact-skel+disjoint-defs]
- **geltaqpilg** -> **geltaqpilg** [low; exact-skel+disjoint-defs]
- **pugsaqte'gn** -> **pugsaqte'gn** [low; exact-skel+disjoint-defs]
- **aptuisginipuguit** -> **aptuisgenapuguit** [low; near-skel-only]
- **nisgamewi'gan** -> **Nisgamewi'gan** [low; exact-skel+disjoint-defs]

