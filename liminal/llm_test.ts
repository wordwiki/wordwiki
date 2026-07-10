// The LLM client (llm.ts): credential loading (degrade-don't-crash, mirroring
// mail.ts), the forced-tool request shape, tool-result extraction, and a mocked
// end-to-end extract via an injected fetch.  No network - buildAnthropicRequest /
// extractToolResult are pure, and the round-trip uses a fake fetch.
import { test } from "./testing/test.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "./testing/assert.ts";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { loadLlm, AnthropicLlm, DisabledLlm, buildAnthropicRequest, extractToolResult,
         EXTRACT_TOOL_NAME, DEFAULT_MAX_TOKENS, type LlmImage } from "./llm.ts";

const IMG: LlmImage = {bytes: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/jpeg'};
const SCHEMA = {type: 'object', properties: {rows: {type: 'array'}}, required: ['rows']};

// Run `fn` with a temp `<app>-anthropic-credential.json` in cwd, cleaned up after.
async function withCredentialFile(app: string, contents: string, fn: () => void | Promise<void>): Promise<void> {
    const file = `${app}-anthropic-credential.json`;
    await Deno.writeTextFile(file, contents);
    try { await fn(); } finally { await Deno.remove(file); }
}

test("loadLlm: no credential file -> DisabledLlm that rejects loudly (never crashes)", async () => {
    const llm = loadLlm('definitely-no-such-app-xyz');
    assert(llm instanceof DisabledLlm);
    assertEquals(llm.available, false);
    await assertRejects(() => llm.extract('m', 'p', IMG, SCHEMA), Error, 'unavailable');
});

test("loadLlm: unparseable / missing-apiKey credential -> DisabledLlm", async () => {
    await withCredentialFile('rabidtest', 'not json{', () => {
        const llm = loadLlm('rabidtest');
        assert(llm instanceof DisabledLlm, 'unparseable -> disabled');
    });
    await withCredentialFile('rabidtest', JSON.stringify({defaultModel: 'x'}), () => {
        const llm = loadLlm('rabidtest');
        assert(llm instanceof DisabledLlm, 'no apiKey -> disabled');
    });
});

test("loadLlm: valid credential -> AnthropicLlm (available)", async () => {
    await withCredentialFile('rabidtest', JSON.stringify({apiKey: 'sk-test', defaultModel: 'claude-opus-4-8'}), () => {
        const llm = loadLlm('rabidtest');
        assert(llm instanceof AnthropicLlm);
        assertEquals(llm.available, true);
    });
});

test("buildAnthropicRequest: forced single output tool, image-before-text, base64 payload", () => {
    const body = buildAnthropicRequest('claude-opus-4-8', 'extract this', IMG, SCHEMA, {maxTokens: 4096, system: 'be terse'}) as any;
    assertEquals(body.model, 'claude-opus-4-8');
    assertEquals(body.max_tokens, 4096);
    assertEquals(body.system, 'be terse');
    // Exactly one tool, and tool_choice pins it -> schema-shaped output only.
    assertEquals(body.tools.length, 1);
    assertEquals(body.tools[0].name, EXTRACT_TOOL_NAME);
    assertEquals(body.tools[0].input_schema, SCHEMA);
    assertEquals(body.tool_choice, {type: 'tool', name: EXTRACT_TOOL_NAME});
    // One user turn: image block first (base64 round-trips to the original bytes), then text.
    const content = body.messages[0].content;
    assertEquals(content[0].type, 'image');
    assertEquals(content[0].source.media_type, 'image/jpeg');
    assertEquals([...decodeBase64(content[0].source.data)], [1, 2, 3, 4]);
    assertEquals(content[1], {type: 'text', text: 'extract this'});
});

test("buildAnthropicRequest: defaults - max_tokens, no system key when unset", () => {
    const body = buildAnthropicRequest('m', 'p', IMG, SCHEMA) as any;
    assertEquals(body.max_tokens, DEFAULT_MAX_TOKENS);
    assert(!('system' in body), 'no system key when none supplied');
});

test("extractToolResult: returns the tool_use input; throws on refusal/no-tool", () => {
    const ok = extractToolResult({content: [
        {type: 'text', text: 'here you go'},
        {type: 'tool_use', name: EXTRACT_TOOL_NAME, input: {rows: [{a: 1}]}},
    ]});
    assertEquals(ok, {rows: [{a: 1}]});

    // No tool call -> throws, surfacing the model's text (a refusal/explanation).
    try {
        extractToolResult({content: [{type: 'text', text: 'I cannot read this'}], stop_reason: 'end_turn'});
        assert(false, 'should have thrown');
    } catch (e) {
        assertStringIncludes(String(e), 'I cannot read this');
    }
    // Malformed response (no content array) -> throws.
    assertRejects(() => Promise.resolve().then(() => extractToolResult({})), Error);
});

test("AnthropicLlm.extract: mocked round-trip - request headers/body + parsed result", async () => {
    let seenUrl = '', seenInit: RequestInit | undefined;
    const fakeFetch = ((url: string, init?: RequestInit) => {
        seenUrl = url; seenInit = init;
        return Promise.resolve(new Response(JSON.stringify({
            content: [{type: 'tool_use', name: EXTRACT_TOOL_NAME, input: {rows: [{client_name: 'Jo'}]}}],
        }), {status: 200}));
    }) as unknown as typeof fetch;

    const llm = new AnthropicLlm({apiKey: 'sk-test', baseUrl: 'https://example.test'}, fakeFetch);
    const out = await llm.extract('claude-opus-4-8', 'extract', IMG, SCHEMA);
    assertEquals(out, {rows: [{client_name: 'Jo'}]});
    assertEquals(seenUrl, 'https://example.test/v1/messages');
    const headers = seenInit!.headers as Record<string, string>;
    assertEquals(headers['x-api-key'], 'sk-test');
    assert(headers['anthropic-version'], 'sends an anthropic-version header');
});

test("AnthropicLlm.extract: HTTP error -> throws with status + body", async () => {
    const fakeFetch = (() => Promise.resolve(new Response('rate limited', {status: 429}))) as unknown as typeof fetch;
    const llm = new AnthropicLlm({apiKey: 'sk-test'}, fakeFetch);
    await assertRejects(() => llm.extract('m', 'p', IMG, SCHEMA), Error, '429');
});

test("AnthropicLlm.extract: model falls back to defaultModel; errors when neither given", async () => {
    let sentModel = '';
    const fakeFetch = ((_url: string, init?: RequestInit) => {
        sentModel = JSON.parse(init!.body as string).model;
        return Promise.resolve(new Response(JSON.stringify({
            content: [{type: 'tool_use', name: EXTRACT_TOOL_NAME, input: {}}]}), {status: 200}));
    }) as unknown as typeof fetch;

    const withDefault = new AnthropicLlm({apiKey: 'k', defaultModel: 'claude-opus-4-8'}, fakeFetch);
    await withDefault.extract('', 'p', IMG, SCHEMA);
    assertEquals(sentModel, 'claude-opus-4-8', 'empty model uses defaultModel');

    const noDefault = new AnthropicLlm({apiKey: 'k'}, fakeFetch);
    await assertRejects(() => noDefault.extract('', 'p', IMG, SCHEMA), Error, 'no model');
});
