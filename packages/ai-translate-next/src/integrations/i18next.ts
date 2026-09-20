import { dependencyNames, firstExistingFile } from "../context";
import {
  isLocaleTag,
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
  "next-i18next.config.cjs",
  "next-i18next.config.mts",
  "next-i18next.config.cts",
  "lib/i18n/i18n.settings.ts",
  "src/lib/i18n/i18n.settings.ts",
  "app/i18n/settings.ts",
  "src/app/i18n/settings.ts",
  "i18n/settings.ts",
  "src/i18n/settings.ts",
];

async function detectLocaleRoots(
  context: DetectionContext,
): Promise<readonly { locales: readonly string[]; rootDir: string }[]> {
  const candidates = await Promise.all(
    LOCALE_DIRS.map(async (rootDir) => {
      const directories = localesFromNames(await context.listDirectories(rootDir));
      const populated = await Promise.all(directories.map(async (locale) => ({
        locale,
        count: await countNamespaces(context, rootDir, locale),
      })));
      return {
        locales: populated.filter((locale) => locale.count > 0).map((locale) => locale.locale),
        rootDir,
      };
    }),
  );

  return candidates.filter((candidate) => candidate.locales.length > 0);
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

    const [localeRoots, settingsPath] = await Promise.all([
      detectLocaleRoots(context),
      firstExistingFile(context, SETTINGS_PATHS),
    ]);

    const evidence: DetectionEvidence[] = [
      { detail: `${runtime.join(", ")} declared as dependencies`, source: "package.json" },
    ];

    let declaredLocales: readonly string[] | null = null;
    let declaredDefault: string | null = null;
    if (settingsPath !== null) {
      const source = (await context.readFile(settingsPath)) ?? "";
      declaredDefault =
        readStringLiteral(source, "defaultLanguage") ??
        readStringLiteral(source, "defaultLocale") ??
        readStringLiteral(source, "fallbackLng");
      const declared =
        readStringArrayLiteral(source, "languages") ?? readStringArrayLiteral(source, "locales");
      // A declared list is more authoritative than directory names, but only
      // for the entries that are locales: these arrays routinely carry
      // pseudo-locales like `default`. If filtering leaves nothing, the
      // directories are the better answer.
      const validLocales = declared === null ? [] : localesFromNames(declared);
      if (validLocales.length > 0) {
        declaredLocales = validLocales;
      }
      evidence.push({ detail: "i18next settings module", source: settingsPath });
    }

    const resolveSource = (locales: readonly string[]): string | null =>
      declaredLocales === null && declaredDefault !== null && isLocaleTag(declaredDefault)
        ? declaredDefault
        : resolveSourceLocale(locales, declaredDefault);
    const localeRoot = localeRoots.find((candidate) => {
      const source = resolveSource(declaredLocales ?? candidate.locales);
      return source !== null && candidate.locales.includes(source);
    });
    if (localeRoot === undefined) {
      return null;
    }
    const locales = declaredLocales ?? localeRoot.locales;
    const sourceLocale = resolveSource(locales);
    if (sourceLocale === null) {
      return null;
    }

    const namespaceCount = await countNamespaces(context, localeRoot.rootDir, sourceLocale);
    evidence.push({
      detail: `${String(namespaceCount)} namespace file(s) across ${String(locales.length)} locales`,
      source: `${localeRoot.rootDir}/${sourceLocale}`,
    });

    const warnings: string[] = [];
    if (localeRoots.length > 1) {
      const alternatives = localeRoots.filter((candidate) => candidate !== localeRoot)
        .map((candidate) => candidate.rootDir);
      warnings.push(`Selected ${localeRoot.rootDir}; other locale roots also exist: ${alternatives.join(", ")}. Review whether additional catalogs are needed.`);
    }
    if (settingsPath === null) {
      warnings.push(
        "No i18next settings module was found, so locales were inferred from directory names. " +
          "Check the generated sourceLocale and targetLocales.",
      );
    } else {
      if (declaredLocales === null) {
        warnings.push(`No literal locale list was found in ${settingsPath}; locales were inferred from directory names. Check targetLocales.`);
      }
      if (declaredDefault === null) {
        warnings.push(`No literal default language was found; assuming "${sourceLocale}" is the source.`);
      } else if (declaredDefault !== sourceLocale) {
        warnings.push(`Declared default language "${declaredDefault}" is not enabled; assuming "${sourceLocale}" is the source.`);
      }
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
