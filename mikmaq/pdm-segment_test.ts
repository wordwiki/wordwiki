/**
 * pdm-segment mechanical helpers: run clustering, gold word assignment,
 * pairwise scoring and cross-model divergence on synthetic geometry.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import * as seg from "./pdm-segment.ts";

const word = (id: number, x: number, y: number, w = 200, h = 80): seg.Word => ({id, x, y, w, h});

test("clusterRuns: lines by y, broken at x-gaps", () => {
    const words = [word(1, 100, 100), word(2, 320, 105),          // run 0
                   word(3, 900, 102),                              // run 1 (gap)
                   word(4, 100, 300), word(5, 330, 300)];          // run 2 (next line)
    const runs = seg.clusterRuns(words);
    assertEquals(runs.map(r => r.words.map(w => w.id)), [[1, 2], [3], [4, 5]]);
});

test("scoreProposal: perfect assignment scores 1.0 and recovers all groups", () => {
    const words = [word(1, 100, 100), word(2, 320, 100),
                   word(3, 100, 300), word(4, 320, 300)];
    const page: seg.PdmPage = {
        page_id: 1, page_number: 9, image_ref: 'x', width: 2000, height: 1000, words,
        gold: new Map([[70, [{x: 90, y: 90, w: 500, h: 100}]],
                       [71, [{x: 90, y: 290, w: 500, h: 100}]]]),
    };
    const runs = seg.clusterRuns(words);
    assertEquals(runs.length, 2);
    const s = seg.scoreProposal(page, runs, [{runs: [0], kind: 'entry'},
                                             {runs: [1], kind: 'entry'}], 90);
    assertEquals(s.pairF1, 1);
    assertEquals(s.recovered, 2);
    // Merging both runs into one entry: recall stays 1, precision drops.
    const merged = seg.scoreProposal(page, runs, [{runs: [0, 1], kind: 'entry'}], 50);
    assert(merged.pairF1 < 1 && merged.pairRecall === 1);
    assertEquals(merged.recovered, 0);
});

test("proposalDivergence: identical proposals diverge 0; split-vs-merge diverges", () => {
    const words = [word(1, 100, 100), word(2, 320, 100), word(3, 100, 300)];
    const runs = seg.clusterRuns(words);
    const a = [{runs: [0], kind: 'entry'}, {runs: [1], kind: 'entry'}];
    const b = [{runs: [0, 1], kind: 'entry'}];
    assertEquals(seg.proposalDivergence(runs, a, a), 0);
    assert(seg.proposalDivergence(runs, a, b) > 0);
});
