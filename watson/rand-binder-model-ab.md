# Binder model A/B: claude-opus-4-8 (reference) vs claude-sonnet-5

20 pages (incl. the dz-reviewed 46-55); 1818 candidate judgments.

- IDENTICAL box sets: 1314 (72.3%)
- overlapping (partial agreement): 345
- disjoint (real disagreement): 31
- opus bound / sonnet not: 125
- sonnet bound / opus not: 2
- neither bound: 1
- confidence-bucket disagreements: 3
- sonnet usage: 15 call(s), 297459 in / 59628 out tokens
- SONNET EXTRACTION FAILURES (schema misfires): 4
    - p.48: extraction does not match schema at $.bindings: expected array, got string
    - p.49: extraction does not match schema at $.bindings: expected array, got string
    - p.50: extraction does not match schema at $.bindings: expected array, got string
    - p.53: extraction does not match schema at $.bindings: expected array, got string

| page | cands | identical | overlap | disjoint | opus-only | sonnet-only | neither |
|-----:|------:|----------:|--------:|---------:|----------:|------------:|--------:|
| 26 | 116 | 85 | 28 | 3 | 0 | 0 | 0 | (sonnet cached)
| 27 | 97 | 34 | 29 | 0 | 34 | 0 | 0 | (sonnet cached)
| 28 | 117 | 107 | 7 | 3 | 0 | 0 | 0 | (sonnet cached)
| 29 | 122 | 101 | 16 | 4 | 1 | 0 | 0 | (sonnet cached)
| 30 | 102 | 73 | 23 | 5 | 1 | 0 | 0 | (sonnet cached)
| 31 | 116 | 99 | 10 | 1 | 3 | 2 | 1 |
| 32 | 110 | 88 | 18 | 4 | 0 | 0 | 0 |
| 33 | 110 | 99 | 7 | 2 | 2 | 0 | 0 |
| 34 | 128 | 113 | 10 | 5 | 0 | 0 | 0 |
| 35 | 134 | 49 | 82 | 3 | 0 | 0 | 0 |
| 46 | 116 | 113 | 3 | 0 | 0 | 0 | 0 |
| 47 | 109 | 97 | 12 | 0 | 0 | 0 | 0 |
| 51 | 106 | 22 | 2 | 0 | 82 | 0 | 0 |
| 52 | 112 | 95 | 16 | 1 | 0 | 0 | 0 |
| 54 | 117 | 60 | 55 | 0 | 2 | 0 | 0 |
| 55 | 106 | 79 | 27 | 0 | 0 | 0 | 0 |

## Disagreement details (first 40)
- p.26 **netowatg** (197400130308649)
    - opus:   Auctioneer, Nedowwotk'; Noojintooesket'; ⏎ Noojesowwet'.
    - sonnet: Auctioneer, Nedowwotk'; Noojintooesket';
- p.26 **tepusit** (957642853788484)
    - opus:   To avoid, Pesogwaase ; Wäkâsiktooã' Medâ- ⏎ doodum ; Tepse Tepoose; Yalitpoose
    - sonnet: doodum ; Tepse Tepoose; Yalitpoose
- p.26 **getlawe'g** (1523151892487755)
    - opus:   Authentic, Authentical, kedlawäik ; kedl- ⏎ waekesedasik.
    - sonnet: Authentic, Authentical, kedlawäik ; kedl-
- p.26 **getugegmujjeta'sit** (1635875166595804)
    - opus:   To augur, Boooinwadega'; kedookegumooch- ⏎ edaase ; Negan- ⏎ ikchijetegâwenooaadega'.
    - sonnet: To augur, Boooinwadega'; kedookegumooch- ⏎ edaase ; Negan-
- p.26 **pemieget** (1871581627057572)
    - opus:   To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei'; ⏎ Pemegwa' Nokseelkik : Ajeâk'.
    - sonnet: To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei';
