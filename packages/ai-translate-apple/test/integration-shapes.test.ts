import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { CatalogAdapter, Entry } from "@ai-translate/core/types";
import { createDetectionContext } from "@ai-translate/integrations";
import type { DetectedSetup } from "@ai-translate/integrations";
import { afterEach, describe, expect, it } from "vitest";

import { appleIntegration } from "../src/integration";
import { createAppleStringsCatalog } from "../src/strings";
import { createAppleStringCatalog } from "../src/xcstrings";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function catalog(sourceLanguage = "en", locales = ["fr"]): string {
  return JSON.stringify({
    sourceLanguage,
    strings: { Hello: { localizations: Object.fromEntries(locales.map((locale) => [locale, {
      stringUnit: { state: "translated", value: `Hello in ${locale}` },
    }])) } },
    version: "1.0",
  });
}

async function detect(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-project-shapes-"));
  workspaces.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }
  return { result: await appleIntegration.detect(createDetectionContext(root)), root };
}

/** Exercise the generated options against real adapters, so a plausible plan
 * cannot hide dropped tables, accidental glob expansion, or unreadable files. */
async function loadSources(root: string, result: DetectedSetup | null) {
  if (result === null) { throw new Error("Expected Apple project detection."); }
  const sources: { file: string; values: Entry["value"][] }[] = [];
  for (const plan of [result.plan.catalog, ...(result.plan.additionalCatalogs ?? [])]) {
    if (plan.kind !== "adapter" || typeof plan.options.rootDir !== "string") {
      throw new Error("Expected a native adapter with a root directory.");
    }
    const options = { ...plan.options, rootDir: path.resolve(root, plan.options.rootDir), sourceLocale: result.plan.sourceLocale };
    let adapter: CatalogAdapter;
    if (plan.factory.name === "createAppleStringCatalog") {
      adapter = createAppleStringCatalog(options);
    } else if (plan.factory.name === "createAppleStringsCatalog") {
      adapter = createAppleStringsCatalog(options);
    } else {
      throw new Error(`Unexpected adapter ${plan.factory.name}.`);
    }
    for (const ref of await adapter.listDocumentRefs(result.plan.sourceLocale)) {
      const document = await adapter.loadDocument(ref);
      if (document === null) { throw new Error(`Discovered source is missing: ${ref.path}.`); }
      sources.push({ file: path.relative(root, ref.path), values: document.entries.map((entry) => entry.value) });
    }
  }
  return sources.toSorted((left, right) => left.file.localeCompare(right.file));
}

