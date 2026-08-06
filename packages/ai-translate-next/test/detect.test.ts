import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDetectionContext, dependencyNames } from "../src/context";
import type { DetectedSetup } from "../src/types";
import { detectProject } from "../src/detect";
import { i18nextIntegration } from "../src/integrations/i18next";
import { nextIntlIntegration } from "../src/integrations/next-intl";
import {
  isLocaleTag,
  readStringArrayLiteral,
  readStringLiteral,
  resolveSourceLocale,
} from "../src/locales";
import { renderConfig } from "../src/render-config";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function seedProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-next-"));
  workspaces.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }
  return root;
}

const MESSAGES = JSON.stringify({ home: { title: "Hello" } });

/** Detection returning nothing is a test failure, not a plan to render. */
function requireBest(setups: readonly DetectedSetup[]): DetectedSetup {
  const [best] = setups;
  if (best === undefined) {
    throw new Error("Expected a detected setup.");
  }
  return best;
}

describe("isLocaleTag", () => {
  it.each(["en", "de", "pt-BR", "zh-Hans", "fil"])("accepts %s", (tag) => {
    expect(isLocaleTag(tag)).toBe(true);
  });

  it.each(["templates", "shared", "images", "node_modules", "components", "_default"])(
    "rejects %s",
    (name) => {
      // These sit next to locale folders in real projects. Intl treats most of
      // them as syntactically valid language subtags, so the guard cannot rely
      // on Intl alone.
      expect(isLocaleTag(name)).toBe(false);
    },
  );

  it.each(["en-", "pt--BR", "en-@@"])("rejects %s rather than throwing", (name) => {
    // A well-shaped primary subtag can still carry a malformed suffix, which
    // makes Intl throw rather than return an empty list.
    expect(isLocaleTag(name)).toBe(false);
  });
});

describe("resolveSourceLocale", () => {
  it("prefers the declared default when the project lists it", () => {
    expect(resolveSourceLocale(["de", "en", "fr"], "de")).toBe("de");
  });

  it("ignores a declared default the locale list does not contain", () => {
    // next-intl projects sometimes keep a defaultLocale for a locale they have
    // since removed; the list on disk is the authority.
    expect(resolveSourceLocale(["de", "fr"], "en")).toBe("de");
  });

  it("falls back to English before the first locale", () => {
    expect(resolveSourceLocale(["de", "en", "fr"], null)).toBe("en");
  });

  it("has no source locale to offer when the list is empty", () => {
    expect(resolveSourceLocale([], null)).toBeNull();
  });
});

describe("detection context", () => {
  it("reports no manifest when the project has none", async () => {
    const context = createDetectionContext(await seedProject({ "readme.md": "" }));
    expect(await context.packageJson()).toBeNull();
    expect(await dependencyNames(context)).toEqual(new Set());
  });

  it("treats an unparsable manifest as absent rather than failing detection", async () => {
    // A project mid-edit should degrade to "nothing detected", not crash the
    // CLI with a JSON syntax error.
    const context = createDetectionContext(await seedProject({ "package.json": "{ oops" }));
    expect(await context.packageJson()).toBeNull();
  });

  it("treats a non-object manifest as absent", async () => {
    const context = createDetectionContext(await seedProject({ "package.json": "null" }));
    expect(await context.packageJson()).toBeNull();
  });
});

describe("literal readers", () => {
  it("reads a locale array without executing the module", () => {
    expect(
      readStringArrayLiteral(
        'export const routing = defineRouting({ locales: ["en", "de", "fr"], defaultLocale: "en" });',
        "locales",
      ),
    ).toEqual(["en", "de", "fr"]);
  });

  it("returns null when the array is computed rather than written out", () => {
    expect(readStringArrayLiteral("export const locales = Object.keys(messages);", "locales")).toBe(
      null,
    );
  });

  it("reads a string literal", () => {
    expect(readStringLiteral('defaultLocale: "pt-BR",', "defaultLocale")).toBe("pt-BR");
  });
});

