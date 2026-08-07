import { describe, expect, it, vi } from "vitest";

import { makeLegacyStateKey, makeStateKey } from "../src/address";
import {
  auditCatalogs,
  createSemanticAuditAcceptanceContractRevision,
  isSemanticallySubstantiveEvidenceSpan,
  SEMANTIC_AUDIT_ACCEPTANCE_CONTRACT_MATERIAL,
} from "../src/audit";
import { hasCompleteAcceptedSemanticAuditProvenance } from "../src/acceptance";
import { digestValue } from "../src/hash";
import { syncCatalogs } from "../src/sync";
import type {
  AiTranslateConfig,
  CatalogAdapter,
  DocumentRef,
  Entry,
  LoadedDocument,
  SemanticAuditDefinition,
  SemanticAuditProvider,
  SyncStateSnapshot,
  SyncStateStore,
  TranslationCandidateCache,
} from "../src/types";

function translatedEntry(value: string): Entry {
  return {
    address: [{ key: "claim", kind: "key" }],
    policy: "translate",
    storage: "string",
    value,
  };
}

function memoryCatalog(sourceText: string, targetText: string): CatalogAdapter {
  const sourceRef: DocumentRef = {
    catalogId: "messages",
    format: "json",
    locale: "en",
    path: "/en/messages.json",
    unitId: "messages",
  };
  const documents = new Map<string, LoadedDocument>([
    [
      "en",
      {
        entries: [translatedEntry(sourceText)],
        ref: sourceRef,
        state: {},
      },
    ],
    [
      "de",
      {
        entries: [translatedEntry(targetText)],
        ref: { ...sourceRef, locale: "de", path: "/de/messages.json" },
        state: {},
      },
    ],
  ]);
  return {
    createDocumentRef(ref, locale) {
      return { ...ref, locale, path: `/${locale}/messages.json` };
    },
    id: "messages",
    listDocumentRefs() {
      return Promise.resolve([sourceRef]);
    },
    loadDocument(ref) {
      return Promise.resolve(documents.get(ref.locale) ?? null);
    },
    reconcileDocument() {
      throw new Error("not used");
    },
    writeDocument() {
      throw new Error("not used");
    },
  };
}

