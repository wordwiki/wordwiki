// Tier-2 SOAK of the batch derivation mechanism against the REAL Message
// Batches API (batch-derivation-design.md §12.2) - the feature ACCEPTANCE
// GATE, run (a) once before first production batch use, (b) after any change
// to the batch client / driver / store batch paths.
//
// Validates ONLY what the Tier-1 fake can't: real submit/poll/results
// shapes, custom_id round-trip, real per-request failures, real
// list-batches reconnect, real timing.  All scenarios ride the SAME batches
// (one soak, wall time = max scenario depth x batch turnaround):
//   - chain1..3: three DEPTH-3 extraction chains (real cross-batch
//     dependency scheduling).
//   - fan1..40: a wide fan-out (real large-batch submit/retrieve).
//   - err: a request built to ERROR (invalid model -> per-request
//     not_found_error; verified non-eager by a live smoke test 2026-08-05).
//     With maxRetries=1 its terminal is a hard 'retry cap' failure.
//   - CRASH-RESUME: the runner (batch-soak.sh) injects
//     LIMINAL_BATCH_CRASH=after-submit into the FIRST invocation, so run 1
//     submits the whole frontier and dies before any marker learns the
//     batch id - later runs must conservative-defer (no double-submit) and
//     then reconnect via list-batches by custom_id.
//   - the NO-AI-FLAG proof: `assert` re-runs the whole pass under
//     LIMINAL_NO_LLM=1 - a fully-landed soak must complete with zero API
//     calls.
//
// Prompts are trivial + deterministic (haiku, ~90 tiny requests: a few
// cents total); the content is irrelevant - the MECHANISM is under test.
//
//   deno run --allow-all liminal/testing/batch-soak.ts run    [--dir=tmp/batch-soak]
//   deno run --allow-all liminal/testing/batch-soak.ts status [--dir=...]
//   deno run --allow-all liminal/testing/batch-soak.ts assert [--dir=...]
//
// Run from the REPO ROOT (the wordwiki credential file lives there).  State
// + report live in --dir; `run` exits 0 done / 3 in-flight (rerun later) /
// 9 injected crash.  batch-soak.sh wraps this with the hourly loop.
import { ExtractConfig, ExtractStage, extractTextStage } from "../extract.ts";
import { BatchContext, BatchUnit, runBatchUnits } from "../batch-derivation.ts";
import { AnthropicBatchBackend } from "../batch-backend-anthropic.ts";
import { DisabledLlm, loadAnthropicCredential } from "../llm.ts";

const MODEL = 'claude-haiku-4-5-20251001';
const BAD_MODEL = 'claude-no-such-model-xyz';
const CHAINS = 3, CHAIN_DEPTH = 3, FANOUT = 40;

function arg(name: string, dflt: string): string {
    return Deno.args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
}
const mode = Deno.args[0] ?? 'status';
const dir = arg('dir', 'tmp/batch-soak');

// --- Persistent soak state ---------------------------------------------------------

interface SoakState {
    runs: number;
    submittedBatchIds: string[];       // ids RECORDED at flush (the crashed
                                       //   run's batch is deliberately absent)
    unitStatus: Record<string, string>;  // unitId -> completed|deferred|failed: <err>
    tokens: {input: number, output: number};
    startedAt?: string;
    doneAt?: string;
}

async function loadState(): Promise<SoakState> {
    try {
        return JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
    } catch {
        return {runs: 0, submittedBatchIds: [], unitStatus: {},
                tokens: {input: 0, output: 0}};
    }
}
async function saveState(s: SoakState): Promise<void> {
    await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify(s, undefined, '  '));
}

// --- The pass ----------------------------------------------------------------------

function soakStage(name: string, model: string): ExtractStage {
    return {name, model, promptVersion: 1, imageBox: 0,
            schema: {type: 'object', properties: {soak: {type: 'string'}},
                     required: ['soak']},
            prompt: input => `Use the record_extraction tool to record exactly ` +
                             `{"soak": "${name}"}.  (context: ${JSON.stringify(input ?? null)})`};
}

function buildUnits(cfg: ExtractConfig): BatchUnit[] {
    const step = (stage: ExtractStage, input: unknown) => extractTextStage(cfg, stage, input);
    const commit = (id: string, result: unknown) =>
        Deno.writeTextFile(`${dir}/unit-${id}.done`, JSON.stringify(result));
    const units: BatchUnit[] = [];
    for(let c = 1; c <= CHAINS; c++)
        units.push({id: `chain${c}`, run: async () => {
            let out: unknown = {chain: c};
            for(let d = 1; d <= CHAIN_DEPTH; d++)
                out = await step(soakStage(`soak-c${c}-d${d}`, MODEL), out);
            await commit(`chain${c}`, out);
        }});
    for(let f = 1; f <= FANOUT; f++)
        units.push({id: `fan${f}`, run: async () => {
            await commit(`fan${f}`, await step(soakStage(`soak-fan${f}`, MODEL), null));
        }});
    units.push({id: 'err', run: async () => {
        await commit('err', await step(soakStage('soak-err', BAD_MODEL), null));
    }});
    return units;
}

