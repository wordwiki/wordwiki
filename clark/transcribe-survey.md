# Clark layer-1 transcription survey

Pages 1, 40, 85, 130, 170; band-transcribe v1, entry-interpret v1, model claude-opus-4-8.
Line scoring compares diacritic-FOLDED LLM lines against the (accent-stripped) textract lines - it checks reading fidelity, NOT diacritic fidelity (that needs the stage-B hand reference).

## Printed page 1

- lines: 70; aligned 69, fold-exact 66 (95.7%), near (dist<=2) 2, disagreeing 1; model dropped 1 (headers etc.), extra 0
- entry starts (hanging indent): 28; headword in rand window: 3 (10.7%)

### Disagreeing lines (textract vs LLM, first 15)

- d3 | `see .` | `see *āoū*.`

### Headwords NOT in the rand window (25)

`ababatc`, `ababatcwotk`, `abābe`, `ababulooe`, `abadā`, `abadak`, `abadakun`, `abadalālun`, `abadām`, `abadookse`, `abadoolk`, `abadooôkwā`, `abadooôwāk`, `abadowoolā`, `abadunum`, `abadunumadimk`, `abajadase`, `abajādoo`, `abajēgādoo`, `abajekwām`, `abajekuloose`, `abajigadoo`, `abajikwāe`, `abajimsunumase`, `abajipkesadoo`

### Interpreted entries (layer-2 taste, first 3)

```
*ā*, very well, yes, I approve of
it, assent to it, it is so; cf.
English aye; negative *mogwā*,
see *āoū*.
=>
{
  "headword": "ā",
  "glosses": [
    "very well",
    "yes",
    "I approve of it",
    "assent to it",
    "it is so"
  ],
  "cross_refs": [
    "cf. English aye",
    "see āoū"
  ],
  "notes": [
    "negative mogwā"
  ],
  "confidence": 95
}
```

```
*ababatc*, a jib; *lit*, a rope-sail;
*ababatcwā*, adj. relating to a
jib.
=>
{
  "headword": "ababatc",
  "glosses": [
    "a jib"
  ],
  "notes": [
    "lit, a rope-sail"
  ],
  "derivatives": [
    {
      "form": "ababatcwā",
      "gloss": "adj. relating to a jib"
    }
  ],
  "confidence": 95
}
```

```
*ababatcwotk*, a bowsprit; *aba-*
*bātcwotkā*, characteristic of a
bowsprit.
=>
{
  "headword": "ababatcwotk",
  "glosses": [
    "a bowsprit"
  ],
  "derivatives": [
    {
      "form": "ababātcwotkā",
      "gloss": "characteristic of a bowsprit"
    }
  ],
  "confidence": 90
}
```

## Printed page 40

- lines: 93; aligned 90, fold-exact 79 (87.8%), near (dist<=2) 11, disagreeing 0; model dropped 3 (headers etc.), extra 0
- entry starts (hanging indent): 41; headword in rand window: 6 (14.6%)

### Headwords NOT in the rand window (35)

`eguntook`, `eguskegwedāk`, `egwadesmasē`, `egwadesumaseanul`, `egwedamā`, `egwedī`, `egwejadoo`, `egwejega`, `egwejin`, `ēgwejôdoo`, `egwejboldigul`, `egwitcāwā`, `ejakjedesīn`, `ejakudek`, `ejaktcedāk`, `ejedoomkwase`, `ejeladoo`, `ejelaluk`, `ejeleā`, `ejeleoolimk`, `ejelimk`, `ejelwekugā`, `ejenabek`, `ejenagwit`, `a ejenagwĕjejit`, `ejeneā`, `ejeneakāet`, `ejetooómkwedak`, `ejetooómkwaluk`, `ejetooómkwasē`, `ejetooómkwesumasē`, `ejetooómkwesumooktak`, `ejoonkweĭek`, `ejidoonkwodejadoo`, `ejiguledādum`

### Interpreted entries (layer-2 taste, first 3)

```
*eguntook*, ahead, in front of.
=>
{
  "headword": "eguntook",
  "glosses": [
    "ahead",
    "in front of"
  ],
  "confidence": 97
}
```

```
*eguskegwedāk*, I slap him on
the face.
=>
{
  "headword": "eguskegwedāk",
  "glosses": [
    "I slap him on the face."
  ],
  "confidence": 96
}
```

```
*egwadesmasē*, I place something
under the head for a pillow.
=>
{
  "headword": "egwadesmasē",
  "glosses": [
    "I place something under the head for a pillow."
  ],
  "confidence": 96
}
```

## Printed page 85

- lines: 72; aligned 71, fold-exact 67 (94.4%), near (dist<=2) 4, disagreeing 0; model dropped 1 (headers etc.), extra 0
- entry starts (hanging indent): 34; headword in rand window: 11 (32.4%)

### Headwords NOT in the rand window (23)

`labāe`, `labaktestakun`, `labaltināwa`, `labegēsigun`, `labelasabe`, `labesogun`, `Lablalōt`, `laboksoon`, `lagab`, `lagīgunabe`, `lagun`, `lagunā`, `lagunadoo`, `lakpadakunabe`, `lamāk`, `lamakesun`, `lamamkoodook`, `lamatk`, `lamatkīkt`, `'amibunek`, `'amigwom`, `'amiltcun`, `!amitpook`

### Interpreted entries (layer-2 taste, first 3)

