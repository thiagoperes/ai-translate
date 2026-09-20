import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDetectionContext,
  defineIntegration,
  dependencyNames,
  detectProject,
  detectSetups,
  findProjectFiles,
  firstExistingFile,
  isLocaleTag,
  localesFromJsonFileNames,
  localesFromNames,
  readStringArrayLiteral,
  readStringLiteral,
  renderConfig,
  requiredConfigPackages,
  resolveSourceLocale,
} from "../src/index";
import type { IntegrationPlan } from "../src/index";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function seed(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-integrations-"));
  workspaces.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }
  return root;
}

const plan: IntegrationPlan = {
  catalog: { kind: "document-json", rootDir: "messages" },
  messageFormat: "plain",
  sourceLocale: "en",
  targetLocales: ["fr"],
  warnings: [],
};

describe("project context", () => {
  it("reads and caches a manifest while handling absent files and directories", async () => {
    const root = await seed({
      "package.json": JSON.stringify({ dependencies: { one: "1" }, devDependencies: { two: "1" }, optionalDependencies: { three: "1" }, peerDependencies: { four: "1" } }),
      "sources/en.json": "{}",
    });
    const context = createDetectionContext(root);
    expect(context.root).toBe(root);
    expect(await dependencyNames(context)).toEqual(new Set(["one", "two", "three", "four"]));
    await fs.writeFile(path.join(root, "package.json"), "null");
    expect(await dependencyNames(context)).toContain("one");
    expect(await context.listFiles("sources")).toEqual(["en.json"]);
    expect(await context.listDirectories("")).toEqual(["sources"]);
    expect(await context.listFiles("missing")).toEqual([]);
    expect(await context.readFile("missing")).toBeNull();
    expect(await firstExistingFile(context, ["missing", "sources/en.json"])).toBe("sources/en.json");
    expect(await firstExistingFile(context, ["missing"])).toBeNull();
  });

  it.each([undefined, "{broken", "null", "[]"])("handles invalid or absent manifests: %s", async (contents) => {
    const context = createDetectionContext(await seed(contents === undefined ? {} : { "package.json": contents }));
    expect(await context.packageJson()).toBeNull();
    expect(await dependencyNames(context)).toEqual(new Set());
  });

  it("discovers nested authored files while excluding output trees and symlinks", async () => {
    const root = await seed({
      "App/Localizable.xcstrings": "{}",
      "Resources/Child/InfoPlist.strings": "text",
      "node_modules/App/Localizable.xcstrings": "{}",
      ".build/App/Localizable.xcstrings": "{}",
      "dist/Localizable.xcstrings": "{}",
      "src-tauri/gen/apple/Localizable.xcstrings": "{}",
      "README.md": "text",
    });
    await fs.symlink(path.join(root, "App"), path.join(root, "linked"));
    expect(await findProjectFiles(createDetectionContext(root), (file) => /\.(?:xcstrings|strings)$/u.test(file)))
      .toEqual(["App/Localizable.xcstrings", "Resources/Child/InfoPlist.strings"]);
  });
});

describe("locale readers", () => {
  it.each(["en", "de", "pt-BR", "zh-Hans", "fil"])("recognizes %s", (value) => {
    expect(isLocaleTag(value)).toBe(true);
  });
  it.each(["default", "templates", "assets", "locales", "en-", "en-@@"])("rejects %s", (value) => {
    expect(isLocaleTag(value)).toBe(false);
  });
  it("selects deterministic locales and preserves explicit source choices", () => {
    expect(localesFromNames(["fr", "default", "en"])).toEqual(["en", "fr"]);
    expect(localesFromJsonFileNames(["fr.json", "readme.md", "en.json"])).toEqual(["en", "fr"]);
    expect(resolveSourceLocale(["en", "fr"], "fr")).toBe("fr");
    expect(resolveSourceLocale(["fr", "en"], "de")).toBe("en");
    expect(resolveSourceLocale(["fr"], null)).toBe("fr");
    expect(resolveSourceLocale([], null)).toBeNull();
  });
  it("only reads literal settings", () => {
    expect(readStringArrayLiteral('locales = ["en", "fr"]', "locales")).toEqual(["en", "fr"]);
    expect(readStringArrayLiteral('locales = []', "locales")).toBeNull();
    expect(readStringArrayLiteral('locales = compute()', "locales")).toBeNull();
    expect(readStringLiteral('defaultLocale: "fr"', "defaultLocale")).toBe("fr");
    expect(readStringLiteral('defaultLocale: compute()', "defaultLocale")).toBeNull();
  });
});

