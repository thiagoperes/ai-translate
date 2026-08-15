import { describe, expect, it, vi } from "vitest";

import { digestValue } from "../src/hash";
import { syncCatalogs } from "../src/sync";
import type {
  AiTranslateConfig,
  CatalogAdapter,
  DocumentRef,
  Entry,
  LoadedDocument,
  SyncStateSnapshot,
  SyncStateStore,
  TranslationAttestedCandidate,
  TranslationCandidateCache,
  TranslationCandidateCacheKey,
  TranslationProvider,
} from "../src/types";

interface MemoryDocumentState {
  locale: string;
  unitId: string;
}

function cloneEntries(entries: readonly Entry[]): Entry[] {
  return entries.map((entry) => ({
    ...entry,
    address: [...entry.address],
  }));
}

function createMemoryCatalog(): CatalogAdapter & {
  documents: Map<string, LoadedDocument<MemoryDocumentState>>;
} {
  const documents = new Map<string, LoadedDocument<MemoryDocumentState>>();
  const keyFor = (locale: string, unitId: string): string =>
    `${locale}:${unitId}`;

  return {
    createDocumentRef(sourceRef, locale) {
      return {
        ...sourceRef,
        locale,
        path: `/memory/${locale}/${sourceRef.unitId}.json`,
      };
    },
    documents,
    id: "memory",
    listDocumentRefs(sourceLocale) {
      return Promise.resolve(
        [...documents.values()]
          .filter((document) => document.ref.locale === sourceLocale)
          .map((document) => document.ref)
      );
    },
    loadDocument(ref) {
      const document = documents.get(keyFor(ref.locale, ref.unitId));
      if (!document) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        entries: cloneEntries(document.entries),
        ref: document.ref,
        state: { ...document.state },
      });
    },
    reconcileDocument({ ref, source, target }) {
      const nextEntries = cloneEntries(source.entries);
      const targetMap = new Map(
        (target?.entries ?? []).map((entry) => [
          JSON.stringify(entry.address),
          entry.value,
        ])
      );
      nextEntries.forEach((entry) => {
        const existing = targetMap.get(JSON.stringify(entry.address));
        if (existing !== undefined) {
          entry.value = existing;
        }
      });
      return Promise.resolve({
        entries: nextEntries,
        ref,
        state: { locale: ref.locale, unitId: ref.unitId },
      });
    },
    writeDocument(document) {
      documents.set(keyFor(document.ref.locale, document.ref.unitId), {
        entries: cloneEntries(document.entries),
        ref: document.ref,
        state: { ...(document.state as MemoryDocumentState) },
      });
      return Promise.resolve();
    },
  };
}

function createStateStore(): SyncStateStore & { snapshot: SyncStateSnapshot } {
  const snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
  return {
    load() {
      return Promise.resolve({
        entries: { ...snapshot.entries },
        version: snapshot.version,
      });
    },
    save(next) {
      snapshot.entries = { ...next.entries };
      snapshot.version = next.version;
      return Promise.resolve();
    },
    snapshot,
    withLock(operation) {
      return operation();
    },
  };
}

function createMemoryCandidateCache(): TranslationCandidateCache & {
  attested: Map<string, TranslationAttestedCandidate>;
  texts: Map<string, string>;
} {
  const attested = new Map<string, TranslationAttestedCandidate>();
  const texts = new Map<string, string>();
  const rejected = new Set<string>();
  const rejectionKey = (key: TranslationCandidateCacheKey, translation: string) =>
    `${key.digest}:${digestValue(translation)}`;

  return {
    attested,
    texts,
    async get(key) {
      const translation = texts.get(key.digest);
      return translation !== undefined &&
        !rejected.has(rejectionKey(key, translation))
        ? translation
        : undefined;
    },
    async getAttested(key) {
      const candidate = attested.get(key.digest);
      return candidate !== undefined &&
        !rejected.has(rejectionKey(key, candidate.translation))
        ? candidate
        : undefined;
    },
    async promote(key, translation) {
      texts.set(key.digest, translation);
    },
    async promoteAttested(key, candidate) {
      attested.set(key.digest, candidate);
      texts.set(key.digest, candidate.translation);
    },
    async put(key, translation) {
      if (!texts.has(key.digest)) {
        texts.set(key.digest, translation);
      }
    },
    async putAttested(key, candidate) {
      if (!attested.has(key.digest)) {
        attested.set(key.digest, candidate);
        texts.set(key.digest, candidate.translation);
      }
    },
    async reject(key, translation) {
      rejected.add(rejectionKey(key, translation));
    },
  };
}

