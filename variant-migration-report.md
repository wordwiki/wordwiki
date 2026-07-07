# Variant (orthography) migration — DRY RUN

> **⚠ Point-in-time report — generated 2026-07-07T16:41:59.949Z from `/tmp/claude-1000/-home-dziegler-projects-wordwiki/61972dfd-5245-4f6c-8442-1149dcc1ee7b/scratchpad/review-instance/database/db.db [db_purpose: dev]`.**
> This is a record of that moment, not a live view; re-run the generator for current data.

**5 finding(s)** across 5 section(s):

- Preconditions: 0 finding(s)
- Decision evidence — the blank-backfill mapping: 0 finding(s)
- Actions (DRY RUN — reported, NOT applied): 0 finding(s)
- The cases (decision-table review detail): 0 finding(s)
- Hand-triage remainder (deliberately untouched): 5 finding(s)

## Preconditions

- flagged schema in force
- scan-variants drop gate: PASS
- backfill mapping covers every keeper tag with blanks (13 keepers)

## Decision evidence — the blank-backfill mapping


| tag | relation | blanks to fill | current stamped values | blank becomes |
|---|---|---|---|---|
| spl | spelling | 192 | mm-li ×8383, mm-sf ×358, mm-pm ×3, us's'g ×1, ugs's'mual ×1, panipja'sit ×1, mp'gigwe'l ×1, mm ×1, gaqigiwto’qwamgitg ×1 | mm-li |
| sta | status | 433 | mm-li ×7484 | mm-li |
| tdo | todo | 585 | mm-li ×99 | mm ($defaultAll) |
| etx | example_text | 31 | mm-li ×7623, mm-sf ×557 | mm-li |
| alx | alternate_form_text | 154 | mm-li ×14551, mm-sf ×712 | mm-li |
| orf | other_regional_form | 1724 | mm-li ×40, mm ×2 | mm-li |
| att | attr | 12739 | — | mm ($defaultAll) |
| rtl | transliteration | 353 | mm-li ×1150 | mm-li |
| rse | source_as_entry | 44 | mm-li ×903, mm ×15, mm-pm ×11 | mm-li |
| rne | normalized_source_as_entry | 46 | mm-li ×899 | mm-li |
| rfr | foreign_reference | 1 | — | mm-li |
| rnp | public_note | 368 | — | mm ($defaultAll) |
| src | source | 783 | — | mm ($defaultAll) |

