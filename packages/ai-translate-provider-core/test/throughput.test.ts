import { syncCatalogs } from "@ai-translate/core/sync";
import { withProviderTelemetry } from "@ai-translate/core/telemetry";
import type {
  CatalogAdapter,
  ProviderRequestMetrics,
  TranslationRequest,
} from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import { createStructuredTranslationProvider } from "../src/index";
import type { StructuredCompletionRequest, StructuredCompletionTransport } from "../src/index";

function request(key: string, sourceText = "Save changes"): TranslationRequest {
  return {
    catalogId: "test",
    key,
    locale: "de",
    path: `/${key}`,
    sourceText,
    provenance: { catalogId: "test", jsonPointer: `/${key}`, unitId: key },
    unitId: key,
  };
}

function payload(call: StructuredCompletionRequest): { requests: { key: string; text: string }[] } {
  return JSON.parse(call.messages.find(({ role }) => role === "user")?.content ?? "{}");
}

function recorder() {
  const calls: StructuredCompletionRequest[] = [];
  const transport: StructuredCompletionTransport = {
    label: "Test",
    complete(call) {
      calls.push(call);
      call.onUsage?.({
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cachedInputTokens: 40,
      });
      const reply = {
        translations: Object.fromEntries(
          payload(call).requests.map(({ key, text }) => [key, { translation: `DE ${text}` }]),
        ),
      };
      expect(call.schema.safeParse(reply).success).toBe(true);
      return Promise.resolve(reply);
    },
  };
  return { calls, transport };
}

