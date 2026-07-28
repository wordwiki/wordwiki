# Similarity pass 1a (language rules v3): 'clark' -> 'rand'

- pairs: 58933
- same-word: 4563 (7.7%)
- related: 13698 (23.2%)
- unrelated: 35248 (59.8%)
- ambiguous: 5424 (9.2%)
- REFERRAL BAND (ambiguous -> the LLM judge, if funded): 5424 pairs
- spelling grades (orthoMatch): exact 0 / candidate 0 / skeleton 3415 / none 55518

## Rule firings
- single-common-token: 35248
- possible-synonym: 9064
- near-skel-only: 2956
- near-skel+def-overlap: 2015
- root-family: 1924
- exact-skel+disjoint-defs: 1714
- exact-skel+def-overlap: 1712
- weak-root-family: 1569
- multi-def-overlap: 1127
- rare-def-only: 695
- cskel+def-overlap: 409
- dialect-sub+def-overlap: 366
- exact-skel+missing-defs: 61
- cskel+missing-defs: 59
- lexicon-root: 10
- same-stem: 4

## same-word (sample)
- **uktcebetooimtulnakun** -> **gjipituimtlnaqn** [high; exact-skel+def-overlap]
- **niktooiktcētckul** -> **nigtuigji'jg** [high; exact-skel+def-overlap]
- **nabedabokteskigun** -> **napitapoqtestign** [high; exact-skel+def-overlap]
- **nookwiltcugētc** -> **nugwiljagej** [high; exact-skel+def-overlap]
- **uktcekabedestakun** -> **gjigapitestaqn** [high; exact-skel+def-overlap]
- **ukskwiskalsoode** -> **gsgwisgalsuti** [high; exact-skel+def-overlap]
- **elminskadāsinumugāwa** -> **elminsgatesinmgewei** [medium; near-skel+def-overlap]
- **pitkwealasoodumâkun** -> **pitgwia'sutmaqn** [high; exact-skel+def-overlap]
- **pitkwelooskunâkun** -> **pitgwelusgnuaqan** [medium; cskel+def-overlap]
- **malkopskadigun** -> **malgopsgatign** [high; exact-skel+def-overlap]
- **neganik-tcije-tegāwēnoo** -> **nianigjijitege'winu** [high; exact-skel+def-overlap]
- **kesitāwotkoogwek** -> **gesitewatgugweg** [high; exact-skel+def-overlap]
- **peskoonadektāsinskāk** -> **pesgunateg_te'sinsga'q** [medium; near-skel+def-overlap]
- **peskoonadektāsinskāk** -> **te'sinsga'q** [medium; near-skel+def-overlap]
- **kulumooetcwôpsk** -> **glmuejuopsg** [high; exact-skel+def-overlap]
- **elseguniguntcētc** -> **elsegnignji'j** [medium; near-skel+def-overlap]
- **keweswosk** -> **giwesuasg** [high; exact-skel+def-overlap]
- **peskwesowoodimk** -> **pesgwesawu'timg** [high; exact-skel+def-overlap]
- **tciktceloojadegā** -> **jigjeluja'teget** [high; exact-skel+def-overlap]
- **pewipskwesigun** -> **pewipsgwesign** [high; exact-skel+def-overlap]
- **weksitpaktesk** -> **wesgitpaqtesuatl** [high; exact-skel+def-overlap]
- **tumutckegwētc** -> **tm`jgigwej** [high; exact-skel+def-overlap]
- **amalegunoktcētc** -> **amalignoqji'j** [medium; near-skel+def-overlap]
- **sēgooeboogwistakun** -> **siguipugwistaqan** [high; exact-skel+def-overlap]
- **aptcetckumootc** -> **apji'jgmuj** [high; exact-skel+def-overlap]

## related (sample)
- **nalkwugadoo** -> **nelagwa'toq** [low; weak-root-family; possibly shared root]
- **megogumkujētc** -> **nespipaqan** [low; multi-def-overlap; shared meaning]
- **mesaltoogooā** -> **mesaltoqwe'g** [medium; root-family; shared root]
- **peskoolmiskaluk** -> **pasglmisga'latl** [low; multi-def-overlap; shared meaning]
- **usogumasoogwā** -> **sugmsugwet** [low; multi-def-overlap; shared meaning]
- **wādumī** -> **watign** [low; weak-root-family; possibly shared root]
- **elowegadasē** -> **elawika'teket** [medium; root-family; shared root]
- **elowegadasē** -> **elawiga'teget** [medium; root-family; shared root]
- **kijikskabudī** -> **gisigsgapite'g** [low; multi-def-overlap; shared meaning]
- **sokwodabē** -> **soqwatepa'sit** [medium; root-family; shared root]
- **meowlagwet** -> **milawiagwet** [low; multi-def-overlap; shared meaning]
- **muskulugunabase** -> **mimsgulugnipit** [low; multi-def-overlap; shared meaning]
- **pegwagitoo** -> **pegwaqiteget** [medium; root-family; shared root]
- **mestegesasegāwā** -> **mestaqisasigewei** [low; weak-root-family; possibly shared root]
- **nebeloktāgunaget** -> **nipelaqtaqniget** [medium; root-family; shared root]
- **nebeloktāgunaget** -> **nipelaqtaqmiget** [medium; root-family; shared root]
- **kegoolekwāmat** -> **gigli'gwemit** [low; weak-root-family; possibly shared root]
- **aboogiskunadām** -> **apugistaqane'g** [medium; root-family; shared root]
- **kakamudām** -> **gisnm'te'g** [low; multi-def-overlap; shared meaning]
- **pādulkik** -> **pe'tlg** [low; multi-def-overlap; shared meaning]
- **ankaptēgā** -> **angapt'g** [medium; root-family; shared root]
- **booktowsum** -> **pugtewteg** [medium; root-family; shared root]
- **epsimkāwā** -> **epsimgewei** [medium; root-family; shared root]
- **amâlaboksumit** -> **amalapugsmit** [medium; root-family; shared root]
- **ulnoojētc** -> **nnuej** [low; multi-def-overlap; shared meaning]

## ambiguous (sample)
- **kēneskwotpamakun** -> **ginisgwatpmaqan** [low; exact-skel+disjoint-defs]
- **nooje-abajipkwodelegā** -> **nujiapajipgwateliget** [low; exact-skel+disjoint-defs]
- **neganik-tcije-tegāwēnoo** -> **niganigjijitege'winu** [low; exact-skel+disjoint-defs]
- **neganik-tcije-tegāwēnoo** -> **niganigjijitege'winu** [low; exact-skel+disjoint-defs]
- **neganik-tcije-tegāwēnoo** -> **niganigjijitege'winu** [low; exact-skel+disjoint-defs]
- **neganik-tcije-tegāwēnoo** -> **niganigjijitege'winu** [low; exact-skel+disjoint-defs]
- **bētooinikskamijenakik** -> **pituinigsgamijinaq** [low; near-skel-only]
- **ejakunjedestakun** -> **ejaqanjetestaqan** [low; exact-skel+disjoint-defs]
- **wepkoomakunogwom** -> **wepgumaqano'guom** [low; exact-skel+disjoint-defs]
- **wepkoomakunogwom** -> **wepgumagno'guom** [low; exact-skel+disjoint-defs]
- **tcinpagoontesk** -> **jinpaquntesg** [low; exact-skel+disjoint-defs]
- **tcinpagoontestoo** -> **jinpaquntestoq** [low; exact-skel+disjoint-defs]
- **tcinpagoontestoo** -> **jinpaquntestoq** [low; exact-skel+disjoint-defs]
- **Apsetkwetck** -> **Apsetgwejg** [low; exact-skel+disjoint-defs]
- **keseoolkwijālooek** -> **gesiulgwija'lueg** [low; exact-skel+disjoint-defs]
- **upskunakunemoose** -> **psgnaqnimusi** [low; exact-skel+disjoint-defs]
- **keskoobalegowk** -> **gesgupaligowg** [low; exact-skel+disjoint-defs]
- **wenmajetabloomk** -> **wenmajit'plumatl** [low; near-skel-only]
- **pegwodāwolsāwe** -> **pegwate'ulsewit** [low; exact-skel+disjoint-defs]
- **noojipkotumodegā** -> **nujipgotmateget** [low; exact-skel+disjoint-defs]
- **tegwodabaktek** -> **tigwatapaqteg** [low; exact-skel+disjoint-defs]
- **esnepitkumadum** -> **esnipitgmat'g** [low; exact-skel+disjoint-defs]
- **wenmajīlsoomajul** -> **wenmaji'lsumatl** [low; near-skel-only]
- **kedooôpsumoodulk** -> **getuapsmutlatl** [low; exact-skel+disjoint-defs]
- **uksiktugedādakun** -> **gsigt'gite'gn** [low; exact-skel+disjoint-defs]

