import type { TranslationRequest } from "@ai-translate/core/types";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AiSdkSemanticAuditProvider,
  AiSdkTranslationProvider,
  createAiSdkSemanticAuditProvider,
  createAiSdkTranslationProvider,
  createAiSdkTransport,
} from "../src/index";

/** Minimal successful reply in the shape the AI SDK expects from a model. */
function reply(payload: unknown) {
  return {
    content: [{ text: JSON.stringify(payload), type: "text" as const }],
    finishReason: { raw: "stop", unified: "stop" as const },
    usage: {
      inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
      outputTokens: { reasoning: undefined, text: 1, total: 1 },
      totalTokens: 2,
    },
    warnings: [],
  };
}

/**
 * The engine aliases keys before sending a batch, so a faithful end-to-end
 * mock has to answer the keys it was actually asked about rather than the
 * catalog keys the test wrote.
 */
function requestedKeys(options: { prompt: unknown }): string[] {
  const prompt = options.prompt as readonly {
    content: readonly { text?: string }[] | string;
    role: string;
  }[];
  const user = prompt.find((message) => message.role === "user");
  const text = typeof user?.content === "string" ? user.content : (user?.content[0]?.text ?? "{}");
  const body = JSON.parse(text) as { requests?: readonly { key: string }[] };
  return (body.requests ?? []).map(({ key }) => key);
}

function translationRequest(key: string, source: string): TranslationRequest {
  return {
    catalogId: "messages",
    key,
    locale: "de",
    path: `/${key}`,
    provenance: { catalogId: "messages", jsonPointer: `/${key}`, unitId: `messages:${key}` },
    sourceText: source,
    unitId: `messages:${key}`,
  };
}

describe("createAiSdkTransport", () => {
  it("sends the neutral request through the AI SDK and returns the decoded object", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply({ answer: "ja" }),
      modelId: "test-model",
    });
    const transport = createAiSdkTransport({ model });

    const result = await transport.complete({
      messages: [
        { content: "system rules", role: "system" },
        { content: "user payload", role: "user" },
      ],
      modelId: "test-model",
      schema: z.object({ answer: z.string() }),
      schemaName: "answer",
    });

    expect(result).toEqual({ answer: "ja" });
    const call = model.doGenerateCalls[0];
    expect(call?.prompt).toEqual([
      { content: "system rules", role: "system" },
      { content: [{ text: "user payload", type: "text" }], role: "user" },
    ]);
  });

  it("carries prompt cache keys and reasoning effort as provider options", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply({ answer: "ja" }),
      modelId: "test-model",
    });
    const transport = createAiSdkTransport({
      model,
      providerOptions: { anthropic: { thinking: "enabled" } },
    });

    await transport.complete({
      maxCompletionTokens: 512,
      messages: [{ content: "user payload", role: "user" }],
      modelId: "test-model",
      promptCacheKey: "catalog:messages",
      reasoningEffort: "low",
      schema: z.object({ answer: z.string() }),
      schemaName: "answer",
      temperature: 0.2,
    });

    const call = model.doGenerateCalls[0];
    expect(call?.providerOptions).toEqual({
      anthropic: { thinking: "enabled" },
      openai: { promptCacheKey: "catalog:messages", reasoningEffort: "low" },
    });
    expect(call?.maxOutputTokens).toBe(512);
    expect(call?.temperature).toBe(0.2);
  });

  it("lets caller-supplied provider options win over the derived ones", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply({ answer: "ja" }),
      modelId: "test-model",
    });
    const transport = createAiSdkTransport({
      model,
      providerOptions: { openai: { reasoningEffort: "high" } },
    });

    await transport.complete({
      messages: [{ content: "user payload", role: "user" }],
      modelId: "test-model",
      reasoningEffort: "low",
      schema: z.object({ answer: z.string() }),
      schemaName: "answer",
    });

    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it("resolves a model per request when given a resolver", async () => {
    const forward = new MockLanguageModelV4({
      doGenerate: async () => reply({ answer: "forward" }),
      modelId: "forward-model",
    });
    const adversarial = new MockLanguageModelV4({
      doGenerate: async () => reply({ answer: "adversarial" }),
      modelId: "adversarial-model",
    });
    const transport = createAiSdkTransport({
      model: (modelId) => (modelId === "forward-model" ? forward : adversarial),
    });

    const schema = z.object({ answer: z.string() });
    await expect(
      transport.complete({
        messages: [{ content: "x", role: "user" }],
        modelId: "forward-model",
        schema,
        schemaName: "answer",
      }),
    ).resolves.toEqual({ answer: "forward" });
    await expect(
      transport.complete({
        messages: [{ content: "x", role: "user" }],
        modelId: "adversarial-model",
        schema,
        schemaName: "answer",
      }),
    ).resolves.toEqual({ answer: "adversarial" });
  });

  it("refuses a request for a model a single-model transport cannot serve", async () => {
    const transport = createAiSdkTransport({
      model: new MockLanguageModelV4({ modelId: "bound-model" }),
    });

    await expect(
      transport.complete({
        messages: [{ content: "x", role: "user" }],
        modelId: "other-model",
        schema: z.object({ answer: z.string() }),
        schemaName: "answer",
      }),
    ).rejects.toThrow('bound to "bound-model" but the request asked for "other-model"');
  });

  it("accepts a model given as a gateway model id string", async () => {
    const transport = createAiSdkTransport({ model: "anthropic/claude-sonnet-4" });

    await expect(
      transport.complete({
        messages: [{ content: "x", role: "user" }],
        modelId: "openai/gpt-5.6-luna",
        schema: z.object({ answer: z.string() }),
        schemaName: "answer",
      }),
    ).rejects.toThrow('bound to "anthropic/claude-sonnet-4"');
  });

  it("reports an unparseable reply as an absent payload so the engine can repair it", async () => {
    const transport = createAiSdkTransport({
      model: new MockLanguageModelV4({
        doGenerate: async () => reply("not an object matching the schema"),
        modelId: "test-model",
      }),
    });

    await expect(
      transport.complete({
        messages: [{ content: "x", role: "user" }],
        modelId: "test-model",
        schema: z.object({ answer: z.string() }),
        schemaName: "answer",
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates transport failures rather than swallowing them", async () => {
    const transport = createAiSdkTransport({
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("upstream is down");
        },
        modelId: "test-model",
      }),
    });

    await expect(
      transport.complete({
        messages: [{ content: "x", role: "user" }],
        modelId: "test-model",
        schema: z.object({ answer: z.string() }),
        schemaName: "answer",
      }),
    ).rejects.toThrow("upstream is down");
  });

  it("forwards the abort signal so the engine's deadline reaches the vendor", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => reply({ answer: "ja" }),
      modelId: "test-model",
    });
    const transport = createAiSdkTransport({ model });
    const controller = new AbortController();

    await transport.complete({
      messages: [{ content: "x", role: "user" }],
      modelId: "test-model",
      schema: z.object({ answer: z.string() }),
      schemaName: "answer",
      signal: controller.signal,
    });

    expect(model.doGenerateCalls[0]?.abortSignal).toBe(controller.signal);
  });
});

