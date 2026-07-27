# Similarity pass 1a (rules v2): 'rand' -> 'dict'

- pairs: 59316
- same-word: 2912 (4.9%)
- related: 16477 (27.8%)
- unrelated: 35512 (59.9%)
- ambiguous: 4415 (7.4%)
- REFERRAL BAND (ambiguous -> the LLM judge, if funded): 4415 pairs

## Rule firings
- single-common-token: 35512
- possible-synonym: 11119
- exact-skel+disjoint-defs: 3643
- weak-root-family: 2259
- exact-skel+def-overlap: 1875
- root-family: 1706
- multi-def-overlap: 1150
- near-skel+def-overlap: 839
- rare-def-only: 772
- exact-skel+missing-defs: 198
- lexicon-root: 174
- same-stem: 59
- diminutive: 10

## same-word (sample)
- **eliga'teget** -> **eliga'teget** [high; exact-skel+def-overlap]
- **apigsigtuatl** -> **apigsigtuatl** [high; exact-skel+def-overlap]
- **aptaqatg** -> **aptaqatg** [high; exact-skel+def-overlap]
- **apoqonmuatl** -> **apoqonmuatl** [high; exact-skel+def-overlap]
- **temastaqte'muet** -> **temastaqte'muet** [high; exact-skel+def-overlap]
- **amalignoqji'j** -> **amalignoqji'j** [high; exact-skel+def-overlap]
- **ne'tata'sit** -> **ne'tata'sit** [high; exact-skel+def-overlap]
- **elisgnuet** -> **elisgnuet** [high; exact-skel+def-overlap]
- **angamsit** -> **angamsit** [high; exact-skel+def-overlap]
- **gnugwatign** -> **gnugwatign** [high; exact-skel+def-overlap]
- **wegwatesg** -> **megwatesg** [medium; near-skel+def-overlap]
- **elue'wit** -> **elue'wit** [high; exact-skel+def-overlap]
- **tepiaq** -> **tepiaq** [high; exact-skel+def-overlap]
- **eligpete'get** -> **eligpete'get** [high; exact-skel+def-overlap]
- **aqtamgiet** -> **aqtamgiet** [high; exact-skel+def-overlap]
- **esiputoq** -> **esiputoq** [high; exact-skel+def-overlap]
- **apji'jgmuj** -> **apji'jgmuj** [high; exact-skel+def-overlap]
- **pem'pugua'sit** -> **pempugua'sit** [high; exact-skel+def-overlap]
- **poqwasnigan** -> **poqwasni'gan** [high; exact-skel+def-overlap]
- **antawe's** -> **antawe's** [high; exact-skel+def-overlap]
- **agnutmajig** -> **agnutmajig** [high; exact-skel+def-overlap]
- **npuinu** -> **npuinu** [high; exact-skel+def-overlap]
- **pi'wej** -> **pi'wej** [high; exact-skel+def-overlap]
- **jilpit** -> **jilpit** [high; exact-skel+def-overlap]
- **wejipeg** -> **wejipeg** [high; exact-skel+def-overlap]

## related (sample)
- **wegnmgosit** -> **plamu** [low; multi-def-overlap; shared meaning]
- **wegwatesg** -> **waqatasg** [low; multi-def-overlap; shared meaning]
- **eligoq** -> **ela'muet** [low; multi-def-overlap; shared meaning]
- **pesigitg** -> **wintsug** [low; multi-def-overlap; shared meaning]
- **pesigitg** -> **wintsug** [low; multi-def-overlap; shared meaning]
- **wenpnat** -> **pusgiweniet** [low; multi-def-overlap; shared meaning]
- **tepiaq** -> **tepiet** [low; weak-root-family; possibly shared root]
- **setamipit** -> **sno'pi** [low; multi-def-overlap; shared meaning]
- **elisgnuet** -> **mawisgnuatg** [low; multi-def-overlap; shared meaning]
- **esiputoq** -> **esipulatl** [medium; root-family; shared root]
- **wejguns`g** -> **gaqawiewlams'g** [low; multi-def-overlap; shared meaning]
- **wegnmgosit** -> **siga'lat** [low; multi-def-overlap; shared meaning]
- **alje'maqan** -> **naqasuetesguatl** [low; multi-def-overlap; shared meaning]
- **nignigatg** -> **pistamun** [low; multi-def-overlap; shared meaning]
- **nignige'g** -> **pistamun** [low; multi-def-overlap; shared meaning]
- **gaqa'q** -> **qame'g** [low; multi-def-overlap; shared meaning]
- **awsepet** -> **sismo'qonapu** [low; multi-def-overlap; shared meaning]
- **najiawsepe'g** -> **sismo'qonapu** [low; multi-def-overlap; shared meaning]
- **niposlet** -> **nipuslat** [low; weak-root-family; possibly shared root]
- **ajgnotegemgewei** -> **winsit** [low; multi-def-overlap; shared meaning]
- **emegwe'g** -> **winsit** [low; multi-def-overlap; shared meaning]
- **giste'wotegemgewei** -> **winsit** [low; multi-def-overlap; shared meaning]
- **egsuet** -> **glusgapewit** [low; multi-def-overlap; shared meaning]
- **naqt`g** -> **naqalatl** [low; weak-root-family; possibly shared root]
- **naqlatl** -> **naqt'g** [low; weak-root-family; possibly shared root]

## ambiguous (sample)
- **nalgwaqane'l** -> **nangwe'get** [low; rare-def-only]
- **a'tugwet** -> **nipiagnutmat** [low; rare-def-only]
- **aqjigateg** -> **aqjigateg** [low; exact-skel+disjoint-defs]
- **apsgulapa'sit** -> **apsgu'lapa'sit** [low; exact-skel+disjoint-defs]
- **angamatl** -> **angamatl** [low; exact-skel+disjoint-defs]
- **emtesgitlega'sit** -> **ginateja'sit** [low; rare-def-only]
- **egse'g** -> **papapuguet** [low; rare-def-only]
- **angunipiget** -> **na'newei** [low; rare-def-only]
- **aqatipaqalasmit** -> **pa'qalaig** [low; rare-def-only]
- **etlapigna't** -> **soqte'get** [low; rare-def-only]
- **aqatipaqalasmit** -> **pa'qalaig** [low; rare-def-only]
- **etlepigna't** -> **soqte'get** [low; rare-def-only]
- **aptu'n** -> **elapte'g** [low; rare-def-only]
- **aptu'n** -> **ugtaptu'n** [low; rare-def-only]
- **gaqwiamgeg** -> **gwe'gwiamgeg** [low; rare-def-only]
- **aqlasiwamugsit** -> **elat** [low; rare-def-only]
- **aqlasiwamugsit** -> **eluatl** [low; rare-def-only]
- **gjigus** -> **gesigewigu's** [low; rare-def-only]
- **elue'wit** -> **wisqilue'wit** [low; rare-def-only]
- **ewsampa'q** -> **lmu'ju'pa'q** [low; rare-def-only]
- **migwite'tg** -> **nestuita'sit** [low; rare-def-only]
- **emegwe'g** -> **getge'g** [low; rare-def-only]
- **gopsgwitm** -> **mensatl** [low; rare-def-only]
- **apjimlusgiet** -> **wesuasgiaq** [low; rare-def-only]
- **apjimlusgiet** -> **wesuasgiet** [low; rare-def-only]

