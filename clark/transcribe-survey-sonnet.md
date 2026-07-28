# Clark layer-1 transcription survey

Pages 1, 40, 85, 130, 170; band-transcribe v1, entry-interpret v1, model claude-sonnet-5.
Line scoring compares diacritic-FOLDED LLM lines against the (accent-stripped) textract lines - it checks reading fidelity, NOT diacritic fidelity (that needs the stage-B hand reference).

## Printed page 1

- lines: 70; aligned 69, fold-exact 66 (95.7%), near (dist<=2) 2, disagreeing 1; model dropped 1 (headers etc.), extra 1
- entry starts (hanging indent): 28; headword in rand window: 3 (10.7%)

### Disagreeing lines (textract vs LLM, first 15)

- d3 | `see .` | `see *āoū*.`

### Headwords NOT in the rand window (25)

`ababatc`, `ababatcwotk`, `abābe`, `ababulooe`, `abadā`, `abadak`, `abadakun`, `abadalālun`, `abadām`, `abadookse`, `abadoolk`, `abadooôkwā`, `abadooôwāk`, `abadowoolā`, `abadunum`, `abadunumadimk`, `abajadase`, `abajādoo`, `abajēgādoo`, `abajekwām`, `abajekuloose`, `abajigadoo`, `abajikwāe`, `abajimsunumase`, `abajipkesadoo`

### Interpreted entries (layer-2 taste, first 3)

```
ā, very well, yes, I approve of
it, assent to it, it is so; cf.
English aye; negative *mogwā*,
see *āoū*.
=>
{
  "headword": "ā",
  "glosses": [
    "very well",
    "yes, I approve of it, assent to it, it is so"
  ],
  "cross_refs": [
    "cf. English aye",
    "negative *mogwā*",
    "see *āoū*"
  ],
  "confidence": 85
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
    "a jib",
    "a rope-sail"
  ],
  "derivatives": [
    {
      "form": "ababatcwā",
      "gloss": "adj. relating to a jib"
    }
  ],
  "notes": [
    "lit, a rope-sail"
  ],
  "confidence": 85
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
  "confidence": 70
}
```

## Printed page 40

- lines: 93; aligned 91, fold-exact 81 (89.0%), near (dist<=2) 10, disagreeing 0; model dropped 2 (headers etc.), extra 1
- entry starts (hanging indent): 42; headword in rand window: 6 (14.3%)

### Headwords NOT in the rand window (36)

`eguntook`, `eguskegwedāk`, `egwadesmasē`, `egwadesumaseanul`, `egwedamā`, `egwedī`, `egwejadoo`, `egwejega`, `egwejin`, `ēgwejôdoo`, `egwejboldigul`, `egwitcāwā`, `ejakjedesīn`, `ejakudek`, `ejaktcedāk`, `ejedoomkwase`, `ejeladoo`, `ejelaluk`, `ejeleā`, `ejeleoolimk`, `ejelimk`, `ejelwekugā`, `ejenabek`, `ejenagwit`, `a ejenagwejejit`, `ejeneā`, `ejeneakāet`, `ejetooómkwedak`, `ejetooómkwaluk`, `ejetooómkwasē`, `ejetooómkwesumasē`, `ejetooómkwesumooktak`, `I`, `ejoonkwedek`, `ejidoonkwodejadoo`, `ejiguledādum`

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
  "confidence": 90
}
```

```
*eguskegwedāk*, I slap him on
the face.
=>
{
  "headword": "eguskegwedāk",
  "glosses": [
    "I slap him on the face"
  ],
  "confidence": 90
}
```

```
*egwadesmasē*, I place something
under the head for a pillow.
=>
{
  "headword": "egwadesmasē",
  "glosses": [
    "I place something under the head for a pillow"
  ],
  "confidence": 85
}
```

## Printed page 85

- lines: 72; aligned 72, fold-exact 69 (95.8%), near (dist<=2) 3, disagreeing 0; model dropped 0 (headers etc.), extra 0
- entry starts (hanging indent): 34; headword in rand window: 12 (35.3%)

### Headwords NOT in the rand window (22)

`labāe`, `labaktestakun`, `labaltināwa`, `labegēsigun`, `labelasabe`, `labesogun`, `Lablalōt`, `laboksoon`, `lagab`, `lagīgunabe`, `lagun`, `lagunā`, `lagunadoo`, `lakpadakunabe`, `lamāk`, `lamakesun`, `lamamkoodook`, `lamatk`, `lamatkīkt`, `'amibunek`, `'amigwom`, `'amiltcun`

### Interpreted entries (layer-2 taste, first 3)

