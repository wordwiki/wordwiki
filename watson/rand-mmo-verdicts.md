# Similarity pass 1a (language rules v2): 'rand' -> 'dict'

- pairs: 65919
- same-word: 3584 (5.4%)
- related: 14967 (22.7%)
- unrelated: 40038 (60.7%)
- ambiguous: 7330 (11.1%)
- REFERRAL BAND (ambiguous -> the LLM judge, if funded): 7330 pairs
- spelling grades (orthoMatch): exact 4778 / candidate 1 / skeleton 1125 / none 60015

## Rule firings
- single-common-token: 40038
- possible-synonym: 9985
- exact-skel+disjoint-defs: 3728
- near-skel-only: 2613
- weak-root-family: 2050
- exact-skel+def-overlap: 1977
- root-family: 1630
- near-skel+def-overlap: 1214
- multi-def-overlap: 1042
- rare-def-only: 654
- cskel+missing-defs: 335
- exact-skel+missing-defs: 203
- cskel+def-overlap: 190
- lexicon-root: 184
- same-stem: 64
- diminutive: 12

## same-word (sample)
- **eliga'teget** -> **eliga'teget** [high; exact-skel+def-overlap]
- **nestuapuguet** -> **nestuapuguet** [high; exact-skel+def-overlap]
- **amalignoqji'j** -> **amalignoqji'j** [high; exact-skel+def-overlap]
- **elisgnuet** -> **elisgnuet** [high; exact-skel+def-overlap]
- **eligpete'get** -> **eligpete'get** [high; exact-skel+def-overlap]
- **wejipeg** -> **wejipeg** [high; exact-skel+def-overlap]
- **poqwasnigan** -> **poqwasni'gan** [high; exact-skel+def-overlap]
- **agnutmajig** -> **agnutmajig** [high; exact-skel+def-overlap]
- **aknutmajik** -> **agnutmajig** [high; exact-skel+def-overlap]
- **apigsigtuatl** -> **apigsigtuatl** [high; exact-skel+def-overlap]
- **aweligj** -> **aweligj** [high; exact-skel+def-overlap]
- **t`pgwantimg** -> **T'pgwantimg** [high; exact-skel+def-overlap]
- **asiteglulatl** -> **asiteglulatl** [high; exact-skel+def-overlap]
- **gisigwet** -> **gisigwet** [high; exact-skel+def-overlap]
- **pgumanapu** -> **pgumanapu** [high; exact-skel+def-overlap]
- **pgumanapu** -> **pgumanapu** [high; exact-skel+def-overlap]
- **mawgiljet** -> **mawgiljet** [high; exact-skel+def-overlap]
- **mi'gmewi'sit** -> **Mi'gmewi'sit** [high; exact-skel+def-overlap]
- **temisguna'toq** -> **temisguna’toq** [high; exact-skel+def-overlap]
- **wigweliej** -> **wigweliej** [high; exact-skel+def-overlap]
- **ugjiljl** -> **ugjiljl** [high; exact-skel+def-overlap]
- **gesigawta'q** -> **gesigawta'q** [high; exact-skel+def-overlap]
- **gi'wasg** -> **giwasg** [high; exact-skel+def-overlap]
- **apli'gmuj** -> **apli'gmuj** [high; exact-skel+def-overlap]
- **apli'kmuj** -> **apli'gmuj** [high; exact-skel+def-overlap]

## related (sample)
- **wegnmgosit** -> **plamu** [low; multi-def-overlap; shared meaning]
- **wegwatesg** -> **waqatasg** [low; multi-def-overlap; shared meaning]
- **eligoq** -> **ela'muet** [low; multi-def-overlap; shared meaning]
- **pesigitg** -> **wintsug** [low; multi-def-overlap; shared meaning]
- **pesigitg** -> **wintsug** [low; multi-def-overlap; shared meaning]
- **wenpnat** -> **pusgiweniet** [low; multi-def-overlap; shared meaning]
- **tepiaq** -> **tepiet** [low; weak-root-family; possibly shared root]
- **elisgnuet** -> **mawisgnuatg** [low; multi-def-overlap; shared meaning]
- **wegnmgosit** -> **siga'lat** [low; multi-def-overlap; shared meaning]
- **setamipit** -> **sno'pi** [low; multi-def-overlap; shared meaning]
- **alje'maqan** -> **naqasuetesguatl** [low; multi-def-overlap; shared meaning]
- **elawiga'toq** -> **elawigatas'g** [medium; root-family; shared root]
- **elawiga'teget** -> **elawigatas'g** [medium; root-family; shared root]
- **elawika'teket** -> **elawigatas'g** [medium; root-family; shared root]
- **nignigatg** -> **pistamun** [low; multi-def-overlap; shared meaning]
- **nignige'g** -> **pistamun** [low; multi-def-overlap; shared meaning]
- **wejguns`g** -> **gaqawiewlams'g** [low; multi-def-overlap; shared meaning]
- **gaqa'q** -> **qame'g** [low; multi-def-overlap; shared meaning]
- **esiputoq** -> **esipulatl** [medium; root-family; shared root]
- **welitla'teget** -> **tetapu'qamigsit** [low; multi-def-overlap; shared meaning]
- **awsepet** -> **sismo'qonapu** [low; multi-def-overlap; shared meaning]
- **najiawsepe'g** -> **sismo'qonapu** [low; multi-def-overlap; shared meaning]
- **apiawsepe'g** -> **sismo'qonapu** [low; multi-def-overlap; shared meaning]
- **egsuet** -> **glusgapewit** [low; multi-def-overlap; shared meaning]
- **ejigls'g** -> **niss'g** [low; multi-def-overlap; shared meaning]

