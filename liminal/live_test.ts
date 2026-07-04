// deno-lint-ignore-file no-explicit-any
// LiveLog (live.ts): the long-poll liveness log - monotonic seqs, immediate
// answers over pending entries, park/wake on intersecting appends, timeout
// re-park semantics, and the resync paths (first contact, epoch mismatch,
// ring overflow).  Pure in-memory; no db.
import { test } from "./testing/test.ts";
import { assert, assertEquals } from "./testing/assert.ts";
import { LiveLog } from "./live.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("append assigns monotonic seqs; empty appends are no-ops", () => {
    const log = new LiveLog();
    assertEquals(log.seq, 0);
    assertEquals(log.append([]), 0);
    assertEquals(log.append(['.-task-1-']), 1);
    assertEquals(log.append(['.-task-2-']), 2);
    assertEquals(log.seq, 2);
});

test("first contact / epoch mismatch / future cursor all answer resync", async () => {
    const log = new LiveLog();
    log.append(['.-task-1-']);
    // No sinceSeq (first contact).
    assertEquals(await log.poll({keys: ['.-task-1-']}),
                 {epoch: log.epoch, seq: 1, resync: true});
    // Wrong epoch (server restarted since the client's last contact).
    assertEquals(await log.poll({epoch: 'stale', sinceSeq: 1, keys: ['.-task-1-']}),
                 {epoch: log.epoch, seq: 1, resync: true});
    // Cursor from the future (clock confusion) - also resync.
    assertEquals(await log.poll({epoch: log.epoch, sinceSeq: 99, keys: ['.-task-1-']}),
                 {epoch: log.epoch, seq: 1, resync: true});
});

test("pending intersecting entries answer immediately; non-intersecting don't", async () => {
    const log = new LiveLog();
    log.append(['.-task-1-', '.-task-']);
    log.append(['.-volunteer-7-']);
    const a = await log.poll({epoch: log.epoch, sinceSeq: 0, keys: ['.-task-']});
    assert(!('resync' in a));
    assertEquals((a as any).entries, [{seq: 1, keys: ['.-task-1-', '.-task-']}]);
    assertEquals((a as any).seq, 2);
    // Everything before the cursor is old news.
    const b = await log.poll({epoch: log.epoch, sinceSeq: 1, keys: ['.-task-']},
                             {timeoutMs: 0});
    assertEquals((b as any).entries, []);
});

test("a parked poll is woken by an intersecting append (and only that one)", async () => {
    const log = new LiveLog();
    const parked = log.poll({epoch: log.epoch, sinceSeq: 0, keys: ['.-subtask-task_id-9-']},
                            {timeoutMs: 5_000});
    assertEquals(log.parkedCount, 1);
    log.append(['.-volunteer-1-']);                      // non-intersecting: stays parked
    assertEquals(log.parkedCount, 1);
    log.append(['.-subtask-3-', '.-subtask-task_id-9-']); // intersecting: wakes
    const answer = await parked;
    assertEquals(log.parkedCount, 0);
    assertEquals((answer as any).entries, [{seq: 2, keys: ['.-subtask-3-', '.-subtask-task_id-9-']}]);
    assertEquals((answer as any).seq, 2);
});

test("timeout answers with zero entries and cleans the waiter up", async () => {
    const log = new LiveLog();
    log.append(['.-task-1-']);
    const answer = await log.poll({epoch: log.epoch, sinceSeq: 1, keys: ['.-task-1-']},
                                  {timeoutMs: 30});
    assertEquals((answer as any).entries, []);
    assertEquals((answer as any).seq, 1);
    await sleep(10);
    assertEquals(log.parkedCount, 0);
});

test("timeoutMs 0 / an empty watch set never park", async () => {
    const log = new LiveLog();
    log.append(['.-task-1-']);
    assertEquals(((await log.poll({epoch: log.epoch, sinceSeq: 1, keys: ['.-x-']},
                                  {timeoutMs: 0})) as any).entries, []);
    assertEquals(((await log.poll({epoch: log.epoch, sinceSeq: 1, keys: []})) as any).entries, []);
    assertEquals(log.parkedCount, 0);
});

test("a cursor older than the ring's retention answers resync", async () => {
    const log = new LiveLog();
    for(let i = 0; i < 600; i++)          // capacity is 512 - the early entries evict
        log.append([`.-task-${i}-`]);
    const answer = await log.poll({epoch: log.epoch, sinceSeq: 1, keys: ['.-task-5-']});
    assertEquals(answer, {epoch: log.epoch, seq: 600, resync: true});
    // A cursor within retention still answers normally.
    const ok = await log.poll({epoch: log.epoch, sinceSeq: 599, keys: ['.-task-599-']},
                              {timeoutMs: 0});
    assertEquals((ok as any).entries, [{seq: 600, keys: ['.-task-599-']}]);
});

test("malformed requests degrade to resync, never throw", async () => {
    const log = new LiveLog();
    log.append(['.-task-1-']);
    for(const bad of [undefined, null, {}, {epoch: 7}, {epoch: log.epoch, sinceSeq: 'x'},
                      {epoch: log.epoch, sinceSeq: 0, keys: 'nope'}] as any[]) {
        const answer = await log.poll(bad);
        assert('resync' in (answer as any) || Array.isArray((answer as any).entries),
               `no throw for ${JSON.stringify(bad)}`);
    }
});
