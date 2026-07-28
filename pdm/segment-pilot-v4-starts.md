# PDM segmentation pilot (task starts, gold merged, prompt v2)

Pages 4, 40, 67, 101, 172, 209, 250, 324, 435, 550; models claude-sonnet-5 vs claude-opus-4-8.  Scored against
the hand Tagging groups: pairwise same-entry F1 over words covered by both
gold and proposal; 'recovered' = gold groups matched by a >=80% pure+complete
proposed entry.  Divergence = same-entry disagreement between the models.

| page | runs | gold | ceiling | sonnet F1 / rec / conf | opus F1 / rec / conf | diverge |
|---|---|---|---|---|---|---|
| 4 | 10 | 8 | 50 | 0 / 8/8 / c55 | 36 / 3/8 / c55 | 14% |
| 40 | 79 | 27 | 65 | 58 / 11/27 / c45 | 54 / 13/27 / c42 | 1% |
| 67 | 97 | 40 | 69 | 83 / 21/40 / c55 | 74 / 18/40 / c55 | 1% |
| 101 | 74 | 34 | 75 | 59 / 13/34 / c55 | 62 / 13/34 / c55 | 1% |
| 172 | 79 | 43 | 53 | 60 / 11/43 / c45 | 59 / 9/43 / c55 | 1% |
| 209 | 83 | 39 | 73 | 72 / 19/39 / c62 | 76 / 21/39 / c55 | 1% |
| 250 | 154 | 35 | 51 | 49 / 3/35 / c55 | 51 / 4/35 / c42 | 1% |
| 324 | 59 | 22 | 70 | 89 / 21/22 / c55 | 67 / 15/24 / c55 | 1% |
| 435 | 121 | 25 | 76 | 64 / 8/25 / c45 | 74 / 12/25 / c42 | 2% |
| 550 | 67 | 37 | 78 | 62 / 15/37 / c55 | 76 / 16/37 / c55 | 3% |

- **run-granularity ceiling**: mean pair-F1 66.0%
- **claude-sonnet-5**: mean pair-F1 59.7%, mean recovered-group rate 48.2%
- **claude-opus-4-8**: mean pair-F1 62.9%, mean recovered-group rate 40.9%
- mean cross-model divergence: 2.5%

## Usage (actual API spend this run)

