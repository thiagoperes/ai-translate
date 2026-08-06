import { dependencyNames, firstExistingFile } from "../context";
import {
  localesFromJsonFileNames,
  localesFromNames,
  readStringArrayLiteral,
  readStringLiteral,
  resolveSourceLocale,
} from "../locales";
import { defineIntegration } from "../types";
import type {
  CatalogPlan,
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
];

const ROUTING_PATHS = [
  "i18n/routing.ts",
  "src/i18n/routing.ts",
  "i18n/routing.js",
  "src/i18n/routing.js",
];

/** The documented default is `messages/`, but `src/messages/` is common. */
const MESSAGE_DIRS = ["messages", "src/messages", "locales", "src/locales"];

interface MessageLayout {
  catalog: CatalogPlan;
  locales: readonly string[];
}

/**
 * next-intl stores either one file per locale (`messages/en.json`) or a folder
 * per locale when messages are split (`messages/en/dashboard.json`). Both are
 * documented, so both must be recognised.
 */
async function detectMessageLayout(context: DetectionContext): Promise<MessageLayout | null> {
  for (const rootDir of MESSAGE_DIRS) {
    const [directories, files] = await Promise.all([
      context.listDirectories(rootDir),
      context.listFiles(rootDir),
    ]);

    const folderLocales = localesFromNames(directories);
    if (folderLocales.length > 0) {
      return {
        catalog: { kind: "namespace-json", rootDir },
        locales: folderLocales,
      };
    }

    const fileLocales = localesFromJsonFileNames(files);
    if (fileLocales.length > 0) {
      return {
        catalog: { kind: "document-json", rootDir },
        locales: fileLocales,
      };
    }
  }

  return null;
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

    const [requestConfig, routingConfig, layout] = await Promise.all([
      firstExistingFile(context, REQUEST_CONFIG_PATHS),
      firstExistingFile(context, ROUTING_PATHS),
      detectMessageLayout(context),
    ]);

    if (requestConfig !== null) {
      evidence.push({ detail: "next-intl request configuration", source: requestConfig });
    }

    if (layout === null) {
      return null;
    }

    evidence.push({
      detail:
        layout.catalog.kind === "document-json"
          ? `One message file per locale (${layout.locales.length} locales)`
          : `One folder per locale with split namespaces (${layout.locales.length} locales)`,
      source: layout.catalog.rootDir,
    });

    // Locales declared in routing are authoritative: a project may ship message
    // files for locales it has not enabled yet.
    let locales = layout.locales;
    let declaredDefault: string | null = null;
    if (routingConfig !== null) {
      const source = (await context.readFile(routingConfig)) ?? "";
      const declared = readStringArrayLiteral(source, "locales");
      declaredDefault = readStringLiteral(source, "defaultLocale");
      if (declared !== null) {
        locales = declared;
        evidence.push({ detail: `Locales declared as ${declared.join(", ")}`, source: routingConfig });
      }
    }

    const sourceLocale = resolveSourceLocale(locales, declaredDefault);
    if (sourceLocale === null) {
      return null;
    }

    const warnings: string[] = [];
    if (routingConfig === null) {
      warnings.push(
        "No i18n/routing.ts found, so locales were inferred from the message files. " +
          "Check the generated targetLocales list.",
      );
    }
    if (declaredDefault === null) {
      warnings.push(`No defaultLocale was declared; assuming "${sourceLocale}" is the source.`);
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
