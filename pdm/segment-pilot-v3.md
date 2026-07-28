# PDM segmentation pilot (task starts, prompt v2)

Pages 4, 40, 67, 101, 172, 209, 250, 324, 435, 550; models claude-sonnet-5 vs claude-opus-4-8.  Scored against
the hand Tagging groups: pairwise same-entry F1 over words covered by both
gold and proposal; 'recovered' = gold groups matched by a >=80% pure+complete
proposed entry.  Divergence = same-entry disagreement between the models.

| page | runs | gold | ceiling | sonnet F1 / rec / conf | opus F1 / rec / conf | diverge |
|---|---|---|---|---|---|---|
| 4 | 10 | 8 | 0 | 0 / 8/8 / c55 | 20 / 3/9 / c55 | 14% |
| 40 | 79 | 52 | 70 | 67 / 9/52 / c45 | 67 / 10/52 / c42 | 1% |
| 67 | 97 | 55 | 68 | 82 / 20/55 / c55 | 72 / 18/55 / c55 | 1% |
| 101 | 74 | 65 | 62 | 61 / 13/65 / c55 | 58 / 9/65 / c55 | 1% |
| 172 | 79 | 53 | 56 | 60 / 8/53 / c45 | 59 / 7/53 / c55 | 1% |
| 209 | 83 | 49 | 75 | 69 / 18/49 / c62 | 74 / 20/49 / c55 | 1% |
| 250 | 154 | 64 | 35 | 36 / 3/64 / c55 | 38 / 4/64 / c42 | 1% |
| 324 | 59 | 25 | 76 | 100 / 21/25 / c55 | 73 / 14/27 / c55 | 1% |
| 435 | 121 | 31 | 70 | 59 / 6/31 / c45 | 68 / 7/31 / c42 | 2% |
| 550 | 67 | 55 | 70 | 54 / 12/55 / c55 | 71 / 12/55 / c55 | 3% |

- **run-granularity ceiling**: mean pair-F1 58.4%
- **claude-sonnet-5**: mean pair-F1 58.8%, mean recovered-group rate 35.5%
- **claude-opus-4-8**: mean pair-F1 60.0%, mean recovered-group rate 25.6%
- mean cross-model divergence: 2.5%

## Usage (actual API spend this run)

- pdm-starts: 20 calls, 66324 in / 14359 out
