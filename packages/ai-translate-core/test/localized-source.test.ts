import { describe, expect, it, vi } from "vitest";

import { auditCatalogs } from "../src/audit";
import { syncCatalogs, validateCatalogs } from "../src/sync";
import type { AiTranslateConfig, CatalogAdapter, Entry, LoadedDocument, SyncStateSnapshot } from "../src/types";

function fixture() {
  const entry = (category: string): Entry => ({
    address: [{ kind: "key", key: category }],
    context: { notes: `Plural category: ${category}` },
    policy: "translate",
    storage: "string",
    value: category === "one" ? "One message" : "Some messages",
  });
  const source: LoadedDocument = {
    entries: [entry("one"), entry("other")],
    ref: { catalogId: "native", format: "custom-native", locale: "en", path: "/source", unitId: "messages" },
    state: {},
    structureDigest: "source",
  };
  const documents = new Map<string, LoadedDocument>();
  const localizeSourceDocument = vi.fn<NonNullable<CatalogAdapter["localizeSourceDocument"]>>(async ({ source: original, locale }) => ({
    ...original,
    entries: locale === "pl" ? [...original.entries, entry("few"), entry("many")] : original.entries,
    structureDigest: locale,
  }));
  const catalog: CatalogAdapter = {
    id: "native",
    createDocumentRef: (ref, locale) => ({ ...ref, locale, path: `/${locale}` }),
    listDocumentRefs: async () => [source.ref],
    loadDocument: async (ref) => ref.locale === "en" ? structuredClone(source) : structuredClone(documents.get(ref.locale) ?? null),
    localizeSourceDocument,
    reconcileDocument: async ({ ref, source: localized, target }) => ({ ...structuredClone(target ?? localized), ref }),
    writeDocument: async (document) => { documents.set(document.ref.locale, structuredClone(document)); },
  };
  let snapshot: SyncStateSnapshot = { version: 2, entries: {} };
  const translate = vi.fn<AiTranslateConfig["provider"]["translate"]>(async ({ requests }) => requests.map(({ key, sourceText }) => ({ key, translation: `Translated ${sourceText}` })));
  const config: AiTranslateConfig = {
    catalogs: [catalog],
    context: { project: { notes: "Use short UI labels." } },
    provider: { translate },
    sourceLocale: "en",
    targetLocales: ["pl", "de"],
    state: {
      load: async () => structuredClone(snapshot),
      save: async (next) => { snapshot = structuredClone(next); },
      withLock: (operation) => operation(),
    },
  };
  return { catalog, config, documents, localizeSourceDocument, source, translate };
}

describe("locale-specific source documents", () => {
  it("uses the same source shape for sync, validation and audit without mutating the authored source", async () => {
    const test = fixture();
    const before = structuredClone(test.source);
    const synced = await syncCatalogs(test.config);
    expect(synced.metrics.translatedEntries).toBe(6);
    expect(test.translate.mock.calls.flatMap(([args]) => args.requests).map(({ context }) => context?.notes))
      .toContain("Use short UI labels.\nPlural category: few");
    expect((await validateCatalogs(test.config)).issues).toEqual([]);

    const analyzed: string[] = [];
    await auditCatalogs({
      ...test.config,
      semanticAudits: [{
        id: "meaning", revision: "1", providerRevision: "1",
        forwardModelId: "test", forwardPromptRevision: "1",
        adversarialModelId: "test", adversarialPromptRevision: "1",
        analyze: ({ path, locale }) => {
          analyzed.push(`${locale}:${path}`);
          return { requirements: [] };
        },
        provider: { audit: async () => [] },
      }],
    });
    expect(analyzed).toContain("pl:/few");
    expect(analyzed).toContain("pl:/many");
    expect(analyzed).not.toContain("de:/few");
    expect(test.source).toEqual(before);
    expect(test.localizeSourceDocument).toHaveBeenCalledTimes(6);
  });

  it("reports missing and invalid synthesized target arms", async () => {
    const test = fixture();
    await syncCatalogs(test.config);
    const polish = test.documents.get("pl");
    if (!polish) { throw new Error("Missing Polish fixture"); }
    polish.entries = polish.entries.filter(({ address }) => address[0]?.kind !== "key" || address[0].key !== "few");
    const result = await validateCatalogs(test.config);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-target-entry", locale: "pl", jsonPointer: "/few" }),
    ]));
  });

  it("invalidates generated text when a translator note is newly added to its source", async () => {
    const test = fixture();
    const firstEntry = test.source.entries[0];
    if (!firstEntry) { throw new Error("Missing source fixture"); }
    delete firstEntry.context;
    await syncCatalogs(test.config);
    test.translate.mockClear();
    firstEntry.context = { notes: "This is a compact toolbar label." };
    const result = await syncCatalogs(test.config);
    expect(result.metrics.translatedEntries).toBe(2);
    expect(test.translate.mock.calls.flatMap(([args]) => args.requests)).toHaveLength(2);
    expect((await validateCatalogs(test.config)).issues).toEqual([]);
  });
});
