// The Tier-1 SUBPROCESS under test (batch-derivation-design.md §12.1).
//
// A tiny synthetic bulk pass, invoked as a REAL process by
// batch-derivation_test.ts against a temp store + the disk-persisted
// FakeBatchBackend - so "crash" is a genuine process death and "resume" is a
// genuine cold start.  It exercises the REAL production wiring
// (extractTextStage -> getDerived -> batchImplFor -> BatchContext), not a
// test double of it.
//
//   deno run --allow-all batch-pass-cli.ts --store=<dir> --fake=<dir> --scenario=<name>
//
// Scenarios (units follow the §6 discipline - pure replay, commit-at-end:
// each unit writes `unit-<id>.done` into the store dir ONLY when its whole
// chain has resolved):
//   chain3   - 3 independent units, each a DEPTH-3 extraction chain (stage
//              k+1's input is stage k's output).  The depth-bound scenario.
//   fanout   - 5 independent single-stage units.  One batch, one cycle.
//   partial  - 3 independent single-stage units (the test completes their
//              batch with mixed succeeded/errored/expired outcomes).
//   serial   - 2 siblings awaited SEQUENTIALLY in one unit (the
//              enroll-before-await ANTI-pattern; pins the degradation).
//   sibling  - the same 2 siblings via awaitAll (the discipline; one cycle).
//
// Env: LIMINAL_BATCH_CRASH=before-flush|after-submit (crash injection),
//      LIMINAL_NO_LLM=1 (the AI ban).
// Output: last stdout line is a JSON report {classification, completed,
// deferred, failed, createCalls, submitted}.
import { ExtractConfig, ExtractStage, extractTextStage } from "../extract.ts";
import { BatchContext, BatchUnit, awaitAll, runBatchUnits } from "../batch-derivation.ts";
import { FakeBatchBackend } from "../batch-backend.ts";
import { DisabledLlm } from "../llm.ts";

function arg(name: string): string {
    const v = Deno.args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if(v === undefined) throw new Error(`batch-pass-cli: missing --${name}=`);
    return v;
}

const storeDir = arg('store');
const fakeDir = arg('fake');
const scenario = arg('scenario');

const backend = new FakeBatchBackend(fakeDir);
const batch = new BatchContext(backend, {maxRetries: 2});
const cfg: ExtractConfig = {
    derivedDir: storeDir,
    // Text-only stages never touch the image source; the sync LLM must never
    // be reached in batch mode - DisabledLlm makes that a loud failure.
    image: {containedBytes: () => { throw new Error('tier-1 pass is text-only'); }},
    llm: new DisabledLlm('tier-1 harness: sync path must not be used'),
    batch,
};

function stage(name: string): ExtractStage {
    return {name, model: 'fake-model', promptVersion: 1, imageBox: 0,
            schema: {type: 'object'},
            prompt: input => `${name} given ${JSON.stringify(input ?? null)}`};
}

// One derivation step; distinct per (stageName, input).
const step = (stageName: string, input: unknown) =>
    extractTextStage(cfg, stage(stageName), input);

// Commit-at-end: the unit's single side effect, after every await resolved.
async function commit(unitId: string, result: unknown): Promise<void> {
    await Deno.writeTextFile(`${storeDir}/unit-${unitId}.done`, JSON.stringify(result));
}

function chainUnit(unitId: string, depth: number): BatchUnit {
    return {id: unitId, run: async () => {
        let out: unknown = {unit: unitId};                 // stage 0 input
        for(let d = 1; d <= depth; d++)
            out = await step(`depth${d}`, out);
        await commit(unitId, out);
    }};
}

function singleUnit(unitId: string): BatchUnit {
    return {id: unitId, run: async () => {
        await commit(unitId, await step('single', {unit: unitId}));
    }};
}

const units: BatchUnit[] = (() => {
    switch(scenario) {
        case 'chain3':  return [1, 2, 3].map(n => chainUnit(`chain${n}`, 3));
        case 'fanout':  return [1, 2, 3, 4, 5].map(n => singleUnit(`fan${n}`));
        case 'partial': return [1, 2, 3].map(n => singleUnit(`part${n}`));
        case 'serial':  return [{id: 'serial', run: async () => {
            const a = await step('sibA', {side: 'a'});     // unwinds before sibB enrolls
            const b = await step('sibB', {side: 'b'});
            await commit('serial', [a, b]);
        }}];
        case 'sibling': return [{id: 'sibling', run: async () => {
            const [a, b] = await awaitAll([step('sibA', {side: 'a'}),
                                           step('sibB', {side: 'b'})]);
            await commit('sibling', [a, b]);
        }}];
        default: throw new Error(`batch-pass-cli: unknown scenario '${scenario}'`);
    }
})();

const outcome = await runBatchUnits(units, batch, {log: line => console.error(line)});
console.log(JSON.stringify({
    classification: outcome.classification,
    completed: outcome.completed,
    deferred: outcome.deferred,
    failed: outcome.failed,
    failures: outcome.units.filter(u => u.status === 'failed')
        .map(u => `${u.unitId}: ${u.error}`),
    createCalls: await backend.createCallCount(),
    submitted: outcome.submitted.length,
}));
