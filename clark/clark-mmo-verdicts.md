# Similarity pass 1a (language rules v3): 'clark' -> 'dict'

- pairs: 37002
- same-word: 281 (0.8%)
- related: 9953 (26.9%)
- unrelated: 25721 (69.5%)
- ambiguous: 1047 (2.8%)
- REFERRAL BAND (ambiguous -> the LLM judge, if funded): 1047 pairs
- spelling grades (orthoMatch): exact 0 / candidate 0 / skeleton 25 / none 36977

## Rule firings
- single-common-token: 25721
- possible-synonym: 7324
- multi-def-overlap: 1572
- weak-root-family: 887
- rare-def-only: 799
- root-family: 165
- near-skel-only: 147
- cskel+def-overlap: 132
- near-skel+def-overlap: 84
- cskel+missing-defs: 80
- dialect-sub+def-overlap: 34
- exact-skel+def-overlap: 25
- exact-skel+disjoint-defs: 21
- exact-skel+missing-defs: 6
- lexicon-root: 4
- same-stem: 1

## same-word (sample)
- **koptumunek** -> **goptmneg** [medium; near-skel+def-overlap]
- **mestugepegajit** -> **mest'gipigajit** [medium; cskel+def-overlap]
- **elsegunigunegun** -> **elsegni'ganigan** [medium; cskel+def-overlap]
- **mowesooltijik** -> **mawisultijig** [medium; cskel+def-overlap]
- **maskwāseman** -> **masgwe'siman** [medium; near-skel+def-overlap]
- **munumkwet** -> **mnmgwet** [medium; near-skel+def-overlap]
- **mowikpoktem** -> **mawgpugtem** [medium; cskel+def-overlap]
- **mowikpoktem** -> **mawigpugtem** [medium; near-skel+def-overlap]
- **espagwit** -> **espa'gwit** [high; exact-skel+def-overlap]
- **kalāmawimk** -> **gale'mewumg** [medium; cskel+def-overlap]
- **soogulugāmat** -> **sugul'gma't** [medium; cskel+def-overlap]
- **tumegalow** -> **tmigalaw** [medium; cskel+def-overlap]
- **nagosetāwā** -> **na'gu'setewei** [medium; cskel+def-overlap]
- **pistamoon** -> **pistamun** [medium; near-skel+def-overlap]
- **pesteāwoode** -> **pestie'wumg** [medium; cskel+def-overlap]
- **kēneskwāk** -> **ginisgwe'g** [medium; cskel+def-overlap]
- **kēneskwāk** -> **gini'sgwe'g** [medium; cskel+def-overlap]
- **kēneskwāk** -> **ginisgwig** [medium; cskel+def-overlap]
- **koolaptan** -> **glaptan** [medium; near-skel+def-overlap]
- **laplesun** -> **laplusan** [medium; cskel+def-overlap]
- **soomagoonis** -> **sma'gnis** [medium; cskel+def-overlap]
- **kalkoonawā** -> **galgunawei** [medium; cskel+def-overlap]
- **Wegowegoos** -> **wigewigu's** [medium; cskel+def-overlap]
- **wenjoosoon** -> **wenju'su'n** [medium; cskel+def-overlap]
- **elnapskook** -> **lnapsgu'g** [medium; cskel+def-overlap]

## related (sample)
- **mestooulode** -> **mestaulo'ti** [low; weak-root-family; possibly shared root]
- **amkuntāgā** -> **amgnte'g** [low; weak-root-family; possibly shared root]
- **elkoosooôkun** -> **lgusuaqan** [low; multi-def-overlap; shared meaning]
- **epesegunum** -> **espesegng** [low; multi-def-overlap; shared meaning]
- **kesegowitk** -> **gesigawitg** [low; weak-root-family; possibly shared root]
- **Abegwēt** -> **qasqamgeg** [low; multi-def-overlap; shared meaning]
- **Koolpujut** -> **tegele'jit** [low; possible-synonym; possible synonym]
- **nigunegī** -> **epistamit** [low; multi-def-overlap; shared meaning]
- **nigunegī** -> **welpistamit** [low; multi-def-overlap; shared meaning]
- **elegāweskw** -> **elege'wi'sgw** [low; weak-root-family; possibly shared root]
- **nigunegī** -> **pistamun** [low; multi-def-overlap; shared meaning]
- **mādelum** -> **paqsipgeitelua'tl** [low; multi-def-overlap; shared meaning]
- **tcajegām** -> **jajiga'q** [low; multi-def-overlap; shared meaning]
- **tcajegām** -> **tajiga'q** [low; multi-def-overlap; shared meaning]
- **amkuntāgā** -> **amgnte'get** [low; weak-root-family; possibly shared root]
- **pepoogwā** -> **pipugwaqan** [low; multi-def-overlap; shared meaning]
- **legapelkun** -> **legepilaqan** [low; weak-root-family; possibly shared root]
- **kundāweā** -> **guntewiet** [low; weak-root-family; possibly shared root]
- **Pagāwimk** -> **Pa'gewumg** [low; weak-root-family; possibly shared root]
- **keskumsidāe** -> **sa'qati'ju'aq** [low; multi-def-overlap; shared meaning]
- **amalegunoktcētc** -> **amalignoqji'j** [low; weak-root-family; possibly shared root]
- **Megumawak** -> **Mi'gmewa'j** [low; weak-root-family; possibly shared root]
- **mestāek** -> **mestait** [medium; root-family; shared root]
- **pilsaboogooā** -> **pisuimatl** [low; multi-def-overlap; shared meaning]
- **epesegunum** -> **espesegnas'g** [low; multi-def-overlap; shared meaning]

## ambiguous (sample)
- **alukoojooiktesk** -> **alagujuigtesg** [low; cskel+missing-defs]
- **mestegesasegāwā** -> **mestegi'sewei** [low; cskel+missing-defs]
- **mestēespāk** -> **mestaespe'g** [low; near-skel-only]
- **penasōlkw** -> **pnasu'lgw** [low; near-skel-only]
- **mestooultek** -> **mestaulteg** [low; near-skel-only]
- **pikseskool** -> **pigsisgul** [low; cskel+missing-defs]
- **pepkūksit** -> **pepgugsit** [low; exact-skel+disjoint-defs]
- **mestanum** -> **mestanm** [low; near-skel-only]
- **ejenagwit** -> **ejina'gwit** [low; near-skel-only]
- **Megwājit** -> **megwe'jit** [low; near-skel-only]
- **mestowik** -> **mestawig** [low; near-skel-only]
- **metogwegi** -> **metgwe'g** [low; near-skel-only]
- **sinskwā** -> **snasgw** [low; cskel+missing-defs]
- **moostesk** -> **mesta's'g ** [low; cskel+missing-defs]
- **kobanētc** -> **atam** [low; rare-def-only]
- **nentowāk** -> **nantawe'g** [low; cskel+missing-defs]
- **keseboodek** -> **gesipte'g** [low; near-skel-only]
- **pematkek** -> **pemitge'g** [low; near-skel-only]
- **elmatkek** -> **lamatgeg** [low; cskel+missing-defs]
- **elmalkuk** -> **lamalgeg** [low; cskel+missing-defs]
- **okokwasit** -> **gegwa'sit** [low; near-skel-only]
- **abedadakun** -> **apita'taqan** [low; rare-def-only]
- **pegoonwegasik** -> **pi'gunwi'gas'g** [low; rare-def-only]
- **amuspegitk** -> **amuspegitg** [low; near-skel-only]
- **m'kuse** -> **ugqosi'l** [low; rare-def-only]

