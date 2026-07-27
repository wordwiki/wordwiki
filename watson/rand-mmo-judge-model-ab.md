# Judge model A/B: claude-opus-4-8 (reference) vs claude-sonnet-5

10 clusters, 42 judged pairs.

- verdict agreement: 36/42 (85.7%)
- verdict+confidence agreement: 27
- opus failed clusters: 0; sonnet failed clusters: 0
- sonnet usage: 10 call(s), 18626 in / 3394 out tokens this run (opus side cached)

## Disagreements
- **wapiet** -> **wata's'g**: opus unrelated[high] (Shared 'becoming' only; means eye cataract, unrelated form.) | sonnet related[low] (Both involve color-related bodily change (cataract clouding vs becoming white), plausible semantic overlap though different roots.)
- **nesp'gimuatl** -> **mawgitg**: opus related[low] (mawgitg 'include in the count/add' plausibly shares counting root; weaker match.) | sonnet unrelated[medium] (means 'include in count/add', different stem and broader math sense)
- **nesp'gimuatl** -> **nespilugweg**: opus related[low] (nespilugweg shares the nesp- 'along with/simultaneously' prefix as in probe nesp'gimuatl; different stem.) | sonnet unrelated[high] (about working while counting, different root and meaning)
- **mawalaji** -> **mawpega'toq**: opus related[low] (mawpega'toq shares maw- prefix but means mix/collect liquid.) | sonnet unrelated[medium] (Different meaning 'mix/collect liquid', root differs (mawpega- vs mawalaji))
- **news'g** -> **news'g**: opus same-word[high] (Exact skeleton 'newsg' and meanings agree: zephyr is a gentle breeze, matching 'breezy/draughty'.) | sonnet related[medium] (Exact skeleton match 'newsg' and both meanings relate to wind/breeze, though 'zephyr' (gentle wind) and 'draughty' (unwanted wind/draft) are distinct senses of same root.)
- **etawet** -> **mesugtaqanat**: opus related[medium] (Shares definition 'crave' but the Mi'gmaq forms (mesugtaqanat vs etawet) are entirely different words.) | sonnet unrelated[medium] (Shares only the English gloss 'crave'; headword 'mesugtaqanat' shares no root or skeleton with 'etawet'.)

## Sonnet failures
