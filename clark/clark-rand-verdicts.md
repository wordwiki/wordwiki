# Similarity pass 1a (language rules v3): 'clark' -> 'rand'

- pairs: 8213
- same-word: 371 (4.5%)
- related: 2766 (33.7%)
- unrelated: 4610 (56.1%)
- ambiguous: 466 (5.7%)
- REFERRAL BAND (ambiguous -> the LLM judge, if funded): 466 pairs
- spelling grades (orthoMatch): exact 0 / candidate 0 / skeleton 241 / none 7972

## Rule firings
- single-common-token: 4610
- possible-synonym: 1942
- root-family: 323
- multi-def-overlap: 301
- rare-def-only: 206
- weak-root-family: 200
- near-skel+def-overlap: 182
- near-skel-only: 152
- exact-skel+def-overlap: 127
- exact-skel+disjoint-defs: 107
- cskel+def-overlap: 31
- dialect-sub+def-overlap: 24
- exact-skel+missing-defs: 7
- cskel+missing-defs: 1

## same-word (sample)
- **amasiksenoogowokun** -> **amsasigsnugowaqan** [high; exact-skel+def-overlap]
- **amalegunoktcētc** -> **amalignoqji'j** [medium; near-skel+def-overlap]
- **aptcetckumootc** -> **apji'jgmuj** [high; exact-skel+def-overlap]
- **aptcetckumootc** -> **apji'jgmuj** [high; exact-skel+def-overlap]
- **aooneskwokteskum** -> **ewnisgwaqtesg`g** [high; exact-skel+def-overlap]
- **abajipkwodelak** -> **apajipgwateluatl** [high; exact-skel+def-overlap]
- **amtcukunigun** -> **amjaqanign** [high; exact-skel+def-overlap]
- **aktcegadamakun** -> **aqijkatamaqn** [high; exact-skel+def-overlap]
- **aktcegadamakun** -> **aqjigatamaqan** [high; exact-skel+def-overlap]
- **amâltcugwetc** -> **amaljugwej** [medium; near-skel+def-overlap]
- **aooneskwēbelakn** -> **ewnisgwepilaqan** [medium; cskel+def-overlap]
- **ajiptcoödakun** -> **ajipju'taqan** [high; exact-skel+def-overlap]
- **amtcimlooskeā** -> **amjimlusge'g** [high; exact-skel+def-overlap]
- **alukoojooiktesk** -> **alaqujuigtesg** [high; exact-skel+def-overlap]
- **ajeoktcemin** -> **ajiaqjimin** [high; exact-skel+def-overlap]
- **adooaskwedēsin** -> **atuasgwetesing** [high; exact-skel+def-overlap]
- **amjaboktc** -> **amjapoqj** [high; exact-skel+def-overlap]
- **apskwegēdum** -> **apsgwegitg** [high; exact-skel+def-overlap]
- **abiktantegā** -> **apigtanteget** [high; exact-skel+def-overlap]
- **akumkwesin** -> **aqamgwesing** [high; exact-skel+def-overlap]
- **apkwiltcasi** -> **apgwilja'sit** [medium; near-skel+def-overlap]
- **aktcekopelàkun** -> **aqijgopilaqan** [medium; near-skel+def-overlap]
- **amtcimlooskeā** -> **amjimlugiet** [high; exact-skel+def-overlap]
- **aktcekopelum** -> **aqijgopilg** [medium; near-skel+def-overlap]
- **amaltēlmakun** -> **amaltelmaqan** [medium; near-skel+def-overlap]

## related (sample)
- **aboogiskunadām** -> **apugistaqane'g** [medium; root-family; shared root]
- **ametcijekekgumagādoo** -> **jijigoqnaq`g** [low; multi-def-overlap; shared meaning]
- **algoojogun** -> **algojug'g** [low; weak-root-family; possibly shared root]
- **ankaptēgā** -> **angapt'g** [medium; root-family; shared root]
- **amâlaboksumit** -> **amalapugsmit** [medium; root-family; shared root]
- **ametcijekekgumagādoo** -> **tegoqmaq** [low; multi-def-overlap; shared meaning]
- **ametcijekekgumagādoo** -> **pitaqamag'g** [low; multi-def-overlap; shared meaning]
- **abeajetckabik** -> **tapiajijgapi** [low; multi-def-overlap; shared meaning]
- **apteekooneet** -> **pagitnet** [low; possible-synonym; possible synonym]
- **adooksē** -> **a'tugwet** [medium; root-family; shared root]
- **adooksē** -> **aqnutmet** [low; multi-def-overlap; shared meaning]
- **alogoojokut** -> **algoju'gatl** [low; multi-def-overlap; shared meaning]
- **ajikpumedādum** -> **gepmite'tg** [low; multi-def-overlap; shared meaning]
- **amaloksowā** -> **eloqsawet** [low; multi-def-overlap; shared meaning]
- **aktalooksēt** -> **ujulusgieg** [low; multi-def-overlap; shared meaning]
- **aboodegadase** -> **aputega'teget** [medium; root-family; shared root]
- **apkwiltcasi** -> **pegwilja'sit** [low; multi-def-overlap; shared meaning]
- **amtcukudejimk bulgoktc iktook** -> **amjaqatejimatl** [medium; root-family; shared root]
- **āladejadusē** -> **elm'tga'teget** [low; multi-def-overlap; shared meaning]
- **anabapskitk** -> **winapsgitg** [low; multi-def-overlap; shared meaning]
- **aktamkeā** -> **wajuamga'toq** [low; multi-def-overlap; shared meaning]
- **aktamkeā** -> **wajuamga'teget** [low; multi-def-overlap; shared meaning]
- **aktamkeā** -> **wajuamga'lsit** [low; multi-def-overlap; shared meaning]
- **aktamkeā** -> **wajuamga'latl** [low; multi-def-overlap; shared meaning]
- **apskwegēdum** -> **apsgwegimatl** [medium; root-family; shared root]

