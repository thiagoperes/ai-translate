import type {
  MarkdownDestinationToken,
  MarkdownFormattingToken,
  MarkdownInlineCodeToken,
  MarkdownOpenerToken,
  PlaceholderToken,
  TagToken,
  Token,
  TranslationValidationIssue,
} from "./types";

const TOKEN_PATTERN =
  /\]\((?:<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)|<\/?(?:[A-Za-z][\w:-]*|\d+)(?:\s+[^<>]*?)?\s*\/?>|\{\{[^{}]+\}\}|\{[^{}]+\}/g;

interface ProtectedMatch {
  index: number;
  token:
    | MarkdownDestinationToken
    | MarkdownFormattingToken
    | MarkdownInlineCodeToken
    | MarkdownOpenerToken
    | PlaceholderToken
    | TagToken;
}

function parseTagToken(raw: string): TagToken {
  const isClose = raw.startsWith("</");
  const isSelf = raw.endsWith("/>");
  const inner = raw.slice(isClose ? 2 : 1, raw.length - (isSelf ? 2 : 1)).trim();
  const [name = ""] = inner.split(/\s+/, 1);

  return {
    flavor: /^\d+$/.test(name) ? "slot" : /^[A-Z]/.test(name) ? "component" : "html",
    name,
    raw,
    tagKind: isClose ? "close" : isSelf ? "self" : "open",
    type: "tag",
  };
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findMarkdownOpener(
  value: string,
  destinationIndex: number,
): { index: number; token: MarkdownOpenerToken } | undefined {
  let nestedBrackets = 0;
  for (let cursor = destinationIndex - 1; cursor >= 0; cursor -= 1) {
    const character = value[cursor];
    if (isEscaped(value, cursor)) {
      continue;
    }
    if (character === "]") {
      nestedBrackets += 1;
      continue;
    }
    if (character !== "[") {
      continue;
    }
    if (nestedBrackets > 0) {
      nestedBrackets -= 1;
      continue;
    }

    const image = cursor > 0 && value[cursor - 1] === "!" && !isEscaped(value, cursor - 1);
    return {
      index: image ? cursor - 1 : cursor,
      token: {
        raw: image ? "![" : "[",
        type: "markdown-opener",
      },
    };
  }

  return undefined;
}

function findInlineCodeMatches(value: string): ProtectedMatch[] {
  const matches: ProtectedMatch[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "`" || isEscaped(value, index)) {
      continue;
    }

    let delimiterLength = 1;
    while (value[index + delimiterLength] === "`") {
      delimiterLength += 1;
    }
    let closeIndex = -1;
    for (let cursor = index + delimiterLength; cursor < value.length; cursor += 1) {
      if (value[cursor] !== "`") {
        continue;
      }
      let closeLength = 1;
      while (value[cursor + closeLength] === "`") {
        closeLength += 1;
      }
      if (closeLength === delimiterLength) {
        closeIndex = cursor;
        break;
      }
      cursor += closeLength - 1;
    }
    if (closeIndex === -1 || closeIndex === index + delimiterLength) {
      index += delimiterLength - 1;
      continue;
    }

    const end = closeIndex + delimiterLength;
    matches.push({
      index,
      token: {
        raw: value.slice(index, end),
        type: "markdown-inline-code",
      },
    });
    index = end - 1;
  }

  return matches;
}

function isWithinMatch(index: number, matches: readonly ProtectedMatch[]): boolean {
  return matches.some(
    (match) => index >= match.index && index < match.index + match.token.raw.length,
  );
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/u.test(character);
}

function isPunctuation(character: string | undefined): boolean {
  return character !== undefined && /[\p{P}\p{S}]/u.test(character);
}

function formattingFlavor(raw: MarkdownFormattingToken["raw"]): MarkdownFormattingToken["flavor"] {
  return raw.length === 1 ? "emphasis" : raw.length === 2 ? "strong" : "strong-emphasis";
}

function findFormattingMatches(
  value: string,
  inlineCodeMatches: readonly ProtectedMatch[],
): ProtectedMatch[] {
  interface DelimiterRun {
    canClose: boolean;
    canOpen: boolean;
    index: number;
    marker: "*" | "_";
    raw: MarkdownFormattingToken["raw"];
  }

  const runs: DelimiterRun[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const marker = value[index];
    if (
      (marker !== "*" && marker !== "_") ||
      isEscaped(value, index) ||
      isWithinMatch(index, inlineCodeMatches)
    ) {
      continue;
    }

    let length = 1;
    while (value[index + length] === marker && length < 3) {
      length += 1;
    }
    if (value[index + length] === marker) {
      while (value[index + length] === marker) {
        length += 1;
      }
      index += length - 1;
      continue;
    }

    const previous = value[index - 1];
    const next = value[index + length];
    const leftFlanking =
      !isWhitespace(next) && (!isPunctuation(next) || isWhitespace(previous) || isPunctuation(previous));
    const rightFlanking =
      !isWhitespace(previous) &&
      (!isPunctuation(previous) || isWhitespace(next) || isPunctuation(next));
    const raw = marker.repeat(length) as MarkdownFormattingToken["raw"];
    runs.push({
      canClose:
        marker === "_" ? rightFlanking && (!leftFlanking || isPunctuation(next)) : rightFlanking,
      canOpen:
        marker === "_" ? leftFlanking && (!rightFlanking || isPunctuation(previous)) : leftFlanking,
      index,
      marker,
      raw,
    });
    index += length - 1;
  }

  const openers = new Map<"*" | "_", { remaining: number; run: DelimiterRun }[]>();
  const paired = new Set<DelimiterRun>();
  for (const run of runs) {
    const candidates = openers.get(run.marker) ?? [];
    let remaining = run.raw.length;
    if (run.canClose) {
      while (remaining > 0 && candidates.length > 0) {
        const opener = candidates[candidates.length - 1] as {
          remaining: number;
          run: DelimiterRun;
        };
        const consumed = Math.min(remaining, opener.remaining);
        opener.remaining -= consumed;
        remaining -= consumed;
        paired.add(opener.run);
        paired.add(run);
        if (opener.remaining === 0) {
          candidates.pop();
        }
      }
    }
    if (run.canOpen && remaining > 0) {
      candidates.push({ remaining, run });
    }
    openers.set(run.marker, candidates);
  }

  return runs
    .filter((run) => paired.has(run))
    .map((run) => ({
      index: run.index,
      token: {
        flavor: formattingFlavor(run.raw),
        raw: run.raw,
        type: "markdown-formatting",
      },
    }));
}

export function tokenizeText(value: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  const matches = [...value.matchAll(TOKEN_PATTERN)];
  const markdownOpeners = matches.flatMap((match) => {
    const raw = match[0];
    if (!raw.startsWith("](")) {
      return [];
    }
    const opener = findMarkdownOpener(value, match.index);
    return opener === undefined ? [] : [opener];
  });
  const inlineCodeMatches = findInlineCodeMatches(value);
  const protectedMatches: ProtectedMatch[] = [
    ...matches.map((match): ProtectedMatch => {
      const raw = match[0];
      return {
        index: match.index,
        token: raw.startsWith("](")
          ? { raw, type: "markdown-destination" }
          : raw.startsWith("{{")
            ? {
                name: raw.slice(2, -2).trim(),
                raw,
                syntax: "double-brace",
                type: "placeholder",
              }
            : raw.startsWith("{")
              ? {
                  name: raw.slice(1, -1).trim(),
                  raw,
                  syntax: "single-brace",
                  type: "placeholder",
                }
              : parseTagToken(raw),
      };
    }),
    ...markdownOpeners.map(({ index, token }) => ({ index, token })),
    ...inlineCodeMatches,
    ...findFormattingMatches(value, inlineCodeMatches),
  ].toSorted((left, right) => left.index - right.index);

  for (const match of protectedMatches) {
    const { raw } = match.token;
    const index = match.index;

    if (index < lastIndex) {
      continue;
    }

    if (index > lastIndex) {
      tokens.push({
        raw: value.slice(lastIndex, index),
        type: "text",
      });
    }

    tokens.push(match.token);

    lastIndex = index + raw.length;
  }

  if (lastIndex < value.length) {
    tokens.push({
      raw: value.slice(lastIndex),
      type: "text",
    });
  }

  return tokens.length === 0
    ? [
        {
          raw: value,
          type: "text",
        },
      ]
    : tokens;
}

type ProtectedToken =
  | MarkdownDestinationToken
  | MarkdownFormattingToken
  | MarkdownInlineCodeToken
  | MarkdownOpenerToken
  | PlaceholderToken
  | TagToken;

function toSignature(token: ProtectedToken): string {
  if (
    token.type === "markdown-destination" ||
    token.type === "markdown-inline-code" ||
    token.type === "markdown-opener"
  ) {
    return `${token.type}:${token.raw}`;
  }

  if (token.type === "markdown-formatting") {
    return `${token.type}:${token.flavor}:${token.raw}`;
  }

  if (token.type === "placeholder") {
    return `${token.type}:${token.syntax}:${token.raw}`;
  }

  return `${token.type}:${token.tagKind}:${token.flavor}:${token.raw}`;
}

interface MarkdownFormattingScope {
  signature: string;
  visibleCharacters: number;
}

function visibleTokenCharacters(token: Token): number {
  if (
    token.type === "markdown-formatting" ||
    token.type === "markdown-destination" ||
    token.type === "markdown-opener" ||
    token.type === "tag"
  ) {
    return 0;
  }
  return [...token.raw].length;
}

function markdownFormattingScopes(tokens: readonly Token[]): readonly MarkdownFormattingScope[] {
  const scopes: MarkdownFormattingScope[] = [];
  const openScopes: { signature: string; visibleStart: number }[] = [];
  let visibleCharacters = 0;

  for (const token of tokens) {
    if (token.type !== "markdown-formatting") {
      visibleCharacters += visibleTokenCharacters(token);
      continue;
    }

    const signature = toSignature(token);
    const currentScope = openScopes.at(-1);
    if (currentScope?.signature === signature) {
      openScopes.pop();
      scopes.push({
        signature,
        visibleCharacters: visibleCharacters - currentScope.visibleStart,
      });
      continue;
    }

    openScopes.push({ signature, visibleStart: visibleCharacters });
  }

  return scopes;
}

function validateMarkdownFormattingScopes(
  sourceTokens: readonly Token[],
  targetTokens: readonly Token[],
): readonly TranslationValidationIssue[] {
  const sourceScopes = markdownFormattingScopes(sourceTokens);
  const targetScopes = markdownFormattingScopes(targetTokens);

  return sourceScopes.flatMap((sourceScope, index) => {
    const targetScope = targetScopes[index];
    if (targetScope === undefined || sourceScope.signature !== targetScope.signature) {
      return [];
    }

    const catastrophicExpansionThreshold = Math.max(
      160,
      sourceScope.visibleCharacters + 100,
      sourceScope.visibleCharacters * 5,
    );
    return targetScope.visibleCharacters > catastrophicExpansionThreshold
      ? [
          {
            code: "token-formatting-scope-expansion",
            message:
              `Markdown formatting scope ${String(index + 1)} expanded from ` +
              `${String(sourceScope.visibleCharacters)} to ${String(targetScope.visibleCharacters)} visible character(s).`,
            severity: "error" as const,
          },
        ]
      : [];
  });
}

export function validateTokenParity(
  sourceText: string,
  targetText: string,
): readonly TranslationValidationIssue[] {
  const allSourceTokens = tokenizeText(sourceText);
  const allTargetTokens = tokenizeText(targetText);
  const sourceTokens = allSourceTokens.filter(
    (token): token is ProtectedToken => token.type !== "text",
  );
  const targetTokens = allTargetTokens.filter(
    (token): token is ProtectedToken => token.type !== "text",
  );

  if (sourceTokens.length !== targetTokens.length) {
    return [
      {
        code: "token-count-mismatch",
        message: `Expected ${String(sourceTokens.length)} non-text token(s) but received ${String(targetTokens.length)}.`,
        severity: "error",
      },
    ];
  }

  const issues: TranslationValidationIssue[] = [];
  sourceTokens.forEach((token, index) => {
    const targetToken = targetTokens[index] as ProtectedToken;
    const position = index + 1;

    if (toSignature(token) !== toSignature(targetToken)) {
      issues.push({
        code: "token-order-mismatch",
        message: `Token "${token.raw}" does not match "${targetToken.raw}" at position ${String(position)}.`,
        severity: "error",
      });
    }
  });

  return issues.length === 0
    ? validateMarkdownFormattingScopes(allSourceTokens, allTargetTokens)
    : issues;
}
