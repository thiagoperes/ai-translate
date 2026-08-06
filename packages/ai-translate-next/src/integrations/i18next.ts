import { dependencyNames, firstExistingFile } from "../context";
import {
  localesFromNames,
  readStringArrayLiteral,
  readStringLiteral,
  resolveSourceLocale,
} from "../locales";
import { defineIntegration } from "../types";
import type { DetectionContext, DetectionEvidence, Integration } from "../types";

export const I18NEXT_INTEGRATION_ID = "i18next";

/** Any of these means the i18next runtime is in play, whether through
 * next-i18next, react-i18next, or a hand-rolled App Router setup. */
const RUNTIME_PACKAGES = ["i18next", "next-i18next", "react-i18next"];

/** Conventional locale roots, most specific first. `public/locales` is the
 * next-i18next default and the one the App Router setups copy. */
const LOCALE_DIRS = [
  "public/locales",
  "src/public/locales",
  "locales",
  "src/locales",
  "app/locales",
];

const SETTINGS_PATHS = [
  "next-i18next.config.js",
  "next-i18next.config.mjs",
  "next-i18next.config.ts",
  "lib/i18n/i18n.settings.ts",
  "src/lib/i18n/i18n.settings.ts",
  "app/i18n/settings.ts",
  "src/app/i18n/settings.ts",
  "i18n/settings.ts",
  "src/i18n/settings.ts",
];

async function detectLocaleRoot(
  context: DetectionContext,
): Promise<{ locales: readonly string[]; rootDir: string } | null> {
  const candidates = await Promise.all(
    LOCALE_DIRS.map(async (rootDir) => ({
      locales: localesFromNames(await context.listDirectories(rootDir)),
      rootDir,
    })),
  );

  return candidates.find((candidate) => candidate.locales.length > 0) ?? null;
}

/** Counts namespace files so the report can state the corpus size, and so a
 * directory of locales with no JSON in it is not mistaken for a catalog. */
async function countNamespaces(
  context: DetectionContext,
  rootDir: string,
  locale: string,
): Promise<number> {
  const files = await context.listFiles(`${rootDir}/${locale}`);
  return files.filter((file) => file.endsWith(".json")).length;
}

export const i18nextIntegration: Integration = defineIntegration({
  async detect(context) {
    const dependencies = await dependencyNames(context);
    const runtime = RUNTIME_PACKAGES.filter((name) => dependencies.has(name));
    if (runtime.length === 0) {
      return null;
    }

    const localeRoot = await detectLocaleRoot(context);
    if (localeRoot === null) {
      return null;
    }

    const evidence: DetectionEvidence[] = [
      { detail: `${runtime.join(", ")} declared as dependencies`, source: "package.json" },
    ];

    let locales = localeRoot.locales;
    let declaredDefault: string | null = null;
    const settingsPath = await firstExistingFile(context, SETTINGS_PATHS);
    if (settingsPath !== null) {
      const source = (await context.readFile(settingsPath)) ?? "";
      declaredDefault =
        readStringLiteral(source, "defaultLanguage") ??
        readStringLiteral(source, "defaultLocale") ??
        readStringLiteral(source, "fallbackLng");
      const declared =
        readStringArrayLiteral(source, "languages") ?? readStringArrayLiteral(source, "locales");
      if (declared !== null) {
        locales = declared;
      }
      evidence.push({ detail: "i18next settings module", source: settingsPath });
    }

    const sourceLocale = resolveSourceLocale(locales, declaredDefault);
    if (sourceLocale === null) {
      return null;
    }

    const namespaceCount = await countNamespaces(context, localeRoot.rootDir, sourceLocale);
    if (namespaceCount === 0) {
      return null;
    }

    evidence.push({
      detail: `${String(namespaceCount)} namespace file(s) across ${String(locales.length)} locales`,
      source: `${localeRoot.rootDir}/${sourceLocale}`,
    });

    const warnings: string[] = [];
    if (settingsPath === null) {
      warnings.push(
        "No i18next settings module was found, so locales were inferred from directory names. " +
          "Check the generated sourceLocale and targetLocales.",
      );
    }

    return {
      confidence: settingsPath === null ? 0.75 : 0.9,
      displayName: "i18next",
      evidence,
      integrationId: I18NEXT_INTEGRATION_ID,
      plan: {
        catalog: {
          kind: "namespace-json",
          // i18next spells plurals as sibling keys, so target files need the
          // forms their locale requires rather than a copy of English's.
          plurals: "i18next-v4",
          rootDir: localeRoot.rootDir,
        },
        messageFormat: "i18next",
        sourceLocale,
        targetLocales: locales.filter((locale) => locale !== sourceLocale),
        warnings,
      },
    };
  },
  displayName: "i18next (react-i18next, next-i18next)",
  id: I18NEXT_INTEGRATION_ID,
});
