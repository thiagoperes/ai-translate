import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createDetectionContext } from "@ai-translate/integrations";
import { afterEach, describe, expect, it } from "vitest";

import { appleIntegration } from "../src/integration";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function seed(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-apple-detect-"));
  workspaces.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }
  return root;
}

function catalog(sourceLanguage = "en", locales: string[] = ["fr"]): string {
  return JSON.stringify({ sourceLanguage, strings: { Hello: { localizations: Object.fromEntries(locales.map((locale) => [locale, { stringUnit: { state: "translated", value: "Hello" } }])) } }, version: "1.0" });
}

async function detect(files: Record<string, string>) {
  return appleIntegration.detect(createDetectionContext(await seed(files)));
}

describe("Apple project detection", () => {
  it("keeps declared target languages when a catalog supplies the source language", async () => {
    const result = await detect({
      "App.xcodeproj/project.pbxproj": "knownRegions = (en, Base, fr);",
      "App/Localizable.xcstrings": catalog("en", []),
    });
    expect(result?.plan.sourceLocale).toBe("en");
    expect(result?.plan.targetLocales).toEqual(["fr"]);
  });

  it("reports unsupported legacy locale aliases without treating them as language codes", async () => {
    const result = await detect({
      "App/en.lproj/Localizable.strings": '"key" = "Hello";',
      "App/French.lproj/Localizable.strings": '"key" = "Bonjour";',
      "App/pt_BR.lproj/Localizable.strings": '"key" = "Olá";',
    });
    expect(result?.plan.targetLocales).toEqual([]);
    expect(result?.plan.warnings.join(" ")).toContain("App/French.lproj");
    expect(result?.plan.warnings.join(" ")).toContain("App/pt_BR.lproj");
  });

  it("does not invent native localization for an Expo/Tauri project with hardcoded text", async () => {
    expect(await detect({ "package.json": '{"dependencies":{"expo":"55"}}', "src/App.tsx": '<Text>Hello</Text>', "src-tauri/gen/apple/App.xcodeproj/project.pbxproj": 'developmentRegion = en;' })).toBeNull();
    expect(await detect({ "Package.swift": 'let package = Package(name: "Server")' })).toBeNull();
    expect(await detect({
      "package.json": '{"dependencies":{"expo":"57"}}',
      ".gitignore": "/ios/\n/android/\n",
      "ios/Beauty.xcodeproj/project.pbxproj": "developmentRegion = en;",
      "ios/Beauty/Localizable.xcstrings": catalog(),
    })).toBeNull();
  });

  it("recognizes the translator-rn Swift package layout without inventing target locales", async () => {
    const result = await detect({
      "native/HoioiKit/Package.swift": 'let package = Package(name: "HoioiKit", platforms: [.iOS(.v17)])',
      "native/HoioiApp/HoioiApp.xcodeproj/project.pbxproj": 'developmentRegion = en; knownRegions = (en, Base);',
    });
    expect(result?.integrationId).toBe("apple");
    expect(result?.plan.sourceLocale).toBe("en");
    expect(result?.plan.targetLocales).toEqual([]);
    expect(result?.plan.catalog).toMatchObject({ factory: { name: "createAppleStringCatalog" }, options: { rootDir: "." } });
    expect(result?.plan.warnings.join(" ")).toContain("Hardcoded strings are not extracted");
    expect(result?.plan.warnings.join(" ")).toContain("No target languages");
  });

  it("recognizes newsblocker's shared Xcode targets before resources are externalized", async () => {
    const result = await detect({ "Newsblocker.xcodeproj/project.pbxproj": 'developmentRegion = "en"; knownRegions = (en, Base);', "Shared/Views/SettingsView.swift": 'Text("Settings")' });
    expect(result?.plan.targetLocales).toEqual([]);
    expect(result?.evidence).toContainEqual({ detail: "Xcode project", source: "Newsblocker.xcodeproj/project.pbxproj" });
  });

  it("warns about provisional source language in an Apple Swift package", async () => {
    const result = await detect({ "Package.swift": 'let package = Package(platforms: [.macOS(.v14)])' });
    expect(result?.plan.sourceLocale).toBe("en");
    expect(result?.plan.warnings.join(" ")).toContain('provisionally "en"');
  });

  it("discovers every authored catalog across app and package roots", async () => {
    const result = await detect({
      "App/Localizable.xcstrings": catalog("en", ["fr"]),
      "Packages/Feature/Sources/Resources/Localizable.xcstrings": catalog("en", ["de", "en"]),
      "App.xcodeproj/project.pbxproj": 'developmentRegion = en; knownRegions = (en, Base, "pt-BR");',
      "node_modules/foreign/Localizable.xcstrings": catalog("zh", ["ja"]),
      "DerivedData/Localizable.xcstrings": catalog("zh", ["ja"]),
      "Pods/Localizable.xcstrings": catalog("zh", ["ja"]),
      ".build/Localizable.xcstrings": catalog("zh", ["ja"]),
    });
    expect(result?.plan.targetLocales).toEqual(["de", "fr", "pt-BR"]);
    expect(result?.plan.catalog).toMatchObject({ options: { include: ["App/Localizable.xcstrings", "Packages/Feature/Sources/Resources/Localizable.xcstrings"] } });
    expect(result?.evidence).toHaveLength(3);
  });

  it("composes legacy strings with String Catalogs", async () => {
    const result = await detect({
      "App/Localizable.xcstrings": catalog(),
      "App/en.lproj/InfoPlist.strings": '"name" = "App";',
      "App/de.lproj/InfoPlist.strings": '"name" = "App";',
    });
    expect(result?.plan.additionalCatalogs).toEqual([{ kind: "adapter", factory: { from: "@ai-translate/apple", name: "createAppleStringsCatalog" }, options: { id: "apple-strings:App", rootDir: "App", include: ["InfoPlist.strings"] } }]);
    expect(result?.plan.targetLocales).toEqual(["de", "fr"]);
  });

  it("infers a legacy source locale when no project metadata exists", async () => {
    const result = await detect({ "App/fr.lproj/Localizable.strings": '"key" = "Bonjour";', "App/de.lproj/Localizable.strings": '"key" = "Hallo";' });
    expect(result?.plan.sourceLocale).toBe("de");
    expect(result?.plan.targetLocales).toEqual(["fr"]);
    expect(result?.plan.catalog).toMatchObject({ factory: { name: "createAppleStringsCatalog" } });
  });

  it("does not treat Base as a language", async () => {
    const result = await detect({ "App/Base.lproj/Localizable.strings": '"key" = "Hello";', "App.xcodeproj/project.pbxproj": 'developmentRegion = en; knownRegions = (en, Base);' });
    expect(result?.plan.targetLocales).toEqual([]);
    expect(result?.plan.catalog).toMatchObject({ options: { rootDir: "App", sourceLocaleDirectory: "Base.lproj" } });
  });

  it("groups nested strings roots and reads a Swift package's default localization", async () => {
    const result = await detect({
      "Package.swift": 'let package = Package(defaultLocalization: "fr", platforms: [.iOS(.v17)])',
      "Sources/Feature/Resources/fr.lproj/Nested/Localizable.strings": '"key" = "Bonjour";',
      "App/Base.lproj/InfoPlist.strings": '"name" = "Application";',
      "App/de.lproj/InfoPlist.strings": '"name" = "Anwendung";',
    });
    expect(result?.plan.sourceLocale).toBe("fr");
    const plans = result ? [result.plan.catalog, ...(result.plan.additionalCatalogs ?? [])] : [];
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ options: { id: "apple-strings:App", rootDir: "App", sourceLocaleDirectory: "Base.lproj", include: ["InfoPlist.strings"] } }),
      expect.objectContaining({ options: { id: "apple-strings:Sources/Feature/Resources", rootDir: "Sources/Feature/Resources", include: ["Nested/Localizable.strings"] } }),
    ]));
    expect(result?.plan.targetLocales).toEqual(["de"]);
  });

  it("reports source-language conflicts instead of silently mixing catalogs", async () => {
    const result = await detect({ "A.xcstrings": catalog("en"), "B.xcstrings": catalog("de", ["es"]) });
    expect(result?.plan.catalog).toMatchObject({ options: { include: ["A.xcstrings"] } });
    expect(result?.plan.targetLocales).toEqual(["fr"]);
    expect(result?.plan.warnings.join(" ")).toContain("B.xcstrings uses source language de");
  });

  it.each(['{broken', '{}', '{"sourceLanguage":"en","strings":[]}', '{"sourceLanguage":"invalid","strings":{}}'])("reports unreadable catalog metadata: %s", async (contents) => {
    const result = await detect({ "App.xcodeproj/project.pbxproj": 'developmentRegion = en;', "Localizable.xcstrings": contents });
    expect(result?.plan.warnings.join(" ")).toContain("Could not read a supported String Catalog");
  });

  it("ignores non-locale metadata and supports empty catalogs", async () => {
    const result = await detect({
      "A.xcstrings": JSON.stringify({ sourceLanguage: "en", version: "1.0", custom: { enabled: true }, strings: {
        Empty: {}, Hello: { localizations: {
          default: { stringUnit: { state: "translated", value: "Fallback" } },
          de: { stringUnit: { state: "translated", value: "Hallo" } },
        } },
      } }),
      "B.xcstrings": '{"sourceLanguage":"en","strings":{},"version":"1.0"}',
    });
    expect(result?.plan.targetLocales).toEqual(["de"]);
    expect(result?.plan.warnings).toEqual([]);
  });
});