## ambiguous (sample)
- **Apsetkwetck** -> **Apsetgwejg** [low; exact-skel+disjoint-defs]
- **amiktcijēdegā** -> **amigjijiteget** [low; exact-skel+disjoint-defs]
- **abootckodasik** -> **apujgotas'g** [low; exact-skel+disjoint-defs]
- **amasogopskool** -> **amasoqopsgw** [low; exact-skel+disjoint-defs]
- **aktcekopelàkun** -> **agijgopilaqan** [low; near-skel-only]
- **aktcekopelàkun** -> **akijkopilaqn** [low; near-skel-only]
- **amtcimlooskeā** -> **amjimlusgiet** [low; exact-skel+disjoint-defs]
- **aooneskwebēlum** -> **ewnisgwapil'g** [low; near-skel-only]
- **adagaltigul** -> **ataqaltig** [low; exact-skel+disjoint-defs]
- **amiktcijēdoo** -> **amigjijitoq** [low; exact-skel+disjoint-defs]
- **abooikpedesk** -> **apuigpetesg** [low; exact-skel+disjoint-defs]
- **abooikpagunegā** -> **apuigpaqamiget** [low; exact-skel+disjoint-defs]
- **amaskwibunâk** -> **amasgwipne'g** [low; near-skel-only]
- **àkabuskadakun** -> **aqapisga'taqan** [low; near-skel-only]
- **apjikslet** -> **apjigslet** [low; exact-skel+disjoint-defs]
- **altestakun** -> **altestaqan** [low; exact-skel+disjoint-defs]
- **amselāwistoo** -> **amsele'wistoq** [low; exact-skel+disjoint-defs]
- **amuspegitk** -> **amuspegitg** [low; near-skel-only]
- **agunoodumumkāwā** -> **agnutm'gewei** [low; exact-skel+disjoint-defs]
- **aktcegadek** -> **aqjigateg** [low; exact-skel+disjoint-defs]
- **amasebagwek** -> **amasipaqweg** [low; exact-skel+disjoint-defs]
- **agunoodumâkun** -> **aqnutmaqn** [low; exact-skel+disjoint-defs]
- **alaktēgāwenoo** -> **elaqtege'winu** [low; exact-skel+disjoint-defs]
- **aptcinpei** -> **apjinpe'g** [low; exact-skel+disjoint-defs]
- **akamkwesin** -> **aqamgwesing** [low; near-skel-only]

