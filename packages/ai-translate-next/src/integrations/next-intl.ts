import { dependencyNames, firstExistingFile } from "../context";
import {
  isLocaleTag,
  localesFromJsonFileNames,
  localesFromNames,
  readStringArrayLiteral,
  readStringLiteral,
  resolveSourceLocale,
} from "../locales";
import { defineIntegration } from "../types";
import type {
  JsonCatalogPlan,
  DetectionContext,
  DetectionEvidence,
  Integration,
} from "../types";

export const NEXT_INTL_INTEGRATION_ID = "next-intl";

/** Where next-intl's request config lives, in precedence order. */
const REQUEST_CONFIG_PATHS = [
  "i18n/request.ts",
  "src/i18n/request.ts",
  "i18n/request.js",
  "src/i18n/request.js",
  "i18n/request.tsx",
  "src/i18n/request.tsx",
  "i18n/request.mjs",
  "src/i18n/request.mjs",
  "i18n/request.mts",
  "src/i18n/request.mts",
];

const ROUTING_PATHS = [
  "i18n/routing.ts",
  "src/i18n/routing.ts",
  "i18n/routing.js",
  "src/i18n/routing.js",
  "i18n/routing.mjs",
  "src/i18n/routing.mjs",
  "i18n/routing.mts",
  "src/i18n/routing.mts",
];

/** The documented default is `messages/`, but `src/messages/` is common. */
const MESSAGE_DIRS = ["messages", "src/messages", "locales", "src/locales"];

interface MessageLayout {
  catalog: JsonCatalogPlan;
  locales: readonly string[];
}

/**
 * next-intl stores either one file per locale (`messages/en.json`) or a folder
 * per locale when messages are split (`messages/en/dashboard.json`). Both are
 * documented, so both must be recognised.
 */
async function detectMessageLayouts(context: DetectionContext): Promise<readonly MessageLayout[]> {
  const layouts: MessageLayout[] = [];
  for (const rootDir of MESSAGE_DIRS) {
    const [directories, files] = await Promise.all([
      context.listDirectories(rootDir),
      context.listFiles(rootDir),
    ]);

    const folders = await Promise.all(localesFromNames(directories).map(async (locale) => ({
      locale,
      populated: (await context.listFiles(`${rootDir}/${locale}`)).some((file) => file.endsWith(".json")),
    })));
    const folderLocales = folders.filter((folder) => folder.populated).map((folder) => folder.locale);
    if (folderLocales.length > 0) {
      layouts.push({
        catalog: { kind: "namespace-json", rootDir },
        locales: folderLocales,
      });
    }

    const fileLocales = localesFromJsonFileNames(files);
    if (fileLocales.length > 0) {
      layouts.push({
        catalog: { kind: "document-json", rootDir },
        locales: fileLocales,
      });
    }
  }

  return layouts;
}

export const nextIntlIntegration: Integration = defineIntegration({
  async detect(context) {
    const dependencies = await dependencyNames(context);
    if (!dependencies.has("next-intl")) {
      return null;
    }

    const evidence: DetectionEvidence[] = [
      { detail: "next-intl is a declared dependency", source: "package.json" },
    ];

    const [requestConfig, routingConfig, layouts] = await Promise.all([
      firstExistingFile(context, REQUEST_CONFIG_PATHS),
      firstExistingFile(context, ROUTING_PATHS),
      detectMessageLayouts(context),
    ]);

    if (requestConfig !== null) {
      evidence.push({ detail: "next-intl request configuration", source: requestConfig });
    }

    // Locales declared in routing are authoritative: a project may ship message
    // files for locales it has not enabled yet.
    let declaredLocales: readonly string[] | null = null;
    let declaredDefault: string | null = null;
    if (routingConfig !== null) {
      const source = (await context.readFile(routingConfig)) ?? "";
      const declared = readStringArrayLiteral(source, "locales");
      declaredDefault = readStringLiteral(source, "defaultLocale");
      const validLocales = declared === null ? [] : localesFromNames(declared);
      if (validLocales.length > 0) {
        declaredLocales = validLocales;
        evidence.push({ detail: `Locales declared as ${validLocales.join(", ")}`, source: routingConfig });
      }
    }

    const resolveSource = (locales: readonly string[]): string | null =>
      declaredLocales === null && declaredDefault !== null && isLocaleTag(declaredDefault)
        ? declaredDefault
        : resolveSourceLocale(locales, declaredDefault);
    const layout = layouts.find((candidate) => {
      const source = resolveSource(declaredLocales ?? candidate.locales);
      return source !== null && candidate.locales.includes(source);
    });
    if (layout === undefined) {
      return null;
    }
    const locales = declaredLocales ?? layout.locales;
    const sourceLocale = resolveSource(locales);
    if (sourceLocale === null) {
      return null;
    }

    evidence.push({
      detail:
        layout.catalog.kind === "document-json"
          ? `One message file per locale (${layout.locales.length} locales)`
          : `One folder per locale with split namespaces (${layout.locales.length} locales)`,
      source: layout.catalog.rootDir,
    });

    const warnings: string[] = [];
    if (layouts.length > 1) {
      const alternatives = layouts.filter((candidate) => candidate !== layout)
        .map((candidate) => `${candidate.catalog.rootDir} (${candidate.catalog.kind})`);
      warnings.push(`Selected ${layout.catalog.rootDir} (${layout.catalog.kind}); other message layouts also exist: ${alternatives.join(", ")}. Review whether additional catalogs are needed.`);
    }
    if (routingConfig === null) {
      warnings.push(
        "No i18n/routing.ts found, so locales were inferred from the message files. " +
          "Check the generated targetLocales list.",
      );
    } else if (declaredLocales === null) {
      warnings.push(`No literal locale list was found in ${routingConfig}; locales were inferred from message files. Check targetLocales.`);
    }
    if (declaredDefault === null) {
      warnings.push(`No defaultLocale was declared; assuming "${sourceLocale}" is the source.`);
    } else if (declaredDefault !== sourceLocale) {
      warnings.push(`Declared defaultLocale "${declaredDefault}" is not enabled; assuming "${sourceLocale}" is the source.`);
    }

    return {
      // Requiring both the dependency and a recognised message layout makes a
      // false positive very unlikely, so this is reported as a firm match.
      confidence: requestConfig === null ? 0.8 : 0.95,
      displayName: "next-intl",
      evidence,
      integrationId: NEXT_INTL_INTEGRATION_ID,
      plan: {
        catalog: layout.catalog,
        // next-intl parses every message with ICU, so plurals and selects live
        // inside the string and need no key expansion.
        messageFormat: "icu",
        sourceLocale,
        targetLocales: locales.filter((locale) => locale !== sourceLocale),
        warnings,
      },
    };
  },
  displayName: "next-intl",
  id: NEXT_INTL_INTEGRATION_ID,
});