- p.26 **elue'uti** (2664738189505824)
    - opus:   Audaciousness, uksimtooaddan ; Meskeek ⏎ eloowäwoode.
    - sonnet: Audacious, Lok medook. ⏎ Audaciousness, uksimtooaddan ; Meskeek ⏎ eloowäwoode.
- p.26 **pisoqiaq** (2695628715052250)
    - opus:   To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei'; ⏎ Pemegwa' Nokseelkik : Ajeâk'.
    - sonnet: To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei';
- p.26 **nguie'g** (3430518047942934)
    - opus:   To augment, v. a. unkooea' Ajeã' : An- ⏎ kooaadoo; Ankooaalugik.
    - sonnet: To augment, v. a. unkooea' Ajeã' : An-
- p.26 **wesimugt** (3433132886017169)
    - opus:   To avoid, Pesogwaase ; Wäkâsiktooã' Medâ- ⏎ doodum ; Tepse Tepoose; Yalitpoose ⏎ Wesemoogwei Kesitpusiktum ; Keseboo- ⏎ looã'; Wesemooktum Wesemooktäk,
    - sonnet: looã'; Wesemooktum Wesemooktäk,
- p.26 **pemeleg** (3528403417567649)
    - opus:   To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei'; ⏎ Pemegwa' Nokseelkik : Ajeâk'.
    - sonnet: To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei';
- p.26 **tepsit** (3808952191436055)
    - opus:   To avoid, Pesogwaase ; Wäkâsiktooã' Medâ- ⏎ doodum ; Tepse Tepoose; Yalitpoose
    - sonnet: doodum ; Tepse Tepoose; Yalitpoose
- p.26 **sete'g** (3934044793633339)
    - opus:   To avenge, usedodega'; usedäâk' Woon- ⏎ maje-ilsoodega!
    - sonnet: To avenge, usedodega'; usedäâk' Woon-
- p.26 **gsimtuataqan** (4128892476538705)
    - opus:   Audaciousness, uksimtooaddan ; Meskeek ⏎ eloowäwoode.
    - sonnet: Audacious, Lok medook. ⏎ Audaciousness, uksimtooaddan ; Meskeek
- p.26 **nutasit** (4350303113537973)
    - opus:   Audibly, Tan noodasis.
    - sonnet: Audibleness, Audible, Noodasis noodum- ⏎ umk' iktook.
- p.26 **gtuegegmujete'taqan** (4486935548867424)
    - opus:   Augury, Boooinwa'dakun uktooekegumooch- ⏎ edaasoode
    - sonnet: August, kesagäwegoo's.
- p.26 **ulisl** (4563326421842673)
    - opus:   Aunt, Núlis', My mother's sister. 'Nsoogwis', ⏎ My father's sister.
    - sonnet: Aunt, Núlis', My mother's sister. 'Nsoogwis',
- p.26 **getugegmujete'tg** (4689938112702239)
    - opus:   To augur, Boooinwadega'; kedookegumooch- ⏎ edaase ; Negan- ⏎ ikchijetegâwenooaadega'.
    - sonnet: To augur, Boooinwadega'; kedookegumooch- ⏎ edaase ; Negan-
- p.26 **pisoqigweg** (4744746055237136)
    - opus:   To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei'; ⏎ Pemegwa' Nokseelkik : Ajeâk'.
    - sonnet: To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei';
- p.26 **melgiglusit** (4892876962056120)
    - opus:   To avouch, Melkekuloose ; elooedumäse. ⏎ Avoucher, Nooje-looedumase.
    - sonnet: To avouch, Melkekuloose ; elooedumäse.
- p.26 **wesimuqtatl** (5069054456569643)
    - opus:   Wesemoogwei Kesitpusiktum ; Keseboo- ⏎ looã'; Wesemooktum Wesemooktäk,
    - sonnet: looã'; Wesemooktum Wesemooktäk,
