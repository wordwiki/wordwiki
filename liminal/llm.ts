// Minimal LLM client for structured extraction from images.
//
// Nothing else in the repo talks to an LLM - this is the whole surface.  It exists
// for the scan -> extract substrate (scan-extract.md): feed a document image + a
// prompt + an output JSON schema, get back validated structured JSON.  We force
// structured output through the model's tool-use mechanism (a single output tool
// whose input_schema IS the caller's schema, with tool_choice pinned to it), so the
// model can only reply by "calling" the tool with schema-shaped arguments.
//
// Credentials mirror mail.ts exactly: a git-ignored `<appName>-anthropic-credential.json`
// in the run dir, read once, degrading to a no-op that FAILS LOUDLY (a rejected
// promise, surfaced as a job error) rather than crashing the server when absent or
// broken.  The whole point of scan-extract is that capture works today and extraction
// is a deferred, re-runnable step - so "no key configured" must be a soft, per-job
// failure, never a boot failure.
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

// ---------------------------------------------------------------------------------
// --- Public surface ---------------------------------------------------------------
// ---------------------------------------------------------------------------------

export interface LlmImage {
    bytes: Uint8Array;
    mediaType: 'image/jpeg' | 'image/png';
}

export interface LlmExtractOptions {
    maxTokens?: number;    // model output budget (default 8192 - sheets can be many rows)
    system?: string;       // optional system prompt
    // Called with the API's usage block after a successful call - the
    // caller's cost accounting (cache hits in layers above never reach the
    // API, so a batch's tallied usage is its actual spend).
    onUsage?: (usage: LlmUsage) => void;
}

export interface LlmUsage {
    inputTokens: number;
    outputTokens: number;
}

/**
 * A structured-extraction client.  `extract` returns the model's tool-call input:
 * JSON the model produced to match `schema` (the model validates its own shape via
 * tool_choice; callers should still validate against the schema before use).
 * `available` is false for the disabled fallback, so callers can pre-flight.
 */
export interface Llm {
    readonly available: boolean;
    extract(model: string, prompt: string, image: LlmImage,
            schema: Record<string, unknown>, opts?: LlmExtractOptions): Promise<unknown>;
}

export interface AnthropicCredential {
    apiKey: string;
    defaultModel?: string;       // used when a call passes '' for model
    baseUrl?: string;            // override the API host (testing / proxy)
    anthropicVersion?: string;   // API version header (default below)
}

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_TOKENS = 8192;
export const EXTRACT_TOOL_NAME = 'record_extraction';

/**
 * Build the app's LLM client from `<appName>-anthropic-credential.json` in the run
 * dir.  Returns a DisabledLlm (never throws) when the file is absent, unreadable,
 * unparseable, or missing `apiKey` - so a missing/broken credential degrades to
 * "extraction unavailable" rather than a crash.  `fetchImpl` is injectable for tests.
 */
export function loadLlm(appName: string, fetchImpl: typeof fetch = fetch): Llm {
    const file = `${appName}-anthropic-credential.json`;
    let raw: string;
    try {
        raw = Deno.readTextFileSync(file);
    } catch {
        return new DisabledLlm(`no ${file}`);
    }
    let cred: AnthropicCredential;
    try {
        cred = JSON.parse(raw);
    } catch (e) {
        console.error(`llm: ${file} is not valid JSON (${e}); extraction disabled`);
        return new DisabledLlm(`unparseable ${file}`);
    }
    if(typeof cred.apiKey !== 'string' || cred.apiKey === '') {
        console.error(`llm: ${file} is missing apiKey; extraction disabled`);
        return new DisabledLlm(`incomplete ${file}`);
    }
    console.info(`llm: Anthropic client configured (default model ${cred.defaultModel ?? 'unset'})`);
    return new AnthropicLlm(cred, fetchImpl);
}

// ---------------------------------------------------------------------------------
// --- The Anthropic implementation -------------------------------------------------
// ---------------------------------------------------------------------------------

