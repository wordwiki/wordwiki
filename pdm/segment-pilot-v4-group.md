# PDM segmentation pilot (task group, gold merged, prompt v2)

Pages 4, 40, 67, 101, 172, 209, 250, 324, 435, 550; models claude-sonnet-5 vs claude-opus-4-8.  Scored against
the hand Tagging groups: pairwise same-entry F1 over words covered by both
gold and proposal; 'recovered' = gold groups matched by a >=80% pure+complete
proposed entry.  Divergence = same-entry disagreement between the models.

| page | runs | gold | ceiling | sonnet F1 / rec / conf | opus F1 / rec / conf | diverge |
|---|---|---|---|---|---|---|
| 4 | 10 | 7 | 100 | 13 / 1/7 / c45 | 100 / 6/6 / c42 | 93% |
| 40 | 79 | 27 | 100 | 56 / 16/27 / c45 | 53 / 10/27 / c55 | 1% |
| 67 | 97 | 40 | 96 | 61 / 10/40 / c45 | 71 / 18/39 / c55 | 2% |
| 101 | 74 | 34 | 96 | 48 / 14/34 / c45 | 53 / 10/33 / c55 | 2% |
| 172 | 79 | 43 | 87 | 50 / 7/43 / c45 | 62 / 12/43 / c45 | 2% |
| 209 | 83 | 39 | 100 | 69 / 15/39 / c42 | 68 / 15/39 / c42 | 1% |
| 250 | 154 | 35 | 100 | 18 / 0/35 / c40 | 65 / 11/35 / c42 | 3% |
| 324 | 59 | 23 | 98 | 60 / 14/23 / c45 | 64 / 13/24 / c55 | 2% |
| 435 | 121 | - | - | FAILED | - |
| 550 | 67 | 37 | 98 | 65 / 12/37 / c45 | 77 / 18/37 / c55 | 2% |

**1 page(s) FAILED after retries.**

- **run-granularity ceiling**: mean pair-F1 97.2%
- **claude-sonnet-5**: mean pair-F1 49.1%, mean recovered-group rate 32.0%
- **claude-opus-4-8**: mean pair-F1 68.3%, mean recovered-group rate 46.0%
- mean cross-model divergence: 12.0%

## Usage (actual API spend this run)

- pdm-segment: 8 calls, 29028 in / 11757 out