describe("generated Apple configuration across project shapes", () => {
  it("loads a valid BOM-prefixed catalog using its declared non-English source", async () => {
    const { root, result } = await detect({ "Localizable.xcstrings": `\uFEFF${catalog("de")}` });
    expect(result?.plan.sourceLocale).toBe("de");
    expect(result?.plan.targetLocales).toEqual(["fr"]);
    expect(result?.plan.warnings).toEqual([]);
    expect(await loadSources(root, result)).toEqual([{ file: "Localizable.xcstrings", values: ["Hello"] }]);
  });

  it.each([
    ["unsupported version", JSON.stringify({ sourceLanguage: "en", strings: {}, version: "2.0" })],
    ["missing version", JSON.stringify({ sourceLanguage: "en", strings: {} })],
    ["invalid string entry", JSON.stringify({ sourceLanguage: "en", strings: { Broken: null }, version: "1.0" })],
    ["invalid string unit", JSON.stringify({ sourceLanguage: "en", strings: { Broken: { localizations: { en: { stringUnit: { state: "translated", value: 7 } } } } }, version: "1.0" })],
  ])("excludes a catalog with %s and reports it before generating an unusable config", async (_case, invalid) => {
    const { root, result } = await detect({ "Invalid.xcstrings": invalid, "Valid.xcstrings": catalog() });
    expect(await loadSources(root, result)).toEqual([{ file: "Valid.xcstrings", values: ["Hello"] }]);
    expect(result?.plan.warnings.join(" ")).toContain("Invalid.xcstrings");
  });

  it("does not re-admit an invalid catalog through the empty-project fallback", async () => {
    const { root, result } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en", strings: {}, version: "2.0" }),
    });
    expect(await loadSources(root, result)).toEqual([]);
    expect(result?.plan.warnings.join(" ")).toContain("Localizable.xcstrings");
  });

  it("uses SwiftPM defaultLocalization without requiring an explicit platform minimum", async () => {
    const { root, result } = await detect({
      "Package.swift": 'let package = Package(name: "Feature", defaultLocalization: "fr", targets: [.target(name: "Feature", resources: [.process("Resources")])])',
      "Sources/Feature/Resources/en.lproj/Localizable.strings": '"hello" = "Hello";',
      "Sources/Feature/Resources/fr.lproj/Localizable.strings": '"hello" = "Bonjour";',
    });
    expect(result?.plan.sourceLocale).toBe("fr");
    expect(result?.plan.targetLocales).toEqual(["en"]);
    expect(await loadSources(root, result)).toEqual([{ file: "Sources/Feature/Resources/fr.lproj/Localizable.strings", values: ["Bonjour"] }]);
  });

  it("reads commented Xcode metadata without mistaking comment text for declarations", async () => {
    const { root, result } = await detect({
      "App.xcodeproj/project.pbxproj": '/* developmentRegion = en; knownRegions = (en,it); */ developmentRegion /* source */ = de; knownRegions = (de /* German */, "fr" /* French */, Base);',
      "App/Base.lproj/Localizable.strings": '"hello" = "Hallo";',
    });
    expect(result?.plan.sourceLocale).toBe("de");
    expect(result?.plan.targetLocales).toEqual(["fr"]);
    expect(await loadSources(root, result)).toEqual([{ file: "App/Base.lproj/Localizable.strings", values: ["Hallo"] }]);
  });

  it("ignores a commented-out SwiftPM source language declaration", async () => {
    const { root, result } = await detect({
      "Package.swift": '// defaultLocalization: "en"\nlet package = Package(name: "Feature", defaultLocalization: "fr", platforms: [.iOS(.v17)])',
      "Sources/Feature/Resources/Base.lproj/Localizable.strings": '"hello" = "Bonjour";',
      "Sources/Feature/Resources/de.lproj/Localizable.strings": '"hello" = "Hallo";',
    });
    expect(result?.plan.sourceLocale).toBe("fr");
    expect(result?.plan.targetLocales).toEqual(["de"]);
    expect(await loadSources(root, result)).toEqual([{ file: "Sources/Feature/Resources/Base.lproj/Localizable.strings", values: ["Bonjour"] }]);
  });

  it("ignores declarations inside nested Swift block comments", async () => {
    const { root, result } = await detect({
      "Package.swift": '/* Migration examples:\n /* old package */\n defaultLocalization: "en"\n*/\nlet package = Package(name: "Feature", defaultLocalization: "fr", platforms: [.iOS(.v17)])',
      "Sources/Feature/Resources/Base.lproj/Localizable.strings": '"hello" = "Bonjour";',
      "Sources/Feature/Resources/de.lproj/Localizable.strings": '"hello" = "Hallo";',
    });
    expect(result?.plan.sourceLocale).toBe("fr");
    expect(result?.plan.targetLocales).toEqual(["de"]);
    expect(await loadSources(root, result)).toEqual([{ file: "Sources/Feature/Resources/Base.lproj/Localizable.strings", values: ["Bonjour"] }]);
  });

  it("includes Base tables absent from the source locale and prefers localized tables when both exist", async () => {
    const { root, result } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en, Base, fr);",
      "App/Base.lproj/Localizable.strings": '"hello" = "Hello";',
      "App/Base.lproj/InfoPlist.strings": '"name" = "Older name";',
      "App/en.lproj/InfoPlist.strings": '"name" = "Current name";',
    });
    expect(await loadSources(root, result)).toEqual([
      { file: "App/Base.lproj/Localizable.strings", values: ["Hello"] },
      { file: "App/en.lproj/InfoPlist.strings", values: ["Current name"] },
    ]);
  });

  it("preserves literal special characters while splitting mixed Base and source-language tables", async () => {
    const { root, result } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en, Base, fr);",
      "App/Base.lproj/Nested/Info[Name].strings": '"name" = "App";',
      "App/Base.lproj/Shared(Feature).strings": '"hello" = "Older source";',
      "App/en.lproj/Shared(Feature).strings": '"hello" = "Hello";',
    });
    expect(await loadSources(root, result)).toEqual([
      { file: "App/Base.lproj/Nested/Info[Name].strings", values: ["App"] },
      { file: "App/en.lproj/Shared(Feature).strings", values: ["Hello"] },
    ]);
  });

  it("keeps ignored nested build output out of generated legacy adapter includes", async () => {
    const { root, result } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "App/en.lproj/Localizable.strings": '"hello" = "Hello";',
      "App/en.lproj/build/Archived.strings": '"generated" = "Old build";',
    });
    expect(await loadSources(root, result)).toEqual([{ file: "App/en.lproj/Localizable.strings", values: ["Hello"] }]);
  });

  it("keeps a differently authored neighboring app's Base resources and locales out of the selected source", async () => {
    const { root, result } = await detect({
      "apps/A/A.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "apps/A/Localizable.xcstrings": catalog(),
      "apps/B/B.xcodeproj/project.pbxproj": "developmentRegion = de; knownRegions = (de,it);",
      "apps/B/Base.lproj/InfoPlist.strings": '"name" = "Anwendung";',
      "apps/B/es.lproj/InfoPlist.strings": '"name" = "Aplicación";',
    });
    expect(result?.plan.sourceLocale).toBe("en");
    expect(result?.plan.targetLocales).toEqual(["fr"]);
    expect(await loadSources(root, result)).toEqual([{ file: "apps/A/Localizable.xcstrings", values: ["Hello"] }]);
    expect(result?.plan.warnings.join(" ")).toContain("apps/B");
  });

  it("prefers an explicit root project source over the first alphabetically sorted conflicting catalog", async () => {
    const { root, result } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,it);",
      "A-German.xcstrings": catalog("de", ["fr"]),
      "Z-English.xcstrings": catalog("en", ["es"]),
    });
    expect(result?.plan.sourceLocale).toBe("en");
    expect(result?.plan.targetLocales).toEqual(["es", "it"]);
    expect(await loadSources(root, result)).toEqual([{ file: "Z-English.xcstrings", values: ["Hello"] }]);
    expect(result?.plan.warnings.join(" ")).toContain("A-German.xcstrings");
  });

  it.each([
    ["App[AB]/Localizable.xcstrings", "AppA/Localizable.xcstrings"],
    ["App{One,Two}/Localizable.xcstrings", "AppOne/Localizable.xcstrings"],
    ["App(Preview)/Localizable.xcstrings", "AppPreview/Localizable.xcstrings"],
    ["!Localizable.xcstrings", "Localizable.xcstrings"],
  ])("treats detected path %s literally without admitting an excluded neighboring catalog", async (included, excluded) => {
    const { root, result } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en;",
      [included]: catalog(),
      [excluded]: catalog("de", ["es"]),
    });
    expect(await loadSources(root, result)).toEqual([{ file: included, values: ["Hello"] }]);
  });

  it("ignores prebuilt native output inside an Expo workspace package", async () => {
    const { result } = await detect({
      "package.json": '{"workspaces":["apps/*"]}',
      "apps/mobile/package.json": '{"dependencies":{"expo":"57"}}',
      "apps/mobile/.gitignore": "/ios/\n/android/\n",
      "apps/mobile/ios/Mobile.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,de);",
      "apps/mobile/ios/Mobile/Localizable.xcstrings": catalog(),
    });
    expect(result).toBeNull();
  });

  it("does not re-admit generated Expo catalogs through an unlocalized project's fallback", async () => {
    const { root, result } = await detect({
      "package.json": '{"dependencies":{"expo":"57"}}',
      ".gitignore": "/ios/\n",
      "NativeApp/NativeApp.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "ios/Mobile/Localizable.xcstrings": catalog(),
    });
    expect(await loadSources(root, result)).toEqual([]);
  });

  it("does not treat exported applications or prebuilt frameworks as authored localization resources", async () => {
    const { root, result } = await detect({
      "App/Localizable.xcstrings": catalog(),
      "Exports/App.xcarchive/Products/Applications/App.app/en.lproj/Localizable.strings": '"hello" = "Archived";',
      "Downloads/Helper.app/en.lproj/Localizable.strings": '"hello" = "Installed";',
      "Frameworks/Feature.framework/en.lproj/Localizable.strings": '"hello" = "Dependency";',
      "Frameworks/Feature.xcframework/ios-arm64/Resources/en.lproj/Localizable.strings": '"hello" = "Dependency";',
    });
    expect(await loadSources(root, result)).toEqual([{ file: "App/Localizable.xcstrings", values: ["Hello"] }]);
  });

  it.each(["/ios/**", "ios/*", "**/ios/"])("honors equivalent Expo native ignore pattern %s", async (ignore) => {
    const { result } = await detect({
      "package.json": '{"dependencies":{"expo":"57"}}',
      ".gitignore": `${ignore}\n`,
      "ios/Mobile.xcodeproj/project.pbxproj": "developmentRegion = en;",
      "ios/Mobile/Localizable.xcstrings": catalog(),
    });
    expect(result).toBeNull();
  });

  it("keeps authored Expo native resources after the ios ignore rule has been negated", async () => {
    const { root, result } = await detect({
      "package.json": '{"dependencies":{"expo":"57"}}',
      ".gitignore": "/ios/\n!/ios/\n",
      "ios/Mobile.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "ios/Mobile/Localizable.xcstrings": catalog(),
    });
    expect(await loadSources(root, result)).toEqual([{ file: "ios/Mobile/Localizable.xcstrings", values: ["Hello"] }]);
  });
});