async function runPass(): Promise<{code: number, line: string}> {
    const cred = loadAnthropicCredential('wordwiki');
    if(cred instanceof Error)
        throw new Error(`soak needs the credential (run from the repo root): ${cred.message}`);
    const batch = new BatchContext(new AnthropicBatchBackend(cred), {maxRetries: 1});
    const usage = {input: 0, output: 0};
    const cfg: ExtractConfig = {
        derivedDir: `${dir}/store`,
        image: {containedBytes: () => { throw new Error('soak is text-only'); }},
        llm: new DisabledLlm('soak: the sync path must never be used'),
        batch,
        onUsage: (_stage, u) => { usage.input += u.inputTokens; usage.output += u.outputTokens; },
    };

    const outcome = await runBatchUnits(buildUnits(cfg), batch,
                                        {log: m => console.error(m)});

    const state = await loadState();
    state.runs++;
    state.startedAt ??= new Date().toISOString();
    state.submittedBatchIds.push(...outcome.submitted.map(b => b.id));
    for(const u of outcome.units)
        state.unitStatus[u.unitId] = u.status + (u.error ? `: ${u.error.slice(0, 120)}` : '');
    state.tokens.input += usage.input;
    state.tokens.output += usage.output;
    if(outcome.classification === 'done')
        state.doneAt ??= new Date().toISOString();
    await saveState(state);

    const line = `| ${new Date().toISOString()} | run ${state.runs} ` +
        `| ${outcome.classification} | ${outcome.completed} ok | ${outcome.deferred} deferred ` +
        `| ${outcome.failed} failed | +${outcome.submitted.length} batch(es) ` +
        `| ${batch.stats.landed} landed | tokens ${state.tokens.input}in/${state.tokens.output}out ` +
        `| waiting: ${outcome.waitingOn.join(' ') || '-'} |`;
    await Deno.writeTextFile(`${dir}/soak-report.md`, line + '\n', {append: true});
    console.log(line);
    return {code: outcome.classification === 'done' ? 0 : 3, line};
}

// --- Terminal assertions (design §12.2: every scenario at its expected
//     terminal, and a flagged full run makes zero real API calls) ---------------------

async function assertTerminals(): Promise<number> {
    const failures: string[] = [];
    const state = await loadState();
    const check = (cond: boolean, what: string) => {
        console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}`);
        if(!cond) failures.push(what);
    };

    check(state.doneAt !== undefined, `soak reached 'done' (${state.doneAt ?? 'not yet'})`);
    for(let c = 1; c <= CHAINS; c++)
        check(state.unitStatus[`chain${c}`] === 'completed'
              && await exists(`${dir}/unit-chain${c}.done`),
              `chain${c} completed (depth-${CHAIN_DEPTH} cross-batch scheduling)`);
    const fansDone = Array.from({length: FANOUT}, (_x, i) => i + 1)
        .filter(f => state.unitStatus[`fan${f}`] === 'completed').length;
    check(fansDone === FANOUT, `fan-out completed ${fansDone}/${FANOUT}`);
    check((state.unitStatus['err'] ?? '').includes('retry cap'),
          `err unit hit the retry cap (real per-request errored landing): ` +
          `'${state.unitStatus['err']}'`);
    // The no-double-spend property, end to end: the RECORDED batches are the
    // post-crash ones; run 1's batch (the injected crash) is unrecorded by
    // design.  Chain depth 3 with the whole frontier in batch 1 -> batches
    // 2..3 recorded, +1 for the err retry riding batch 2 -> recorded <= 2.
    const uniqueBatches = new Set(state.submittedBatchIds).size;
    check(uniqueBatches <= CHAIN_DEPTH - 1,
          `recorded batches ${uniqueBatches} <= ${CHAIN_DEPTH - 1} ` +
          `(+1 unrecorded crash batch = minimum spend, no double-submit)`);

    // THE final proof: the whole pass under the AI ban - a fully-landed soak
    // is pure cache, zero API calls.  Any drift/miss throws loudly here.
    console.log('running the full pass under LIMINAL_NO_LLM=1 ...');
    Deno.env.set('LIMINAL_NO_LLM', '1');
    const cred = loadAnthropicCredential('wordwiki');
    if(cred instanceof Error) throw new Error(cred.message);
    const batch = new BatchContext(new AnthropicBatchBackend(cred), {maxRetries: 1});
    const cfg: ExtractConfig = {
        derivedDir: `${dir}/store`,
        image: {containedBytes: () => { throw new Error('soak is text-only'); }},
        llm: new DisabledLlm('soak assert: sync path must never be used'),
        batch,
    };
    const banned = await runBatchUnits(buildUnits(cfg), batch, {log: () => undefined});
    check(banned.classification === 'done' && banned.completed === CHAINS + FANOUT
          && banned.submitted.length === 0,
          `no-AI-flag proof: flagged full run served from cache ` +
          `(${banned.completed} ok, ${banned.submitted.length} submitted)`);
    check((banned.units.find(u => u.unitId === 'err')?.error ?? '').includes('retry cap'),
          `no-AI-flag proof: err unit fails at the cap WITHOUT enrolling`);

    console.log(failures.length === 0
        ? `\nSOAK PASSED - ${state.runs} runs, ${uniqueBatches}+1 batches, ` +
          `${state.tokens.input}in/${state.tokens.output}out tokens ` +
          `(${state.startedAt} -> ${state.doneAt})`
        : `\nSOAK FAILED: ${failures.length} assertion(s)`);
    return failures.length === 0 ? 0 : 1;
}

async function exists(p: string): Promise<boolean> {
    try { await Deno.stat(p); return true; } catch { return false; }
}

// --- Entry -------------------------------------------------------------------------

await Deno.mkdir(dir, {recursive: true});
switch(mode) {
    case 'run': {
        const {code} = await runPass();
        Deno.exit(code);
        break;
    }
    case 'assert':
        Deno.exit(await assertTerminals());
        break;
    case 'status': {
        const state = await loadState();
        console.log(JSON.stringify(state, undefined, '  '));
        try { console.log(await Deno.readTextFile(`${dir}/soak-report.md`)); }
        catch { console.log('(no report yet)'); }
        break;
    }
    default:
        console.error(`usage: batch-soak.ts run|assert|status [--dir=tmp/batch-soak]`);
        Deno.exit(1);
}
