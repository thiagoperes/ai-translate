import { describe, expect, it } from "vitest";

import { localesFromNames, readStringArrayLiteral, readStringLiteral } from "../src/locales";

describe("conservative config literal discovery", () => {
  it.each([
    'export const locales = ["en", "fr"]',
    "export const locales = ['en', 'fr',] as const;",
    'defineRouting({ "locales": ["en", "fr"] })',
    "defineRouting({ 'locales': [`en`, `fr`] })",
    'const locales /* separator */ = ["en", /* not an entry: "de" */ "fr"]',
    'const locales = ["en", // ignored: "de", ]\n "fr"]',
    'const locales = ["en", "fr"]\nexport const defaultLocale = "en"',
    'const ignored = "locales: [\'de\']"; const locales = ["en", "fr"]',
    'const ignored = /locales: ["de"]/; const locales = ["en", "fr"]',
    '// locales: ["de"]\n/* locales: ["nl"] */\nconst locales = ["en", "fr"]',
    'const preferred_locales = ["de"]; const locales = ["en", "fr"]',
    'const $locales = ["de"]; const locales = ["en", "fr"]',
    'export const locales: readonly string[] = ["en", "fr"]',
    'export const locales: Array<"en" | "fr"> = ["en", "fr"]',
  ])("reads only a complete literal array: %s", (source) => {
    expect(readStringArrayLiteral(source, "locales")).toEqual(["en", "fr"]);
  });

  it.each([
    'const locales = ["en", language]',
    'const locales = ["en", 42]',
    'const locales = ["en", null]',
    'const locales = ["en", ...others]',
    'const locales = ["en", ["fr"]]',
    'const locales = ["en", , "fr"]',
    'const locales = ["en" "fr"]',
    'const locales = ["en", enabled ? "fr" : "de"]',
    'const locales = ["en", `fr-${region}`]',
    'const locales = ["en", "f" + "r"]',
    'const locales = ["en", "fr"',
    'const locales = ["en", "fr"] .filter(enabled)',
    'const locales = ["en", "fr"].concat(other)',
    'const locales = ["en", "fr"] || fallback',
    'const locales = ["en", "fr"] as const + other',
    'const locales = compute("en", "fr")',
    'const locales = ["en", "fr"]; const locales = ["en", "de"]',
    'const locales = ["en"]; function nested() { const locales = ["fr"]; }',
    'const locales = ["en", "f\\x72"]',
    '// locales: ["en", "fr"]',
    '/* locales: ["en", "fr"]',
    'const text = "locales: [\'en\', \'fr\']"',
    'const text = `locales: ["en", "fr"]`',
    'const text = `nested ${`locales = ["en", "fr"]`}`',
    'const pattern = /locales: ["en", "fr"]/',
    'const some_locales = ["en", "fr"]',
    'config.locales = ["en", "fr"]',
    'locales == ["en", "fr"]',
    'locales === ["en", "fr"]',
    'function config(locales = ["en", "fr"]) {}',
    'const { locales = ["en", "fr"] } = runtimeConfig;',
    '"locales" = ["en", "fr"]',
    'declare const locales: readonly string[];',
    'const locales: readonly string[] = ["en", ...other]',
    'const locales: readonly string[]',
    'const locales = []',
  ])("refuses partial, computed, misleading, or ambiguous arrays: %s", (source) => {
    expect(readStringArrayLiteral(source, "locales")).toBeNull();
  });

  it.each([
    'const defaultLocale = "fr";',
    "const defaultLocale = 'fr' as const;",
    'config({ "defaultLocale": "fr" })',
    'defaultLocale /* description */ : `fr`,',
    'let defaultLocale = "fr"\nconst other = "en"',
    '// defaultLocale: "de"\n/* defaultLocale: "en" */\nconst defaultLocale = "fr"',
    'const fallback_defaultLocale = "de"; const defaultLocale = "fr";',
    'let pattern = /defaultLocale: "en"/; const defaultLocale = "fr"',
    'const defaultLocale: Locale = "fr";',
  ])("reads complete source locale literals: %s", (source) => {
    expect(readStringLiteral(source, "defaultLocale")).toBe("fr");
  });

  it.each([
    'const defaultLocale = "fr" + region',
    'const defaultLocale = "fr".toLowerCase()',
    'const defaultLocale = "fr" || fallback',
    'const defaultLocale = enabled ? "fr" : "en"',
    'const defaultLocale = `fr-${region}`',
    'const defaultLocale = "f\\u0072"',
    'const defaultLocale = "fr',
    'const defaultLocale = ""',
    'const defaultLocale = ["fr"]',
    'const defaultLocale = "fr"; const defaultLocale = "en"',
    'const text = `defaultLocale: "fr"`',
    'const pattern = /defaultLocale: "fr"/',
    'const preferred_defaultLocale = "fr"',
    'function config(defaultLocale = "fr") {}',
    'const { defaultLocale = "fr" } = runtimeConfig;',
  ])("does not guess computed source locales: %s", (source) => {
    expect(readStringLiteral(source, "defaultLocale")).toBeNull();
  });

  it("deduplicates locale declarations without changing authored directory spelling", () => {
    expect(localesFromNames(["fr", "en", "default", "fr", "pt-BR", "en"]))
      .toEqual(["en", "fr", "pt-BR"]);
  });
});