- p.26 **pisaqwet** (5893697044104847)
    - opus:   Avaricious, Pesogwãe ; Wesämiksadum mil- ⏎ äsoode.
    - sonnet: Avaricious, Pesogwãe ; Wesämiksadum mil-
- p.26 **wesimugwet** (5901377869105816)
    - opus:   Wesemoogwei Kesitpusiktum ; Keseboo- ⏎ looã'; Wesemooktum Wesemooktäk,
    - sonnet: Wesemoogwei Kesitpusiktum ; Keseboo-
- p.26 **pemigeit** (6250835483781012)
    - opus:   To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei'; ⏎ Pemegwa' Nokseelkik : Ajeâk'.
    - sonnet: To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei';
- p.26 **waqasigtuet** (7102889447569673)
    - opus:   To avoid, Pesogwaase ; Wäkâsiktooã' Medâ- ⏎ doodum ; Tepse Tepoose; Yalitpoose
    - sonnet: To avoid, Pesogwaase ; Wäkâsiktooã' Medâ-
- p.26 **pisoqigwen'met** (7342967368156151)
    - opus:   To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei'; ⏎ Pemegwa' Nokseelkik : Ajeâk'.
    - sonnet: kuyã' Pesokegwegul Pesokegwenumei';
- p.26 **pemigwet** (7811135459826364)
    - opus:   To augment, v. int. Pemelek Pemege Peso- ⏎ kuyã' Pesokegwegul Pesokegwenumei'; ⏎ Pemegwa' Nokseelkik : Ajeâk'.
    - sonnet: Pemegwa' Nokseelkik : Ajeâk'.
- p.26 **nujisowet** (7885580028378406)
    - opus:   Auctioneer, Nedowwotk'; Noojintooesket'; ⏎ Noojesowwet'.
    - sonnet: edaase ; Negan- ⏎ Noojesowwet'.
- p.26 **nutasit** (7948680024895979)
    - opus:   Audibly, Tan noodasis.
    - sonnet: Audibleness, Audible, Noodasis noodum- ⏎ umk' iktook.
- p.26 **gisitpsigt'g** (8536892223596124)
    - opus:   Wesemoogwei Kesitpusiktum ; Keseboo- ⏎ looã'; Wesemooktum Wesemooktäk,
    - sonnet: Wesemoogwei Kesitpusiktum ; Keseboo-
- p.26 **ialitpusit** (8610135243153524)
    - opus:   To avoid, Pesogwaase ; Wäkâsiktooã' Medâ- ⏎ doodum ; Tepse Tepoose; Yalitpoose
    - sonnet: doodum ; Tepse Tepoose; Yalitpoose
- p.26 **pesaqwa'sit** (8798557673230205)
    - opus:   To avoid, Pesogwaase ; Wäkâsiktooã' Medâ- ⏎ doodum ; Tepse Tepoose; Yalitpoose
    - sonnet: To avoid, Pesogwaase ; Wäkâsiktooã' Medâ-
- p.27 **mnamaliet**: opus bound, sonnet did not
- p.27 **pitugtoq**: opus bound, sonnet did not
- p.27 **toqiet** (713020666941426)
    - opus:   To awake, v. int., Toogea'; keskoose Nes- ⏎ tooeã'; Wespase Nebebe; Nebabe.
    - sonnet: To awake, v. int., Toogea'; keskoose Nes-
- p.27 **gopiteg**: opus bound, sonnet did not
- p.27 **apsgwapiga'latl**: opus bound, sonnet did not
- p.27 **ugji'taqn**: opus bound, sonnet did not
- p.27 **nemjinaqteg**: opus bound, sonnet did not
- p.27 **gisgusit** (1268196118875475)
    - opus:   To awake, v. int., Toogea'; keskoose Nes- ⏎ tooeã'; Wespase Nebebe; Nebabe.
    - sonnet: To awake, v. int., Toogea'; keskoose Nes-
- p.27 **pusgipetgutanget**: opus bound, sonnet did not