export class AnthropicLlm implements Llm {
    readonly available = true;
    constructor(private cred: AnthropicCredential,
                private fetchImpl: typeof fetch = fetch) {}

    async extract(model: string, prompt: string, image: LlmImage,
                  schema: Record<string, unknown>, opts: LlmExtractOptions = {}): Promise<unknown> {
        const useModel = model || this.cred.defaultModel;
        if(!useModel) throw new Error('llm: no model given and no defaultModel configured');
        const body = buildAnthropicRequest(useModel, prompt, image, schema, opts);
        const url = (this.cred.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL) + '/v1/messages';
        const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: {
                'x-api-key': this.cred.apiKey,
                'anthropic-version': this.cred.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if(!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`llm: anthropic HTTP ${res.status}: ${text.slice(0, 500)}`);
        }
        const data = await res.json();
        const u = (data as {usage?: {input_tokens?: number, output_tokens?: number}}).usage;
        if(u && opts.onUsage)
            opts.onUsage({inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0});
        return extractToolResult(data);
    }
}

// A no-op client for installs without a credential: every call rejects with the
// reason, so a job fails visibly (status 'failed', error surfaced) and the server
// stays up.  `available` is false so callers can skip/queue instead of calling.
export class DisabledLlm implements Llm {
    readonly available = false;
    constructor(private reason: string) {}
    extract(_model: string, _prompt: string, _image: LlmImage,
            _schema: Record<string, unknown>, _opts?: LlmExtractOptions): Promise<unknown> {
        return Promise.reject(new Error(`llm: unavailable (${this.reason})`));
    }
}

// ---------------------------------------------------------------------------------
// --- Pure request/response shaping (no network - unit-tested directly) -------------
// ---------------------------------------------------------------------------------

/**
 * The Anthropic /v1/messages request that forces schema-shaped output: one output
 * tool whose input_schema is the caller's schema, with tool_choice pinned to it, and
 * the image (base64) before the prompt text in a single user turn.
 */
export function buildAnthropicRequest(model: string, prompt: string, image: LlmImage,
                                      schema: Record<string, unknown>,
                                      opts: LlmExtractOptions = {}): Record<string, unknown> {
    return {
        model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts.system ? {system: opts.system} : {}),
        tools: [{
            name: EXTRACT_TOOL_NAME,
            description: 'Return the structured data extracted from the image.',
            input_schema: schema,
        }],
        tool_choice: {type: 'tool', name: EXTRACT_TOOL_NAME},
        messages: [{
            role: 'user',
            content: [
                {type: 'image', source: {type: 'base64',
                                         media_type: image.mediaType, data: encodeBase64(image.bytes)}},
                {type: 'text', text: prompt},
            ],
        }],
    };
}

// Pull the forced tool call's `input` out of a /v1/messages response, or throw with a
// diagnostic (refusal / stop / no tool_use) so job errors are legible.
export function extractToolResult(response: unknown): unknown {
    const r = response as {content?: unknown; stop_reason?: string} | null;
    const blocks = r?.content;
    if(!Array.isArray(blocks))
        throw new Error(`llm: anthropic response had no content (stop_reason=${r?.stop_reason ?? '?'})`);
    const tool = blocks.find((b: {type?: string; name?: string}) =>
        b?.type === 'tool_use' && b?.name === EXTRACT_TOOL_NAME) as {input?: unknown} | undefined;
    if(!tool) {
        // Surface any text the model returned instead (a refusal / explanation).
        const text = blocks.filter((b: {type?: string}) => b?.type === 'text')
            .map((b: {text?: string}) => b?.text ?? '').join(' ').slice(0, 500);
        throw new Error(`llm: model did not call the extraction tool` +
            (text ? ` (said: ${text})` : ` (stop_reason=${r?.stop_reason ?? '?'})`));
    }
    return tool.input;
}