describe("translation throughput", () => {
  it("restores a known closing tag with a missing delimiter without changing its prose", async () => {
    const provider = inlineProvider("Bevor <em>Sie beginnen</em, lesen Sie <a>den Leitfaden</a>.");
    await expect(
      provider.translate({
        locale: "de",
        requests: [
          {
            ...request(
              "inline",
              "Read <a_one>the guide</a_one> before <em_two>you start</em_two>.",
            ),
            inlineMarkup: true,
          },
        ],
      }),
    ).resolves.toEqual([
      {
        key: "inline",
        translation: "Bevor <em_two>Sie beginnen</em_two>, lesen Sie <a_one>den Leitfaden</a_one>.",
      },
    ]);
  });

  it("counts a timed-out transport even when it ignores the abort signal", async () => {
    const events: ProviderRequestMetrics[] = [];
    const provider = createStructuredTranslationProvider({
      model: "test",
      requestTimeoutMs: 10,
      onRequest: (event) => {
        events.push(event);
      },
      transport: { label: "Test", complete: () => new Promise(() => {}) },
    });
    await expect(
      provider.translate({ locale: "de", requests: [request("timeout")] }),
    ).rejects.toThrow("exceeded 10ms");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ attempt: 1, failed: true });
  });

  it.each(["outside", "invented", "changed"])(
    "rejects %s inline numeric values",
    async (failure) => {
      const provider = createStructuredTranslationProvider({
        model: "test",
        transport: {
          label: "Test",
          complete(call) {
            const { key, text } = payload(call).requests[0] ?? { key: "", text: "" };
            const marker = /\{\{AI_TRANSLATE_NUMBER_[^}]+\}\}/u.exec(text)?.[0] ?? "";
            const translationTemplate =
              failure === "outside"
                ? `${marker} <strong>Projekte</strong>.`
                : `<strong>${marker} Projekte</strong>${failure === "invented" ? " 21" : ""}.`;
            return Promise.resolve({
              translations: {
                [key]: {
                  translationTemplate,
                  localizedNumbers: { number_0: failure === "changed" ? "21" : "20" },
                },
              },
            });
          },
        },
      });
      await expect(
        provider.translate({
          locale: "de",
          requests: [
            {
              ...request("inline", "Includes <strong_one>20 projects</strong_one>."),
              inlineMarkup: true,
            },
          ],
        }),
      ).rejects.toThrow("failed after 1 attempt(s)");
    },
  );

  it("coalesces identical entries before singleton batching and restores every destination key", async () => {
    const { calls, transport } = recorder();
    const provider = createStructuredTranslationProvider({
      model: "test",
      transport,
      batchSize: 1,
    });
    const requests = Array.from({ length: 96 }, (_, i) => request(String(i)));
    const results = await provider.translate({ locale: "de", requests });
    expect(calls).toHaveLength(1);
    expect(results.map(({ key }) => key)).toEqual(requests.map(({ key }) => key));
  });

  it("reuses complete candidates across groups only for the duration of a sync", async () => {
    const { calls, transport } = recorder();
    const provider = createStructuredTranslationProvider({ model: "test", transport });
    await withProviderTelemetry(
      () => {},
      async () => {
        await provider.translate({ locale: "de", requests: [request("first")] });
        await provider.translate({ locale: "de", requests: [request("second")] });
        await provider.translate({
          locale: "de",
          requests: [{ ...request("context"), context: { tone: "formal" } }],
        });
        await provider.translate({
          locale: "de",
          glossary: [{ source: "Save", target: "Speichern" }],
          requests: [request("glossary")],
        });
      },
    );
    expect(calls).toHaveLength(3);
    await provider.translate({ locale: "de", requests: [request("next-sync")] });
    expect(calls).toHaveLength(4);
  });

  it("shares an in-flight generation between simultaneous callers", async () => {
    const { calls, transport } = recorder();
    const provider = createStructuredTranslationProvider({
      model: "test",
      transport,
      batchSize: 1,
    });
    const results = await Promise.all(
      ["first", "second"].map((key) =>
        provider.translate({ locale: "de", requests: [request(key)] }),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(results.flat().map(({ key }) => key)).toEqual(["first", "second"]);
  });

  it("packs a backlog without grouping different contexts or reducing small-job parallelism", async () => {
    const { calls, transport } = recorder();
    const provider = createStructuredTranslationProvider({
      model: "test",
      transport,
      concurrentRequests: 4,
    });
    const requests = Array.from({ length: 64 }, (_, i) => ({
      ...request(
        String(i),
        `Review project ${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}`,
      ),
      contentRole: "ui-label" as const,
      context: { tone: i % 2 === 0 ? "formal" : "casual" },
    }));
    const result = await provider.translate({ locale: "de", requests });
    expect(result).toHaveLength(64);
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => payload(call).requests.length === 8)).toBe(true);
    expect(
      calls.every(
        (call) =>
          call.messages[0]?.content.includes("Tone: formal") ||
          call.messages[0]?.content.includes("Tone: casual"),
      ),
    ).toBe(true);
    calls.length = 0;
    await provider.translate({ locale: "de", requests: requests.slice(0, 3) });
    expect(calls).toHaveLength(3);
  });

  it("reports actual attempts and billed usage rather than logical provider groups", async () => {
    const { calls, transport } = recorder();
    const source = {
      ref: {
        catalogId: "test",
        format: "json" as const,
        locale: "en",
        path: "/memory/en",
        unitId: "unit",
      },
      entries: Array.from({ length: 120 }, (_, i) => ({
        address: [{ kind: "key" as const, key: String(i) }],
        policy: "translate" as const,
        storage: "string" as const,
        value: `Review ${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}`,
      })),
      state: {},
    };
    const catalog: CatalogAdapter = {
      id: "test",
      listDocumentRefs: async () => [source.ref],
      loadDocument: async (ref) => (ref.locale === "en" ? structuredClone(source) : null),
      createDocumentRef: (ref, locale) => ({ ...ref, locale, path: `/memory/${locale}` }),
      reconcileDocument: async ({ ref }) => ({ ...structuredClone(source), ref }),
      writeDocument: async () => {},
    };
    const result = await syncCatalogs({
      sourceLocale: "en",
      targetLocales: ["de"],
      catalogs: [catalog],
      state: {
        load: async () => ({ version: 2, entries: {} }),
        save: async () => {},
        withLock: (f) => f(),
      },
      provider: createStructuredTranslationProvider({ model: "test", transport, batchSize: 1 }),
    });
    expect(calls).toHaveLength(120);
    expect(result.metrics).toMatchObject({
      providerInvocationCount: 1,
      providerRequestCount: 120,
      translatedEntries: 120,
      failedEntries: 0,
      providerUsage: {
        requestsWithUsage: 120,
        inputTokens: 12_000,
        outputTokens: 2_400,
        reasoningTokens: 600,
        cachedInputTokens: 4_800,
      },
    });
    expect(result.metrics.providerLatency?.p95Ms).toBeGreaterThanOrEqual(0);
  });

  it("recognizes SDK status codes and reports retries and failed attempts", async () => {
    const { transport } = recorder();
    const events: ProviderRequestMetrics[] = [];
    let attempts = 0;
    const provider = createStructuredTranslationProvider({
      model: "test",
      maxRetries: 2,
      onRequest: (event) => {
        events.push(event);
      },
      transport: {
        label: "SDK",
        complete(call) {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("rate limited"), {
              statusCode: 429,
              responseHeaders: { "retry-after-ms": "0" },
              isRetryable: true,
            });
          }
          return transport.complete(call);
        },
      },
    });
    await provider.translate({ locale: "de", requests: [request("retry")] });
    expect(events.map(({ attempt, failed }) => ({ attempt, failed }))).toEqual([
      { attempt: 1, failed: true },
      { attempt: 2, failed: false },
    ]);
  });

  it("moves paired inline elements with target grammar", async () => {
    const provider = inlineProvider("Bevor <em>Sie beginnen</em>, lesen Sie <a>den Leitfaden</a>.");
    await expect(
      provider.translate({
        locale: "de",
        requests: [
          {
            ...request(
              "inline",
              "Read <a_one>the guide</a_one> before <em_two>you start</em_two>.",
            ),
            inlineMarkup: true,
          },
        ],
      }),
    ).resolves.toEqual([
      {
        key: "inline",
        translation: "Bevor <em_two>Sie beginnen</em_two>, lesen Sie <a_one>den Leitfaden</a_one>.",
      },
    ]);
  });

  it.each([
    "<a>Leitfaden <em>Beginn</a></em>",
    "<a>Leitfaden</a><a>Leitfaden</a><em>Beginn</em>",
    "<a>, </a><em>.</em>",
  ])("rejects crossed, repeated, or empty inline elements: %s", async (template) => {
    await expect(
      inlineProvider(template).translate({
        locale: "de",
        requests: [
          {
            ...request(
              "inline",
              "Read <a_one>the guide</a_one> before <em_two>you start</em_two>.",
            ),
            inlineMarkup: true,
          },
        ],
      }),
    ).rejects.toThrow("failed after 1 attempt(s)");
  });

  it("rejects inline formatting that absorbs the following sentence", async () => {
    const provider = createStructuredTranslationProvider({
      model: "test",
      transport: {
        label: "Test",
        complete(call) {
          const key = payload(call).requests[0]?.key ?? "";
          return Promise.resolve({
            translations: {
              [key]: {
                translationTemplate:
                  "Comprend <strong>des projets. Annulez à tout moment.</strong>",
              },
            },
          });
        },
      },
    });
    await expect(
      provider.translate({
        locale: "fr",
        requests: [
          {
            ...request("inline", "Includes <strong_one>projects</strong_one>. Cancel at any time."),
            inlineMarkup: true,
          },
        ],
      }),
    ).rejects.toThrow("inline-element-absorbed-following-sentence");
  });
});

function inlineProvider(template: string) {
  return createStructuredTranslationProvider({
    model: "test",
    transport: {
      label: "Test",
      complete(call) {
        const key = payload(call).requests[0]?.key ?? "";
        return Promise.resolve({
          translations: {
            [key]: {
              translationTemplate: template,
            },
          },
        });
      },
    },
  });
}
