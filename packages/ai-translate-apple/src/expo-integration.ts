import * as path from "node:path";

import {
  defineIntegration,
  dependencyNames,
  isLocaleTag,
} from "@ai-translate/integrations";
import type { DetectionContext, Integration } from "@ai-translate/integrations";

import { readStaticExpoConfig } from "./expo-config";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(source: string): unknown {
  try {
    return JSON.parse(source.replace(/^\uFEFF/u, ""));
  } catch {
    return undefined;
  }
}

function identity(locale: string): string {
  return (
    Intl.getCanonicalLocales(locale)[0]?.toLowerCase() ?? locale.toLowerCase()
  );
}

/** Missing output files are allowed, but all their parent directories must be
 * authored directories visible to the bounded, symlink-free context. */
async function localFile(
  context: DetectionContext,
  value: unknown,
): Promise<string | null> {
  if (
    typeof value !== "string" ||
    !value.endsWith(".json") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return null;
  }
  const file = path.posix.normalize(value);
  if (file.startsWith("../")) {
    return null;
  }
  let directory = "";
  for (const component of file.split("/").slice(0, -1)) {
    if (!(await context.listDirectories(directory)).includes(component)) {
      return null;
    }
    directory = directory === "" ? component : `${directory}/${component}`;
  }
  return file;
}

/** Expo consumes these authored JSON files during prebuild for native labels
 * and permissions. Shared application UI remains a separate runtime catalog. */
export const expoIntegration: Integration = defineIntegration({
  async detect(context) {
    let config: unknown;
    let configPath = "app.json";
    for (const file of ["app.config.ts", "app.config.js", "app.json"]) {
      const source = await context.readFile(file);
      if (source === null) {
        continue;
      }
      configPath = file;
      config =
        file === "app.json" ? json(source) : readStaticExpoConfig(source);
      // A dynamic export overrides app.json; never infer stale static paths.
      break;
    }
    if (!record(config)) {
      return null;
    }
    const wrapped = Object.hasOwn(config, "expo");
    if (!wrapped && !(await dependencyNames(context)).has("expo")) {
      return null;
    }
    const expo = wrapped ? config.expo : config;
    if (!record(expo) || !record(expo.locales)) {
      return null;
    }
    const warnings: string[] = [];
    const entries = Object.entries(expo.locales);
    if (entries.length === 0) {
      return null;
    }
    const identities = new Set<string>();
    const paths = new Set<string>();
    const localeFiles: Record<string, string> = {};
    for (const [locale, candidate] of entries) {
      if (!isLocaleTag(locale)) {
        return null;
      }
      const canonical = identity(locale);
      const file = await localFile(context, candidate);
      if (file === null) {
        return null;
      }
      const fileIdentity = file.normalize("NFC").toLowerCase();
      if (identities.has(canonical) || paths.has(fileIdentity)) {
        return null;
      }
      identities.add(canonical);
      paths.add(fileIdentity);
      localeFiles[locale] = file;
    }
    const locales = Object.keys(localeFiles).toSorted();
    const declared =
      record(expo.ios) && record(expo.ios.infoPlist)
        ? expo.ios.infoPlist.CFBundleDevelopmentRegion
        : undefined;
    const declaredSource =
      typeof declared === "string" && isLocaleTag(declared)
        ? locales.find((locale) => identity(locale) === identity(declared))
        : undefined;
    const sourceLocale =
      declaredSource ??
      locales.find((locale) => identity(locale) === "en") ??
      locales[0];
    if (sourceLocale === undefined) {
      return null;
    }
    const sourceFile = localeFiles[sourceLocale];
    const sourceText =
      sourceFile === undefined ? null : await context.readFile(sourceFile);
    if (sourceText === null || !record(json(sourceText))) {
      return null;
    }
    if (declaredSource === undefined) {
      warnings.push(
        `Expo does not declare a mapped source language; sourceLocale is provisionally "${sourceLocale}". Confirm it before syncing.`,
      );
    }
    const targetLocales = locales.filter((locale) => locale !== sourceLocale);
    if (targetLocales.length === 0) {
      warnings.push(
        "No target languages were found. Add locale files to expo.locales and re-run init before syncing.",
      );
    }
    warnings.push(
      "Expo generates native resources from these JSON files during prebuild. Shared React Native UI strings need their own localization runtime and catalog.",
    );
    return {
      confidence: 0.97,
      displayName: "Expo native metadata",
      evidence: [
        {
          detail: `${String(locales.length)} native locale JSON file mapping(s)`,
          source: configPath,
        },
      ],
      integrationId: "expo",
      plan: {
        catalog: {
          id: "expo-native-metadata",
          kind: "document-json",
          localeFiles,
          rootDir: ".",
          unitId: "native-metadata",
        },
        messageFormat: {
          from: "@ai-translate/message-formats",
          name: "applePrintfMessageFormat",
        },
        sourceLocale,
        targetLocales,
        warnings,
      },
    };
  },
  displayName: "Expo native locale JSON",
  id: "expo",
});