describe("composable detection", () => {
  it("has no implicit platform detectors", async () => {
    expect(await detectProject(await seed({}))).toEqual([]);
  });
  it("isolates failing detectors and ranks successful matches", async () => {
    const detector = (id: string, confidence: number) => defineIntegration({
      id, displayName: id,
      detect: async () => ({ integrationId: id, displayName: id, confidence, evidence: [], plan }),
    });
    const result = await detectSetups(createDetectionContext(await seed({})), {
      integrations: [detector("low", 0.5), { id: "broken", displayName: "Broken", detect: async () => { throw new Error("failure"); } }, detector("high", 1)],
    });
    expect(result.map((setup) => setup.integrationId)).toEqual(["high", "low"]);
  });
});

describe("config rendering", () => {
  it("preserves the legacy JSON config with explicit provider options", () => {
    const rendered = renderConfig(plan, { model: "chosen" });
    expect(rendered).toContain('import { createLocalizedJsonDocument, createShardedJsonStateStore } from "@ai-translate/fs-json";');
    expect(rendered).toContain('unitId: "messages",');
    expect(rendered).toContain('model: "chosen",');
    expect(rendered).toContain('const targetLocales = ["fr"];');
    expect(requiredConfigPackages(plan)).toEqual(["@ai-translate/cli", "@ai-translate/fs-json", "@ai-translate/provider-openai"]);
  });

  it("composes custom adapters and JSON catalogs with deduplicated imports", () => {
    const composed: IntegrationPlan = {
      ...plan,
      catalog: { kind: "adapter", factory: { from: "custom-adapter", name: "createCatalog" }, options: { rootDir: "native", include: ["A.xcstrings"], enabled: true, version: 1, missing: null, nested: { key: "value" } } },
      additionalCatalogs: [
        { kind: "adapter", factory: { from: "custom-adapter", name: "createCatalog" }, options: { rootDir: "other", sourceLocale: "en" } },
        { kind: "namespace-json", id: "web", rootDir: "web", plurals: "i18next-v4" },
      ],
      messageFormat: "i18next",
    };
    const rendered = renderConfig(composed);
    expect(rendered.match(/import \{ createCatalog \}/gu)).toHaveLength(1);
    expect(rendered).toContain('"include": ["A.xcstrings"],');
    expect(rendered).toContain('"sourceLocale": "en",');
    expect(rendered).toContain('id: "web",');
    expect(rendered).toContain('messageFormat: i18nextMessageFormat,');
    expect(rendered).toContain('plurals: i18nextPluralKeys,');
    expect(requiredConfigPackages(composed)).toContain("custom-adapter");
    expect(requiredConfigPackages(composed)).toContain("@ai-translate/message-formats");
  });

  it("supports a custom JSON message format without adding a platform branch", () => {
    const custom = { ...plan, messageFormat: { from: "printf-format", name: "printfFormat" } };
    expect(renderConfig(custom)).toContain('import { printfFormat } from "printf-format";');
    expect(requiredConfigPackages(custom)).toContain("printf-format");
    expect(renderConfig({ ...plan, messageFormat: "icu" })).toContain("messageFormat: icuMessageFormat,");
  });

  it.each([
    ["@acme/localization/apple", "@acme/localization"],
    ["localization/apple", "localization"],
    ["./adapter.ts", undefined],
    ["../adapter.ts", undefined],
    ["/project/adapter.ts", undefined],
    ["C:\\project\\adapter.ts", undefined],
    ["\\\\server\\project\\adapter.ts", undefined],
    ["#local-adapter", undefined],
    ["node:fs/promises", undefined],
    ["fs/promises", undefined],
    ["file:///project/adapter.ts", undefined],
    ["https://example.com/adapter.ts", undefined],
    ["", undefined],
    ["@scope", undefined],
    ["@scope/", undefined],
  ])("reports installable packages for custom imports: %s", (from, expectedPackage) => {
    const custom: IntegrationPlan = {
      ...plan,
      additionalCatalogs: [{ kind: "adapter", factory: { from, name: "createCatalog" }, options: {} }],
      messageFormat: { from, name: "messageFormat" },
    };
    expect(requiredConfigPackages(custom)).toEqual([
      "@ai-translate/cli",
      "@ai-translate/fs-json",
      ...(expectedPackage === undefined ? [] : [expectedPackage]),
      "@ai-translate/provider-openai",
    ]);
    expect(renderConfig(custom)).toContain(`from ${JSON.stringify(from)};`);
  });

  it("deduplicates different subpaths of the same package", () => {
    expect(requiredConfigPackages({
      ...plan,
      additionalCatalogs: [{ kind: "adapter", factory: { from: "@acme/localization/apple", name: "createAppleCatalog" }, options: {} }],
      messageFormat: { from: "@acme/localization/formats", name: "messageFormat" },
    })).toEqual([
      "@ai-translate/cli", "@ai-translate/fs-json", "@acme/localization", "@ai-translate/provider-openai",
    ]);
  });

  it("renders AI SDK providers and reports their dependencies", () => {
    const options = { provider: "ai-sdk", providerPackage: "@ai-sdk/anthropic", model: "custom" } as const;
    expect(renderConfig(plan, options)).toContain('model: anthropic("custom"),');
    expect(requiredConfigPackages(plan, options)).toEqual(["@ai-translate/cli", "@ai-translate/fs-json", "@ai-translate/provider-ai-sdk", "ai", "@ai-sdk/anthropic"]);
    expect(renderConfig(plan, { provider: "ai-sdk" })).toContain('model: openai("gpt-5.6-luna"),');
    expect(requiredConfigPackages(plan, { provider: "ai-sdk" })).toContain("@ai-sdk/openai");
    expect(renderConfig(plan, { provider: "ai-sdk", providerPackage: "unknown" })).toContain("model: model(");
  });

  it("escapes literal values and each warning line", () => {
    const rendered = renderConfig({
      ...plan,
      catalog: { kind: "document-json", rootDir: 'a"; execute(); //', unitId: "special" },
      warnings: ["one\nexecute();\r\nthree\rfour\u2028five\u2029six"],
      targetLocales: Array.from({ length: 20 }, (_, index) => `locale-${String(index)}`),
    });
    expect(rendered).toContain('rootDir: "a\\\"; execute(); //",');
    expect(rendered).toContain("// TODO: one\n// TODO: execute();\n// TODO: three\n// TODO: four\n// TODO: five\n// TODO: six");
    expect(rendered).toContain("const targetLocales = [\n");
    expect(rendered).toContain('unitId: "special",');
  });

  it.each(["run();", "default", "sourceLocale", "eval", "interface"])("rejects invalid import names: %s", (name) => {
    expect(() => renderConfig({ ...plan, catalog: { kind: "adapter", factory: { from: "adapter", name }, options: {} } })).toThrow(/Invalid config import name/u);
  });
  it("rejects ambiguous import names", () => {
    expect(() => renderConfig({ ...plan, catalog: { kind: "adapter", factory: { from: "adapter", name: "defineConfig" }, options: {} } })).toThrow(/declared by both/u);
  });
});