```
*labāe*, a keeler, shallow tub
    *labatcētc*, (dimunitive), a little|
tub; *ejenagwēt* is the proper|
word in P. E. I. to-day.
=>
{
  "headword": "labāe",
  "glosses": [
    "a keeler, shallow tub"
  ],
  "derivatives": [
    {
      "form": "labatcētc",
      "gloss": "(diminutive), a little tub"
    }
  ],
  "notes": [
    "ejenagwēt is the proper word in P. E. I. to-day."
  ],
  "cross_refs": [
    "ejenagwēt"
  ],
  "confidence": 88
}
```

```
*labaktestakun*, a standard of|
measurement, ruler, compass-
es, straight-edge, chalk-line.
=>
{
  "headword": "labaktestakun",
  "glosses": [
    "a standard of measurement",
    "ruler",
    "compasses",
    "straight-edge",
    "chalk-line"
  ],
  "confidence": 90
}
```

```
*labaltināwa*, holy-water.
=>
{
  "headword": "labaltināwa",
  "glosses": [
    "holy-water"
  ],
  "confidence": 97
}
```

## Printed page 130

- lines: 92; aligned 90, fold-exact 84 (93.3%), near (dist<=2) 4, disagreeing 2; model dropped 2 (headers etc.), extra 0
- entry starts (hanging indent): 42; headword in rand window: 10 (23.8%)

### Disagreeing lines (textract vs LLM, first 15)

- d3 | `-130-` | `-130—                    PEG`
- d3 | `begajeankrendum, I keep it care-` | `*begajeankwodum*, I keep it care-`

### Headwords NOT in the rand window (32)

`peboogoolegwok`, `pebooskadoo`, `pedabâktusin`, `pedabāwê`, `pedagāwāl`, `pedăk`, `pedāsooēm`, `pedătkweak`, `pedeadasik`, `pedogamoosegek`, `pedōgwat`, `pedoksit`, `pedoktām`, `pēdoobegasik`, `pedoobuk`, `pedoodoo`, `pedoogoonōsum`, `-130—                    PEG`, `Pēduobók`, `peduptoo`, `peduwēgā`, `pegabāwe`, `pegadoo`, `begajeankwodum`, `pegajenoogwadoo`, `pejak`, `pegalkoodunase`, `pegāoolabase`, `pegai`, `pegāwadoo`, `pegāweagase`, `pegepoogwe`

### Interpreted entries (layer-2 taste, first 3)

```
*pebe*, I have a sore (ulcerated)
mouth.
=>
{
  "headword": "pebe",
  "glosses": [
    "I have a sore (ulcerated) mouth"
  ],
  "confidence": 96
}
```

```
*pebimkāwā*, alum, remedy for
sore mouth.
=>
{
  "headword": "pebimkāwā",
  "glosses": [
    "alum",
    "remedy for sore mouth"
  ],
  "confidence": 95
}
```

```
*peboogoolegwok*, pimpled, cov-
ered with an eruption,[2]bird-
eye maple.
=>
{
  "headword": "peboogoolegwok",
  "glosses": [
    "pimpled, covered with an eruption",
    "bird-eye maple"
  ],
  "confidence": 85
}
```

## Printed page 170

- lines: 91; aligned 90, fold-exact 82 (91.1%), near (dist<=2) 5, disagreeing 3; model dropped 1 (headers etc.), extra 0
- entry starts (hanging indent): 57; headword in rand window: 17 (29.8%)

### Disagreeing lines (textract vs LLM, first 15)

- d3 | `wenjoetag, I box, strik` | `*wenjoŏtāgā*, I box, s t r i k e`
- d3 | `-170-` | `-170—                    WES`
- d3 | `weskakeluma, kiss line, embrace.` | `*weskakelumā*, kiss me, embrace.`

### Headwords NOT in the rand window (40)

`wenjooe`, `wenjooēgan`, `wenjooegantcētc`, `wenjooegētakŭn`, `wenjooesegubun`, `wenjooetagun`, `wenjooetcēmā`, `wenjoolkadook`, `wenjoŏtāgā`, `wenjootĕam`, `wenjootĕamwā`, `wenjootĕamwēse`, `wenjootckwetc`, `wenjunkī`, `wenmajāk`, `wenmajetabloomk`, `wenmajīlsomk`, `wenmajīlsoomajul`, `-170—                    WES`, `wenmajogun`, `wep`, `wepkoomakunā`, `wepkoomanul`, `wēs`, `wesabegalow`, `wesāk`, `wesameboogwelk`, `wesamenkusiū`, `wesawāk`, `wesāse`, `wesâwegesum`, `wesek`, `Wesek`, `wesemoogwā`, `weskakeĺum`, `weskakelumā`, `weskawâse`, `weskawegwase`, `weskijadoo`, `weskitegadoo`

### Interpreted entries (layer-2 taste, first 3)

```
*wenjāwe*, I lead.
=>
{
  "headword": "wenjāwe",
  "glosses": [
    "I lead"
  ],
  "confidence": 97
}
```

```
*wenjooe*, a  prefix  m e a n i n g
French; *Wenootc.*
=>
{
  "headword": "wenjooe",
  "glosses": [
    "a prefix meaning French"
  ],
  "cross_refs": [
    "Wenootc."
  ],
  "confidence": 82
}
```

```
*wenjooēgan*, (*wenjoogwam*), a
frame house, a French house.
=>
{
  "headword": "wenjooēgan",
  "alt_spellings": [
    "wenjoogwam"
  ],
  "glosses": [
    "a frame house",
    "a French house"
  ],
  "confidence": 92
}
```

## Usage (actual API spend this run; cache hits free)

- total ~$0.00
