import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { Integration } from "@ai-translate/next";
import { afterEach, describe, expect, it } from "vitest";

import { runInit as initialize } from "../src/init";
import type { InitOptions } from "../src/init";

function runInit(cwd: string, options: InitOptions = {}) {
  return initialize(cwd, { install: false, ...options });
}

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function seedProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-init-"));
  workspaces.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }
  return root;
}

const MESSAGES = JSON.stringify({ greeting: "Hello" });

function i18nextProject(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({ dependencies: { i18next: "23.0.0" } }),
    "public/locales/de/common.json": MESSAGES,
    "public/locales/en/common.json": MESSAGES,
    ...extra,
  };
}

function nextIntlProject(): Record<string, string> {
  return {
    "i18n/routing.ts": 'defineRouting({ locales: ["en", "fr"], defaultLocale: "en" })',
    "messages/en.json": MESSAGES,
    "messages/fr.json": MESSAGES,
    "package.json": JSON.stringify({ dependencies: { "next-intl": "3.0.0" } }),
  };
}

async function configExists(root: string): Promise<boolean> {
  return fs
    .access(path.join(root, "ai-translate.config.ts"))
    .then(() => true)
    .catch(() => false);
}

describe("runInit", () => {
  it("writes a config and reports what it found", async () => {
    const root = await seedProject(i18nextProject());

    const result = await runInit(root);
    const written = await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8");

    expect(result.setup.integrationId).toBe("i18next");
    expect(written).toContain("createNamespaceJsonCatalog({");
    expect(written).toContain('rootDir: "public/locales",');
    expect(result.lines.join("\n")).toContain("Detected i18next");
  });

  it("sets up tooling while preserving authored resources and existing dependencies", async () => {
    const files = i18nextProject();
    const root = await seedProject(files);
    await runInit(root);
    for (const [name, contents] of Object.entries(files).filter(([fileName]) => fileName !== "package.json")) {
      expect(await fs.readFile(path.join(root, name), "utf8")).toBe(contents);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.dependencies).toEqual({ i18next: "23.0.0" });
    expect(manifest.scripts).toEqual({ translate: "ai-translate sync", "translate:check": "ai-translate check", "translate:validate": "ai-translate validate" });
    expect(await fs.readdir(root)).toEqual([".env.example", ".gitignore", "ai-translate.config.ts", "package.json", "public"]);
  });

  it("refuses to clobber an existing config", async () => {
    const root = await seedProject({
      ...i18nextProject(),
      "ai-translate.config.ts": "// hand written\n",
    });

    await expect(runInit(root)).rejects.toThrow(/already exists.*--force/u);
    expect(await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8")).toBe(
      "// hand written\n",
    );
  });

  it("overwrites when forced", async () => {
    const root = await seedProject({
      ...i18nextProject(),
      "ai-translate.config.ts": "// hand written\n",
    });

    await runInit(root, { force: true });

    expect(await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8")).toContain(
      "defineConfig",
    );
  });

  it("previews without touching the filesystem", async () => {
    const root = await seedProject(i18nextProject());

    const result = await runInit(root, { preview: true });

    expect(result.configPath).toBe(null);
    expect(result.lines.join("\n")).toContain("Would write ai-translate.config.ts");
    expect(await configExists(root)).toBe(false);
  });

  it("explains itself when nothing is recognised", async () => {
    const root = await seedProject({ "package.json": JSON.stringify({ dependencies: {} }) });

    await expect(runInit(root)).rejects.toThrow(/next-intl and i18next/u);
    expect(await configExists(root)).toBe(false);
  });

  it("combines disjoint localization setups with their own message formats", async () => {
    const root = await seedProject({
      ...nextIntlProject(),
      "i18n/request.ts": "export default getRequestConfig(async () => ({}));",
      "package.json": JSON.stringify({
        dependencies: { i18next: "23.0.0", "next-intl": "3.0.0" },
      }),
      "public/locales/en/common.json": MESSAGES,
      "public/locales/pt/common.json": MESSAGES,
    });

    const result = await runInit(root, { preview: true });

    expect(result.setup.integrationId).toBe("next-intl+i18next");
    expect(result.lines.join("\n")).toContain("messageFormat: icuMessageFormat");
    expect(result.lines.join("\n")).toContain("messageFormat: i18nextMessageFormat");
  });

  it("refuses to guess between two equally confident setups", async () => {
    const root = await seedProject(i18nextProject());
    const stub = (id: string): Integration => ({
      detect: () =>
        Promise.resolve({
          confidence: 0.5,
          displayName: id,
          evidence: [{ detail: "stub", source: "package.json" }],
          integrationId: id,
          plan: {
            catalog: { kind: "namespace-json", rootDir: "locales" },
            messageFormat: "plain",
            sourceLocale: "en",
            targetLocales: ["de"],
            warnings: [],
          },
        }),
      displayName: id,
      id,
    });

    await expect(
      runInit(root, { integrations: [stub("alpha"), stub("beta")] }),
    ).rejects.toThrow(/--integration/u);
    expect(await configExists(root)).toBe(false);
  });

  it("honours an explicit integration choice", async () => {
    const root = await seedProject({
      ...nextIntlProject(),
      "package.json": JSON.stringify({
        dependencies: { i18next: "23.0.0", "next-intl": "3.0.0" },
      }),
      "public/locales/en/common.json": MESSAGES,
      "public/locales/pt/common.json": MESSAGES,
    });

    const result = await runInit(root, { integration: "i18next", preview: true });

    expect(result.setup.integrationId).toBe("i18next");
    expect(result.lines.join("\n")).toContain("Also detected, not used: next-intl");
  });

  it("rejects an integration that was not detected", async () => {
    const root = await seedProject(i18nextProject());

    await expect(runInit(root, { integration: "next-intl" })).rejects.toThrow(
      /No next-intl setup was detected/u,
    );
  });

  it("lists the packages the generated config needs", async () => {
    const root = await seedProject(i18nextProject());

    expect((await runInit(root)).lines.join("\n")).toContain(
      "Install dependencies: npm install --save-dev --ignore-scripts @ai-translate/cli @ai-translate/fs-json @ai-translate/message-formats " +
        "@ai-translate/provider-openai",
    );
  });

  it("lists the AI SDK packages when the config is generated for that provider", async () => {
    const root = await seedProject(i18nextProject());

    const { lines } = await runInit(root, {
      provider: "ai-sdk",
      providerPackage: "@ai-sdk/anthropic",
    });

    expect(lines.join("\n")).toContain(
      "Install dependencies: npm install --save-dev --ignore-scripts @ai-translate/cli @ai-translate/fs-json @ai-translate/message-formats " +
        "@ai-translate/provider-ai-sdk ai @ai-sdk/anthropic",
    );
    expect(lines.join("\n")).toContain("Set ANTHROPIC_API_KEY");
  });

  it("installs declared dependencies for fresh clones without adding them again", async () => {
    const root = await seedProject(
      i18nextProject({
        "package.json": JSON.stringify({
          dependencies: {
            "@ai-translate/cli": "1.0.0",
            "@ai-translate/fs-json": "1.0.0",
            "@ai-translate/message-formats": "1.0.0",
            "@ai-translate/provider-openai": "1.0.0",
            i18next: "23.0.0",
          },
        }),
      }),
    );

    expect((await runInit(root)).lines.join("\n")).toContain("Install dependencies: npm install --ignore-scripts\n");
  });

  it("surfaces detection warnings next to the config it wrote", async () => {
    const root = await seedProject({
      "messages/en.json": MESSAGES,
      "messages/nl.json": MESSAGES,
      "package.json": JSON.stringify({ dependencies: { "next-intl": "3.0.0" } }),
    });

    expect((await runInit(root)).lines.join("\n")).toContain("! No i18n/routing.ts found");
  });
});