describe("next-intl detection", () => {
  it("detects one message file per locale and reads routing", async () => {
    const root = await seedProject({
      "i18n/request.ts": "export default getRequestConfig(async () => ({}));",
      "i18n/routing.ts": 'export const routing = defineRouting({ locales: ["en", "de", "fr"], defaultLocale: "de" });',
      "messages/de.json": MESSAGES,
      "messages/en.json": MESSAGES,
      "messages/fr.json": MESSAGES,
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0", "next-intl": "3.0.0" } }),
    });

    const [detected] = await detectProject(root);

    expect(detected?.integrationId).toBe("next-intl");
    expect(detected?.plan).toMatchObject({
      catalog: { kind: "document-json", rootDir: "messages" },
      messageFormat: "icu",
      sourceLocale: "de",
      targetLocales: ["en", "fr"],
    });
    expect(detected?.plan.warnings).toEqual([]);
  });

  it("detects a folder per locale as a namespace catalog", async () => {
    const root = await seedProject({
      "package.json": JSON.stringify({ dependencies: { "next-intl": "3.0.0" } }),
      "src/messages/en/home.json": MESSAGES,
      "src/messages/pt-BR/home.json": MESSAGES,
    });

    const [detected] = await detectProject(root);

    expect(detected?.plan.catalog).toEqual({ kind: "namespace-json", rootDir: "src/messages" });
    expect(detected?.plan.targetLocales).toEqual(["pt-BR"]);
  });

  it("warns when locales had to be inferred", async () => {
    const root = await seedProject({
      "messages/en.json": MESSAGES,
      "messages/es.json": MESSAGES,
      "package.json": JSON.stringify({ dependencies: { "next-intl": "3.0.0" } }),
    });

    const [detected] = await detectProject(root);

    expect(detected?.plan.warnings.join(" ")).toContain("routing.ts");
  });

  it("ignores a project that depends on next-intl but has no messages", async () => {
    const root = await seedProject({
      "package.json": JSON.stringify({ dependencies: { "next-intl": "3.0.0" } }),
    });

    expect(await detectProject(root)).toEqual([]);
  });

  it("ignores a project with messages but no next-intl", async () => {
    const root = await seedProject({
      "messages/en.json": MESSAGES,
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
    });

    expect(await detectProject(root)).toEqual([]);
  });
});

describe("i18next detection", () => {
  it("detects the public/locales convention and reads a settings module", async () => {
    const root = await seedProject({
      "lib/i18n/i18n.settings.ts":
        'export const languages = ["en", "de", "pl"];\nexport const defaultLanguage = "en";',
      "package.json": JSON.stringify({
        dependencies: { i18next: "23.0.0", "react-i18next": "14.0.0" },
      }),
      "public/locales/de/common.json": MESSAGES,
      "public/locales/en/common.json": MESSAGES,
      "public/locales/en/dashboard.json": MESSAGES,
      "public/locales/pl/common.json": MESSAGES,
    });

    const [detected] = await detectProject(root);

    expect(detected?.integrationId).toBe("i18next");
    expect(detected?.plan).toMatchObject({
      catalog: { kind: "namespace-json", plurals: "i18next-v4", rootDir: "public/locales" },
      messageFormat: "i18next",
      sourceLocale: "en",
      targetLocales: ["de", "pl"],
    });
  });

  it("skips directories that look like locales but hold no namespaces", async () => {
    const root = await seedProject({
      "package.json": JSON.stringify({ dependencies: { i18next: "23.0.0" } }),
      "public/locales/en/.gitkeep": "",
    });

    expect(await detectProject(root)).toEqual([]);
  });

  it("ignores a project that depends on i18next but keeps no locale tree", async () => {
    const root = await seedProject({
      "package.json": JSON.stringify({ dependencies: { i18next: "23.0.0" } }),
    });

    expect(await detectProject(root)).toEqual([]);
  });

  it("keeps the directory locales when the declared list holds only pseudo-locales", async () => {
    // `default` is a routing placeholder, not a language. Taking the declared
    // list literally would drop every real locale on disk.
    const root = await seedProject({
      "next-i18next.config.js": 'module.exports = { locales: ["default"] };',
      "package.json": JSON.stringify({ dependencies: { i18next: "23.0.0" } }),
      "public/locales/en/common.json": MESSAGES,
      "public/locales/nl/common.json": MESSAGES,
    });

    expect(requireBest(await detectProject(root)).plan.targetLocales).toEqual(["nl"]);
  });

  it("drops non-locale entries from a declared list but keeps the rest", async () => {
    const root = await seedProject({
      "next-i18next.config.js": 'module.exports = { locales: ["en", "default", "nl"] };',
      "package.json": JSON.stringify({ dependencies: { i18next: "23.0.0" } }),
      "public/locales/en/common.json": MESSAGES,
    });

    expect(requireBest(await detectProject(root)).plan.targetLocales).toEqual(["nl"]);
  });

  it("infers locales from directories when no settings module exists", async () => {
    const root = await seedProject({
      "package.json": JSON.stringify({ dependencies: { "next-i18next": "15.0.0" } }),
      "public/locales/en/common.json": MESSAGES,
      "public/locales/fr/common.json": MESSAGES,
    });

    const detected = requireBest(await detectProject(root));

    expect(detected.confidence).toBeLessThan(0.9);
    expect(detected.plan.warnings).toHaveLength(1);
    expect(detected.plan.targetLocales).toEqual(["fr"]);
  });

  it("reports both integrations for a project mid-migration, best first", async () => {
    const root = await seedProject({
      "i18n/request.ts": "export default getRequestConfig(async () => ({}));",
      "messages/en.json": MESSAGES,
      "package.json": JSON.stringify({
        dependencies: { i18next: "23.0.0", "next-intl": "3.0.0" },
      }),
      "public/locales/en/common.json": MESSAGES,
    });

    expect((await detectProject(root)).map((setup) => setup.integrationId)).toEqual([
      "next-intl",
      "i18next",
    ]);
  });
});

