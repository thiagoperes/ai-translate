import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncCatalogs, validateCatalogs } from "@ai-translate/core";
import type { AiTranslateConfig, JsonObject, SyncStateSnapshot, TranslationProvider } from "@ai-translate/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppleStringCatalog } from "../src/xcstrings";
import { isObject, own } from "../src/xcstrings-model";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const unit = (value: string, state = "translated"): JsonObject => ({ stringUnit: { state, value } });
const hasXcode = process.platform === "darwin" && spawnSync("xcrun", ["--find", "xcstringstool"]).status === 0;

function at(value: JsonObject, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) { current = isObject(current) ? own(current, key) : undefined; }
  return current;
}

async function setup(strings?: JsonObject) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-xcstrings-sync-"));
  roots.push(rootDir);
  const filePath = path.join(rootDir, "Localizable.xcstrings");
  await fs.writeFile(filePath, JSON.stringify({
    sourceLanguage: "en", version: "1.0",
    strings: strings ?? {
      greeting: { comment: "Welcome screen; keep friendly", localizations: { en: unit("Hello %@") } },
      files: { localizations: { en: { variations: { plural: { one: unit("%lld file"), other: unit("%lld files") } } } } },
      device: { localizations: { en: { variations: { device: { iphone: unit("On your phone"), other: unit("On your device") } } } } },
      count: { localizations: { en: { ...unit("%#@items@ available"), substitutions: { items: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg item"), other: unit("%arg items") } } } } } } },
      untouched: { shouldTranslate: false }, stale: { extractionState: "stale" },
    },
  }, null, 2));
  let snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
  const translate = vi.fn<TranslationProvider["translate"]>(async ({ locale, requests }) => requests.map((request) => ({ key: request.key, translation: `${locale} ${request.sourceText}` })));
  const adapter = createAppleStringCatalog({ rootDir, sourceLocale: "en" });
  const config: AiTranslateConfig = {
    catalogs: [adapter], provider: { translate }, sourceLocale: "en", targetLocales: ["de", "pl"],
    state: {
      load: async () => structuredClone(snapshot),
      save: async (next) => { snapshot = structuredClone(next); },
      withLock: (operation) => operation(),
    },
  };
  const read = async () => JSON.parse(await fs.readFile(filePath, "utf8")) as JsonObject;
  return { adapter, config, filePath, read, rootDir, translate };
}

describe("String Catalog engine integration", () => {
  it("preserves explicitly literal percentages through scaffolding and still validates real printf keys", async () => {
    const { config, rootDir, filePath, read, translate } = await setup({
      progress: { localizations: { en: unit("100% done") } },
      "progress.detail": { localizations: { en: unit("Hello %@") } },
    });
    const adapter = createAppleStringCatalog({ rootDir, sourceLocale: "en", plainTextKeys: ["progress"] });
    const literalConfig = { ...config, catalogs: [adapter], targetLocales: ["fr"] };
    expect((await adapter.scaffoldLocale?.({ locale: "fr", strategy: "copy-source" }))?.createdDocuments).toBe(1);
    translate.mockImplementation(async ({ requests }) => requests.map((request) => ({
      key: request.key,
      translation: request.sourceText === "100% done" ? "100 % terminé" : "Bonjour %@",
    })));
    expect((await syncCatalogs(literalConfig)).metrics).toMatchObject({ failedEntries: 0, translatedEntries: 2 });
    const requests = translate.mock.calls.flatMap(([args]) => args.requests);
    expect(requests.find(({ sourceText }) => sourceText === "100% done")?.tokens).toEqual([
      { raw: "100% done", type: "text" },
    ]);
    expect(requests.find(({ sourceText }) => sourceText === "Hello %@")?.tokens).toContainEqual(
      expect.objectContaining({ raw: "%@", syntax: "printf" }),
    );
    expect(at(await read(), "strings", "progress", "localizations", "fr")).toEqual(unit("100 % terminé"));
    expect((await validateCatalogs(literalConfig)).issues).toEqual([]);
    expect((await syncCatalogs(literalConfig)).metrics.translatedEntries).toBe(0);
    if (hasXcode) {
      const output = path.join(rootDir, "compiled");
      await fs.mkdir(output);
      execFileSync("xcrun", ["xcstringstool", "compile", filePath, "--output-directory", output]);
    }
    const invalid = await read();
    (at(invalid, "strings", "progress.detail", "localizations", "fr") as JsonObject).stringUnit = { state: "translated", value: "Bonjour" };
    await fs.writeFile(filePath, JSON.stringify(invalid));
    expect((await validateCatalogs(literalConfig)).issues.map(({ code }) => code))
      .toContain("apple-printf-argument-mismatch");
  });

  it("syncs native families into shared-file locales, forwards context, and stays incremental", async () => {
    const { config, read, filePath, translate } = await setup();
    const first = await syncCatalogs(config);
    expect(first.metrics).toMatchObject({ failedEntries: 0, translatedEntries: 20 });
    const requests = translate.mock.calls.flatMap(([args]) => args.requests);
    expect(requests.find(({ provenance }) => provenance.jsonPointer === "/greeting/stringUnit/value")?.context?.notes).toContain("Welcome screen; keep friendly");
    expect(requests.find(({ provenance }) => provenance.jsonPointer.includes("/few/"))?.context?.notes).toContain("Plural category: few.");
    expect(requests.find(({ provenance }) => provenance.jsonPointer.includes("/substitutions/"))?.tokens).toContainEqual(expect.objectContaining({ raw: "%arg", type: "placeholder" }));
    expect((await validateCatalogs(config)).issues).toEqual([]);
    const before = await fs.readFile(filePath, "utf8");
    translate.mockClear();
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(0);
    expect(translate).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    const result = await read();
    expect(at(result, "strings", "files", "localizations", "pl", "variations", "plural", "few")).toEqual(unit("pl %lld files"));
    expect(at(result, "strings", "untouched", "localizations")).toBeUndefined();
    expect(at(result, "strings", "stale", "localizations")).toBeUndefined();
  });

  it("retranslates changed source values and preserves later human target edits", async () => {
    const { config, read, filePath, translate } = await setup({ greeting: { localizations: { en: unit("Hello %@") } } });
    await syncCatalogs(config);
    const changed = await read();
    ((at(changed, "strings", "greeting", "localizations", "en") as JsonObject).stringUnit as JsonObject).value = "Welcome %@";
    await fs.writeFile(filePath, JSON.stringify(changed));
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(2);
    const manual = await read();
    ((at(manual, "strings", "greeting", "localizations", "de") as JsonObject).stringUnit as JsonObject).value = "Menschlich %@";
    await fs.writeFile(filePath, JSON.stringify(manual));
    translate.mockClear();
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(0);
    expect(translate).not.toHaveBeenCalled();
    expect(at(await read(), "strings", "greeting", "localizations", "de", "stringUnit", "value")).toBe("Menschlich %@");
  });

  it("resyncs review-state entries while retaining translated peers", async () => {
    const { config, read, translate } = await setup({
      ready: { localizations: { de: unit("Fertig") } },
      review: { localizations: { de: unit("Review me", "needs_review") } },
      fresh: { localizations: { de: unit("Fresh", "new") } },
    });
    const result = await syncCatalogs({ ...config, targetLocales: ["de"] });
    expect(result.metrics.translatedEntries).toBe(2);
    expect(translate.mock.calls.flatMap(([args]) => args.requests).map(({ sourceText }) => sourceText)).toEqual(["review", "fresh"]);
    expect(at(await read(), "strings", "ready", "localizations", "de")).toEqual(unit("Fertig"));
  });

  it("supports locale-owned device variants and sources every synthetic translation from English", async () => {
    const { config, read, translate } = await setup({
      label: { localizations: { en: unit("View saved articles"), pt: { variations: { device: { applewatch: unit("Old watch", "new"), other: unit("Old other", "new") } } } } },
    });
    const local = { ...config, targetLocales: ["pt"] };
    expect((await syncCatalogs(local)).metrics.translatedEntries).toBe(2);
    expect(translate.mock.calls.flatMap(([args]) => args.requests).map(({ sourceText }) => sourceText)).toEqual(["View saved articles", "View saved articles"]);
    expect((await validateCatalogs(local)).issues).toEqual([]);
    expect(at(await read(), "strings", "label", "localizations", "pt", "variations", "device", "applewatch")).toEqual(unit("pt View saved articles"));
  });

  it("rejects target-only substitution fragments before provider calls and preserves all catalog bytes", async () => {
    const { config, filePath, translate } = await setup({
      "Found %lld birds": { localizations: { de: { ...unit("%#@birds@ entdeckt"), substitutions: { birds: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg Vogel"), other: unit("%arg Vögel") } } } } } } },
    });
    const before = await fs.readFile(filePath, "utf8");
    await expect(syncCatalogs({ ...config, targetLocales: ["de"] })).rejects.toThrow('Unsupported target-only String Catalog substitution "birds" at key "Found %lld birds" (de)');
    expect(translate).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    const explicit = JSON.parse(before) as JsonObject;
    const localizations = at(explicit, "strings", "Found %lld birds", "localizations") as JsonObject;
    localizations.en = { ...unit("Found %#@birds@"), substitutions: { birds: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg bird"), other: unit("%arg birds") } } } } };
    await fs.writeFile(filePath, JSON.stringify(explicit));
    expect((await syncCatalogs({ ...config, targetLocales: ["de"] })).metrics.failedEntries).toBe(0);
    expect((await validateCatalogs({ ...config, targetLocales: ["de"] })).issues).toEqual([]);
    expect(translate).not.toHaveBeenCalled();
  });

  it("retranslates changed substitution bindings even if resulting text stays identical", async () => {
    const node = { ...unit("%#@items@ available"), substitutions: { items: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg item"), other: unit("%arg items") } } } } };
    const { config, filePath, read, translate } = await setup({ count: { localizations: { en: node } } });
    const local = { ...config, targetLocales: ["de"] };
    await syncCatalogs(local);
    const changed = await read();
    const binding = at(changed, "strings", "count", "localizations", "en", "substitutions", "items") as JsonObject;
    binding.argNum = 2;
    binding.formatSpecifier = "d";
    await fs.writeFile(filePath, JSON.stringify(changed));
    translate.mockClear();
    expect((await syncCatalogs(local)).metrics.translatedEntries).toBe(3);
    expect(translate.mock.calls.flatMap(([args]) => args.requests)[0]?.context?.notes).toContain('"items":[2,"d"]');
    expect(at(await read(), "strings", "count", "localizations", "de", "substitutions", "items", "argNum")).toBe(2);
    expect(at(await read(), "strings", "count", "localizations", "de", "substitutions", "items", "formatSpecifier")).toBe("d");
    expect((await validateCatalogs(local)).issues).toEqual([]);
  });

  it("syncs and validates reordered catalog substitutions using canonical source bindings", async () => {
    const substitutions = {
      animals: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg animal"), other: unit("%arg animals") } } },
      birds: { argNum: 2, formatSpecifier: "lld", variations: { plural: { one: unit("%arg bird"), other: unit("%arg birds") } } },
    };
    const { config, read, translate } = await setup({ counts: { localizations: { en: { ...unit("%#@animals@ and %#@birds@"), substitutions } } } });
    translate.mockImplementation(async ({ requests }) => requests.map(({ key, sourceText }) => ({
      key, translation: sourceText === "%#@animals@ and %#@birds@" ? "%#@birds@ und %#@animals@" : `de ${sourceText}`,
    })));
    const local = { ...config, targetLocales: ["de"] };
    expect((await syncCatalogs(local)).metrics).toMatchObject({ translatedEntries: 5, failedEntries: 0 });
    const base = translate.mock.calls.flatMap(([args]) => args.requests).find(({ sourceText }) => sourceText === "%#@animals@ and %#@birds@");
    expect(base?.tokens?.map(({ raw }) => raw).join("")).toBe("%#@animals@ and %#@birds@");
    expect(base?.context?.notes).toContain('"animals":[1,"lld"],"birds":[2,"lld"]');
    expect(at(await read(), "strings", "counts", "localizations", "de", "stringUnit", "value")).toBe("%#@birds@ und %#@animals@");
    expect((await validateCatalogs(local)).issues).toEqual([]);
    translate.mockClear();
    expect((await syncCatalogs(local)).metrics.translatedEntries).toBe(0);
    expect(translate).not.toHaveBeenCalled();
  });

  it("keeps source bindings authoritative when an existing target changes argument metadata", async () => {
    const bindings = (animals: number, birds: number) => ({
      animals: { argNum: animals, formatSpecifier: "lld", variations: { plural: { one: unit("%arg animal"), other: unit("%arg animals") } } },
      birds: { argNum: birds, formatSpecifier: "lld", variations: { plural: { one: unit("%arg bird"), other: unit("%arg birds") } } },
    });
    const { config, read, translate } = await setup({ counts: { localizations: {
      en: { ...unit("%#@animals@ and %#@birds@"), substitutions: bindings(1, 2) },
      de: { ...unit("%#@birds@ und %#@animals@"), substitutions: bindings(2, 1) },
    } } });
    const local = { ...config, targetLocales: ["de"] };
    expect((await validateCatalogs(local)).issues.map(({ code }) => code)).toContain("markdoc-structure-mismatch");
    translate.mockImplementation(async ({ requests }) => requests.map(({ key, sourceText }) => ({
      key, translation: sourceText === "%#@animals@ and %#@birds@" ? "%#@birds@ und %#@animals@" : `de ${sourceText}`,
    })));
    expect((await syncCatalogs(local)).metrics).toMatchObject({ translatedEntries: 5, failedEntries: 0 });
    expect(at(await read(), "strings", "counts", "localizations", "de", "substitutions", "animals", "argNum")).toBe(1);
    expect(at(await read(), "strings", "counts", "localizations", "de", "substitutions", "birds", "argNum")).toBe(2);
    expect((await validateCatalogs(local)).issues).toEqual([]);
  });

  it("keeps scoped writes inside existing locales and rejects a missing scoped target before provider work", async () => {
    const { config, read, translate } = await setup({
      a: { localizations: { de: unit("Old", "new") } }, b: {},
    });
    const result = await syncCatalogs(config, { includePaths: ["/a/stringUnit/value"], locales: ["de"] });
    expect(result.metrics.translatedEntries).toBe(1);
    expect(at(await read(), "strings", "b", "localizations")).toBeUndefined();
    translate.mockClear();
    await expect(syncCatalogs(config, { includePaths: ["/a/stringUnit/value"], locales: ["pl"] })).rejects.toThrow("target");
    expect(translate).not.toHaveBeenCalled();
  });

  it("does not persist failed native argument validation or dry-run translations", async () => {
    const { config, filePath } = await setup({ greeting: { localizations: { en: unit("Hello %@") } } });
    const before = await fs.readFile(filePath, "utf8");
    await syncCatalogs(config, { dryRun: true });
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    config.provider = { translate: async ({ requests }) => requests.map(({ key }) => ({ key, translation: "Hallo %d" })) };
    const invalid = await syncCatalogs(config);
    expect(invalid.metrics.failedEntries).toBe(2);
    expect(invalid.documents.flatMap((document) => document.issues.map(({ code }) => code))).toContain("apple-printf-argument-mismatch");
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
  });

  it.skipIf(!hasXcode)("compiles translated plurals, devices, and substitutions with Apple's xcstringstool", async () => {
    const { config, filePath, rootDir } = await setup();
    await syncCatalogs(config);
    const output = path.join(rootDir, "compiled");
    await fs.mkdir(output);
    execFileSync("xcrun", ["xcstringstool", "compile", filePath, "--output-directory", output]);
    const de = await fs.readFile(path.join(output, "de.lproj/Localizable.stringsdict"), "utf8");
    const pl = await fs.readFile(path.join(output, "pl.lproj/Localizable.stringsdict"), "utf8");
    expect(de).toContain("NSStringDeviceSpecificRuleType");
    expect(de).toContain("de %1$lld item");
    expect(de).toContain("de %1$#@items@ available");
    expect(pl).toContain("<key>few</key>");
    expect(pl).toContain("<key>many</key>");
    expect(pl).toContain("pl %1$lld items");
    expect(await fs.readFile(path.join(output, "de.lproj/Localizable.strings"), "utf8")).toContain("de Hello %@");
  });

  it.skipIf(!hasXcode)("recognizes native-valid target-only substitutions but refuses destructive automated conversion", async () => {
    const { config, filePath, rootDir, translate } = await setup({
      "Found %lld birds": { localizations: { de: { ...unit("%#@birds@ entdeckt"), substitutions: { birds: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg Vogel"), other: unit("%arg Vögel") } } } } } } },
    });
    const before = await fs.readFile(filePath, "utf8");
    const output = path.join(rootDir, "compiled");
    await fs.mkdir(output);
    execFileSync("xcrun", ["xcstringstool", "compile", filePath, "--output-directory", output]);
    const de = await fs.readFile(path.join(output, "de.lproj/Localizable.stringsdict"), "utf8");
    expect(de).toContain("%1$#@birds@ entdeckt");
    expect(de).toContain("%1$lld Vögel");
    await expect(syncCatalogs({ ...config, targetLocales: ["de"] })).rejects.toThrow("Define the corresponding substitution in the source localization");
    expect(translate).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
  });

  it.skipIf(!hasXcode)("compiles reordered named substitutions to the original bound argument positions", async () => {
    const substitutions = {
      animals: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg animal"), other: unit("%arg animals") } } },
      birds: { argNum: 2, formatSpecifier: "lld", variations: { plural: { one: unit("%arg bird"), other: unit("%arg birds") } } },
    };
    const { config, filePath, rootDir, translate } = await setup({ counts: { localizations: { en: { ...unit("%#@animals@ and %#@birds@"), substitutions } } } });
    translate.mockImplementation(async ({ requests }) => requests.map(({ key, sourceText }) => ({
      key, translation: sourceText === "%#@animals@ and %#@birds@" ? "%#@birds@ und %#@animals@" : `de ${sourceText}`,
    })));
    const local = { ...config, targetLocales: ["de"] };
    expect((await syncCatalogs(local)).metrics.failedEntries).toBe(0);
    expect((await validateCatalogs(local)).issues).toEqual([]);
    const output = path.join(rootDir, "compiled");
    await fs.mkdir(output);
    execFileSync("xcrun", ["xcstringstool", "compile", filePath, "--output-directory", output]);
    const de = await fs.readFile(path.join(output, "de.lproj/Localizable.stringsdict"), "utf8");
    expect(de).toContain("%2$#@birds@ und %1$#@animals@");
    expect(de).toContain("de %1$lld animal");
    expect(de).toContain("de %2$lld bird");
  });

  it.skipIf(!hasXcode)("compiles target-only variants and partial scoped substitution scaffolds", async () => {
    const { adapter, config, filePath, rootDir } = await setup({
      label: { localizations: { pt: { variations: { device: { applewatch: unit("Abrir", "new"), other: unit("Abrir artigos", "new") } } } } },
      count: { localizations: { en: { ...unit("%#@items@ available"), substitutions: { items: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg item"), other: unit("%arg items") } } } } } } },
    });
    await syncCatalogs({ ...config, targetLocales: ["pt"] });
    await adapter.scaffoldLocale?.({ locale: "pl" });
    const output = path.join(rootDir, "compiled");
    await fs.mkdir(output);
    execFileSync("xcrun", ["xcstringstool", "compile", filePath, "--output-directory", output]);
    const result = await fs.readFile(path.join(output, "pt.lproj/Localizable.stringsdict"), "utf8");
    expect(result).toContain("applewatch");
    expect(result).toContain("pt label");
  });
});
