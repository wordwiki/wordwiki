/**
 * The per-request dirty-key collector: the emission half of the dependency
 * model (the registration half is the dep classes fragments carry - see
 * table.ts reloadableProps / tableKey / rowKey / fkKey).
 *
 * Every row write (Table.insert / updateNamedFields / delete) records the
 * dirty keys it derives from the table's declared metadata - table key, row
 * key, and one fk key per declared foreign key (see Table.dirtyKeysFor).
 * Rare raw-SQL writes call record() by hand.  The keys accumulate in an
 * ambient per-request Set installed by rpcHandler around the mutation
 * dispatch (and by the test harnesses' invoke()), and are merged into the
 * mutation response's `targets` - so mutations no longer hand-assemble their
 * dirty lists.
 *
 * Deliberately a SEPARATE AsyncLocalStorage from the security context:
 * mutations routinely run sub-steps under security.runSystem(), which swaps
 * the security storage - the collector must survive those blocks.
 *
 * record() without an installed collector is a silent no-op, so scripts,
 * fake-data seeding, and direct table calls in tests pay nothing (and the
 * DML layer uses isCollecting() to skip its before-row reads entirely).
 *
 * Keys are recorded in SELECTOR form ('.-task-7-') - the same strings
 * mutation `targets` have always carried.
 *
 * This is also the future long-poll liveness chokepoint (see
 * liminal-refresh-future-work.md section 1): the drain point where a request's
 * keys are read back is where a dirty log would be appended.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<Set<string>>();

/** Install `collector` as the ambient dirty-key set for the duration of fn. */
export function run<T>(collector: Set<string>, fn: () => T): T {
    return storage.run(collector, fn);
}

/** The ambient collector, or undefined when none is installed. */
export function current(): Set<string> | undefined {
    return storage.getStore();
}

/** Whether a collector is installed (the DML layer's cheap gate: skip the
 *  before-row read when nobody is listening). */
export function isCollecting(): boolean {
    return storage.getStore() !== undefined;
}

/** Record dirty keys (selector form).  No-op without a collector. */
export function record(keys: string[]): void {
    const collector = storage.getStore();
    if(collector === undefined) return;
    for(const k of keys) collector.add(k);
}

/**
 * Run `fn` with a fresh collector and return its result together with the
 * keys it recorded.  The single merge idiom shared by rpcHandler and the test
 * harnesses' invoke(), so production and tests see identical target sets:
 *
 *   const {result, keys} = await collectTargets(() => dispatch(...));
 *   if(result?.action === 'reload' || result?.action === 'open')
 *       result.targets = mergeTargets(result.targets, keys);
 */
export async function collectTargets<T>(fn: () => T | Promise<T>): Promise<{result: T, keys: string[]}> {
    const collector = new Set<string>();
    const result = await storage.run(collector, async () => await fn());
    return {result, keys: [...collector]};
}

/** Union hand-written targets with collected keys, deduped, hand-first. */
export function mergeTargets(handTargets: unknown, keys: string[]): string[] {
    const out: string[] = [];
    if(Array.isArray(handTargets))
        for(const t of handTargets)
            if(typeof t === 'string' && !out.includes(t)) out.push(t);
    for(const k of keys)
        if(!out.includes(k)) out.push(k);
    return out;
}
