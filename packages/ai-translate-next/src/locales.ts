/**
 * Directory and file names that sit alongside locale folders in real projects
 * and would otherwise be mistaken for locales.
 */
const NON_LOCALE_NAMES = new Set([
  "_default",
  "assets",
  "common",
  "default",
  "dist",
  "img",
  "images",
  "node_modules",
  "shared",
  "static",
  "templates",
]);

/**
 * Whether a directory or file name is a BCP 47 language tag.
 *
 * `Intl.getCanonicalLocales` is the authority, but it is more permissive than
 * we want: it accepts `templates` as a language subtag because any three-to-
 * eight letter string is syntactically valid. Requiring either a two-or-three
 * letter primary subtag or a region/script suffix rejects the folder names that
 * actually collide in practice.
 */
export function isLocaleTag(name: string): boolean {
  if (NON_LOCALE_NAMES.has(name.toLowerCase())) {
    return false;
  }

  const [primary = ""] = name.split("-");
  if (!/^[A-Za-z]{2,3}$/.test(primary)) {
    return false;
  }

  try {
    return Intl.getCanonicalLocales(name).length === 1;
  } catch {
    return false;
  }
}

export function localesFromNames(names: readonly string[]): readonly string[] {
  return names
    .filter((name) => isLocaleTag(name))
    .toSorted((left, right) => left.localeCompare(right));
}

export function localesFromJsonFileNames(names: readonly string[]): readonly string[] {
  return localesFromNames(
    names.filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/u, "")),
  );
}

/**
 * Reads a string array assigned to `name` in a config module, without executing
 * it.
 *
 * Detection must not import project code — a Next.js config pulls in plugins,
 * environment access, and arbitrary side effects — so the array is recovered
 * textually. Anything computed rather than written out literally is simply not
 * found, and the caller falls back to directory discovery.
 */
export function readStringArrayLiteral(source: string, name: string): readonly string[] | null {
  const pattern = new RegExp(`${name}\\s*[:=]\\s*\\[([^\\]]*)\\]`, "u");
  const match = pattern.exec(source);
  if (match?.[1] === undefined) {
    return null;
  }

  const values = [...match[1].matchAll(/["'`]([^"'`]+)["'`]/gu)].map((entry) => entry[1] ?? "");
  return values.length === 0 ? null : values;
}

/** Reads a string assigned to `name`, with the same textual-only caveat. */
export function readStringLiteral(source: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*[:=]\\s*["'\`]([^"'\`]+)["'\`]`, "u");
  return pattern.exec(source)?.[1] ?? null;
}

/**
 * Splits a locale list into the source and the rest.
 *
 * Falls back to `en` when present, then to the first locale, because a project
 * that never states a default almost always authors in English.
 */
export function resolveSourceLocale(
  locales: readonly string[],
  declared: string | null,
): string | null {
  if (declared !== null && locales.includes(declared)) {
    return declared;
  }
  if (locales.includes("en")) {
    return "en";
  }
  return locales[0] ?? null;
}
