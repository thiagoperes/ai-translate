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
  if (!/^[A-Za-z]{2,3}$/u.test(primary)) {
    return false;
  }

  try {
    return Intl.getCanonicalLocales(name).length === 1;
  } catch {
    return false;
  }
}

export function localesFromNames(names: readonly string[]): readonly string[] {
  return [...new Set(names)]
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
  const value = readLiteralAssignment(source, name);
  return Array.isArray(value) && value.length > 0 ? value : null;
}

/** Reads a string assigned to `name`, with the same textual-only caveat. */
export function readStringLiteral(source: string, name: string): string | null {
  const value = readLiteralAssignment(source, name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface LiteralToken {
  end: number;
  raw: string;
  start: number;
}

// Keep comments, quoted strings, templates, and regular expressions opaque.
// This is deliberately a conservative lexer, not a JavaScript evaluator. In
// particular, escaped strings and interpolated templates fall back to disk.
const CONFIG_TOKENS = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|`(?:\\[\s\S]|[^`\\])*`?|\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\\r\n[])+\/[a-z]*|[$\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*|===|==|=>|[^\s]/gu;

function stringToken(token: LiteralToken | undefined): string | null {
  const raw = token?.raw ?? "";
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || raw.at(-1) !== quote || raw.length < 2) {
    return null;
  }
  return raw.includes("\\") || raw.includes("${") ? null : raw.slice(1, -1);
}

function readLiteralAssignment(source: string, name: string): string | readonly string[] | null {
  const tokens: LiteralToken[] = [];
  for (const match of source.matchAll(CONFIG_TOKENS)) {
    const raw = match[0];
    if (raw.startsWith("//") || raw.startsWith("/*")) {
      continue;
    }
    // Nested templates need a full parser. Refuse the module rather than
    // accidentally interpreting an expression inside one as configuration.
    if (raw.startsWith("`") && raw.includes("${")) {
      return null;
    }
    tokens.push({ end: match.index + raw.length, raw, start: match.index });
  }

  let found: string | readonly string[] | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.raw !== name && stringToken(token) !== name) {
      continue;
    }
    const separator = tokens[index + 1]?.raw;
    if ((separator !== ":" && separator !== "=") || tokens[index - 1]?.raw === ".") {
      continue;
    }
    if (separator === "=" && (token?.raw !== name ||
        (index > 0 && !["const", "let", "var"].includes(tokens[index - 1]?.raw ?? "")))) {
      // A function/destructuring default is conditional on its runtime input.
      continue;
    }
    // Multiple declarations are ambiguous without evaluating module scope.
    if (found !== null) {
      return null;
    }
    let end = index + 2;
    if (separator === ":" && ["const", "let", "var"].includes(tokens[index - 1]?.raw ?? "")) {
      // A variable's TypeScript annotation does not change its initializer.
      // Complex object/function annotations remain outside this small subset.
      while (tokens[end] !== undefined && !["=", ";", "{", "}", "("].includes(tokens[end]?.raw ?? "")) {
        end += 1;
      }
      if (tokens[end]?.raw !== "=") {
        return null;
      }
      end += 1;
    }
    if (tokens[end]?.raw === "[") {
      const values: string[] = [];
      end += 1;
      while (tokens[end]?.raw !== "]") {
        const value = stringToken(tokens[end]);
        if (value === null) {
          return null;
        }
        values.push(value);
        end += 1;
        if (tokens[end]?.raw !== ",") {
          break;
        }
        end += 1;
      }
      if (tokens[end]?.raw !== "]") {
        return null;
      }
      found = values;
    } else {
      found = stringToken(tokens[end]);
      if (found === null) {
        return null;
      }
    }
    if (tokens[end + 1]?.raw === "as" && tokens[end + 2]?.raw === "const") {
      end += 2;
    }
    const next = tokens[end + 1];
    const previous = tokens[end];
    if (next !== undefined && ![",", ";", "}", ")"].includes(next.raw)) {
      // Support automatic semicolon insertion between declarations, without
      // accepting computed suffixes such as .filter(), +, or conditional ?:.
      if (previous === undefined || !/\r|\n/u.test(source.slice(previous.end, next.start)) ||
          !["const", "export", "let", "var"].includes(next.raw)) {
        return null;
      }
    }
  }
  return found;
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