describe("renderConfig", () => {
  it("renders an i18next namespace catalog with plural support", async () => {
    const root = await seedProject({
      "package.json": JSON.stringify({ dependencies: { i18next: "23.0.0" } }),
      "public/locales/en/common.json": MESSAGES,
      "public/locales/pl/common.json": MESSAGES,
    });

    const config = renderConfig(requireBest(await detectProject(root)).plan);

    expect(config).toContain('import { i18nextMessageFormat, i18nextPluralKeys } from "@ai-translate/message-formats";');
    expect(config).toContain("createNamespaceJsonCatalog({");
    expect(config).toContain("plurals: i18nextPluralKeys,");
    expect(config).toContain('rootDir: "public/locales",');
    expect(config).toContain('const targetLocales = ["pl"];');
  });

  it("renders a next-intl document catalog without plural keys", async () => {
    const root = await seedProject({
      "i18n/routing.ts": 'defineRouting({ locales: ["en", "de"], defaultLocale: "en" })',
      "messages/de.json": MESSAGES,
      "messages/en.json": MESSAGES,
      "package.json": JSON.stringify({ dependencies: { "next-intl": "3.0.0" } }),
    });

    const config = renderConfig(requireBest(await detectProject(root)).plan);

    expect(config).toContain("createLocalizedJsonDocument({");
    expect(config).toContain("messageFormat: icuMessageFormat,");
    // ICU encodes plurals inside the message, so no key strategy belongs here.
    expect(config).not.toContain("plurals:");
  });

  it("breaks a long locale list across lines so it stays reviewable", async () => {
    const locales = ["en", "de", "el", "es", "et", "fi", "fr", "ga", "hr", "it", "lt", "lv", "nl"];
    const root = await seedProject({
      "package.json": JSON.stringify({ dependencies: { i18next: "23.0.0" } }),
      ...Object.fromEntries(
        locales.map((locale) => [`public/locales/${locale}/common.json`, MESSAGES]),
      ),
    });

    const config = renderConfig(requireBest(await detectProject(root)).plan);

    expect(config).toContain('const targetLocales = [\n  "de",\n');
    expect(config).toContain('  "nl",\n];');
  });

  it("turns warnings into TODO comments rather than dropping them", async () => {
    const root = await seedProject({
      "messages/en.json": MESSAGES,
      "messages/es.json": MESSAGES,
      "package.json": JSON.stringify({ dependencies: { "next-intl": "3.0.0" } }),
    });

    expect(renderConfig(requireBest(await detectProject(root)).plan)).toContain("// TODO:");
  });
});

/**
 * Synthetic fixtures agree with the detector by construction, because the same
 * understanding of a layout produced both. Pointing it at a real i18next app
 * is the only check that the conventions it looks for are the ones projects
 * actually use. Set `AI_TRANSLATE_REAL_PROJECT` to such an app to run it;
 * detection is read-only, so nothing is written to the target.
 */
describe("detection against a real project", () => {
  const realProject = process.env.AI_TRANSLATE_REAL_PROJECT;

  it("infers the i18next setup from the repository as it stands", async ({ skip }) => {
    if (realProject === undefined || !(await fs.stat(realProject).catch(() => null))) {
      skip();
      return;
    }

    const setups = await detectProject(realProject);
    const i18next = setups.find((setup) => setup.integrationId === "i18next");

    expect(i18next?.plan.catalog).toMatchObject({
      kind: "namespace-json",
      plurals: "i18next-v4",
      rootDir: "public/locales",
    });
    expect(i18next?.plan.sourceLocale).toBe("en");
    expect(i18next?.plan.targetLocales.length).toBeGreaterThan(10);
    expect(i18next?.evidence.length).toBeGreaterThan(1);
  });
});

describe("integration registry", () => {
  it("exposes stable ids", () => {
    expect([nextIntlIntegration.id, i18nextIntegration.id]).toEqual(["next-intl", "i18next"]);
  });

  it("survives an integration that throws", async () => {
    const context = createDetectionContext(await seedProject({ "package.json": "{}" }));
    const setups = await Promise.resolve(
      import("../src/detect").then(async ({ detectSetups }) =>
        detectSetups(context, {
          integrations: [
            {
              detect: () => Promise.reject(new Error("boom")),
              displayName: "broken",
              id: "broken",
            },
          ],
        }),
      ),
    );

    expect(setups).toEqual([]);
  });
});
