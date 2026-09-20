import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { Integration, IntegrationPlan } from "@ai-translate/integrations";
import { afterEach, describe, expect, it } from "vitest";

import { runInit } from "../src/init";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function seed(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-composition-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
  return root;
}

function detector(id: string, plan: Partial<IntegrationPlan> = {}, confidence = 0.9): Integration {
  return {
    id,
    displayName: id,
    detect: async () => ({
      confidence,
      displayName: id,
      evidence: [],
      integrationId: id,
      plan: {
        catalog: { kind: "document-json", rootDir: id },
        messageFormat: "plain",
        sourceLocale: "en",
        targetLocales: ["fr"],
        warnings: [],
        ...plan,
      },
    }),
  };
}

const sharedFiles = {
  "public/locales/en/common.json": JSON.stringify({ title: "Settings" }),
  "public/locales/fr/common.json": JSON.stringify({ title: "Paramètres" }),
};

describe("initialization across resource types", () => {
  it("composes Expo's explicit metadata files with shared i18next UI", async () => {
    const root = await seed({
      ...sharedFiles,
      "package.json": JSON.stringify({ dependencies: { expo: "55", i18next: "23" } }),
      "app.json": JSON.stringify({ expo: {
        ios: { infoPlist: { CFBundleDevelopmentRegion: "en" } },
        locales: { en: "native/en.json", fr: "native/fr.json" },
      } }),
      "native/en.json": JSON.stringify({ ios: { NSCameraUsageDescription: "Camera access" } }),
      "native/fr.json": JSON.stringify({ ios: { NSCameraUsageDescription: "Accès caméra" } }),
    });

    const result = await runInit(root, { install: false });
    const config = await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8");

    expect(result.setup.integrationId.split("+")).toEqual(["expo", "i18next"]);
    expect(config).toContain("createLocalizedJsonDocument({");
    expect(config).toContain("createNamespaceJsonCatalog({");
    expect(config).toContain("messageFormat: applePrintfMessageFormat,");
    expect(config).toContain("messageFormat: i18nextMessageFormat,");
    expect(config).toContain('localeFiles: {"en":"native/en.json","fr":"native/fr.json"},');
    expect(config).toContain('rootDir: "public/locales",');
  });

  it("composes native catalogs with shared UI and unions their target languages", async () => {
    const root = await seed({
      ...sharedFiles,
      "package.json": JSON.stringify({ dependencies: { i18next: "23" } }),
      "Native/Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {
        Hello: { localizations: { de: { stringUnit: { state: "translated", value: "Hallo" } } } },
      } }),
    });

    const result = await runInit(root, { install: false });
    const config = await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8");

    expect(result.setup.integrationId.split("+")).toEqual(["apple", "i18next"]);
    expect(new Set(result.setup.plan.targetLocales)).toEqual(new Set(["de", "fr"]));
    expect(config).toContain("createAppleStringCatalog({");
    expect(config).toContain("createNamespaceJsonCatalog({");
    expect(config).toContain("messageFormat: i18nextMessageFormat,");
  });

  it("preserves each JSON catalog's message format when composing detectors", async () => {
    const root = await seed({});
    const result = await runInit(root, {
      install: false,
      integrations: [detector("icu", { messageFormat: "icu" }), detector("i18next", { messageFormat: "i18next" })],
    });
    const config = await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8");

    expect(result.setup.integrationId).toBe("icu+i18next");
    expect(config).toMatch(/messageFormat: icuMessageFormat,[\s\S]*rootDir: "icu"/u);
    expect(config).toMatch(/messageFormat: i18nextMessageFormat,[\s\S]*rootDir: "i18next"/u);
    expect(config).toContain('id: "icu-1",');
    expect(config).toContain('id: "i18next-1",');
  });

  it("previews a composed setup without writing files or executing project code", async () => {
    const files = {
      ...sharedFiles,
      "package.json": JSON.stringify({ dependencies: { i18next: "23" }, scripts: { postinstall: "exit 99" } }),
      "Native/Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: { Hello: {} } }),
      "i18next.config.mjs": 'throw new Error("Project configuration must never run during detection");',
    };
    const root = await seed(files);
    const before = (await fs.readdir(root, { recursive: true })).toSorted();

    const result = await runInit(root, { preview: true });

    expect(result.configPath).toBeNull();
    expect(result.setup.integrationId).toBe("apple+i18next");
    expect(result.lines.join("\n")).toContain("Would write package.json");
    expect((await fs.readdir(root, { recursive: true })).toSorted()).toEqual(before);
    for (const [name, contents] of Object.entries(files)) {
      expect(await fs.readFile(path.join(root, name), "utf8")).toBe(contents);
    }
  });

  it("requires explicit selection when equally confident detectors cover the same files", async () => {
    const root = await seed({});
    const integrations = [detector("first", { catalog: { kind: "document-json", rootDir: "shared" } }), detector("second", { catalog: { kind: "document-json", rootDir: "shared" } })];

    await expect(runInit(root, { integrations, install: false })).rejects.toThrow(/overlapping localization setups/u);
    expect(await fs.readdir(root)).toEqual([]);
    expect((await runInit(root, { integrations, integration: "second", preview: true })).setup.integrationId).toBe("second");
  });

  it("rejects incompatible source languages before making setup changes", async () => {
    const root = await seed({});

    await expect(runInit(root, {
      install: false,
      integrations: [detector("english"), detector("german", { sourceLocale: "de", targetLocales: ["fr"] })],
    })).rejects.toThrow(/different source locales/u);

    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects conflicting target locale aliases instead of creating two target paths", async () => {
    const root = await seed({});

    await expect(runInit(root, {
      install: false,
      integrations: [detector("first", { targetLocales: ["pt-BR"] }), detector("second", { targetLocales: ["pt-br"] })],
    })).rejects.toThrow(/Locale aliases pt-BR and pt-br/u);

    expect(await fs.readdir(root)).toEqual([]);
  });

  it("requires mapped filenames for languages introduced by another catalog", async () => {
    const root = await seed({});
    const integrations = [
      detector("expo", { catalog: { kind: "document-json", rootDir: ".", localeFiles: { en: "native/en.json", fr: "native/fr.json" } } }),
      detector("web", { targetLocales: ["de"] }),
    ];

    await expect(runInit(root, { integrations, install: false })).rejects.toThrow(/Missing locale file mappings for de/u);

    expect(await fs.readdir(root)).toEqual([]);
    expect((await runInit(root, { integrations, locales: ["fr"], preview: true })).setup.plan.targetLocales).toEqual(["fr"]);
  });

  it("rejects an explicit language missing from the authored mapping", async () => {
    const root = await seed({});

    await expect(runInit(root, {
      install: false,
      integrations: [detector("expo", { catalog: { kind: "document-json", rootDir: ".", localeFiles: { en: "native/en.json", fr: "native/fr.json" } } })],
      locales: ["de"],
    })).rejects.toThrow(/Missing locale file mappings for de/u);

    expect(await fs.readdir(root)).toEqual([]);
  });

  it("resolves requested locale aliases to the project's existing mapped spelling", async () => {
    const root = await seed({});
    const result = await runInit(root, {
      integrations: [detector("expo", {
        catalog: { kind: "document-json", rootDir: ".", localeFiles: { en: "native/en.json", "pt-br": "native/Portuguese.json" } },
        targetLocales: ["pt-br"],
      })],
      locales: ["pt-BR"],
      preview: true,
    });

    expect(result.setup.plan.targetLocales).toEqual(["pt-br"]);
    expect(result.lines.join("\n")).toContain('const targetLocales = ["pt-br"];');
    expect(await fs.readdir(root)).toEqual([]);
  });
});
