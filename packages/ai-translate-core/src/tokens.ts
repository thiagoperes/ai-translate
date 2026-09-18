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

// Tag attributes cannot cross angle brackets. A single whitespace prefix
// avoids overlapping repetitions on unterminated tags such as "<9\t\t...".
const TOKEN_PATTERN =
  /<\/?(?:[A-Za-z][\w:-]*|\d+)(?:\s[^<>]*)?\/?>|\{\{[^{}]+\}\}|\{[^{}]+\}/gu;

interface RawMatch {
  index: number;
  raw: string;
}

function nextBoundary(boundaries: readonly number[], start: number): number | undefined {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((boundaries[middle] as number) < start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return boundaries[low];
}

function findMarkdownDestinations(value: string): { index: number; end: number }[] {
  let index = value.indexOf("](");
  if (index === -1) {
    return [];
  }

  // Index terminators once. Repeated unterminated ](< or ](! prefixes used to
  // make the regex rescan the remaining string at every possible opener.
  const angles: number[] = [];
  const bare: number[] = [];
  const doubleQuotes: number[] = [];
  const singleQuotes: number[] = [];
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character === ">" || character === "\n") {
      angles.push(cursor);
    }
    if (character === ")" || isWhitespace(character)) {
      bare.push(cursor);
    }
    if (character === '"' || character === "\n") {
      doubleQuotes.push(cursor);
    }
    if (character === "'" || character === "\n") {
      singleQuotes.push(cursor);
    }
  }

  const suffixes = new Map<number, number | undefined>();
  const suffixEnd = (start: number): number | undefined => {
    if (value[start] === ")") {
      return start + 1;
    }
    if (suffixes.has(start)) {
      return suffixes.get(start);
    }
    let cursor = start;
    while (cursor < value.length && isWhitespace(value[cursor])) {
      cursor += 1;
    }
    const quote = value[cursor];
    let end: number | undefined;
    if (cursor > start && (quote === '"' || quote === "'")) {
      const close = nextBoundary(quote === '"' ? doubleQuotes : singleQuotes, cursor + 1);
      if (close !== undefined && value[close] === quote && value[close + 1] === ")") {
        end = close + 2;
      }
    }
    suffixes.set(start, end);
    return end;
  };

  const matches: { index: number; end: number }[] = [];
  while (index !== -1) {
    const start = index + 2;
    let end: number | undefined;
    if (value[start] === "<") {
      const close = nextBoundary(angles, start + 1);
      if (close !== undefined && close > start + 1 && value[close] === ">") {
        end = suffixEnd(close + 1);
      }
    }
    if (end === undefined) {
      const close = nextBoundary(bare, start);
      if (close !== undefined && close > start) {
        end = suffixEnd(close);
      }
    }
    if (end !== undefined) {matches.push({ index, end });}
    index = value.indexOf("](", start);
  }
  return matches;
}

function findRawMatches(value: string): RawMatch[] {
  const candidates = [
    ...[...value.matchAll(TOKEN_PATTERN)].map((match) => ({
      index: match.index,
      end: match.index + match[0].length,
    })),
    ...findMarkdownDestinations(value),
  ].toSorted((left, right) => left.index - right.index);
  let end = 0;
  return candidates
    .filter((match) => {
      if (match.index < end) {
        return false;
      }
      end = match.end;
      return true;
    })
    .map((match) => ({ index: match.index, raw: value.slice(match.index, match.end) }));
}

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
  const [name = ""] = inner.split(/\s+/u, 1);

  return {
    flavor: /^\d+$/u.test(name) ? "slot" : /^[A-Z]/u.test(name) ? "component" : "html",
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

function findMarkdownOpeners(value: string, matches: readonly RawMatch[]): ProtectedMatch[] {
  const brackets: number[] = [];
  const openers: ProtectedMatch[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (!match.raw.startsWith("](")) {
      continue;
    }
    // Walk the prefix only once, even for a long sequence of destinations
    // without labels. Searching backwards independently was quadratic too.
    for (; cursor < match.index; cursor += 1) {
      const character = value[cursor];
      if ((character === "[" || character === "]") && !isEscaped(value, cursor)) {
        if (character === "[") {
          brackets.push(cursor);
        } else {
          brackets.pop();
        }
      }
    }
    const opener = brackets.at(-1);
    if (opener !== undefined) {
      const image = opener > 0 && value[opener - 1] === "!" && !isEscaped(value, opener - 1);
      openers.push({
        index: image ? opener - 1 : opener,
        token: { raw: image ? "![" : "[", type: "markdown-opener" },
      });
    }
  }
  return openers;
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
  const matches = findRawMatches(value);
  const markdownOpeners = findMarkdownOpeners(value, matches);
  const inlineCodeMatches = findInlineCodeMatches(value);
  const protectedMatches: ProtectedMatch[] = [
    ...matches.map((match): ProtectedMatch => {
      const { raw } = match;
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
  // Code points, not graphemes: this width feeds the formatting-scope
  // comparison between source and target, where both sides are measured the
  // same way, so a consistent unit matters more than a human-visible one.
  // oxlint-disable-next-line typescript/no-misused-spread
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
            severity: "warning" as const,
          },
        ]
      : [];
  });
}

