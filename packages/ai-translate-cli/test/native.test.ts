import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createAppleStringCatalog, createAppleStringsCatalog } from "@ai-translate/apple";
import { syncCatalogs } from "@ai-translate/core";
import type { AiTranslateConfig, TranslationProvider } from "@ai-translate/core";
import { createJsonStateStore, createLocalizedJsonDocument } from "@ai-translate/fs-json";
import { applePrintfMessageFormat, i18nextMessageFormat, i18nextPluralKeys } from "@ai-translate/message-formats";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as configModule from "../src/config";
import { runCli } from "../src/index";
import { runStagedCatalogTransaction } from "../src/transaction";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const unit = (value: string) => ({ stringUnit: { state: "translated", value } });

async function setup() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-native-cli-"));
  roots.push(cwd);
  const catalogPath = path.join(cwd, "Localizable.xcstrings");
  const catalog = {
    sourceLanguage: "en", version: "1.0", customMetadata: { preserved: true },
    strings: {
      "Speak like a local": { comment: "Hoioi onboarding title" },
      "Page %lld of %lld": { comment: "BlockTheNews onboarding progress" },
      earlier: { localizations: { en: { variations: { plural: {
        one: unit("%lld earlier message"), other: unit("%lld earlier messages"),
      } } } } },
      Hoioi: { shouldTranslate: false, localizations: { fr: unit("Hoioi") } },
    },
  };
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  await fs.mkdir(path.join(cwd, "legacy/en.lproj"), { recursive: true });
  await fs.writeFile(path.join(cwd, "legacy/en.lproj/InfoPlist.strings"), '/* Camera permission */\n"NSCameraUsageDescription" = "Use your camera to translate text.";\n');
  await fs.mkdir(path.join(cwd, "native"));
  await fs.writeFile(path.join(cwd, "native/en.json"), JSON.stringify({ ios: {
    NSPhotoLibraryUsageDescription: "Beauty needs access to your photos.",
    "Localizable.strings": { notification: "%@ shared a document" },
  } }));
  await fs.mkdir(path.join(cwd, "ui"));
  await fs.writeFile(path.join(cwd, "ui/en.json"), JSON.stringify({
    words_one: "{{count}} word", words_other: "{{count}} words",
  }));
  const translate = vi.fn<TranslationProvider["translate"]>(async ({ locale, requests }) => requests.map(({ key, sourceText }) => ({ key, translation: `${locale}: ${sourceText}` })));
  const config: AiTranslateConfig = {
    catalogs: [
      createAppleStringCatalog({ id: "swift", rootDir: cwd, sourceLocale: "en" }),
      createAppleStringsCatalog({ id: "legacy", rootDir: path.join(cwd, "legacy"), sourceLocale: "en" }),
      createLocalizedJsonDocument({ id: "expo", rootDir: path.join(cwd, "native"), unitId: "permissions", sourceLocale: "en", messageFormat: applePrintfMessageFormat }),
      createLocalizedJsonDocument({ id: "ui", rootDir: path.join(cwd, "ui"), unitId: "messages", sourceLocale: "en", messageFormat: i18nextMessageFormat, plurals: i18nextPluralKeys }),
    ],
    sourceLocale: "en", targetLocales: ["de", "pl"], provider: { translate },
    state: createJsonStateStore({ rootDir: cwd }),
  };
  vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
  vi.spyOn(configModule, "loadConfig").mockResolvedValue({ config, configPath: path.join(cwd, "ai-translate.config.ts") });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  return { catalog, catalogPath, config, cwd, errors, output, translate };
}

async function readCatalog(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8")) as {
    sourceLanguage: string;
    strings: Record<string, { localizations?: Record<string, unknown> }>;
  };
}