## ambiguous (sample)
- **nisgamewi'gan** -> **Nisgamewi'gan** [low; exact-skel+disjoint-defs]
- **wejgwa'latl** -> **wejgwa'latl** [low; exact-skel+disjoint-defs]
- **tmignatgw** -> **tmi'gnatgw** [low; exact-skel+disjoint-defs]
- **pemsing** -> **pemsing** [low; exact-skel+disjoint-defs]
- **sngatigna'teget** -> **sngatigna'teget** [low; exact-skel+disjoint-defs]
- **ugsisqon** -> **ugsisqon** [low; exact-skel+disjoint-defs]
- **wesgitpegiet** -> **wesgitpegiet** [low; exact-skel+disjoint-defs]
- **ligpete'gnapi** -> **ligpete'gnapi** [low; exact-skel+disjoint-defs]
- **menaje'jg** -> **menaje'jg** [low; exact-skel+disjoint-defs]
- **amgnte'get** -> **amgnte'get** [low; exact-skel+disjoint-defs]
- **sigtogwet** -> **sigto'gwet** [low; exact-skel+disjoint-defs]
- **listuguj** -> **Listuguj** [low; exact-skel+disjoint-defs]
- **getmenet** -> **getmenet** [low; exact-skel+disjoint-defs]
- **tagali'j** -> **tagali'j** [low; exact-skel+disjoint-defs]
- **tela'tegeg** -> **tela'tegeg** [low; exact-skel+disjoint-defs]
- **wijitgotg** -> **wijitgo'tg** [low; exact-skel+disjoint-defs]
- **tegismit** -> **tegismit** [low; exact-skel+disjoint-defs]
- **getumuet** -> **getu'muet** [low; exact-skel+disjoint-defs]
- **melga'latl** -> **melga'latl** [low; exact-skel+disjoint-defs]
- **gigajotg** -> **gi'gajo'tg** [low; exact-skel+disjoint-defs]
- **welpegitg** -> **welpegitg** [low; exact-skel+disjoint-defs]
- **poqwajite'tg** -> **poqwajite'tg** [low; exact-skel+disjoint-defs]
- **gejgapa'toq** -> **gejgapa'toq** [low; exact-skel+disjoint-defs]
- **gejigiaq** -> **gejigiaq** [low; exact-skel+disjoint-defs]
- **pugwelijipuji'juig** -> **pugwelijipu'ji’juig** [low; exact-skel+disjoint-defs]