describe("native project initialization", () => {
  it("prefers a usable web layout over native project markers with invalid resources", async () => {
    const root = await seedProject({
      ...nextIntlProject(),
      "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);",
      "Localizable.xcstrings": '{"sourceLanguage":"en","version":"2.0","strings":{}}',
    });
    const result = await runInit(root, { preview: true });
    expect(result.setup.integrationId).toBe("next-intl");
    expect(result.lines.join("\n")).toContain("Also detected, not used: Apple localization");
    const native = await runInit(root, { integration: "apple", preview: true });
    expect(native.lines.join("\n")).toContain('"include": []');
    expect(native.lines.join("\n")).toContain("Localizable.xcstrings");
    expect(await configExists(root)).toBe(false);
  });

  it("previews a Swift project before resources exist without inventing languages", async () => {
    const root = await seedProject({
      "Newsblocker.xcodeproj/project.pbxproj": 'developmentRegion = en; knownRegions = (en, Base);',
      "Shared/Views/Settings.swift": 'Text("Settings")',
    });
    const result = await runInit(root, { preview: true });
    expect(result.setup.integrationId).toBe("apple");
    expect(result.setup.plan.targetLocales).toEqual([]);
    expect(result.lines.join("\n")).toContain("Create and populate an Xcode String Catalog");
    expect(result.lines.join("\n")).toContain("const targetLocales = [];");
    expect(await configExists(root)).toBe(false);
  });

  it("writes one composable config for native catalog and strings roots", async () => {
    const root = await seedProject({
      "App/Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en", strings: { Hello: { localizations: { fr: { stringUnit: { state: "translated", value: "Bonjour" } } } } }, version: "1.0" }),
      "Package/Resources/Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en", strings: {}, version: "1.0" }),
      "App/en.lproj/InfoPlist.strings": '"name" = "App";',
      "App/fr.lproj/InfoPlist.strings": '"name" = "App";',
    });
    const result = await runInit(root, { integration: "apple" });
    const written = await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8");
    expect(written).toContain("createAppleStringCatalog({");
    expect(written).toContain("createAppleStringsCatalog({");
    expect(written).toContain('"include": ["App/Localizable.xcstrings","Package/Resources/Localizable.xcstrings"],');
    expect(result.lines.join("\n")).toContain("Install dependencies: npm install --save-dev --ignore-scripts @ai-translate/cli @ai-translate/fs-json @ai-translate/apple @ai-translate/provider-openai");
  });

  it("explains the required externalization for Expo and Tauri without resources", async () => {
    const root = await seedProject({ "package.json": '{"dependencies":{"expo":"55"}}', "src/App.tsx": '<Text>Hello</Text>', "src-tauri/tauri.conf.json": '{}' });
    await expect(runInit(root)).rejects.toThrow(/first externalize strings into localization resources/u);
    expect(await configExists(root)).toBe(false);
  });
});