/**
 * Placeholders and tags bind the message to the application: a placeholder the
 * code never supplies renders as literal `{{braces}}` to the user, and a tag
 * the runtime cannot map drops or breaks the element it wraps. Markdown is
 * presentation, so losing emphasis is worth reporting but not worth discarding
 * an otherwise correct translation over.
 */
function isStructuralToken(token: ProtectedToken): boolean {
  return token.type === "placeholder" || token.type === "tag";
}

function tokenParityIssue(
  token: ProtectedToken,
  kind: "missing" | "unexpected",
): TranslationValidationIssue {
  return {
    code: kind === "missing" ? "token-missing" : "token-unexpected",
    message:
      kind === "missing"
        ? `Source token "${token.raw}" is absent from the translation.`
        : `Translation adds token "${token.raw}", which the source does not contain.`,
    severity: isStructuralToken(token) ? "error" : "warning",
  };
}

/**
 * Compares the *set* of protected tokens, deliberately ignoring their order.
 *
 * Order carries no meaning for either kind of binding this validates.
 * Placeholders resolve by name and indexed tags by index, so a translation is
 * free to move them wherever the target grammar needs them — German fronting
 * `{{count}}` ahead of `{{language}}`, or Irish reordering a parenthetical, is
 * correct output, not a defect. Enforcing position rejected those translations
 * outright and left the string untranslated in perpetuity, because the model
 * kept producing the same correct text on every retry.
 */
export function validateTokenParity(
  sourceText: string,
  targetText: string,
): readonly TranslationValidationIssue[] {
  const allSourceTokens = tokenizeText(sourceText);
  const allTargetTokens = tokenizeText(targetText);

  const unmatchedTargets = new Map<string, ProtectedToken[]>();
  for (const token of allTargetTokens) {
    if (token.type === "text") {
      continue;
    }
    const signature = toSignature(token);
    const bucket = unmatchedTargets.get(signature);
    if (bucket) {
      bucket.push(token);
    } else {
      unmatchedTargets.set(signature, [token]);
    }
  }

  const issues: TranslationValidationIssue[] = [];
  for (const token of allSourceTokens) {
    if (token.type === "text") {
      continue;
    }
    const bucket = unmatchedTargets.get(toSignature(token));
    if (bucket && bucket.length > 0) {
      bucket.pop();
      continue;
    }
    issues.push(tokenParityIssue(token, "missing"));
  }

  for (const bucket of unmatchedTargets.values()) {
    for (const token of bucket) {
      issues.push(tokenParityIssue(token, "unexpected"));
    }
  }

  // Scope comparison pairs formatting runs by position, so it only means
  // anything once both sides agree on which formatting tokens exist.
  const formattingBalanced = !issues.some((issue) => issue.severity === "warning");
  return formattingBalanced
    ? [...issues, ...validateMarkdownFormattingScopes(allSourceTokens, allTargetTokens)]
    : issues;
}
