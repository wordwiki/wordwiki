import { assertEquals, assertRejects, assertThrows } from 'std/assert/mod.ts';
import { Semaphore } from './semaphore.ts';

Deno.test('Semaphore: never exceeds its limit and completes all work', async () => {
    const sem = new Semaphore(3);
    let active = 0, peak = 0, done = 0;
    await Promise.all(Array.from({ length: 20 }, () => sem.use(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 1));
        active--;
        done++;
    })));
    assertEquals(peak, 3);
    assertEquals(active, 0);
    assertEquals(done, 20);
});

Deno.test('Semaphore: a throwing job releases its permit', async () => {
    const sem = new Semaphore(1);
    await assertRejects(() => sem.use(() => Promise.reject(new Error('boom'))), Error, 'boom');
    // The permit must be free again: this would hang forever if it leaked.
    assertEquals(await sem.use(() => Promise.resolve(42)), 42);
});

Deno.test('Semaphore: waiters are served in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    await Promise.all(Array.from({ length: 5 }, (_, i) => sem.use(async () => {
        order.push(i);
        await new Promise(r => setTimeout(r, 1));
    })));
    assertEquals(order, [0, 1, 2, 3, 4]);
});

Deno.test('Semaphore: rejects a non-positive limit', () => {
    assertThrows(() => new Semaphore(0), Error, 'positive integer');
});