describe("AiSdkTranslationProvider", () => {
  /** Answers every requested key, so the reply satisfies the generated schema. */
  const german: Record<string, string> = { farewell: "Tschüss", greeting: "Hallo" };
  const translateEverything = async (options: { prompt: unknown }) =>
    reply({
      translations: Object.fromEntries(
        requestedKeys(options).map((key) => [key, { translation: german[key] ?? "Hallo" }]),
      ),
    });

  it("translates a batch end to end through a mock model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: translateEverything,
      modelId: "test-model",
    });
    const provider = new AiSdkTranslationProvider({ model });

    const result = await provider.translate({
      locale: "de",
      requests: [translationRequest("greeting", "Hello"), translationRequest("farewell", "Bye")],
    });

    expect(result).toEqual([
      { key: "greeting", translation: "Hallo" },
      { key: "farewell", translation: "Tschüss" },
    ]);
  });

  it("takes its model id from the bound language model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: translateEverything,
      modelId: "claude-sonnet-4",
    });
    const provider = new AiSdkTranslationProvider({ model });

    await provider.translate({ locale: "de", requests: [translationRequest("greeting", "Hello")] });

    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("exposes typed factories", () => {
    const model = new MockLanguageModelV4({ modelId: "test-model" });

    expect(createAiSdkTranslationProvider({ model })).toBeInstanceOf(AiSdkTranslationProvider);
    expect(createAiSdkSemanticAuditProvider({ model })).toBeInstanceOf(AiSdkSemanticAuditProvider);
  });

  it("passes provider options configured on the provider through to the model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: translateEverything,
      modelId: "test-model",
    });
    const provider = new AiSdkTranslationProvider({
      model,
      providerOptions: { anthropic: { thinking: "enabled" } },
    });

    await provider.translate({ locale: "de", requests: [translationRequest("greeting", "Hello")] });

    expect(model.doGenerateCalls[0]?.providerOptions).toMatchObject({
      anthropic: { thinking: "enabled" },
    });
  });
});

describe("AiSdkSemanticAuditProvider", () => {
  it("audits a batch end to end through a mock model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (options) =>
        reply({
          audits: requestedKeys(options).map((key) => ({
            evaluations: [
              {
                confidence: "high",
                evidence: [
                  { end: 5, field: "source", quote: "Hello", start: 0 },
                  { end: 5, field: "target", quote: "Hallo", start: 0 },
                ],
                reason: "The greeting carries the same claim in both languages.",
                requirementId: "claim",
                verdict: "preserved",
              },
            ],
            key,
          })),
        }),
      modelId: "audit-model",
    });
    const provider = new AiSdkSemanticAuditProvider({
      model,
      providerOptions: { anthropic: { thinking: "enabled" } },
    });

    const result = await provider.audit({
      auditId: "claim-integrity",
      locale: "de",
      modelId: "audit-model",
      pass: "forward",
      promptRevision: "v1",
      requests: [
        {
          auditId: "claim-integrity",
          catalogId: "messages",
          deterministicEvaluations: [],
          inputDigest: "digest-greeting",
          key: "greeting",
          locale: "de",
          path: "/greeting",
          requestDigest: "request-digest-greeting",
          requirements: [{ description: "Preserve the claim.", id: "claim" }],
          sourceText: "Hello",
          targetText: "Hallo",
          unitId: "messages:greeting",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.evaluations[0]?.verdict).toBe("preserved");
    expect(model.doGenerateCalls[0]?.providerOptions).toMatchObject({
      anthropic: { thinking: "enabled" },
    });
  });
});
