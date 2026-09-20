import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectProject } from "../src/detect";

const workspaces: string[] = [];
const MESSAGE = '{"title":"Hello"}';
const INTL = '{"dependencies":{"next-intl":"4.0.0"}}';
const I18NEXT = '{"dependencies":{"i18next":"25.0.0"}}';

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function seed(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-project-shapes-"));
  workspaces.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
  return root;
}

describe("next-intl project shapes", () => {
  it.each(["messages", "src/messages", "locales", "src/locales"].flatMap((rootDir) =>
    ["document-json", "namespace-json"].map((kind) => ({ kind, rootDir })),
  ))("detects $kind at $rootDir", async ({ kind, rootDir }) => {
    const suffix = kind === "document-json" ? ".json" : "/common.json";
    const root = await seed({
      "package.json": INTL,
      [`${rootDir}/en${suffix}`]: MESSAGE,
      [`${rootDir}/zh-Hant${suffix}`]: MESSAGE,
      [`${rootDir}/default${suffix}`]: MESSAGE,
      [`${rootDir}/assets${suffix}`]: MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan).toMatchObject({
      catalog: { kind, rootDir }, sourceLocale: "en", targetLocales: ["zh-Hant"],
    });
  });

  it("ignores placeholder folders beside file-per-locale messages", async () => {
    const root = await seed({
      "package.json": INTL,
      "messages/en/.gitkeep": "",
      "messages/fr/readme.md": "",
      "messages/en.json": MESSAGE,
      "messages/de.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.catalog).toEqual({ kind: "document-json", rootDir: "messages" });
    expect(setup?.plan.targetLocales).toEqual(["de"]);
  });

  it("continues after an empty higher-priority root", async () => {
    const root = await seed({
      "package.json": INTL,
      "messages/en/.gitkeep": "",
      "src/messages/en/home.json": MESSAGE,
      "src/messages/fr/home.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.catalog).toEqual({ kind: "namespace-json", rootDir: "src/messages" });
  });

  it("requires a real source document and can find it in a later root", async () => {
    const root = await seed({
      "package.json": INTL,
      "i18n/routing.ts": 'defineRouting({ locales: ["en", "fr"], defaultLocale: "en" })',
      "messages/fr.json": MESSAGE,
      "src/messages/en.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.catalog).toEqual({ kind: "document-json", rootDir: "src/messages" });
    expect(setup?.plan.warnings.join(" ")).toContain("other message layouts");
  });

  it.each([
    'defineRouting({ locales: ["en", "fr"], defaultLocale: "en" })',
    'defineRouting({ locales: computeLocales(), defaultLocale: "en" })',
    'defineRouting({ defaultLocale: "en" })',
  ])("does not generate a plan whose declared source is missing: %s", async (routing) => {
    const root = await seed({
      "package.json": INTL,
      "i18n/routing.ts": routing,
      "messages/fr.json": MESSAGE,
    });
    expect(await detectProject(root)).toEqual([]);
  });

  it("uses uncommented literal declarations, filters pseudo-locales, and deduplicates targets", async () => {
    const root = await seed({
      "package.json": INTL,
      "i18n/routing.mts": '// locales: ["de"]; defaultLocale: "de"\n' +
        'defineRouting({ locales: ["en", "fr", "fr", "default", "../escape"], defaultLocale: "en" })',
      "messages/en.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.sourceLocale).toBe("en");
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
    expect(setup?.plan.warnings).toEqual([]);
  });

  it.each([
    'defineRouting({ locales: ["fr", ...more], defaultLocale: "fr" + region })',
    'defineRouting({ locales: availableLocales, defaultLocale: getDefault() })',
    'defineRouting({ locales: ["default"], defaultLocale: "default" })',
  ])("reports disk inference for unresolved declarations: %s", async (routing) => {
    const root = await seed({
      "package.json": INTL, "i18n/routing.ts": routing,
      "messages/en.json": MESSAGE, "messages/fr.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.sourceLocale).toBe("en");
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
    expect(setup?.plan.warnings.join(" ")).toContain("inferred");
    expect(setup?.plan.warnings.join(" ")).toContain('assuming "en"');
  });

  it("reports competing populated layouts instead of silently hiding them", async () => {
    const root = await seed({
      "package.json": INTL,
      "messages/en.json": MESSAGE,
      "messages/en/common.json": MESSAGE,
      "src/messages/en.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.catalog).toEqual({ kind: "namespace-json", rootDir: "messages" });
    expect(setup?.plan.warnings.join(" ")).toContain("messages (document-json), src/messages (document-json)");
  });
});

describe("i18next project shapes", () => {
  it.each(["public/locales", "src/public/locales", "locales", "src/locales", "app/locales"])(
    "recognizes namespaces at %s", async (rootDir) => {
      const root = await seed({
        "package.json": I18NEXT,
        [`${rootDir}/en/common.json`]: MESSAGE,
        [`${rootDir}/pl/common.json`]: MESSAGE,
      });
      const [setup] = await detectProject(root);
      expect(setup?.plan).toMatchObject({
        catalog: { kind: "namespace-json", plurals: "i18next-v4", rootDir },
        sourceLocale: "en", targetLocales: ["pl"],
      });
    },
  );

  it.each(["js", "mjs", "ts", "cjs", "mts", "cts"])("reads next-i18next.config.%s without executing it", async (extension) => {
    const root = await seed({
      "package.json": I18NEXT,
      [`next-i18next.config.${extension}`]: 'throw new Error("Must never execute");\n' +
        'module.exports = { locales: ["en", "fr"], defaultLocale: "fr" };',
      "public/locales/en/common.json": MESSAGE,
      "public/locales/fr/common.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.sourceLocale).toBe("fr");
    expect(setup?.plan.warnings).toEqual([]);
  });

  it("continues past empty locale roots and ignores empty pseudo catalogs", async () => {
    const root = await seed({
      "package.json": I18NEXT,
      "public/locales/en/.gitkeep": "",
      "public/locales/fr/readme.md": "",
      "src/locales/en/common.json": MESSAGE,
      "src/locales/fr/common.json": MESSAGE,
      "src/locales/ja/.gitkeep": "",
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.catalog.rootDir).toBe("src/locales");
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
  });

  it("finds the declared source in a later populated root", async () => {
    const root = await seed({
      "package.json": I18NEXT,
      "next-i18next.config.js": 'module.exports = { locales: ["en", "fr"], defaultLocale: "en" };',
      "public/locales/fr/common.json": MESSAGE,
      "locales/en/common.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.catalog.rootDir).toBe("locales");
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
    expect(setup?.plan.warnings.join(" ")).toContain("other locale roots");
  });

  it.each([
    'module.exports = { locales: ["en", "fr"], defaultLocale: "en" };',
    'module.exports = { defaultLocale: "en" };',
    'module.exports = { locales: computeLocales(), fallbackLng: "en" };',
  ])("refuses a catalog whose declared source is absent: %s", async (settings) => {
    const root = await seed({
      "package.json": I18NEXT,
      "next-i18next.config.js": settings,
      "public/locales/fr/common.json": MESSAGE,
    });
    expect(await detectProject(root)).toEqual([]);
  });

  it.each([
    'export const languages = ["fr", ...others]; export const defaultLanguage = "fr" + region;',
    'export const languages = getLanguages(); export const defaultLanguage = getLanguage();',
    'export const old_languages = ["fr"]; export const old_defaultLanguage = "fr";',
  ])("warns when a present settings module still requires inference: %s", async (settings) => {
    const root = await seed({
      "package.json": I18NEXT, "i18n/settings.ts": settings,
      "public/locales/en/common.json": MESSAGE, "public/locales/fr/common.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.sourceLocale).toBe("en");
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
    expect(setup?.plan.warnings.join(" ")).toContain("inferred");
    expect(setup?.plan.warnings.join(" ")).toContain('assuming "en"');
  });

  it("warns when the declared default no longer belongs to the enabled locales", async () => {
    const root = await seed({
      "package.json": I18NEXT,
      "next-i18next.config.js": 'module.exports = { locales: ["en", "fr", "fr"], fallbackLng: "de" };',
      "public/locales/en/common.json": MESSAGE,
    });
    const [setup] = await detectProject(root);
    expect(setup?.plan.targetLocales).toEqual(["fr"]);
    expect(setup?.plan.warnings.join(" ")).toContain('"de" is not enabled');
  });
});