describe("automatic setup safeguards", () => {
  it("resumes identical setup without duplicating scripts or templates", async () => {
    const root = await seedProject(i18nextProject());
    await runInit(root);
    const names = ["ai-translate.config.ts", "package.json", ".gitignore", ".env.example"];
    const before = await Promise.all(names.map((name) => fs.readFile(path.join(root, name), "utf8")));
    await runInit(root);
    expect(await Promise.all(names.map((name) => fs.readFile(path.join(root, name), "utf8")))).toEqual(before);
  });

  it.each(["mts", "js", "mjs"])("protects an existing .%s config and previews without shadowing it", async (extension) => {
    const name = `ai-translate.config.${extension}`;
    const root = await seedProject(i18nextProject({ [name]: "// custom config\n" }));
    await expect(runInit(root)).rejects.toThrow(/already exists/u);
    const result = await runInit(root, { preview: true });
    expect(result.lines.join("\n")).toContain(`Would write ${name}`);
    expect(await configExists(root)).toBe(false);
    expect(await fs.readFile(path.join(root, name), "utf8")).toBe("// custom config\n");
    await runInit(root, { force: true });
    expect(await fs.readFile(path.join(root, name), "utf8")).toContain("defineConfig");
    expect(await configExists(root)).toBe(false);
  });

  it("refuses multiple configs even when force is requested", async () => {
    const root = await seedProject(i18nextProject({ "ai-translate.config.ts": "a", "ai-translate.config.mjs": "b" }));
    await expect(runInit(root, { force: true })).rejects.toThrow(/Multiple ai-translate configs/u);
    expect(await fs.readFile(path.join(root, "ai-translate.config.ts"), "utf8")).toBe("a");
  });

  it.each(["ai-translate.config.ts", ".gitignore", ".env.example", "package.json"])("rejects a symlinked %s before writing any setup files", async (name) => {
    const root = await seedProject(i18nextProject());
    const outside = await seedProject({ target: name === "package.json" ? JSON.stringify({ dependencies: { i18next: "23" } }) : "original" });
    await fs.rm(path.join(root, name), { force: true });
    await fs.symlink(path.join(outside, "target"), path.join(root, name));
    const before = await fs.readdir(root);
    await expect(runInit(root, { force: true })).rejects.toThrow(/regular file/u);
    expect(await fs.readdir(root)).toEqual(before);
    expect(await fs.readFile(path.join(outside, "target"), "utf8")).toBe(name === "package.json" ? JSON.stringify({ dependencies: { i18next: "23" } }) : "original");
  });

  it("validates the manifest before creating a native config", async () => {
    const root = await seedProject({ "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,fr);", "package.json": "{broken" });
    await expect(runInit(root)).rejects.toThrow(/Invalid JSON/u);
    expect(await fs.readdir(root)).toEqual(["App.xcodeproj", "package.json"]);
  });

  it("previews all tooling changes without writes", async () => {
    const root = await seedProject(i18nextProject());
    const before = await fs.readdir(root);
    const result = await runInit(root, { preview: true, install: true, packageManager: "bun" });
    expect(result.lines.join("\n")).toContain("Would write package.json");
    expect(result.lines.join("\n")).toContain("bun add --dev --ignore-scripts");
    expect(await fs.readdir(root)).toEqual(before);
  });

  it("preserves existing scripts, ignore entries, credentials templates and local secrets", async () => {
    const root = await seedProject(i18nextProject({
      "package.json": JSON.stringify({ scripts: { translate: "custom-command" }, dependencies: { i18next: "23.0.0" } }),
      ".gitignore": "build/\r\n",
      ".env.example": "OPENAI_API_KEY=example\nEXTRA=keep\n",
      ".env.local": "OPENAI_API_KEY=local-secret\n",
    }));
    const result = await runInit(root);
    expect(await fs.readFile(path.join(root, ".env.example"), "utf8")).toBe("OPENAI_API_KEY=example\nEXTRA=keep\n");
    expect(await fs.readFile(path.join(root, ".env.local"), "utf8")).toBe("OPENAI_API_KEY=local-secret\n");
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toContain("build/\r\nnode_modules/\r\n");
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toContain('"translate": "custom-command"');
    expect(result.lines.join("\n")).not.toContain("local-secret");
  });

  it("accepts explicit target locales for a native starter", async () => {
    const root = await seedProject({ "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en,Base);" });
    const result = await runInit(root, { locales: ["fr", "pl", "fr"] });
    expect(result.setup.plan.targetLocales).toEqual(["fr", "pl"]);
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toContain('"private": true');
  });

  it.each([["EN"], ["../de"], ["fr", "FR"]])("rejects invalid or ambiguous explicit locale lists %j without writes", async (...locales) => {
    const root = await seedProject(i18nextProject());
    await expect(runInit(root, { locales })).rejects.toThrow(/locale|Locale/u);
    expect(await configExists(root)).toBe(false);
  });
});
