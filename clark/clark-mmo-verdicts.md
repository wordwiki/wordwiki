# Similarity pass 1a (language rules v3): 'clark' -> 'dict'

- pairs: 6292
- same-word: 20 (0.3%)
- related: 2123 (33.7%)
- unrelated: 3873 (61.6%)
- ambiguous: 276 (4.4%)
- REFERRAL BAND (ambiguous -> the LLM judge, if funded): 276 pairs
- spelling grades (orthoMatch): exact 0 / candidate 0 / skeleton 6 / none 6286

## Rule firings
- single-common-token: 3873
- possible-synonym: 1685
- multi-def-overlap: 336
- rare-def-only: 249
- weak-root-family: 87
- cskel+missing-defs: 16
- root-family: 15
- cskel+def-overlap: 12
- near-skel-only: 7
- exact-skel+disjoint-defs: 4
- near-skel+def-overlap: 4
- exact-skel+def-overlap: 3
- dialect-sub+def-overlap: 1

## same-word (sample)
- **anēapsimk** -> **aniapsimg** [high; dialect-sub+def-overlap; e<->i]
- **amekaloolk** -> **amiglu'lg** [medium; cskel+def-overlap]
- **anesk** -> **anesg** [high; exact-skel+def-overlap]
- **anesit** -> **anesit** [high; exact-skel+def-overlap]
- **adam** -> **atam** [high; exact-skel+def-overlap]
- **aloosool** -> **aluso'l** [medium; cskel+def-overlap]
- **ankoowā** -> **anguowei** [medium; cskel+def-overlap]
- **âlgow** -> **aligew** [medium; cskel+def-overlap]
- **agwēsun** -> **a'gwesn** [medium; near-skel+def-overlap]
- **aneaptuk** -> **aniaptg** [medium; cskel+def-overlap]
- **aneaptuk** -> **neiapt'g** [medium; cskel+def-overlap]
- **alma** -> **alman** [medium; near-skel+def-overlap]
- **alooskeā** -> **ala's'g** [medium; cskel+def-overlap]
- **alooskeā** -> **als'g** [medium; cskel+def-overlap]
- **alaptāgā** -> **alapt'g** [medium; cskel+def-overlap]
- **alaptāgā** -> **aluapt'g** [medium; cskel+def-overlap]
- **alaptāgā** -> **ilapt'g** [medium; cskel+def-overlap]
- **anedek** -> **aneteg** [medium; near-skel+def-overlap]
- **aoolamk** -> **lame'g** [medium; cskel+def-overlap]
- **aljā** -> **alja't** [medium; near-skel+def-overlap]

## related (sample)
- **amkuntāgā** -> **amgnte'g** [low; weak-root-family; possibly shared root]
- **Abegwēt** -> **qasqamgeg** [low; multi-def-overlap; shared meaning]
- **altestamk** -> **waltes** [low; multi-def-overlap; shared meaning]
- **amkuntāgā** -> **amgnte'get** [low; weak-root-family; possibly shared root]
- **amalegunoktcētc** -> **amalignoqji'j** [low; weak-root-family; possibly shared root]
- **adooistaoo** -> **ti'ls** [low; multi-def-overlap; shared meaning]
- **adooistaoo** -> **ti'lsi'gan** [low; multi-def-overlap; shared meaning]
- **amaskaltēek** -> **amaspit** [low; weak-root-family; possibly shared root]
- **Abegwēt** -> **paslue'gati** [low; multi-def-overlap; shared meaning]
- **Abegwēt** -> **Epegwitg** [low; multi-def-overlap; shared meaning]
- **Abegwēt** -> **pqa'lu'sgw** [low; multi-def-overlap; shared meaning]
- **apteekooneet** -> **apjigu'niet** [low; multi-def-overlap; shared meaning]
- **abadakun** -> **apataqan** [low; multi-def-overlap; shared meaning]
- **altestamk** -> **waltestaqan** [low; multi-def-overlap; shared meaning]
- **amnastukadâkun, ul** -> **amnast'ga'toq** [medium; root-family; shared root]
- **abeajētc** -> **etlte'g** [low; multi-def-overlap; shared meaning]
- **abeajētc** -> **getu'muet** [low; multi-def-overlap; shared meaning]
- **abeajētc** -> **pipugwaqan** [low; multi-def-overlap; shared meaning]
- **abadak** -> **apatoq** [low; multi-def-overlap; shared meaning]
- **abadā** -> **apatoq** [low; multi-def-overlap; shared meaning]
- **amkuntame** -> **amgnte'g** [low; weak-root-family; possibly shared root]
- **abunegwā** -> **papguiaq** [low; multi-def-overlap; shared meaning]
- **alaktēgāwenoo** -> **alaqtegewinu** [low; weak-root-family; possibly shared root]
- **ādagaltēek** -> **a'sugwesugwijig** [low; multi-def-overlap; shared meaning]
- **adooômkemin** -> **atuomgomin** [low; possible-synonym; possible synonym]

## ambiguous (sample)
- **alukoojooiktesk** -> **alagujuigtesg** [low; cskel+missing-defs]
- **abedadakun** -> **apita'taqan** [low; rare-def-only]
- **amuspegitk** -> **amuspegitg** [low; near-skel-only]
- **Ada** -> **atam** [low; rare-def-only]
- **akudā** -> **aqatatpa't** [low; rare-def-only]
- **abipskwesowā** -> **pesgwesawet** [low; rare-def-only]
- **aneapsōkwon** -> **aniapsuoqon** [low; rare-def-only]
- **ālāk** -> **ntaqo'qon** [low; rare-def-only]
- **abooikpā** -> **sipigpa'q** [low; rare-def-only]
- **abooikpā** -> **sipigpa't** [low; rare-def-only]
- **akàbooldek** -> **mtasoq** [low; rare-def-only]
- **abewekegā** -> **tu'gwesmun** [low; rare-def-only]
- **amalegunoktcētc** -> **migjigj** [low; rare-def-only]
- **āboonadoo** -> **anesga'latl** [low; rare-def-only]
- **adooseksit** -> **matnaggewaqan** [low; rare-def-only]
- **adooseksit** -> **matntimg** [low; rare-def-only]
- **anāgwaitc** -> **sasqe'g** [low; rare-def-only]
- **aa** -> **gjipa'tlia's_ewgwam**** [low; rare-def-only]
- **abokwadasik** -> **apattesg** [low; rare-def-only]
- **abooksigun** -> **pugsigna'qewit** [low; rare-def-only]
- **amiktcijedegemk** -> **megitelsit** [low; rare-def-only]
- **āltakumasik** -> **megwatesg** [low; rare-def-only]
- **āltakumasik** -> **waqatasg** [low; rare-def-only]
- **aootowsooôkun** -> **ewlawsuo'qon** [low; rare-def-only]
- **Amajetckebajit** -> **mila'teget** [low; rare-def-only]

