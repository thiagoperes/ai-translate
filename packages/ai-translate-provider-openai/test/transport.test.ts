import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createOpenAiSemanticAuditProvider,
  createOpenAiTransport,
  createOpenAiTranslationProvider,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  OpenAiSemanticAuditProvider,
  OpenAiTranslationProvider,
} from "../src/index";

type ParseArguments = readonly [Record<string, unknown>, Record<string, unknown> | undefined];

/**
 * Stands in for the OpenAI SDK. Only `chat.completions.parse` is reached, so
 * the rest of the client surface stays absent on purpose.
 */
function createMockClient(parsed: unknown = { answer: "ja" }): {
  client: OpenAI;
  parse: ReturnType<typeof vi.fn>;
} {
  const parse = vi.fn(async () => ({ choices: [{ message: { parsed } }] }));
  return { client: { chat: { completions: { parse } } } as unknown as OpenAI, parse };
}

const schema = z.object({ answer: z.string() });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAiTransport", () => {
  it.each([true, false])("accepts usage without optional token details (reporter: %s)", async (report) => {
    const usage = vi.fn();
    const parse = vi.fn(async () => ({
      choices: [{ message: { parsed: { answer: "ja" } } }],
      usage: { prompt_tokens: 120, completion_tokens: 0 },
    }));
    const client = { chat: { completions: { parse } } } as unknown as OpenAI;

    await expect(createOpenAiTransport({ client }).complete({
      messages: [{ content: "x", role: "user" }],
      modelId: "test",
      schema,
      schemaName: "answer",
      ...(report ? { onUsage: usage } : {}),
    })).resolves.toEqual({ answer: "ja" });
    expect(usage.mock.calls).toEqual(report ? [[{ inputTokens: 120, outputTokens: 0 }]] : []);
  });

  it("reports billed input, output, cached, cache-write, and reasoning tokens", async () => {
    const usage = vi.fn();
    const parse = vi.fn(async () => ({
      choices: [{ message: { parsed: { answer: "ja" } } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }));
    const client = { chat: { completions: { parse } } } as unknown as OpenAI;
    await createOpenAiTransport({ client }).complete({
      messages: [{ content: "x", role: "user" }],
      modelId: "test",
      schema,
      schemaName: "answer",
      onUsage: usage,
    });
    expect(usage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 20,
      reasoningTokens: 10,
    });
  });

  it.each([undefined, "", "   "])("requires credentials only on the first real request (key: %s)", async (apiKey) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const transport = createOpenAiTransport(apiKey === undefined ? {} : { apiKey });
    expect(transport.label).toBe("OpenAI");
    await expect(transport.complete({
      messages: [{ content: "Hello", role: "user" }],
      modelId: "test",
      schema,
      schemaName: "answer",
    })).rejects.toThrow(/requires either apiKey or client.*Set OPENAI_API_KEY/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds the SDK client lazily and supports concurrent requests using a local fetch stub", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"answer":"ja"}' } }],
      created: 1,
      id: "test-completion",
      model: "test",
      object: "chat.completion",
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const transport = createOpenAiTransport({ apiKey: "sk-test" });
    expect(fetch).not.toHaveBeenCalled();
    const request = { messages: [{ content: "Hello", role: "user" as const }], modelId: "test", schema, schemaName: "answer" };
    await expect(Promise.all([transport.complete(request), transport.complete(request)])).resolves.toEqual([{ answer: "ja" }, { answer: "ja" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicitly supplied client even when no API key is configured", async () => {
    const { client, parse } = createMockClient();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const transport = createOpenAiTransport({ apiKey: "", client });
    const request = { messages: [{ content: "Hello", role: "user" as const }], modelId: "test", schema, schemaName: "answer" };
    await transport.complete(request);
    await transport.complete(request);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders the neutral request in the OpenAI chat completions dialect", async () => {
    const { client, parse } = createMockClient();
    const transport = createOpenAiTransport({ client });

    const result = await transport.complete({
      maxCompletionTokens: 4_096,
      messages: [
        { content: "system rules", role: "system" },
        { content: "user payload", role: "user" },
      ],
      modelId: "gpt-5.6-luna",
      promptCacheKey: "catalog:messages",
      reasoningEffort: "low",
      schema,
      schemaName: "answer",
      temperature: 0.2,
    });

    expect(result).toEqual({ answer: "ja" });
    const [body] = parse.mock.calls[0] as unknown as ParseArguments;
    expect(body).toEqual({
      max_completion_tokens: 4_096,
      messages: [
        { content: "system rules", role: "system" },
        { content: "user payload", role: "user" },
      ],
      model: "gpt-5.6-luna",
      prompt_cache_key: "catalog:messages",
      reasoning_effort: "low",
      response_format: zodResponseFormat(schema, "answer"),
      temperature: 0.2,
    });
  });

  it("omits optional parameters the engine did not set", async () => {
    const { client, parse } = createMockClient();
    const transport = createOpenAiTransport({ client });

    await transport.complete({
      messages: [{ content: "user payload", role: "user" }],
      modelId: "gpt-5.6-luna",
      schema,
      schemaName: "answer",
    });

    const [body] = parse.mock.calls[0] as unknown as ParseArguments;
    expect(Object.keys(body).toSorted()).toEqual(["messages", "model", "response_format"]);
  });

  it("disables SDK retries and applies the configured timeout and abort signal", async () => {
    const { client, parse } = createMockClient();
    const transport = createOpenAiTransport({ client, requestTimeoutMs: 3_210 });
    const controller = new AbortController();

    await transport.complete({
      messages: [{ content: "user payload", role: "user" }],
      modelId: "gpt-5.6-luna",
      schema,
      schemaName: "answer",
      signal: controller.signal,
    });

    const [, requestOptions] = parse.mock.calls[0] as unknown as ParseArguments;
    expect(requestOptions).toEqual({
      maxRetries: 0,
      signal: controller.signal,
      timeout: 3_210,
    });
  });

  it("reports an absent payload as undefined so the engine can repair the batch", async () => {
    const parse = vi.fn(async () => ({ choices: [] }));
    const client = { chat: { completions: { parse } } } as unknown as OpenAI;

    await expect(
      createOpenAiTransport({ client }).complete({
        messages: [{ content: "user payload", role: "user" }],
        modelId: "gpt-5.6-luna",
        schema,
        schemaName: "answer",
      }),
    ).resolves.toBeUndefined();
  });

  it("names itself in engine error messages", () => {
    expect(createOpenAiTransport({ apiKey: "sk-test" }).label).toBe("OpenAI");
  });
});

describe("OpenAI providers", () => {
  it("constructs both providers and handles empty batches without credentials or API calls", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const translation = createOpenAiTranslationProvider();
    const audit = createOpenAiSemanticAuditProvider();
    expect(translation).toBeInstanceOf(OpenAiTranslationProvider);
    expect(audit).toBeInstanceOf(OpenAiSemanticAuditProvider);
    await expect(translation.translate({ locale: "de", requests: [] })).resolves.toEqual([]);
    await expect(audit.audit({ auditId: "test", locale: "de", modelId: "test", pass: "forward", promptRevision: "v1", requests: [] })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("defaults to the inexpensive reasoning model", async () => {
    const { client, parse } = createMockClient({
      translations: { greeting: { translation: "Hallo" } },
    });
    const provider = new OpenAiTranslationProvider({ client });

    await provider.translate({
      locale: "de",
      requests: [
        {
          catalogId: "messages",
          key: "greeting",
          locale: "de",
          path: "/greeting",
          provenance: {
            catalogId: "messages",
            jsonPointer: "/greeting",
            unitId: "messages:greeting",
          },
          sourceText: "Hello",
          unitId: "messages:greeting",
        },
      ],
    });

    const [body] = parse.mock.calls[0] as unknown as ParseArguments;
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.reasoning_effort).toBe(DEFAULT_REASONING_EFFORT);
  });

  it("defaults transport requests to a 45 second timeout", async () => {
    const { client, parse } = createMockClient();
    const transport = createOpenAiTransport({ client });

    await transport.complete({
      messages: [{ content: "user payload", role: "user" }],
      modelId: "gpt-5.6-luna",
      schema,
      schemaName: "answer",
    });

    const [, requestOptions] = parse.mock.calls[0] as unknown as ParseArguments;
    expect(requestOptions?.timeout).toBe(45_000);
  });

  it("hands the configured timeout to the transport it builds", async () => {
    const { client, parse } = createMockClient({
      translations: { greeting: { translation: "Hallo" } },
    });
    const provider = new OpenAiTranslationProvider({ client, requestTimeoutMs: 7_500 });

    await provider.translate({
      locale: "de",
      requests: [
        {
          catalogId: "messages",
          key: "greeting",
          locale: "de",
          path: "/greeting",
          provenance: {
            catalogId: "messages",
            jsonPointer: "/greeting",
            unitId: "messages:greeting",
          },
          sourceText: "Hello",
          unitId: "messages:greeting",
        },
      ],
    });

    const [, requestOptions] = parse.mock.calls[0] as unknown as ParseArguments;
    expect(requestOptions?.timeout).toBe(7_500);
  });

  it("routes the semantic audit through the same transport", async () => {
    const { client, parse } = createMockClient({ audits: [] });
    const provider = new OpenAiSemanticAuditProvider({ client });

    await provider.audit({
      auditId: "claim-integrity",
      locale: "de",
      modelId: "audit-model",
      pass: "forward",
      promptRevision: "v1",
      requests: [],
    });

    expect(parse).not.toHaveBeenCalled();
  });

  it("exposes typed factories", () => {
    expect(createOpenAiTranslationProvider({ apiKey: "sk-test" })).toBeInstanceOf(
      OpenAiTranslationProvider,
    );
    expect(createOpenAiSemanticAuditProvider({ apiKey: "sk-test" })).toBeInstanceOf(
      OpenAiSemanticAuditProvider,
    );
  });
});