- Rule: $defaultAll tags (usually orthography-neutral content) → the 'mm' wildcard; all others → 'mm-li' (the corpus is Listuguj-dominant, and each tag's own stamped values above bear that out).

## Actions (DRY RUN — reported, NOT applied)


| action | tag | new value | rows |
|---|---|---|---|
| normalize-blank | spl | NULL | 191 |
| normalize-blank | sta | NULL | 432 |
| normalize-blank | tdo | NULL | 585 |
| normalize-blank | tra | NULL | 651 |
| null-literal | tra | NULL | 1 |
| normalize-blank | gls | NULL | 1031 |
| null-literal | gls | NULL | 2 |
| normalize-blank | etx | NULL | 31 |
| normalize-blank | etr | NULL | 547 |
| normalize-blank | erc | NULL | 12 |
| normalize-blank | prn | NULL | 13 |
| normalize-blank | alx | NULL | 154 |
| normalize-blank | orf | NULL | 15 |
| normalize-blank | att | NULL | 18 |
| normalize-blank | rtl | NULL | 353 |
| normalize-blank | rse | NULL | 44 |
| normalize-blank | rne | NULL | 46 |
| normalize-blank | rfr | NULL | 1 |
| normalize-blank | src | NULL | 5 |
| normalize-blank | rec | NULL | 29 |
| drop-notVariant | tra | NULL | 35 |
| drop-notVariant | gls | NULL | 24 |
| drop-notVariant | etr | NULL | 12 |
| drop-notVariant | erc | NULL | 531 |
| drop-notVariant | prn | NULL | 8321 |
| drop-notVariant | rec | NULL | 1629 |
| value-fix | rse | mm-pm | 15 |
| value-fix | orf | mm-li | 2 |
| value-fix | spl | mm-li | 1 |
| backfill-blank | spl | mm-li | 192 |
| backfill-blank | sta | mm-li | 433 |
| backfill-blank | tdo | mm | 585 |
| backfill-blank | etx | mm-li | 31 |
| backfill-blank | alx | mm-li | 154 |
| backfill-blank | orf | mm-li | 1724 |
| backfill-blank | att | mm | 12739 |
| backfill-blank | rtl | mm-li | 353 |
| backfill-blank | rse | mm-li | 44 |
| backfill-blank | rne | mm-li | 46 |
| backfill-blank | rfr | mm-li | 1 |
| backfill-blank | rnp | mm | 368 |
| backfill-blank | src | mm | 783 |

- 32184 row(s) WOULD change (dry run - nothing was written)

## The cases (decision-table review detail)

- value-fix `rse`: every case (15 row(s) → mm-pm)

| word | field text | variant was | becomes |
|---|---|---|---|
| [sasqeia'sit](/ww/wordwiki.entry(1790802170343329)) | (sasgeiato) sasgeiăsi, I lay down flooring | mm | mm-pm |
| [sasqate'get](/ww/wordwiki.entry(6071323139546673)) | sasgategei, I slap something | mm | mm-pm |
| [sa'p'g](/ww/wordwiki.entry(122468)) | sapmeg | mm | mm-pm |
| [sa'se'wamugwa'sit](/ww/wordwiki.entry(745737643981689)) | saseoamogoasi, I change my appearance, I transform | mm | mm-pm |
| [epnemugwet](/ww/wordwiki.entry(7068490568530547)) | epnmugwet, drink with | mm | mm-pm |
| [sasqo'plaw](/ww/wordwiki.entry(8950411935022719)) | sasgŏplao, flattened rod/pole/boom | mm | mm-pm |
| [saptesguatl](/ww/wordwiki.entry(2511595789026113)) | saptesguaji, he/she passes them | mm | mm-pm |
| [sasoqoman](/ww/wordwiki.entry(5346397076807397)) | sasŏgŏman, bunchberry | mm | mm-pm |
| [saptesguatl](/ww/wordwiki.entry(2511595789026113)) | saptesgag, I pass him/her | mm | mm-pm |
| [sasqo'plaw](/ww/wordwiki.entry(8950411935022719)) | sasgoplag, flattened rods/poles/booms | mm | mm-pm |
| [sa'se'wa'tasit](/ww/wordwiki.entry(5580875212477203)) | sa'se'wa'tasi, I change my ideas, I am changed | mm | mm-pm |
| [qasgusi](/ww/wordwiki.entry(120910)) | sasgosi or ğasğosi, cedar | mm | mm-pm |
| [sasqeia'toq](/ww/wordwiki.entry(1395175708537477)) | sasqeiatu, I lay it down (flooring) | mm | mm-pm |
| [sasqeia'latl](/ww/wordwiki.entry(2496189463150901)) | (sasgeiato) sasgeialeg, to lay down (flooring) | mm | mm-pm |
| [saps'g](/ww/wordwiki.entry(1795559667270423)) | sapsem, I cut through | mm | mm-pm |

- value-fix `orf`: every case (2 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [nipialsutmat](/ww/wordwiki.entry(2310240804424137)) | nipialasutmat | mm | mm-li |
| [nipisugwit](/ww/wordwiki.entry(2436025421793067)) | nipisigwit | mm | mm-li |

- value-fix `spl`: every case (1 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [nipisugwit](/ww/wordwiki.entry(2436025421793067)) | nipisigwit | mm | mm-li |

- backfill-blank `spl`: sample (192 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [mpesewigen](/ww/wordwiki.entry(4852632471235311)) | mpesewigen | NULL | mm-li |
| [pasangiaq](/ww/wordwiki.entry(1125737633416581)) | pasangiaq | NULL | mm-li |
| [crossed out entry](/ww/wordwiki.entry(7056232020525559)) | crossed out entry | NULL | mm-li |
| [amuspegitg](/ww/wordwiki.entry(7171212299942925)) | amuspegitg | NULL | mm-li |
| [pepgugsit](/ww/wordwiki.entry(2528730260464471)) | pepgugsit | NULL | mm-li |
| [nipatalg](/ww/wordwiki.entry(8859984122250817)) | nipatalg | NULL | mm-li |
| [giwset](/ww/wordwiki.entry(5936415261241991)) | giwset | NULL | mm-li |
| [naqanipgwa'tmg](/ww/wordwiki.entry(6077265662099475)) | naqanipgwa'tmg | NULL | mm-li |
| [usgagelsuti](/ww/wordwiki.entry(5913125471207693)) | usgagelsuti | NULL | mm-li |
| [AEI](/ww/wordwiki.entry(3847709554837483)) | AEI | NULL | mm-li |

- … and 182 more like these
- backfill-blank `sta`: sample (433 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [natagnutmuatl](/ww/wordwiki.entry(85197)) | Completed | NULL | mm-li |
| [nipetesmat](/ww/wordwiki.entry(1895465545067971)) | Completed | NULL | mm-li |
| [entry 1970386119290085](/ww/wordwiki.entry(1970386119290085)) | InProcessPDMOnly | NULL | mm-li |
| [sepawe’nmat](/ww/wordwiki.entry(1100339211047057)) | Completed | NULL | mm-li |
| [pugtewigtug](/ww/wordwiki.entry(2977205277022441)) | Completed | NULL | mm-li |
| [sa'se'wa'tasit](/ww/wordwiki.entry(5580875212477203)) | Completed | NULL | mm-li |
| [waqamisgegwat](/ww/wordwiki.entry(2434758715566313)) | InProcessPDMOnly | NULL | mm-li |
| [espogwasig](/ww/wordwiki.entry(6061096077452793)) | InProcessPDMOnly | NULL | mm-li |
| [nuta'mat](/ww/wordwiki.entry(96951)) | Completed | NULL | mm-li |
| [pepgwijeta'q](/ww/wordwiki.entry(1180100874486135)) | Completed | NULL | mm-li |

- … and 423 more like these
- backfill-blank `tdo`: sample (585 row(s) → mm)

| word | field text | variant was | becomes |
|---|---|---|---|
| [apt'sqi'gn](/ww/wordwiki.entry(11820)) | Todo | NULL | mm |
| [mejiganig](/ww/wordwiki.entry(1484627701318899)) | NeedsRecording | NULL | mm |
| [ugumuljin te's'gl](/ww/wordwiki.entry(587185155084746)) | NeedsRecording | NULL | mm |
| [Gisu'lgw](/ww/wordwiki.entry(48650)) | NeedsRecording | NULL | mm |
| [welisasqi'gan](/ww/wordwiki.entry(4179614903869874)) | NeedsRecording | NULL | mm |
| [mestegi'sasigewei/mest'gi'sas'gewei](/ww/wordwiki.entry(808703851524071)) | NeedsSpeakerGroupReview | NULL | mm |
| [ga'tomi](/ww/wordwiki.entry(34495)) | Todo | NULL | mm |
| [welo'tmasit](/ww/wordwiki.entry(158047)) | Todo | NULL | mm |
| [maqiguomguoma't](/ww/wordwiki.entry(3264387969594041)) | NeedsSpeakerGroupReview | NULL | mm |
| [aniapsuaqan](/ww/wordwiki.entry(8858692499700025)) | NeedsRecording | NULL | mm |

- … and 575 more like these
- backfill-blank `etx`: sample (31 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [ewlawsuaqan](/ww/wordwiki.entry(414089403307506)) | dmm | NULL | mm-li |
| [elsegni'gnji'jiganmit](/ww/wordwiki.entry(1361926334888966)) | dmm | NULL | mm-li |
| [ewlamatl](/ww/wordwiki.entry(4007384903522325)) | dmm | NULL | mm-li |
| [ewlawsuo'qon](/ww/wordwiki.entry(6191655970582883)) | dmm | NULL | mm-li |
| [ewlite'lmatl](/ww/wordwiki.entry(7814458831485153)) | dmm | NULL | mm-li |
| [qo'paniej](/ww/wordwiki.entry(4249268535093386)) | dmm | NULL | mm-li |
| [aniaptg](/ww/wordwiki.entry(5110870414476983)) | dmm | NULL | mm-li |
| [ewle'juti](/ww/wordwiki.entry(7703965776401607)) | dmm | NULL | mm-li |
| [ewliteltultijig](/ww/wordwiki.entry(7136723868733944)) | dmm | NULL | mm-li |
| [pewgweteget](/ww/wordwiki.entry(3420556289157327)) | dmm | NULL | mm-li |

- … and 21 more like these
- backfill-blank `alx`: sample (154 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [Gisu'lgw](/ww/wordwiki.entry(48650)) |  | NULL | mm-li |
| [ewlite'tasit](/ww/wordwiki.entry(7917753559361969)) | you (P) are thought of with pity/compassion | NULL | mm-li |
| [oqonoqo'piteg](/ww/wordwiki.entry(8144791786985264)) | they curled over/coiled (like a breaking wave) | NULL | mm-li |
| [ewlite'tmuatl](/ww/wordwiki.entry(3445706385982036)) | they (p) feel pity/compassion for his/her animate/inanima… | NULL | mm-li |
| [pastelg](/ww/wordwiki.entry(3184324953013788)) | they (p) break it by shooting | NULL | mm-li |
| [oqonoqo'pilatl](/ww/wordwiki.entry(6113917104636056)) | I blindfold you | NULL | mm-li |
| [papapuguet](/ww/wordwiki.entry(1560324957606499)) | you jest (d) | NULL | mm-li |
| [oqonoqupilsit](/ww/wordwiki.entry(6345353746295663)) | we (d) veil themselves | NULL | mm-li |
| [oqonoqo'pilatl](/ww/wordwiki.entry(6113917104636056)) | I blindfold him/her/it | NULL | mm-li |
| [mi'walsit](/ww/wordwiki.entry(1152152631076565)) | mi'walsultieg | NULL | mm-li |

- … and 144 more like these
- backfill-blank `orf`: sample (1724 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [Terminaisons -omg](/ww/wordwiki.entry(110)) |  | NULL | mm-li |
| [ajiet](/ww/wordwiki.entry(780)) | Ta's'g gloq (Nova Scotia) | NULL | mm-li |
| [ajiet](/ww/wordwiki.entry(780)) | Listuguj | NULL | mm-li |
| [ajioqjemin](/ww/wordwiki.entry(928)) | ajioqjimin, ajioqjomin | NULL | mm-li |
| [ajipugwennaji](/ww/wordwiki.entry(1028)) | ajipigwelnaji | NULL | mm-li |
| [ajipugwenn'g](/ww/wordwiki.entry(1053)) | ajipugweln'g | NULL | mm-li |
| [aji-**](/ww/wordwiki.entry(1161)) |  | NULL | mm-li |
| [aji-**](/ww/wordwiki.entry(1161)) |  | NULL | mm-li |
| [ajoqlue'j](/ww/wordwiki.entry(1181)) | ajoqluej, ajoqoluej, ajoqolue'j | NULL | mm-li |
| [ala](/ww/wordwiki.entry(1203)) | ala' (Nova Scotia) | NULL | mm-li |

- … and 1714 more like these
- backfill-blank `att`: sample (12739 row(s) → mm)

| word | field text | variant was | becomes |
|---|---|---|---|
| [agase'wa'latl](/ww/wordwiki.entry(133)) | shoebox-date | NULL | mm |
| [agase'wa'latl](/ww/wordwiki.entry(133)) | twitter-post | NULL | mm |
| [agase'wa'toq](/ww/wordwiki.entry(160)) | shoebox-date | NULL | mm |
| [agase'wa'toq](/ww/wordwiki.entry(160)) | twitter-post | NULL | mm |
| [agase'wit](/ww/wordwiki.entry(194)) | shoebox-date | NULL | mm |
| [agase'wit](/ww/wordwiki.entry(194)) | twitter-post | NULL | mm |
| [agnimatl](/ww/wordwiki.entry(224)) | shoebox-date | NULL | mm |
| [agnimatl](/ww/wordwiki.entry(224)) | twitter-post | NULL | mm |
| [agnimuet](/ww/wordwiki.entry(251)) | shoebox-date | NULL | mm |
| [agnimuet](/ww/wordwiki.entry(251)) | twitter-post | NULL | mm |

- … and 12729 more like these
- backfill-blank `rtl`: sample (353 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [wejijuig](/ww/wordwiki.entry(8961626219806927)) | wejijuig, flows from | NULL | mm-li |
| [usgitan](/ww/wordwiki.entry(8396538239385673)) | usgitan, envelope; | NULL | mm-li |
| [Dictionnaire Micmac Père Pacifique](/ww/wordwiki.entry(5346380514697653)) | Mi'gmaq Dictionary Father Pacifique, Capuchin | NULL | mm-li |
| [giwset](/ww/wordwiki.entry(5936415261241991)) | giwsei, come upon moose or caribou in their den | NULL | mm-li |
| [mi'walatl](/ww/wordwiki.entry(78321)) | mui’wal’g, thank, mui’waln, I thank you | NULL | mm-li |
| [saqapja'sit](/ww/wordwiki.entry(368828090882561)) | (oepteni) close, saqapja'si, saqapja'l'g | NULL | mm-li |
| [Terminaisons -omg](/ww/wordwiki.entry(110)) | Terminations -omg endings | NULL | mm-li |
| [saptesguatl](/ww/wordwiki.entry(2511595789026113)) | saptesgaq, saptesguaji, pass (gengatign, the letters) Jo.… | NULL | mm-li |
| [aweligj](/ww/wordwiki.entry(6087113041254737)) | aweligj, hazel wood, | NULL | mm-li |
| [maqi'gan](/ww/wordwiki.entry(8938092476632095)) | big, maqigan (gh), maqo'guom, maqigano'guo'm,maqigaqiguo'… | NULL | mm-li |

- … and 343 more like these
- backfill-blank `rse`: sample (44 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [espaqsing](/ww/wordwiki.entry(27989)) | espagsing, it flies high, he/she flies high | NULL | mm-li |
| [papawei](/ww/wordwiki.entry(100180)) | papawei, bean | NULL | mm-li |
| [papgug? papqu'g](/ww/wordwiki.entry(541878361044121)) | maybe the question mark is there because this might mean … | NULL | mm-li |
| [nepsiaqa’si](/ww/wordwiki.entry(5541320513731809)) | nepsiagāsit, rise high/go (up) high | NULL | mm-li |
| [espe'g](/ww/wordwiki.entry(28092)) | espei (Pronunciation guide: es·peey), I am important or h… | NULL | mm-li |
| [mi'walsit](/ww/wordwiki.entry(1152152631076565)) | mi'walsi, I thank myself | NULL | mm-li |
| [espa'toq](/ww/wordwiki.entry(28035)) | espa'tu, I lift it | NULL | mm-li |
| [esmatmugsit](/ww/wordwiki.entry(27598)) | esmatmugsi, I am pretty/lovely/nice/attractive | NULL | mm-li |
| [pempegitg](/ww/wordwiki.entry(107107)) | pempegitg, it flows | NULL | mm-li |
| [na'ntemigjematl](/ww/wordwiki.entry(6040514465645495)) | na'ntemigjemg: I check him/her for fleas | NULL | mm-li |

- … and 34 more like these
- backfill-blank `rne`: sample (46 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [ejina'gwit](/ww/wordwiki.entry(17401)) | ejina'guit, low sided container | NULL | mm-li |
| [esp'teg](/ww/wordwiki.entry(28391)) | esp'teg, it is high/tall | NULL | mm-li |
| [esmatmugsit](/ww/wordwiki.entry(27598)) | esmatmugsit, he/she/it is pretty/lovely/nice/attractive | NULL | mm-li |
| [espa'gwit](/ww/wordwiki.entry(27786)) | espa'guit, high sided container (vase) | NULL | mm-li |
| [espetg](/ww/wordwiki.entry(3160857275046825)) | espetg/esp'tg, high hill | NULL | mm-li |
| [la'qana'toq](/ww/wordwiki.entry(628233070319343)) | la'qana'toq, he/she makes an injury/inflicts a wound on it | NULL | mm-li |
| [aweligjaqamigt](/ww/wordwiki.entry(8392297050256717)) | aweligjaqamigt, hazel wood grove | NULL | mm-li |
| [gasgigweta'tl](/ww/wordwiki.entry(4226287219374627)) | gasgigweteta'tl, he/she strikes him/her on the face, he/s… | NULL | mm-li |
| [mi'walsit](/ww/wordwiki.entry(1152152631076565)) | mi'walsit, he/she thanks himself/herself | NULL | mm-li |
| [nipetesmuatl](/ww/wordwiki.entry(3620982608182423)) | nipetesmuatl, he/she cooks (rice, etc.) overnight for him… | NULL | mm-li |

- … and 36 more like these
- backfill-blank `rfr`: sample (1 row(s) → mm-li)

| word | field text | variant was | becomes |
|---|---|---|---|
| [mestagsepgu / mestags'pgw tba](/ww/wordwiki.entry(226240702597482)) |  | NULL | mm-li |

- backfill-blank `rnp`: sample (368 row(s) → mm)

| word | field text | variant was | becomes |
|---|---|---|---|
| [apt'sqa'tl](/ww/wordwiki.entry(11797)) | apt'sqa'in, you lock me up  | NULL | mm |
| [sepawe’nmat](/ww/wordwiki.entry(1100339211047057)) | On page of "pogteo, fire" related words. | NULL | mm |
| [nantunewet](/ww/wordwiki.entry(82772)) | nenatunewei, I search by hand, feel about | NULL | mm |
| [papgugewei, papqu'gewei ](/ww/wordwiki.entry(544102514828645)) | unresolved reference A. M. 361 possible reference to Abbe… | NULL | mm |
| [apt'puguet](/ww/wordwiki.entry(7188456070225441)) | Reference: (Pi. Met.) P. Metallic | NULL | mm |
| [mimgusgawo'guomgeg](/ww/wordwiki.entry(3017564377721581)) | mim- round like making a fist, from mimtoqopsga'toq (Joe … | NULL | mm |
| [paspa'q](/ww/wordwiki.entry(6061874700166303)) | (129, 1) is a reference to Clark's Dictionary, page 129, … | NULL | mm |
| [metpit](/ww/wordwiki.entry(6560621316957755)) | On page of "pogteo, fire" related words. | NULL | mm |
| [oqonoqopisit](/ww/wordwiki.entry(1414951365656199)) | oqonoqopisit, he/she is masked | NULL | mm |
| [ewle'juinu'sgw](/ww/wordwiki.entry(3869961271270178)) | According to the Speaker's group, this term does not refe… | NULL | mm |

- … and 358 more like these
- backfill-blank `src`: sample (783 row(s) → mm)

| word | field text | variant was | becomes |
|---|---|---|---|
| [agnimuet](/ww/wordwiki.entry(251)) | wwsd (Watson's 1SchDct 12/Sep/2002) rf MGFP -p85 | NULL | mm |
| [agoqomaw](/ww/wordwiki.entry(376)) | ww | NULL | mm |
| [agumegw](/ww/wordwiki.entry(399)) | wwsd (Watson's 1SchDct 12/Sep/2002) | NULL | mm |
| [-aig](/ww/wordwiki.entry(447)) | ww | NULL | mm |
| [aitetapu](/ww/wordwiki.entry(489)) | dmm 27 Sept 2010 | NULL | mm |
| [aja'sit](/ww/wordwiki.entry(515)) | wwsd (Watson's 1SchDct 12/Sep/2002) | NULL | mm |
| [ajgnewa'toq**](/ww/wordwiki.entry(712)) | ww | NULL | mm |
| [aji-](/ww/wordwiki.entry(744)) | ww | NULL | mm |
| [ajiaq_suliewei](/ww/wordwiki.entry(760)) | ww | NULL | mm |
| [ajioqjemin](/ww/wordwiki.entry(928)) | wwsd | NULL | mm |

- … and 773 more like these

## Hand-triage remainder (deliberately untouched)

- **`spl` [gaqigiwto’qwamgwitg](/ww/wordwiki.entry(6600191186939385)): variant 'gaqigiwto’qwamgitg' needs a human decision**
- **`spl` [panilja'sit](/ww/wordwiki.entry(8827091097655615)): variant 'panipja'sit' needs a human decision**
- **`spl` [mpugugwe'l](/ww/wordwiki.entry(6025112336228945)): variant 'mp'gigwe'l' needs a human decision**
- **`spl` [us'seg](/ww/wordwiki.entry(3692627557683377)): variant 'us's'g' needs a human decision**
- **`spl` [ugs'semual](/ww/wordwiki.entry(5586271656062367)): variant 'ugs's'mual' needs a human decision**