function seedSource(
  catalog: ReturnType<typeof createMemoryCatalog>,
  sourceText: string,
  unitId = "common"
): DocumentRef {
  const sourceRef: DocumentRef = {
    catalogId: "memory",
    format: "json",
    locale: "en",
    path: `/memory/en/${unitId}.json`,
    unitId,
  };
  catalog.documents.set(`en:${unitId}`, {
    entries: [
      {
        address: [{ key: "body", kind: "key" }],
        policy: "translate",
        storage: "string",
        value: sourceText,
      },
    ],
    ref: sourceRef,
    state: { locale: "en", unitId },
  });
  return sourceRef;
}

describe("cache semantics", () => {
  it("cache-only scoped sync performs zero provider calls", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    seedSource(catalog, "Hello world");

    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: (request.selfCheckPlans ?? []).map(({ digest }) => digest),
            verified: true as const,
          },
          translation: "Hallo Welt",
        }))
      )
    );

    const config: AiTranslateConfig = {
      catalogs: [catalog],
      candidateCache: {
        identity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      generationRevision: "generation-v1",
      provider: { translate },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: {
        semanticAuditExecution: "generator-self-check",
      },
    };

    const first = await syncCatalogs(config);
    expect(first.metrics.failedEntries).toBe(0);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(first.metrics.providerRequestCount).toBe(1);
    expect(first.metrics.candidateCacheWrites).toBeGreaterThan(0);

    translate.mockClear();
    const second = await syncCatalogs(config);
    expect(second.metrics.failedEntries).toBe(0);
    expect(translate).not.toHaveBeenCalled();
    expect(second.metrics.providerRequestCount).toBe(0);

    // Forced path must reuse attested cache with host revalidation.
    const forced = await syncCatalogs(config, { forceRetranslate: true });
    expect(translate).not.toHaveBeenCalled();
    expect(forced.metrics.providerRequestCount).toBe(0);
    expect(forced.metrics.candidateCacheHits).toBeGreaterThan(0);
  });

  it("takes the cache identity from the provider when the config omits one", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    seedSource(catalog, "Hello world");
    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation: "Hallo Welt",
        }))
      )
    );
    const config: AiTranslateConfig = {
      catalogs: [catalog],
      candidateCache: { store: cache },
      generationRevision: "generation-v1",
      provider: {
        candidateCacheIdentity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        translate,
      },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: { semanticAuditExecution: "generator-self-check" },
    };

    await syncCatalogs(config);
    expect(translate).toHaveBeenCalledTimes(1);

    translate.mockClear();
    const cached = await syncCatalogs(config, { forceRetranslate: true });
    expect(translate).not.toHaveBeenCalled();
    expect(cached.metrics.candidateCacheHits).toBeGreaterThan(0);
  });

  it("refuses a cache it cannot key", async () => {
    const catalog = createMemoryCatalog();
    seedSource(catalog, "Hello world");

    await expect(
      syncCatalogs({
        catalogs: [catalog],
        candidateCache: { store: createMemoryCandidateCache() },
        generationRevision: "generation-v1",
        provider: { translate: () => Promise.resolve([]) },
        sourceLocale: "en",
        state: createStateStore(),
        targetLocales: ["de"],
      })
    ).rejects.toThrow(
      "candidateCache.identity is required for a provider that does not report candidateCacheIdentity."
    );
  });

  it("does not serve a cached candidate after the provider's model changes", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    seedSource(catalog, "Hello world");
    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation: "Hallo Welt",
        }))
      )
    );
    const configFor = (modelId: string): AiTranslateConfig => ({
      catalogs: [catalog],
      candidateCache: { store: cache },
      generationRevision: "generation-v1",
      provider: {
        candidateCacheIdentity: {
          modelId,
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        translate,
      },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: { semanticAuditExecution: "generator-self-check" },
    });

    await syncCatalogs(configFor("model-v1"));
    translate.mockClear();

    await syncCatalogs(configFor("model-v2"), { forceRetranslate: true });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("transport knobs are not part of generation identity", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    seedSource(catalog, "Hello world");
    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation: "Hallo Welt",
        }))
      )
    );
    const baseConfig: AiTranslateConfig = {
      batching: { maxRequestsPerProviderCall: 4, scope: "locale" },
      catalogs: [catalog],
      candidateCache: {
        identity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      concurrency: { documents: 2 },
      generationRevision: "generation-v1",
      provider: { translate },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: { semanticAuditExecution: "generator-self-check" },
    };

    await syncCatalogs(baseConfig);
    translate.mockClear();

    for (const override of [
      { concurrency: { documents: 10 } },
      { batching: { maxRequestsPerProviderCall: 1, scope: "locale" as const } },
      { concurrency: { documents: 1 }, batching: { maxRequestsPerProviderCall: 8, scope: "locale" as const } },
    ]) {
      const result = await syncCatalogs(
        { ...baseConfig, ...override },
        { forceRetranslate: true }
      );
      expect(translate).not.toHaveBeenCalled();
      expect(result.metrics.providerRequestCount).toBe(0);
      expect(result.metrics.candidateCacheHits).toBeGreaterThan(0);
    }
  });

  it("validator contract changes revalidate and rebind without provider calls", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    seedSource(catalog, "Hello world");
    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation: "Hallo Welt",
        }))
      )
    );
    const config: AiTranslateConfig = {
      catalogs: [catalog],
      candidateCache: {
        identity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      generationRevision: "generation-v1",
      provider: { translate },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: {
        deterministicContractRevision: `sha256:${"a".repeat(64)}`,
        enforceAcceptanceProvenance: true,
        semanticAuditExecution: "generator-self-check",
      },
    };

    await syncCatalogs(config);
    translate.mockClear();

    // New validator revision + implementation: force the cache path so host
    // validators re-run. Passing output must be rebound without provider calls.
    const rebound = await syncCatalogs(
      {
        ...config,
        validation: {
          ...config.validation,
          deterministicContractRevision: `sha256:${"b".repeat(64)}`,
        },
        validators: [() => []],
      },
      { forceRetranslate: true }
    );
    expect(translate).not.toHaveBeenCalled();
    expect(rebound.metrics.providerRequestCount).toBe(0);
    expect(rebound.metrics.candidateCacheHits).toBeGreaterThan(0);
  });

  it("English source changes invalidate only that entry", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    const sourceRef: DocumentRef = {
      catalogId: "memory",
      format: "json",
      locale: "en",
      path: "/memory/en/common.json",
      unitId: "common",
    };
    catalog.documents.set("en:common", {
      entries: [
        {
          address: [{ key: "a", kind: "key" }],
          policy: "translate",
          storage: "string",
          value: "Alpha",
        },
        {
          address: [{ key: "b", kind: "key" }],
          policy: "translate",
          storage: "string",
          value: "Beta",
        },
      ],
      ref: sourceRef,
      state: { locale: "en", unitId: "common" },
    });

    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation:
            request.sourceText === "Alpha"
              ? "Alpha DE"
              : request.sourceText === "Alpha changed"
                ? "Alpha DE v2"
                : "Beta DE",
        }))
      )
    );
    const config: AiTranslateConfig = {
      catalogs: [catalog],
      candidateCache: {
        identity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      generationRevision: "generation-v1",
      provider: { translate },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: { semanticAuditExecution: "generator-self-check" },
    };

    await syncCatalogs(config);
    expect(translate.mock.calls[0]?.[0].requests).toHaveLength(2);
    translate.mockClear();

    const enDoc = catalog.documents.get("en:common");
    expect(enDoc).toBeDefined();
    if (enDoc === undefined) {
      return;
    }
    const firstEntry = enDoc.entries[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry === undefined) {
      return;
    }
    firstEntry.value = "Alpha changed";

    const result = await syncCatalogs(config);
    expect(result.metrics.failedEntries).toBe(0);
    expect(translate).toHaveBeenCalledTimes(1);
    const requested = translate.mock.calls[0]?.[0].requests ?? [];
    expect(requested).toHaveLength(1);
    expect(requested[0]?.sourceText).toBe("Alpha changed");
    expect(result.metrics.invalidationReasons?.["source-changed"]).toBe(1);
  });

  it("page-specific SEO context invalidates only matching entries", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    seedSource(catalog, "Hello world", "page-a");
    seedSource(catalog, "Hello world", "page-b");

    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation: "Hallo Welt",
        }))
      )
    );

    let seoNoteForPageA = "seo-v1";
    const config: AiTranslateConfig = {
      catalogs: [catalog],
      candidateCache: {
        identity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      generationRevision: "generation-v1",
      provider: { translate },
      requestContext: ({ unitId, context }) =>
        unitId === "page-a"
          ? { ...context, notes: seoNoteForPageA }
          : context,
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: {
        contextChangePolicy: "retranslate",
        semanticAuditExecution: "generator-self-check",
      },
    };

    await syncCatalogs(config);
    expect(translate.mock.calls[0]?.[0].requests.length).toBeGreaterThanOrEqual(2);
    translate.mockClear();

    seoNoteForPageA = "seo-v2";
    const result = await syncCatalogs(config);
    const requested = translate.mock.calls.flatMap(
      (call) => call[0].requests
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]?.unitId).toBe("page-a");
    expect(result.metrics.invalidationReasons?.["context-changed"]).toBe(1);
  });

  it("glossary term changes invalidate only sources that use the term", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    seedSource(catalog, "Fuel card savings", "with-term");
    seedSource(catalog, "Fleet platform", "without-term");

    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation:
            request.sourceText === "Fuel card savings"
              ? "Tankkarte Sparen"
              : "Flottenplattform",
        }))
      )
    );

    const config: AiTranslateConfig = {
      catalogs: [catalog],
      candidateCache: {
        identity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      generationRevision: "generation-v1",
      glossary: [{ source: "Fuel card", target: "Tankkarte" }],
      provider: { translate },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: { semanticAuditExecution: "generator-self-check" },
    };

    await syncCatalogs(config);
    translate.mockClear();

    const result = await syncCatalogs({
      ...config,
      glossary: [{ source: "Fuel card", target: "Tankkarte Plus" }],
    });
    const requested = translate.mock.calls.flatMap(
      (call) => call[0].requests
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]?.unitId).toBe("with-term");
    expect(result.metrics.providerRequestCount).toBe(1);
  });

  it("failed cache revalidation invalidates only the failed entry", async () => {
    const catalog = createMemoryCatalog();
    const state = createStateStore();
    const cache = createMemoryCandidateCache();
    const sourceRef: DocumentRef = {
      catalogId: "memory",
      format: "json",
      locale: "en",
      path: "/memory/en/common.json",
      unitId: "common",
    };
    catalog.documents.set("en:common", {
      entries: [
        {
          address: [{ key: "ok", kind: "key" }],
          policy: "translate",
          storage: "string",
          value: "Keep",
        },
        {
          address: [{ key: "bad", kind: "key" }],
          policy: "translate",
          storage: "string",
          value: "Drop",
        },
      ],
      ref: sourceRef,
      state: { locale: "en", unitId: "common" },
    });

    let rejectDrop = false;
    let dropTranslation = "Verwerfen";
    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          selfCheck: {
            modelId: "model-v1",
            planDigests: [],
            verified: true as const,
          },
          translation:
            request.sourceText === "Keep" ? "Behalten" : dropTranslation,
        }))
      )
    );

    const config: AiTranslateConfig = {
      catalogs: [catalog],
      candidateCache: {
        identity: {
          modelId: "model-v1",
          providerId: "memory",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      generationRevision: "generation-v1",
      provider: { translate },
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: { semanticAuditExecution: "generator-self-check" },
      validators: [
        ({ sourceText, targetText }) =>
          rejectDrop && sourceText === "Drop" && targetText === "Verwerfen"
            ? [
                {
                  code: "forced-failure",
                  message: "Reject cached Drop translation.",
                  severity: "error" as const,
                },
              ]
            : [],
      ],
    };

    await syncCatalogs(config);
    expect(translate).toHaveBeenCalledTimes(1);
    translate.mockClear();

    rejectDrop = true;
    dropTranslation = "Verwerfen neu";
    const result = await syncCatalogs(config, { forceRetranslate: true });
    const requested = translate.mock.calls.flatMap(
      (call) => call[0].requests
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]?.sourceText).toBe("Drop");
    expect(result.metrics.candidateCacheHits).toBeGreaterThan(0);
    expect(result.metrics.invalidationReasons?.["cache-revalidation-failed"]).toBe(
      1
    );
  });
});
