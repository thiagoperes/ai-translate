import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { Integration } from "@ai-translate/next";
import { afterEach, describe, expect, it } from "vitest";

import { runInit } from "../src/init";

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

  it("writes nothing else", async () => {
    // init's whole contract is that it produces exactly one new file. Anything
    // more would make running it against an unfamiliar repository risky.
    const files = i18nextProject();
    const root = await seedProject(files);
    const before = JSON.stringify(
      await Promise.all(Object.keys(files).map((name) => fs.readFile(path.join(root, name), "utf8"))),
    );

    await runInit(root);

    const after = JSON.stringify(
      await Promise.all(Object.keys(files).map((name) => fs.readFile(path.join(root, name), "utf8"))),
    );
    expect(after).toBe(before);
    expect(await fs.readdir(root)).toEqual(["ai-translate.config.ts", "package.json", "public"]);
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

  it("prefers the more confident setup when a project runs two libraries", async () => {
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

    expect(result.setup.integrationId).toBe("next-intl");
    expect(result.lines.join("\n")).toContain("Also detected, not used: i18next");
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
      "Install: @ai-translate/cli @ai-translate/fs-json @ai-translate/message-formats " +
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
      "Install: @ai-translate/cli @ai-translate/fs-json @ai-translate/message-formats " +
        "@ai-translate/provider-ai-sdk ai @ai-sdk/anthropic",
    );
    expect(lines.join("\n")).toContain("the API key your @ai-sdk/anthropic provider reads");
  });

  it("omits the install step once the packages are declared", async () => {
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

    expect((await runInit(root)).lines.join("\n")).not.toContain("Install:");
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