```
*labāe*, a keeler, shallow tub
   *labatcētc*, (dimunitive), a little
   tub; *ejenagwēt* is the proper
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
      "gloss": "(dimunitive), a little tub"
    },
    {
      "form": "ejenagwēt",
      "gloss": "is the proper word in P. E. I. to-day"
    }
  ],
  "notes": [
    "ejenagwēt is the proper word in P. E. I. to-day."
  ],
  "confidence": 80
}
```

```
*labaktestakun*, a standard of
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
  "confidence": 90
}
```

## Printed page 130

- lines: 92; aligned 90, fold-exact 86 (95.6%), near (dist<=2) 3, disagreeing 1; model dropped 2 (headers etc.), extra 1
- entry starts (hanging indent): 41; headword in rand window: 9 (22.0%)

### Disagreeing lines (textract vs LLM, first 15)

- d4 | `begajeankrendum, I keep it care-` | `*pegajeankwodum*, I keep it care-`

### Headwords NOT in the rand window (32)

`peboogoolegwok`, `pebooskadoo`, `pedabâktusin`, `pedabăwē`, `pedagāwāl`, `pedâk`, `pedāsooēm`, `pedâtkweak`, `pedeadasik`, `pedek. it is inside something;`, `pedogamoosegek`, `pedōgwat`, `pedoksit. long-quilled ;  (2)`, `pedoktām`, `pēdoobĕgasik`, `pedoobuk`, `pedoodoo`, `pedoogoonōsum`, `Pēduobók`, `peduptoo`, `peduwēgā`, `pegabāwe`, `pegadoo`, `pegajeankwodum`, `pegajénoogwadoo`, `pejak`, `pegalkoodunase`, `pegāoolabase`, `pegat`, `pegāwadoo`, `pegāweagase`, `pegepoogwe`

### Interpreted entries (layer-2 taste, first 3)

```
*pebe*, I have a  sore  (ulcerated)
mouth.
=>
{
  "headword": "pebe",
  "glosses": [
    "I have a sore (ulcerated) mouth."
  ],
  "confidence": 85
}
```

```
*pebimkāwā*, alum, remedy for
sore mouth.
=>
{
  "headword": "pebimkāwā",
  "glosses": [
    "alum, remedy for sore mouth"
  ],
  "confidence": 85
}
```

```
*peboogoolegwok*, pimpled, cov-
ered with an eruption, [2] bird-
eye maple.
=>
{
  "headword": "peboogoolegwok",
  "glosses": [
    "pimpled, covered with an eruption",
    "bird-eye maple"
  ],
  "confidence": 80
}
```

## Printed page 170

- lines: 91; aligned 89, fold-exact 84 (94.4%), near (dist<=2) 3, disagreeing 2; model dropped 2 (headers etc.), extra 0
- entry starts (hanging indent): 56; headword in rand window: 17 (30.4%)

### Disagreeing lines (textract vs LLM, first 15)

- d3 | `wenjoetag, I box, strik` | `*wenjootāgā*, I box, s t r i k e`
- d3 | `weskakeluma, kiss line, embrace.` | `*weskakelumā*, kiss me, embrace.`

### Headwords NOT in the rand window (39)

`wenjooe`, `wenjooēgan`, `wenjooegantcētc`, `wenjooegētakun`, `wenjooesegubun`, `wenjooetagun`, `wenjooetcēmā`, `wenjoolkadook`, `wenjootāgā`, `wenjootēam`, `wenjoutēamwā`, `wenjootēamwēse`, `wenjootckwetc`, `wenjunkī`, `wenmajāk`, `wenmajetabloomk`, `wenmajīlsomk`, `wenmajīlsoomajul`, `wenmajogun`, `wep`, `wepkoomakunā`, `wepkoomanul`, `wēs`, `wesabegalow`, `wesāk`, `wesameboogwelk`, `wesamenkusīū`, `wesawāk`, `wesāse`, `wesáwegesum`, `wesek`, `Wesek`, `wesemoogwā`, `weskakelum`, `weskakelumā`, `weskawâse`, `weskawegwase`, `weskijadoo`, `weskitegadoo`

### Interpreted entries (layer-2 taste, first 3)

```
*wenjāwe*, I lead.
=>
{
  "headword": "wenjāwe",
  "glosses": [
    "I lead"
  ],
  "confidence": 90
}
```

```
*wenjooe*, a prefix meaning
  French; *Wenootc*.
=>
{
  "headword": "wenjooe",
  "glosses": [
    "a prefix meaning French"
  ],
  "alt_spellings": [
    "Wenootc"
  ],
  "confidence": 70
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
  "confidence": 88
}
```

## Usage (actual API spend this run; cache hits free)

- band-transcribe: 30 calls, 77994 in / 7614 out tokens (~$0.35)
- clark-entry-interpret: 15 calls, 17927 in / 1862 out tokens (~$0.08)
- total ~$0.43
