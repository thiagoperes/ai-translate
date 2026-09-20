import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDetectionContext } from "@ai-translate/integrations";
import { afterEach, describe, expect, it } from "vitest";

import { appleIntegration } from "../src/integration";
import { createAppleStringsCatalog } from "../src/strings";
import { createAppleStringCatalog } from "../src/xcstrings";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function detect(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-fresh-detection-"));
  roots.push(root);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return { root, setup: await appleIntegration.detect(createDetectionContext(root)) };
}

const xcstrings = JSON.stringify({ sourceLanguage: "en", strings: { Hello: {} }, version: "1.0" });

describe("fresh automatic detection review", () => {
  it("keeps per-file Expo ignore rules from entering an explicit catalog include", async () => {
    const { setup } = await detect({
      "package.json": '{"dependencies":{"expo":"57"}}',
      ".gitignore": "/ios/**/*.xcstrings\n",
      "ios/App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "ios/App/Localizable.xcstrings": xcstrings,
      "resources/Localizable.xcstrings": xcstrings,
    });
    expect(setup?.plan.catalog).toMatchObject({ options: { include: ["resources/Localizable.xcstrings"] } });
  });

  it("applies ancestor ignore rules to nested Expo workspaces", async () => {
    const { setup } = await detect({
      ".gitignore": "apps/*/ios/\n",
      "apps/mobile/package.json": '{"dependencies":{"expo":"57"}}',
      "apps/mobile/ios/App.xcodeproj/project.pbxproj": "developmentRegion = en;",
      "apps/mobile/ios/App/Localizable.xcstrings": xcstrings,
      "native/Localizable.xcstrings": xcstrings,
    });
    expect(setup?.plan.catalog).toMatchObject({ options: { include: ["native/Localizable.xcstrings"] } });
  });

  it("allows a nested ignore file to re-include authored files under a traversable ios tree", async () => {
    const { setup } = await detect({
      "package.json": '{"dependencies":{"expo":"57"}}',
      ".gitignore": "/ios/**/*.xcstrings\n",
      "ios/.gitignore": "!Authored/Localizable.xcstrings\n",
      "ios/Authored/Localizable.xcstrings": xcstrings,
      "ios/Generated/Localizable.xcstrings": xcstrings,
    });
    expect(setup?.plan.catalog).toMatchObject({ options: { include: ["ios/Authored/Localizable.xcstrings"] } });
  });

  it("recognizes resources packaged in an authored bundle", async () => {
    const { setup } = await detect({
      "Feature.bundle/en.lproj/Localizable.strings": '"title" = "Hello";',
      "Feature.bundle/fr.lproj/Localizable.strings": '"title" = "Bonjour";',
    });
    expect(setup?.plan.catalog).toMatchObject({ options: { rootDir: "Feature.bundle", include: ["Localizable.strings"] } });
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
  });

  it("does not infer Swift package metadata from a raw multiline string", async () => {
    const { setup } = await detect({
      "Package.swift": 'let example = #"""\nPackage(defaultLocalization: "de", platforms: [.iOS(.v17)])\n"""#\nlet package = Package(name: "Server")',
    });
    expect(setup).toBeNull();
  });

  it("does not translate the source into a case-equivalent Xcode region", async () => {
    const { setup } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,EN,fr,FR);",
      "en.lproj/Localizable.strings": '"hello" = "Hello";',
    });
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
  });

  it("retains physical locale spelling while merging equivalent source and target declarations", async () => {
    const { root, setup } = await detect({
      "App.xcodeproj/project.pbxproj": 'developmentRegion = "en-US"; knownRegions = ("en-US", "EN-us", FR, fr);',
      "en-us.lproj/Localizable.strings": '"hello" = "Hello";',
      "fr.lproj/Localizable.strings": '"hello" = "Bonjour";',
    });
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
    const plan = setup?.plan.catalog;
    if (plan?.kind !== "adapter" || setup === null) { throw new Error("Expected native configuration."); }
    expect(plan.options).toMatchObject({ rootDir: ".", sourceLocaleDirectory: "en-us.lproj" });
    const adapter = createAppleStringsCatalog({ ...plan.options, rootDir: root, sourceLocale: setup.plan.sourceLocale });
    const [sourceRef] = await adapter.listDocumentRefs(setup.plan.sourceLocale);
    if (sourceRef === undefined) { throw new Error("Expected source strings table."); }
    expect((await adapter.loadDocument(sourceRef))?.entries.map((entry) => entry.value)).toEqual(["Hello"]);
    expect((await adapter.loadDocument(adapter.createDocumentRef(sourceRef, "fr")))?.entries.map((entry) => entry.value)).toEqual(["Bonjour"]);
  });

  it("uses the exact String Catalog source spelling when Xcode declares an equivalent locale", async () => {
    const { root, setup } = await detect({
      "App.xcodeproj/project.pbxproj": 'developmentRegion = "en-US"; knownRegions = ("en-US", fr);',
      "Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en-us", strings: { Hello: {} }, version: "1.0" }),
    });
    expect(setup?.plan.sourceLocale).toBe("en-us");
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
    expect(setup?.plan.catalog).toMatchObject({ options: { include: ["Localizable.xcstrings"] } });
    expect(setup?.plan.warnings).toEqual([]);
    if (setup === null) { throw new Error("Expected native configuration."); }
    const adapter = createAppleStringCatalog({ rootDir: root, sourceLocale: setup.plan.sourceLocale });
    const [ref] = await adapter.listDocumentRefs(setup.plan.sourceLocale);
    if (ref === undefined) { throw new Error("Expected source String Catalog."); }
    expect((await adapter.loadDocument(ref))?.entries.map((entry) => entry.value)).toEqual(["Hello"]);
  });

  it.each([["fr", "FR"], ["he", "iw"], ["pt-BR", "pt-br"]])("omits ambiguous target aliases %s / %s until physical resources are normalized", async (first, second) => {
    const catalogWith = (locale: string) => JSON.stringify({ sourceLanguage: "en", strings: {
      Hello: { localizations: { [locale]: { stringUnit: { state: "translated", value: "Bonjour" } } } },
    }, version: "1.0" });
    const { setup } = await detect({
      "App.xcodeproj/project.pbxproj": `developmentRegion = en; knownRegions = (en,"${first}",de);`,
      "First.xcstrings": catalogWith(first),
      "Second.xcstrings": catalogWith(second),
    });
    expect(setup?.plan.targetLocales).toEqual(["de"]);
    expect(setup?.plan.warnings.join(" ")).toContain(`Locale spellings ${[first, second].toSorted().join(", ")} identify the same language`);
  });

  it("prefers English source inference independent of directory case", async () => {
    const { setup } = await detect({
      "EN.lproj/Localizable.strings": '"hello" = "Hello";',
      "de.lproj/Localizable.strings": '"hello" = "Hallo";',
    });
    expect(setup?.plan.sourceLocale).toBe("EN");
    expect(setup?.plan.targetLocales).toEqual(["de"]);
  });

  it("refuses ambiguous physical source directories on a case-sensitive filesystem", async () => {
    const { root } = await detect({
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "en.lproj/Localizable.strings": '"hello" = "Hello";',
    });
    // Model both entries explicitly so this runs on macOS's default
    // case-insensitive filesystem as well as case-sensitive CI volumes.
    const context = createDetectionContext(root);
    const directories = context.listDirectories;
    const files = context.listFiles;
    context.listDirectories = async (directory) => directory === "" ? ["App.xcodeproj", "en.lproj", "EN.lproj"] : directories(directory);
    context.listFiles = async (directory) => directory === "EN.lproj" ? ["Localizable.strings"] : files(directory);
    const setup = await appleIntegration.detect(context);
    expect(setup?.plan.catalog).toMatchObject({ options: { include: [] } });
    expect(setup?.plan.warnings.join(" ")).toContain("ambiguous spellings of source language en");
  });
});