function memoryState(
  sourceText: string,
  targetText: string,
): SyncStateStore & {
  snapshot: SyncStateSnapshot;
} {
  const key = makeStateKey("de", "messages", "messages", "/claim");
  const snapshot: SyncStateSnapshot = {
    entries: {
      [key]: {
        catalogId: "messages",
        jsonPointer: "/claim",
        locale: "de",
        origin: "generated",
        sourceDigest: digestValue(sourceText),
        status: "synced",
        targetDigest: digestValue(targetText),
        unitId: "messages",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    },
    version: 2,
  };
  return {
    load: () => Promise.resolve(structuredClone(snapshot)),
    save(next) {
      snapshot.entries = structuredClone(next.entries);
      return Promise.resolve();
    },
    snapshot,
    withLock: (operation) => operation(),
  };
}

function provider(verdict: "ambiguous" | "contradicted" | "preserved" = "preserved") {
  const audit = vi.fn<SemanticAuditProvider["audit"]>(({ modelId, requests }) =>
    Promise.resolve(
      requests.map((request) => ({
        evaluations: request.requirements.map(({ id }) => ({
          confidence: "high" as const,
          evidence: [
            {
              end: request.sourceText.length,
              field: "source" as const,
              quote: request.sourceText,
              start: 0,
            },
            {
              end: request.targetText.length,
              field: "target" as const,
              quote: request.targetText,
              start: 0,
            },
          ],
          reason: "The cited source and target spans determine the semantic verdict.",
          requirementId: id,
          verdict,
        })),
        key: request.key,
        modelId,
      })),
    ),
  );
  return { audit };
}

it("fingerprints semantic acceptance behavior without sync or transport plumbing", () => {
  const baseline = createSemanticAuditAcceptanceContractRevision();
  expect(
    createSemanticAuditAcceptanceContractRevision({
      ...SEMANTIC_AUDIT_ACCEPTANCE_CONTRACT_MATERIAL,
      implementation: [
        ...SEMANTIC_AUDIT_ACCEPTANCE_CONTRACT_MATERIAL.implementation,
        "changed consensus",
      ],
    }),
  ).not.toBe(baseline);
  expect(JSON.stringify(SEMANTIC_AUDIT_ACCEPTANCE_CONTRACT_MATERIAL)).not.toMatch(
    /auditCatalogs|runWithConcurrency|candidateCache/u,
  );
});

describe("semantic audit evidence substance", () => {
  it.each([
    ["single alphabetic character", "F", false],
    ["standalone determiner", "the", false],
    ["punctuation", ":", false],
    ["percentage claim", "1%", true],
    ["currency claim", "€5", true],
    ["prefix currency with grouped-space amount", "€30 000", true],
    ["suffix currency with grouped-space amount", "30 000 €", true],
    ["prefix currency with grouped-apostrophe amount", "USD 30'000", true],
    ["suffix currency with grouped-apostrophe amount", "30’000 GBP", true],
    ["malformed two-digit grouping", "30 00 €", false],
    ["ordinary numeric whitespace", "2026 30", false],
    ["compact uppercase concept", "EV", true],
    ["self-contained phrase", "no refundable deposit", true],
  ])("classifies %s", (_label, quote, expected) => {
    expect(
      isSemanticallySubstantiveEvidenceSpan({
        end: quote.length,
        field: "source",
        quote,
        start: 0,
      }),
    ).toBe(expected);
  });
});

function definition(
  semanticProvider: SemanticAuditProvider,
  revision = "detector-v1",
  overrides: Partial<SemanticAuditDefinition> = {},
): SemanticAuditDefinition {
  return {
    adversarialModelId: "audit-adversarial-model-v1",
    adversarialPromptRevision: "adversarial-v1",
    analyze: () => ({
      deterministicEvaluations: [{ requirementId: "claim", verdict: "ambiguous" }],
      keyMaterial: { signedClaim: "no-deposit:denied" },
      requirements: [{ description: "Preserve the signed claim.", id: "claim" }],
    }),
    forwardPromptRevision: "forward-v1",
    forwardModelId: "audit-forward-model-v1",
    id: "claim-integrity",
    provider: semanticProvider,
    providerRevision: "provider-v1",
    revision,
    ...overrides,
  };
}

function config(args: {
  audit: SemanticAuditDefinition;
  sourceText: string;
  state: SyncStateStore;
  targetText: string;
}): AiTranslateConfig {
  return {
    catalogs: [memoryCatalog(args.sourceText, args.targetText)],
    provider: { translate: () => Promise.resolve([]) },
    semanticAudits: [args.audit],
    sourceLocale: "en",
    state: args.state,
    targetLocales: ["de"],
    validation: {
      deterministicContractRevision: `sha256:${"b".repeat(64)}`,
      enforceAcceptanceProvenance: true,
      semanticAuditExecution: "provider" as const,
    },
  };
}

function multiLocaleFixture(args: {
  concurrency: number;
  locales: readonly string[];
  provider: SemanticAuditProvider;
  sourceText: string;
  targetText: string;
}): { config: AiTranslateConfig; state: ReturnType<typeof memoryState> } {
  const sourceRef: DocumentRef = {
    catalogId: "messages",
    format: "json",
    locale: "en",
    path: "/en/messages.json",
    unitId: "messages",
  };
  const documents = new Map<string, LoadedDocument>([
    ["en", { entries: [translatedEntry(args.sourceText)], ref: sourceRef, state: {} }],
    ...args.locales.map((locale): [string, LoadedDocument] => [
      locale,
      {
        entries: [translatedEntry(args.targetText)],
        ref: { ...sourceRef, locale, path: `/${locale}/messages.json` },
        state: {},
      },
    ]),
  ]);
  const catalog: CatalogAdapter = {
    createDocumentRef(ref, locale) {
      return { ...ref, locale, path: `/${locale}/messages.json` };
    },
    id: "messages",
    listDocumentRefs: () => Promise.resolve([sourceRef]),
    loadDocument: (ref) => Promise.resolve(documents.get(ref.locale) ?? null),
    reconcileDocument() {
      throw new Error("not used");
    },
    writeDocument() {
      throw new Error("not used");
    },
  };
  const state = memoryState(args.sourceText, args.targetText);
  state.snapshot.entries = Object.fromEntries(
    args.locales.map((locale) => [
      makeStateKey(locale, "messages", "messages", "/claim"),
      {
        catalogId: "messages",
        jsonPointer: "/claim",
        locale,
        origin: "generated" as const,
        sourceDigest: digestValue(args.sourceText),
        status: "synced" as const,
        targetDigest: digestValue(args.targetText),
        unitId: "messages",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    ]),
  );
  return {
    config: {
      catalogs: [catalog],
      concurrency: { documents: args.concurrency },
      provider: { translate: () => Promise.resolve([]) },
      semanticAudits: [definition(args.provider, "detector-concurrent", { batchSize: 1 })],
      sourceLocale: "en",
      state,
      targetLocales: args.locales,
      validation: {
        deterministicContractRevision: `sha256:${"b".repeat(64)}`,
        enforceAcceptanceProvenance: true,
        semanticAuditExecution: "provider" as const,
      },
    },
    state,
  };
}

describe("auditCatalogs", () => {
  it("runs single-mode audits once and accepts evidenced medium-confidence preservation", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const calls: string[] = [];
    const semanticProvider: SemanticAuditProvider = {
      audit: ({ modelId, pass, requests }) => {
        calls.push(pass);
        return Promise.resolve(
          requests.map((request) => ({
            evaluations: request.requirements.map(({ id }) => ({
              confidence: "medium" as const,
              evidence: [
                {
                  end: request.sourceText.length,
                  field: "source" as const,
                  quote: request.sourceText,
                  start: 0,
                },
                {
                  end: request.targetText.length,
                  field: "target" as const,
                  quote: request.targetText,
                  start: 0,
                },
              ],
              reason: "The claim is preserved with complete literal evidence.",
              requirementId: id,
              verdict: "preserved" as const,
            })),
            key: request.key,
            modelId,
          })),
        );
      },
    };
    const state = memoryState(sourceText, targetText);

    const result = await auditCatalogs(
      config({
        audit: definition(semanticProvider, "single-v1", {
          adversarialModelId: "audit-mini",
          forwardModelId: "audit-mini",
          mode: "single",
        }),
        sourceText,
        state,
        targetText,
      }),
    );

    expect(calls).toEqual(["forward"]);
    expect(result).toMatchObject({ accepted: 1, audited: 1, retranslate: 0, unresolved: 0 });
    const provenance =
      state.snapshot.entries[makeStateKey("de", "messages", "messages", "/claim")]
        ?.validationAudits?.["claim-integrity"];
    expect(provenance).toMatchObject({
      auditMode: "single",
      forwardModelId: "audit-mini",
      status: "accepted",
    });
    expect(provenance).not.toHaveProperty("adversarialModelId");
    expect(hasCompleteAcceptedSemanticAuditProvenance(provenance)).toBe(true);

    await expect(
      auditCatalogs(
        config({
          audit: definition(semanticProvider, "single-v1", {
            adversarialModelId: "audit-mini",
            forwardModelId: "audit-mini",
            mode: "single",
          }),
          sourceText,
          state,
          targetText,
        }),
      ),
    ).resolves.toMatchObject({ accepted: 1, audited: 0, cached: 1 });
    expect(calls).toEqual(["forward"]);
  });

  it("audits locales concurrently within the document limit and reports deterministic order", async () => {
    const locales = ["de", "nl", "fr"] as const;
    const sourceText = "No refundable deposit";
    const targetText = "Translated refundable-deposit claim";
    const base = provider("contradicted");
    const inFlightLocales = new Set<string>();
    let maxConcurrentLocaleGroups = 0;
    const calls: string[] = [];
    const semanticProvider: SemanticAuditProvider = {
      audit: async (request) => {
        calls.push(`${request.locale}:${request.pass}`);
        if (request.pass === "forward") {
          inFlightLocales.add(request.locale);
          maxConcurrentLocaleGroups = Math.max(maxConcurrentLocaleGroups, inFlightLocales.size);
        }
        await new Promise((resolve) => { setTimeout(resolve, request.locale === "de" ? 30 : 5); });
        try {
          return await base.audit(request);
        } finally {
          if (request.pass === "forward") {
            inFlightLocales.delete(request.locale);
          }
        }
      },
    };
    const fixture = multiLocaleFixture({
      concurrency: 2,
      locales,
      provider: semanticProvider,
      sourceText,
      targetText,
    });

    const result = await auditCatalogs(fixture.config);

    expect(maxConcurrentLocaleGroups).toBe(2);
    expect(calls.slice(0, 4)).toEqual([
      "de:forward",
      "de:adversarial",
      "nl:forward",
      "nl:adversarial",
    ]);
    expect(result).toMatchObject({ audited: 3, retranslate: 3, unresolved: 0 });
    expect(result.issues.map(({ locale }) => locale)).toEqual(locales);
    expect(
      locales.map(
        (locale) =>
          fixture.state.snapshot.entries[makeStateKey(locale, "messages", "messages", "/claim")]
            ?.validationAudits?.["claim-integrity"]?.status,
      ),
    ).toEqual(["retranslate", "retranslate", "retranslate"]);
  });

  it("does not persist successful concurrent batches when another batch fails", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Translated refundable-deposit claim";
    const base = provider();
    const calls: string[] = [];
    let activeCalls = 0;
    const semanticProvider: SemanticAuditProvider = {
      audit: async (request) => {
        calls.push(`${request.locale}:${request.pass}`);
        activeCalls += 1;
        try {
          const delay = request.locale === "de" ? (request.pass === "adversarial" ? 1 : 5) : 30;
          await new Promise((resolve) => { setTimeout(resolve, delay); });
          if (request.locale === "de" && request.pass === "adversarial") {
            throw new Error("audit provider unavailable");
          }
          return await base.audit(request);
        } finally {
          activeCalls -= 1;
        }
      },
    };
    const fixture = multiLocaleFixture({
      concurrency: 2,
      locales: ["de", "nl", "fr"],
      provider: semanticProvider,
      sourceText,
      targetText,
    });
    const save = vi.spyOn(fixture.state, "save");

    await expect(auditCatalogs(fixture.config)).rejects.toThrow("audit provider unavailable");
    expect(calls).toEqual(["de:forward", "de:adversarial", "nl:forward", "nl:adversarial"]);
    expect(activeCalls).toBe(0);
    expect(save).not.toHaveBeenCalled();
    expect(
      Object.values(fixture.state.snapshot.entries).every(
        ({ validationAudits }) => validationAudits === undefined,
      ),
    ).toBe(true);
  });

  it("fails closed when translated documents or entries are missing", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider();
    const missingDocumentCatalog = memoryCatalog(sourceText, targetText);
    const loadMissingDocument = missingDocumentCatalog.loadDocument.bind(missingDocumentCatalog);
    missingDocumentCatalog.loadDocument = (ref) =>
      ref.locale === "de" ? Promise.resolve(null) : loadMissingDocument(ref);
    const baseConfig = config({
      audit: definition(semanticProvider),
      sourceText,
      state,
      targetText,
    });
    const missingDocument = await auditCatalogs(
      { ...baseConfig, catalogs: [missingDocumentCatalog] },
      { checkOnly: true },
    );
    expect(missingDocument.issues).toEqual([
      expect.objectContaining({ code: "semantic-audit-missing-target-document" }),
    ]);

    const missingEntryCatalog = memoryCatalog(sourceText, targetText);
    const loadMissingEntry = missingEntryCatalog.loadDocument.bind(missingEntryCatalog);
    missingEntryCatalog.loadDocument = async (ref) => {
      const document = await loadMissingEntry(ref);
      return ref.locale === "de" && document ? { ...document, entries: [] } : document;
    };
    const missingEntry = await auditCatalogs(
      { ...baseConfig, catalogs: [missingEntryCatalog] },
      { checkOnly: true },
    );
    expect(missingEntry.issues).toEqual([
      expect.objectContaining({ code: "semantic-audit-missing-target-entry" }),
    ]);
    expect(semanticProvider.audit).not.toHaveBeenCalled();
  });

  it("skips unmarked historical audit migration but never skips tracked output", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider();
    const translationConfig = config({
      audit: definition(semanticProvider),
      sourceText,
      state,
      targetText,
    });
    translationConfig.validation = {
      ...translationConfig.validation,
      legacyUnverifiedSemanticPolicy: "skip-provider",
    };
    const initialEntry = state.snapshot.entries["de::messages::messages::/claim"];
    if (!initialEntry) {
      throw new Error("Expected initial state entry.");
    }
    initialEntry.generationRevision = "legacy-unverified";

    expect(await auditCatalogs(translationConfig, { checkOnly: true })).toMatchObject({
      audited: 0,
      checked: 0,
      issues: [],
    });
    expect(semanticProvider.audit).not.toHaveBeenCalled();

    const stateKey = "de::messages::messages::/claim";
    const legacyEntry = state.snapshot.entries[stateKey];
    if (!legacyEntry) {
      throw new Error("Expected legacy state entry.");
    }
    state.snapshot.entries[stateKey] = {
      ...legacyEntry,
      status: "failed",
    };
    expect(await auditCatalogs(translationConfig, { checkOnly: true })).toMatchObject({
      audited: 0,
      checked: 1,
      issues: [expect.objectContaining({ code: "semantic-audit-missing" })],
    });

    state.snapshot.entries[stateKey] = {
      ...legacyEntry,
      generationRevision: "sha256:current-generation",
      requiresAcceptanceAudit: true,
    };
    expect(await auditCatalogs(translationConfig)).toMatchObject({
      audited: 1,
      checked: 1,
      issues: [],
    });
    expect(semanticProvider.audit).toHaveBeenCalledTimes(2);
  });

  it("requires independent high-confidence passes and caches bound provenance", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider();
    const audit = definition(semanticProvider);
    const translationConfig = config({ audit, sourceText, state, targetText });

    const first = await auditCatalogs(translationConfig);
    expect(first).toMatchObject({ accepted: 1, audited: 1, cached: 0, issues: [] });
    expect(semanticProvider.audit).toHaveBeenCalledTimes(2);
    expect(
      Object.keys(semanticProvider.audit.mock.calls[0]?.[0].requests[0] ?? {}).toSorted(),
    ).toEqual([
      "auditId",
      "catalogId",
      "deterministicEvaluations",
      "inputDigest",
      "key",
      "locale",
      "path",
      "requestDigest",
      "requirements",
      "sourceText",
      "targetText",
      "unitId",
    ]);
    expect(
      state.snapshot.entries["de::messages::messages::/claim"]?.validationAudits?.[
        "claim-integrity"
      ],
    ).toMatchObject({
      adversarialModelId: "audit-adversarial-model-v1",
      adversarialResponseDigest: expect.any(String),
      auditRevision: "detector-v1",
      consensusEvaluations: [
        expect.objectContaining({ requirementId: "claim", status: "accepted" }),
      ],
      forwardModelId: "audit-forward-model-v1",
      forwardResponseDigest: expect.any(String),
      schemaVersion: 1,
      status: "accepted",
    });
    expect(
      state.snapshot.entries["de::messages::messages::/claim"]?.acceptedContractRevision,
    ).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const second = await auditCatalogs(translationConfig, { checkOnly: true });
    expect(second).toMatchObject({ accepted: 1, cached: 1, issues: [] });
    expect(semanticProvider.audit).toHaveBeenCalledTimes(2);
  });

  it("retries unresolved cached judgments until they converge", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    let verdict: "ambiguous" | "preserved" = "ambiguous";
    const semanticProvider = {
      audit: vi.fn<SemanticAuditProvider["audit"]>(({ modelId, requests }) =>
        Promise.resolve(
          requests.map((request) => ({
            evaluations: request.requirements.map(({ id }) => ({
              confidence: "high" as const,
              evidence: [
                {
                  end: request.sourceText.length,
                  field: "source" as const,
                  quote: request.sourceText,
                  start: 0,
                },
                {
                  end: request.targetText.length,
                  field: "target" as const,
                  quote: request.targetText,
                  start: 0,
                },
              ],
              reason: "The evidence determines the current semantic judgment.",
              requirementId: id,
              verdict,
            })),
            key: request.key,
            modelId,
          })),
        ),
      ),
    };
    const translationConfig = config({
      audit: definition(semanticProvider),
      sourceText,
      state,
      targetText,
    });

    const unresolved = await auditCatalogs(translationConfig);
    expect(unresolved).toMatchObject({ audited: 1, cached: 0, unresolved: 1 });

    verdict = "preserved";
    const converged = await auditCatalogs(translationConfig);
    expect(converged).toMatchObject({ accepted: 1, audited: 1, cached: 0, unresolved: 0 });
    expect(semanticProvider.audit).toHaveBeenCalledTimes(4);

    const cached = await auditCatalogs(translationConfig, { checkOnly: true });
    expect(cached).toMatchObject({ accepted: 1, cached: 1, unresolved: 0 });
  });

  it("rejects non-literal provider evidence instead of caching unverifiable judgments", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider: SemanticAuditProvider = {
      audit: ({ requests }) =>
        Promise.resolve(
          requests.map((request) => ({
            evaluations: request.requirements.map(({ id }) => ({
              confidence: "high" as const,
              evidence: [
                { end: 4, field: "source" as const, quote: "fake", start: 0 },
                {
                  end: request.targetText.length,
                  field: "target" as const,
                  quote: request.targetText,
                  start: 0,
                },
              ],
              reason: "Claims preservation.",
              requirementId: id,
              verdict: "preserved" as const,
            })),
            key: request.key,
            modelId: "audit-forward-model-v1",
          })),
        ),
    };
    await expect(
      auditCatalogs(config({ audit: definition(semanticProvider), sourceText, state, targetText })),
    ).rejects.toThrow("non-literal evidence span");
    expect(
      state.snapshot.entries["de::messages::messages::/claim"]?.validationAudits,
    ).toBeUndefined();
  });

  it("rejects source-only ambiguous evidence instead of treating audit abstention as proof", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider: SemanticAuditProvider = {
      audit: ({ modelId, requests }) =>
        Promise.resolve(
          requests.map((request) => ({
            evaluations: request.requirements.map(({ id }) => ({
              confidence: "high" as const,
              evidence: [
                {
                  end: request.sourceText.length,
                  field: "source" as const,
                  quote: request.sourceText,
                  start: 0,
                },
              ],
              reason: "The target evidence was not established.",
              requirementId: id,
              verdict: "ambiguous" as const,
            })),
            key: request.key,
            modelId,
          })),
        ),
    };

    await expect(
      auditCatalogs(config({ audit: definition(semanticProvider), sourceText, state, targetText })),
    ).rejects.toThrow("must cite source and target evidence for ambiguous requirement");
  });

  it("rejects literal but semantically trivial preserved evidence", async () => {
    const sourceText = "Fleet cards have no refundable deposit";
    const targetText = "Flottenkarten haben keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider: SemanticAuditProvider = {
      audit: ({ modelId, requests }) =>
        Promise.resolve(
          requests.map((request) => ({
            evaluations: request.requirements.map(({ id }) => ({
              confidence: "high" as const,
              evidence: [
                { end: 1, field: "source" as const, quote: "F", start: 0 },
                { end: 1, field: "target" as const, quote: "F", start: 0 },
              ],
              reason: "The claim is preserved.",
              requirementId: id,
              verdict: "preserved" as const,
            })),
            key: request.key,
            modelId,
          })),
        ),
    };

    await expect(
      auditCatalogs(config({ audit: definition(semanticProvider), sourceText, state, targetText })),
    ).rejects.toThrow("semantically trivial preserved evidence");
    expect(
      state.snapshot.entries["de::messages::messages::/claim"]?.validationAudits,
    ).toBeUndefined();
  });

  it("invalidates cache on detector revisions and never calls providers in check mode", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider();
    await auditCatalogs(
      config({ audit: definition(semanticProvider), sourceText, state, targetText }),
    );

    for (const staleDefinition of [
      definition(semanticProvider, "detector-v2"),
      definition(semanticProvider, "detector-v1", { forwardPromptRevision: "forward-v2" }),
      definition(semanticProvider, "detector-v1", {
        adversarialPromptRevision: "adversarial-v2",
      }),
      definition(semanticProvider, "detector-v1", { forwardModelId: "audit-model-v2" }),
      definition(semanticProvider, "detector-v1", { providerRevision: "provider-v2" }),
      definition(semanticProvider, "detector-v1", {
        analyze: () => ({
          keyMaterial: { signedClaim: "no-deposit:asserted" },
          requirements: [{ description: "Preserve changed semantics.", id: "claim" }],
        }),
      }),
    ]) {
      const result = await auditCatalogs(
        config({ audit: staleDefinition, sourceText, state, targetText }),
        { checkOnly: true },
      );
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "semantic-audit-stale", status: "stale" }),
      ]);
    }
    for (const changedConfig of [
      config({
        audit: definition(semanticProvider),
        sourceText: `${sourceText}.`,
        state,
        targetText,
      }),
      config({
        audit: definition(semanticProvider),
        sourceText,
        state,
        targetText: `${targetText}.`,
      }),
    ]) {
      const result = await auditCatalogs(changedConfig, { checkOnly: true });
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "semantic-audit-stale", status: "stale" }),
      ]);
    }
    const contextOnlyChange = await auditCatalogs(
      {
        ...config({ audit: definition(semanticProvider), sourceText, state, targetText }),
        context: {
          project: {
            constraints: [
              {
                kind: "required-term",
                targetValues: ["SECRET-ALTERNATE-A", "SECRET-ALTERNATE-B"],
                value: "fuel card",
              },
            ],
            notes: "Analyzer-only translation guidance changed.",
          },
        },
      },
      { checkOnly: true },
    );
    expect(contextOnlyChange.issues).toEqual([
      expect.objectContaining({ code: "semantic-audit-stale", status: "stale" }),
    ]);
    expect(semanticProvider.audit).toHaveBeenCalledTimes(2);
  });

  it("keeps provider request identity stable across analyzer bookkeeping revisions", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider();

    await auditCatalogs(
      config({ audit: definition(semanticProvider, "detector-v1"), sourceText, state, targetText }),
    );
    const firstKey = semanticProvider.audit.mock.calls[0]?.[0].requests[0]?.key;

    await auditCatalogs(
      config({ audit: definition(semanticProvider, "detector-v2"), sourceText, state, targetText }),
    );
    const secondKey = semanticProvider.audit.mock.calls[2]?.[0].requests[0]?.key;

    expect(firstKey).toMatch(/^claim-integrity:/u);
    expect(secondKey).toBe(firstKey);
  });

  it("records material provider findings as retranslation requirements", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Eine Kaution ist erforderlich";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider("contradicted");
    const result = await auditCatalogs(
      config({
        audit: definition(semanticProvider),
        sourceText,
        state,
        targetText,
      }),
    );
    expect(result).toMatchObject({ accepted: 0, retranslate: 1, unresolved: 0 });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "semantic-audit-retranslate" }),
    ]);
  });

  it("promotes a semantic repair for zero-generation reuse after transaction rollback", async () => {
    const sourceText = "No refundable deposit is required.";
    const rejectedTarget = "Eine rückzahlbare Kaution ist erforderlich.";
    const repairedTarget = "Es ist keine rückzahlbare Kaution erforderlich.";
    const sourceRef: DocumentRef = {
      catalogId: "messages",
      format: "json",
      locale: "en",
      path: "/en/messages.json",
      unitId: "messages",
    };
    const sourceDocument: LoadedDocument = {
      entries: [translatedEntry(sourceText)],
      ref: sourceRef,
      state: {},
    };
    const initialTarget: LoadedDocument = {
      entries: [translatedEntry(sourceText)],
      ref: { ...sourceRef, locale: "de", path: "/de/messages.json" },
      state: {},
    };
    let targetDocument = structuredClone(initialTarget);
    const catalog: CatalogAdapter = {
      createDocumentRef(ref, locale) {
        return { ...ref, locale, path: `/${locale}/messages.json` };
      },
      id: "messages",
      listDocumentRefs: () => Promise.resolve([sourceRef]),
      loadDocument: (ref) =>
        Promise.resolve(structuredClone(ref.locale === "en" ? sourceDocument : targetDocument)),
      reconcileDocument({ ref, source, target }) {
        return Promise.resolve(
          structuredClone(
            target ?? {
              entries: source.entries,
              ref,
              state: source.state,
            },
          ),
        );
      },
      writeDocument(document) {
        targetDocument = structuredClone(document);
        return Promise.resolve();
      },
    };
    const state = {
      snapshot: { entries: {}, version: 2 },
      load() {
        return Promise.resolve(structuredClone(this.snapshot));
      },
      save(next: SyncStateSnapshot) {
        this.snapshot = structuredClone(next);
        return Promise.resolve();
      },
      withLock<T>(operation: () => Promise<T>) {
        return operation();
      },
    };
    const base = new Map<string, string>();
    const promoted = new Map<string, string>();
    const rejected = new Set<string>();
    const rejectionKey = (digest: string, translation: string) =>
      `${digest}:${digestValue(translation)}`;
    const cache: TranslationCandidateCache = {
      get(key) {
        const candidates = [promoted.get(key.digest), base.get(key.digest)];
        return Promise.resolve(
          candidates.find(
            (translation) =>
              translation !== undefined && !rejected.has(rejectionKey(key.digest, translation)),
          ),
        );
      },
      promote(key, translation) {
        promoted.set(key.digest, translation);
        return Promise.resolve();
      },
      put(key, translation) {
        if (!base.has(key.digest)) {
          base.set(key.digest, translation);
        }
        return Promise.resolve();
      },
      reject(key, translation) {
        rejected.add(rejectionKey(key.digest, translation));
        return Promise.resolve();
      },
    };
    const generationCalls: string[] = [];
    const semanticProvider: SemanticAuditProvider = {
      audit: vi.fn<SemanticAuditProvider["audit"]>(({ modelId, requests }) =>
        Promise.resolve(
          requests.map((request) => ({
            evaluations: request.requirements.map(({ id }) => ({
              confidence: "high" as const,
              evidence: [
                {
                  end: request.sourceText.length,
                  field: "source" as const,
                  quote: request.sourceText,
                  start: 0,
                },
                {
                  end: request.targetText.length,
                  field: "target" as const,
                  quote: request.targetText,
                  start: 0,
                },
              ],
              reason: "The target either preserves or contradicts the no-deposit claim.",
              requirementId: id,
              verdict:
                request.targetText === repairedTarget
                  ? ("preserved" as const)
                  : ("contradicted" as const),
            })),
            key: request.key,
            modelId,
          })),
        ),
      ),
    };
    const translationConfig: AiTranslateConfig = {
      candidateCache: {
        identity: {
          modelId: "translation-model-v1",
          providerId: "provider",
          providerRevision: "provider-v1",
        },
        store: cache,
      },
      catalogs: [catalog],
      generationRevision: "generation-v1",
      provider: {
        translate({ requests }) {
          generationCalls.push(...requests.map(({ sourceText: source }) => source));
          const translation = generationCalls.length === 1 ? rejectedTarget : repairedTarget;
          return Promise.resolve(requests.map(({ key }) => ({ key, translation })));
        },
      },
      semanticAudits: [definition(semanticProvider)],
      sourceLocale: "en",
      state,
      targetLocales: ["de"],
      validation: {
        deterministicContractRevision: `sha256:${"b".repeat(64)}`,
        enforceAcceptanceProvenance: true,
        semanticAuditExecution: "provider" as const,
      },
    };

    const originalState = structuredClone(state.snapshot);
    await syncCatalogs(translationConfig);
    await expect(auditCatalogs(translationConfig)).resolves.toMatchObject({ retranslate: 1 });
    await syncCatalogs(translationConfig);
    await expect(auditCatalogs(translationConfig)).resolves.toMatchObject({ accepted: 1 });

    targetDocument = structuredClone(initialTarget);
    state.snapshot = structuredClone(originalState);
    const retried = await syncCatalogs(translationConfig);

    expect(retried.metrics).toMatchObject({ candidateCacheHits: 1, failedEntries: 0 });
    expect(generationCalls).toHaveLength(2);
    expect(targetDocument.entries[0]?.value).toBe(repairedTarget);
  });

  it("rejects extra response keys and responses attributed to the wrong model", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const base = provider();
    const extraProvider: SemanticAuditProvider = {
      audit: async (args) => {
        const responses = await base.audit(args);
        const first = responses[0];
        return first ? [...responses, { ...first, key: "injected" }] : responses;
      },
    };
    await expect(
      auditCatalogs(config({ audit: definition(extraProvider), sourceText, state, targetText })),
    ).rejects.toThrow('returned unknown key "injected"');

    const wrongModelProvider: SemanticAuditProvider = {
      audit: async (args) =>
        (await base.audit(args)).map((response) => ({ ...response, modelId: "wrong-model" })),
    };
    await expect(
      auditCatalogs(
        config({ audit: definition(wrongModelProvider), sourceText, state, targetText }),
      ),
    ).rejects.toThrow('returned modelId "wrong-model"');
  });

  it("fails closed on incomplete cached provenance even when its digest matches", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider();
    const translationConfig = config({
      audit: definition(semanticProvider),
      sourceText,
      state,
      targetText,
    });
    await auditCatalogs(translationConfig);
    const stateEntry = state.snapshot.entries[makeStateKey("de", "messages", "messages", "/claim")];
    const inputDigest = stateEntry?.validationAudits?.["claim-integrity"]?.inputDigest;
    expect(inputDigest).toBeTypeOf("string");
    if (!stateEntry || !inputDigest) {
      throw new Error("Expected an audited state entry.");
    }
    stateEntry.validationAudits = {
      "claim-integrity": {
        inputDigest,
        status: "accepted",
      } as never,
    };

    const result = await auditCatalogs(translationConfig, { checkOnly: true });
    expect(result).toMatchObject({ accepted: 0, cached: 0, unresolved: 1 });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "semantic-audit-stale", status: "stale" }),
    ]);
  });

  it("replaces or retires stale retranslate findings when detector applicability changes", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Eine Kaution ist erforderlich";
    const state = memoryState(sourceText, targetText);
    const rejectedDefinition = definition(provider("contradicted"));
    await auditCatalogs(config({ audit: rejectedDefinition, sourceText, state, targetText }));

    const deterministicDefinition = definition(provider(), "detector-v2", {
      analyze: () => ({
        deterministicEvaluations: [
          {
            confidence: "high",
            evidence: [
              { end: sourceText.length, field: "source", quote: sourceText, start: 0 },
              { end: targetText.length, field: "target", quote: targetText, start: 0 },
            ],
            reason: "Exact deterministic claim and scope parity.",
            requirementId: "claim",
            verdict: "preserved",
          },
        ],
        requirements: [{ description: "Preserve the signed claim.", id: "claim" }],
      }),
    });
    const accepted = await auditCatalogs(
      config({ audit: deterministicDefinition, sourceText, state, targetText }),
    );
    expect(accepted).toMatchObject({ accepted: 1, retranslate: 0, unresolved: 0 });
    expect(
      state.snapshot.entries[makeStateKey("de", "messages", "messages", "/claim")]
        ?.validationAudits?.["claim-integrity"],
    ).toMatchObject({ auditRevision: "detector-v2", status: "accepted" });
    expect(
      state.snapshot.entries[makeStateKey("de", "messages", "messages", "/claim")]
        ?.acceptedContractRevision,
    ).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const rejectedAgain = definition(provider("contradicted"), "detector-v3");
    await auditCatalogs(config({ audit: rejectedAgain, sourceText, state, targetText }));
    const notApplicable = definition(provider(), "detector-v4", { analyze: () => null });
    const staleCheck = await auditCatalogs(
      config({ audit: notApplicable, sourceText, state, targetText }),
      { checkOnly: true },
    );
    expect(staleCheck.issues).toEqual([
      expect.objectContaining({ code: "semantic-audit-stale", status: "stale" }),
    ]);
    await auditCatalogs(config({ audit: notApplicable, sourceText, state, targetText }));
    expect(
      state.snapshot.entries[makeStateKey("de", "messages", "messages", "/claim")]
        ?.validationAudits,
    ).toBeUndefined();
  });

  it("requires high-confidence literal evidence before deterministic acceptance", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const semanticProvider = provider("preserved");
    const lowConfidenceDefinition = definition(semanticProvider, "detector-low-confidence", {
      analyze: () => ({
        deterministicEvaluations: [
          {
            confidence: "low",
            reason: "The detector is uncertain.",
            requirementId: "claim",
            verdict: "preserved",
          },
        ],
        requirements: [{ description: "Preserve the signed claim.", id: "claim" }],
      }),
    });

    const result = await auditCatalogs(
      config({ audit: lowConfidenceDefinition, sourceText, state, targetText }),
    );

    expect(result).toMatchObject({ accepted: 1, audited: 1, unresolved: 0 });
    expect(semanticProvider.audit).toHaveBeenCalledTimes(2);
    expect(semanticProvider.audit.mock.calls[0]?.[0].requests[0]?.requirements).toEqual([
      { description: "Preserve the signed claim.", id: "claim" },
    ]);
  });

  it("atomically rekeys legacy state while persisting audit provenance", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    const state = memoryState(sourceText, targetText);
    const modernKey = makeStateKey("de", "messages", "messages", "/claim");
    const legacyKey = makeLegacyStateKey("de", "messages", "/claim");
    const legacyEntry = state.snapshot.entries[modernKey];
    if (!legacyEntry) {
      throw new Error("Expected state fixture.");
    }
    delete state.snapshot.entries[modernKey];
    state.snapshot.entries[legacyKey] = { ...legacyEntry, catalogId: undefined } as never;

    const result = await auditCatalogs(
      config({ audit: definition(provider()), sourceText, state, targetText }),
    );
    expect(result).toMatchObject({ accepted: 1, issues: [] });
    expect(state.snapshot.entries[legacyKey]).toBeUndefined();
    expect(state.snapshot.entries[modernKey]).toMatchObject({
      catalogId: "messages",
      validationAudits: { "claim-integrity": expect.objectContaining({ status: "accepted" }) },
    });
  });

  it("fails closed when an explicit unit filter matches nothing", async () => {
    const sourceText = "No refundable deposit";
    const targetText = "Keine rückzahlbare Kaution";
    await expect(
      auditCatalogs(
        config({
          audit: definition(provider()),
          sourceText,
          state: memoryState(sourceText, targetText),
          targetText,
        }),
        { checkOnly: true, unitIds: ["typo"] },
      ),
    ).rejects.toThrow('No source document matched requested unitId "typo"');
  });
});