describe("native CLI workflows", () => {
  it("syncs Swift, legacy, Expo and shared UI catalogs together and then passes a read-only check", async () => {
    const test = await setup();
    expect(await runCli(["sync"], test.cwd)).toBe(0);
    const firstBytes = await fs.readFile(test.catalogPath);
    const result = await readCatalog(test.catalogPath);
    expect(result.sourceLanguage).toBe("en");
    expect(result.strings.earlier?.localizations?.en).toEqual(test.catalog.strings.earlier.localizations.en);
    expect(result.strings.Hoioi).toEqual(test.catalog.strings.Hoioi);
    expect(result.strings["Speak like a local"]?.localizations).toEqual({
      de: unit("de: Speak like a local"), pl: unit("pl: Speak like a local"),
    });
    const requests = test.translate.mock.calls.flatMap(([args]) => args.requests);
    expect(requests.filter(({ locale, provenance }) => locale === "pl" && provenance.jsonPointer.includes("/few/"))).toHaveLength(1);
    expect(requests.find(({ sourceText }) => sourceText === "Speak like a local")?.context?.notes).toContain("Hoioi onboarding title");
    expect(requests.filter(({ catalogId }) => catalogId === "expo")).toHaveLength(4);
    const polishUi = JSON.parse(await fs.readFile(path.join(test.cwd, "ui/pl.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(polishUi)).toEqual(["words_one", "words_few", "words_many", "words_other"]);
    test.translate.mockClear();
    expect(await runCli(["check"], test.cwd)).toBe(0);
    expect(await runCli(["sync"], test.cwd)).toBe(0);
    expect(test.translate).not.toHaveBeenCalled();
    expect(await fs.readFile(test.catalogPath)).toEqual(firstBytes);
  });

  it("keeps dry runs and failed mixed-catalog translations completely unwritten", async () => {
    const test = await setup();
    const original = await fs.readFile(test.catalogPath);
    expect(await runCli(["sync", "--dry-run"], test.cwd)).toBe(0);
    expect(test.translate).not.toHaveBeenCalled();
    expect(await fs.readFile(test.catalogPath)).toEqual(original);
    test.translate.mockImplementation(async ({ requests }) => requests.map(({ key, sourceText }) => ({ key, translation: sourceText.replaceAll("%lld", "%@").replaceAll("%@", "%d") })));
    expect(await runCli(["sync"], test.cwd)).toBe(1);
    expect(await fs.readFile(test.catalogPath)).toEqual(original);
    await expect(fs.access(path.join(test.cwd, "native/de.json"))).rejects.toThrow(/ENOENT/u);
    await expect(fs.access(path.join(test.cwd, "legacy/de.lproj/InfoPlist.strings"))).rejects.toThrow(/ENOENT/u);
    expect((await test.config.state.load()).entries).toEqual({});
  });

  it("scopes one new native key without filling unrelated locales or catalogs", async () => {
    const test = await setup();
    const existing = await readCatalog(test.catalogPath);
    const progress = existing.strings["Page %lld of %lld"];
    if (!progress) { throw new Error("Missing progress fixture"); }
    progress.localizations = { de: unit("Seite %lld von %lld") };
    await fs.writeFile(test.catalogPath, JSON.stringify(existing));
    expect(await runCli(["sync", "--catalog", "swift", "--locale", "de", "--include-path", "/Speak like a local/stringUnit/value"], test.cwd)).toBe(0);
    const result = await readCatalog(test.catalogPath);
    expect(result.strings["Speak like a local"]?.localizations?.de).toEqual(unit("de: Speak like a local"));
    expect(result.strings["Speak like a local"]?.localizations?.pl).toBeUndefined();
    expect(result.strings.earlier?.localizations?.de).toBeUndefined();
    expect(result.strings["Page %lld of %lld"]?.localizations?.de).toEqual(unit("Seite %lld von %lld"));
    expect(test.translate.mock.calls.flatMap(([args]) => args.requests)).toHaveLength(1);
    await expect(fs.access(path.join(test.cwd, "native/de.json"))).rejects.toThrow(/ENOENT/u);
  });

  it("creates a new native locale inside the transaction and translates scaffolded strings", async () => {
    const test = await setup();
    expect(await runCli(["new-locale", "ja"], test.cwd)).toBe(0);
    const result = await readCatalog(test.catalogPath);
    expect(result.strings["Speak like a local"]?.localizations?.ja).toEqual(unit("ja: Speak like a local"));
    expect(result.strings["Page %lld of %lld"]?.localizations?.ja).toEqual(unit("ja: Page %lld of %lld"));
    expect(await runCli(["check", "--locale", "ja"], test.cwd)).toBe(0);
  });

  it("rolls back scaffolded native locales when translation fails", async () => {
    const test = await setup();
    const original = await fs.readFile(test.catalogPath);
    test.translate.mockRejectedValue(new Error("provider unavailable"));
    expect(await runCli(["new-locale", "ja"], test.cwd)).toBe(1);
    expect(await fs.readFile(test.catalogPath)).toEqual(original);
    expect((await test.config.state.load()).entries).toEqual({});
    await expect(fs.access(path.join(test.cwd, "native/ja.json"))).rejects.toThrow(/ENOENT/u);
  });

  it("creates locales and passes check alongside empty and nontranslatable native catalogs", async () => {
    const test = await setup();
    const empty = JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {} });
    const brands = JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {
      Hoioi: { shouldTranslate: false }, retired: { extractionState: "stale" },
    } });
    await fs.writeFile(path.join(test.cwd, "Empty.xcstrings"), empty);
    await fs.writeFile(path.join(test.cwd, "Brands.xcstrings"), brands);
    const comment = "/* No localized metadata yet. */\n";
    await fs.writeFile(path.join(test.cwd, "legacy/en.lproj/Empty.strings"), comment);
    expect(await runCli(["new-locale", "ja"], test.cwd)).toBe(0);
    expect(await runCli(["check", "--locale", "ja"], test.cwd)).toBe(0);
    expect(await fs.readFile(path.join(test.cwd, "Empty.xcstrings"), "utf8")).toBe(empty);
    expect(await fs.readFile(path.join(test.cwd, "Brands.xcstrings"), "utf8")).toBe(brands);
    expect(await fs.readFile(path.join(test.cwd, "legacy/ja.lproj/Empty.strings"), "utf8")).toBe(comment);
    test.translate.mockClear();
    expect(await runCli(["sync", "--locale", "ja"], test.cwd)).toBe(0);
    expect(test.translate).not.toHaveBeenCalled();
  });

  it.each(["durable", "memory"])("preserves source and sibling locale edits made after staging with %s state", async (store) => {
    const test = await setup();
    if (store === "memory") {
      let snapshot = await test.config.state.load();
      test.config.state = {
        load: () => Promise.resolve(structuredClone(snapshot)),
        save: (next) => { snapshot = structuredClone(next); return Promise.resolve(); },
        withLock: (operation) => operation(),
      };
    }
    const edited = {
      ...test.catalog,
      strings: {
        ...test.catalog.strings,
        "Speak like a local": {
          ...test.catalog.strings["Speak like a local"],
          localizations: { en: unit("Speak to everyone"), fr: unit("Parlez à tout le monde") },
        },
      },
    };
    const editedBytes = JSON.stringify(edited);
    await expect(runStagedCatalogTransaction(test.config, async (staged) => {
      const result = await syncCatalogs(staged);
      expect(result.metrics.failedEntries).toBe(0);
      // A developer or Xcode saves the live catalog while an audit is running.
      await fs.writeFile(test.catalogPath, editedBytes);
      return result;
    })).rejects.toThrow("Localization file changed during translation");
    expect(await fs.readFile(test.catalogPath, "utf8")).toBe(editedBytes);
    expect((await test.config.state.load()).entries).toEqual({});
    await expect(fs.access(path.join(test.cwd, "native/de.json"))).rejects.toThrow(/ENOENT/u);
    await expect(fs.access(path.join(test.cwd, "legacy/de.lproj/InfoPlist.strings"))).rejects.toThrow(/ENOENT/u);
  });

  it("detects a newly created later target before committing any earlier staged file", async () => {
    const test = await setup();
    const original = await fs.readFile(test.catalogPath);
    const createdPath = path.join(test.cwd, "native/de.json");
    const created = '{"ios":{"NSPhotoLibraryUsageDescription":"Human translation"}}';
    await expect(runStagedCatalogTransaction(test.config, async (staged) => {
      const result = await syncCatalogs(staged);
      await fs.writeFile(createdPath, created);
      return result;
    })).rejects.toThrow("Localization file changed during translation");
    expect(await fs.readFile(test.catalogPath)).toEqual(original);
    expect(await fs.readFile(createdPath, "utf8")).toBe(created);
    expect((await test.config.state.load()).entries).toEqual({});
  });

  it("adopts native and JSON translations, including synthesized plural arms, without provider calls", async () => {
    const test = await setup();
    expect(await runCli(["sync"], test.cwd)).toBe(0);
    const original = await fs.readFile(test.catalogPath);
    await test.config.state.save({ version: 2, entries: {} });
    test.translate.mockClear();
    expect(await runCli(["adopt"], test.cwd)).toBe(0);
    const adopted = await test.config.state.load();
    expect(Object.values(adopted.entries).some(({ locale, jsonPointer }) => locale === "pl" && jsonPointer.includes("/few/"))).toBe(true);
    test.config.legacyOriginPolicy = "validate-existing";
    expect(await runCli(["sync"], test.cwd)).toBe(0);
    expect(await runCli(["check"], test.cwd)).toBe(0);
    expect(test.translate).not.toHaveBeenCalled();
    expect(await fs.readFile(test.catalogPath)).toEqual(original);
  });

  it("copies a translated native locale as a pending scaffold before retranslating from canonical source", async () => {
    const test = await setup();
    expect(await runCli(["sync"], test.cwd)).toBe(0);
    test.translate.mockClear();
    expect(await runCli(["new-locale", "es", "--from", "de", "--strategy", "copy-locale-and-retranslate"], test.cwd)).toBe(0);
    const result = await readCatalog(test.catalogPath);
    expect(result.strings["Speak like a local"]?.localizations?.es).toEqual(unit("es: Speak like a local"));
    expect(test.translate.mock.calls.flatMap(([args]) => args.requests).every(({ sourceText }) => !sourceText.startsWith("de:"))).toBe(true);
  });
});
