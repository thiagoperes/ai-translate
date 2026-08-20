import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { describe, expect, it, vi } from "vitest";
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

describe("createOpenAiTransport", () => {
  it("requires an api key or a client", () => {
    expect(() => createOpenAiTransport()).toThrow(
      "OpenAI transport requires either apiKey or client.",
    );
  });

  it("builds a client from an api key", () => {
    expect(() => createOpenAiTransport({ apiKey: "sk-test" })).not.toThrow();
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
    expect(Object.keys(body).toSorted()).toEqual([
      "messages",
      "model",
      "response_format",
    ]);
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
