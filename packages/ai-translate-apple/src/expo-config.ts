/** A deliberately small static subset of Expo's JavaScript configuration.
 * Never import a config: plugins and environment-dependent exports execute code. */
type Literal =
  | string
  | number
  | boolean
  | null
  | Literal[]
  | { [key: string]: Literal };

const TOKENS =
  /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]/gu;

function quoted(token: string): string | undefined {
  if (token[0] === '"') {
    try {
      return JSON.parse(token) as string;
    } catch {
      return undefined;
    }
  }
  const quote = token[0];
  return (quote === "'" || quote === "`") &&
    token.at(-1) === quote &&
    !token.includes("\\") &&
    !token.includes("${")
    ? token.slice(1, -1)
    : undefined;
}

export function readStaticExpoConfig(
  source: string,
): Record<string, unknown> | null {
  const tokens = [...source.matchAll(TOKENS)]
    .map(([token]) => token)
    .filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  if (tokens.length > 100_000) {
    return null;
  }
  let cursor = 0;
  const take = (expected: string): boolean => {
    if (tokens[cursor] !== expected) {
      return false;
    }
    cursor += 1;
    return true;
  };
  function value(depth = 0): Literal | undefined {
    if (depth > 64) {
      return undefined;
    }
    if (take("{")) {
      const pairs: [string, Literal][] = [];
      const keys = new Set<string>();
      while (!take("}")) {
        const token = tokens[cursor++] ?? "";
        const key =
          quoted(token) ??
          (/^[A-Za-z_$][\w$]*$/u.test(token) ? token : undefined);
        if (key === undefined || keys.has(key) || !take(":")) {
          return undefined;
        }
        const next = value(depth + 1);
        if (next === undefined) {
          return undefined;
        }
        keys.add(key);
        pairs.push([key, next]);
        if (!take(",")) {
          if (!take("}")) {
            return undefined;
          }
          break;
        }
      }
      return Object.fromEntries(pairs);
    }
    if (take("[")) {
      const items: Literal[] = [];
      while (!take("]")) {
        const next = value(depth + 1);
        if (next === undefined) {
          return undefined;
        }
        items.push(next);
        if (!take(",")) {
          if (!take("]")) {
            return undefined;
          }
          break;
        }
      }
      return items;
    }
    const token = tokens[cursor++] ?? "";
    const string = quoted(token);
    if (string !== undefined) {
      return string;
    }
    if (token === "true" || token === "false") {
      return token === "true";
    }
    if (token === "null") {
      return null;
    }
    return /^-?\d/u.test(token) && Number.isFinite(Number(token))
      ? Number(token)
      : undefined;
  }

  // Type-only imports cannot supply values or mutate the exported object.
  while (take("import")) {
    if (!take("type")) {
      return null;
    }
    while (cursor < tokens.length && !take(";")) {
      cursor += 1;
    }
  }
  let exportedName: string | undefined;
  if (take("const")) {
    exportedName = tokens[cursor++];
    if (
      exportedName === undefined ||
      !/^[A-Za-z_$][\w$]*$/u.test(exportedName)
    ) {
      return null;
    }
    if (take(":")) {
      if (!/^[A-Za-z_$][\w$]*$/u.test(tokens[cursor++] ?? "")) {
        return null;
      }
    }
    if (!take("=")) {
      return null;
    }
  } else if (
    !(take("export") && take("default")) &&
    !(take("module") && take(".") && take("exports") && take("="))
  ) {
    return null;
  }
  const result = value();
  if (take("as") && !take("const")) {
    return null;
  }
  if (
    take("satisfies") &&
    !/^[A-Za-z_$][\w$]*$/u.test(tokens[cursor++] ?? "")
  ) {
    return null;
  }
  take(";");
  if (exportedName !== undefined) {
    if (!take("export") || !take("default") || !take(exportedName)) {
      return null;
    }
    take(";");
  }
  return cursor === tokens.length &&
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result)
    ? result
    : null;
}
