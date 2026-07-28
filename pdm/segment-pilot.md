# PDM segmentation pilot (prompt v2)

Pages 4, 40, 67, 101, 172, 209, 250, 324, 435, 550; models claude-sonnet-5 vs claude-opus-4-8.  Scored against
the hand Tagging groups: pairwise same-entry F1 over words covered by both
gold and proposal; 'recovered' = gold groups matched by a >=80% pure+complete
proposed entry.  Divergence = same-entry disagreement between the models.

| page | runs | gold | ceiling | sonnet F1 / rec / conf | opus F1 / rec / conf | diverge |
|---|---|---|---|---|---|---|
| 4 | 10 | 8 | 100 | 7 / 1/8 / c45 | 67 / 5/7 / c42 | 93% |
| 40 | 79 | 52 | 93 | 71 / 12/52 / c45 | 66 / 8/52 / c55 | 1% |
| 67 | 97 | 55 | 93 | 60 / 9/55 / c45 | 67 / 14/54 / c55 | 2% |
| 101 | 74 | 65 | 82 | 62 / 19/65 / c45 | 50 / 10/64 / c55 | 2% |
| 172 | 79 | - | - | FAILED | - |
| 209 | 83 | - | - | FAILED | - |
| 250 | 154 | 64 | 100 | 23 / 15/64 / c40 | 45 / 5/64 / c42 | 3% |
| 324 | 59 | 26 | 97 | 64 / 14/26 / c45 | 71 / 14/27 / c55 | 2% |
| 435 | 121 | - | - | FAILED | - |
| 550 | 67 | 55 | 89 | 60 / 11/55 / c45 | 70 / 12/55 / c55 | 2% |

**3 page(s) FAILED after retries.**

- **run-granularity ceiling**: mean pair-F1 93.3%
- **claude-sonnet-5**: mean pair-F1 49.6%, mean recovered-group rate 25.5%
- **claude-opus-4-8**: mean pair-F1 62.2%, mean recovered-group rate 30.0%
- mean cross-model divergence: 14.9%

## Usage (actual API spend this run)

- pdm-segment: 30 calls, 107334 in / 43970 out
