import { TYPE, parse } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import type { MessageFormat, MessageParityArgs } from "@ai-translate/core/message-format";
import type { Token, TranslationValidationIssue } from "@ai-translate/core/types";

import { PLURAL_CATEGORIES, pluralCategoriesFor } from "./plural";

export const ICU_MESSAGE_FORMAT_ID = "icu";

type ArgumentKind = "argument" | "date" | "number" | "plural" | "select" | "selectordinal" | "time";

interface SelectorBlock {
  /** Literal `=N` selectors, which ICU matches before category keywords. */
  exact: ReadonlySet<string>;
  keywords: ReadonlySet<string>;
  kind: "plural" | "select" | "selectordinal";
  name: string;
}

interface MessageShape {
  arguments: ReadonlyMap<string, ArgumentKind>;
  selectors: readonly SelectorBlock[];
  tags: readonly string[];
}

const PLURAL_KEYWORDS = new Set<string>(PLURAL_CATEGORIES);

function argumentKind(element: MessageFormatElement): ArgumentKind | undefined {
  switch (element.type) {
    case TYPE.argument: {
      return "argument";
    }
    case TYPE.number: {
      return "number";
    }
    case TYPE.date: {
      return "date";
    }
    case TYPE.time: {
      return "time";
    }
    case TYPE.select: {
      return "select";
    }
    case TYPE.plural: {
      return element.pluralType === "ordinal" ? "selectordinal" : "plural";
    }
    default: {
      return undefined;
    }
  }
}

function collectShape(elements: readonly MessageFormatElement[]): MessageShape {
  const argumentsByName = new Map<string, ArgumentKind>();
  const selectors: SelectorBlock[] = [];
  const tags: string[] = [];

  const walk = (nodes: readonly MessageFormatElement[]): void => {
    for (const node of nodes) {
      const kind = argumentKind(node);
      if (kind !== undefined && "value" in node && typeof node.value === "string") {
        argumentsByName.set(node.value, kind);
      }

      if (node.type === TYPE.tag) {
        tags.push(node.value);
        walk(node.children);
        continue;
      }

      if (node.type === TYPE.select || node.type === TYPE.plural) {
        const exact = new Set<string>();
        const keywords = new Set<string>();
        for (const [selector, option] of Object.entries(node.options)) {
          if (selector.startsWith("=")) {
            exact.add(selector);
          } else {
            keywords.add(selector);
          }
          walk(option.value);
        }
        selectors.push({
          exact,
          keywords,
          kind: kind === "select" ? "select" : kind === "selectordinal" ? "selectordinal" : "plural",
          name: node.value,
        });
      }
    }
  };

  walk(elements);
  return {
    arguments: argumentsByName,
    selectors,
    // Sorted so parity compares a multiset rather than an ordering. ICU tags
    // legitimately move within a sentence when word order changes.
    tags: tags.toSorted((left, right) => left.localeCompare(right)),
  };
}

function tokenizeElements(elements: readonly MessageFormatElement[], tokens: Token[]): void {
  for (const node of elements) {
    switch (node.type) {
      case TYPE.literal: {
        tokens.push({ raw: node.value, type: "text" });
        break;
      }
      case TYPE.pound: {
        tokens.push({ name: "#", raw: "#", syntax: "single-brace", type: "placeholder" });
        break;
      }
      case TYPE.tag: {
        tokens.push({
          flavor: /^[A-Z]/u.test(node.value) ? "component" : "html",
          name: node.value,
          raw: `<${node.value}>`,
          tagKind: "open",
          type: "tag",
        });
        tokenizeElements(node.children, tokens);
        tokens.push({
          flavor: /^[A-Z]/u.test(node.value) ? "component" : "html",
          name: node.value,
          raw: `</${node.value}>`,
          tagKind: "close",
          type: "tag",
        });
        break;
      }
      case TYPE.select:
      case TYPE.plural: {
        tokens.push({
          name: node.value,
          raw: `{${node.value}}`,
          syntax: "single-brace",
          type: "placeholder",
        });
        for (const option of Object.values(node.options)) {
          tokenizeElements(option.value, tokens);
        }
        break;
      }
      default: {
        if ("value" in node && typeof node.value === "string") {
          tokens.push({
            name: node.value,
            raw: `{${node.value}}`,
            syntax: "single-brace",
            type: "placeholder",
          });
        }
        break;
      }
    }
  }
}

function parseOrNull(value: string): readonly MessageFormatElement[] | null {
  try {
    // `requiresOtherClause` is enforced separately so a missing `other` is
    // reported as a category issue rather than an opaque parse failure.
    return parse(value, { requiresOtherClause: false });
  } catch {
    return null;
  }
}

function describeList(values: readonly string[]): string {
  return values.toSorted((left, right) => left.localeCompare(right)).join(", ");
}

function validateSelectorBlock(args: {
  issues: TranslationValidationIssue[];
  locale: string;
  source: SelectorBlock;
  target: SelectorBlock;
}): void {
  const { issues, locale, source, target } = args;

  if (target.kind === "select") {
    // A `select` is keyed on application values (a role, a plan name), not on
    // grammar, so its arms must match the source exactly.
    const missing = [...source.keywords].filter((keyword) => !target.keywords.has(keyword));
    const unexpected = [...target.keywords].filter((keyword) => !source.keywords.has(keyword));
    if (missing.length > 0 || unexpected.length > 0) {
      issues.push({
        code: "icu-select-option-mismatch",
        message:
          `Select "${source.name}" must keep the source options. ` +
          `Missing: ${describeList(missing) || "none"}. Unexpected: ${describeList(unexpected) || "none"}.`,
        severity: "error",
      });
    }
    return;
  }

  const required = pluralCategoriesFor(
    locale,
    target.kind === "selectordinal" ? "ordinal" : "cardinal",
  );
  const missing = required.filter((category) => !target.keywords.has(category));
  if (missing.length > 0) {
    issues.push({
      code: "icu-plural-category-missing",
      message:
        `Plural "${source.name}" is missing the ${describeList(missing)} form(s) required for ` +
        `locale "${locale}". Required: ${required.join(", ")}.`,
      severity: "error",
    });
  }

  const invalid = [...target.keywords].filter(
    (keyword) => !PLURAL_KEYWORDS.has(keyword) || !required.includes(keyword as never),
  );
  if (invalid.length > 0) {
    issues.push({
      code: "icu-plural-category-unexpected",
      message:
        `Plural "${source.name}" declares ${describeList(invalid)}, which locale "${locale}" ` +
        `does not use. Allowed: ${required.join(", ")}.`,
      severity: "error",
    });
  }

  const inventedExact = [...target.exact].filter((selector) => !source.exact.has(selector));
  if (inventedExact.length > 0) {
    issues.push({
      code: "icu-plural-exact-unexpected",
      message: `Plural "${source.name}" introduces exact selector(s) ${describeList(inventedExact)} that the source does not have.`,
      severity: "error",
    });
  }

  const droppedExact = [...source.exact].filter((selector) => !target.exact.has(selector));
  if (droppedExact.length > 0) {
    // A dropped `=0 {No items}` still renders through `other`, so the message
    // works; it just loses a hand-written special case. Worth surfacing, not
    // worth failing a sync over.
    issues.push({
      code: "icu-plural-exact-dropped",
      message: `Plural "${source.name}" drops exact selector(s) ${describeList(droppedExact)} present in the source.`,
      severity: "warning",
    });
  }
}

function validateIcuParity(args: MessageParityArgs): readonly TranslationValidationIssue[] {
  const sourceElements = parseOrNull(args.sourceText);
  if (sourceElements === null) {
    // The source is authored by hand and validated separately; refusing to
    // judge the target against an unparseable source avoids a cascade of
    // misleading failures on every locale.
    return [];
  }

  const targetElements = parseOrNull(args.targetText);
  if (targetElements === null) {
    return [
      {
        code: "icu-parse-error",
        message: "The translation is not valid ICU MessageFormat syntax.",
        severity: "error",
      },
    ];
  }

  const source = collectShape(sourceElements);
  const target = collectShape(targetElements);
  const issues: TranslationValidationIssue[] = [];

  const missingArguments = [...source.arguments.keys()].filter((name) => !target.arguments.has(name));
  if (missingArguments.length > 0) {
    issues.push({
      code: "icu-argument-missing",
      message: `The translation drops argument(s) ${describeList(missingArguments)}.`,
      severity: "error",
    });
  }

  const unexpectedArguments = [...target.arguments.keys()].filter(
    (name) => !source.arguments.has(name),
  );
  if (unexpectedArguments.length > 0) {
    issues.push({
      code: "icu-argument-unexpected",
      message: `The translation introduces argument(s) ${describeList(unexpectedArguments)} that the source does not have.`,
      severity: "error",
    });
  }

  for (const [name, kind] of source.arguments) {
    const targetKind = target.arguments.get(name);
    if (targetKind !== undefined && targetKind !== kind) {
      issues.push({
        code: "icu-argument-type-mismatch",
        message: `Argument "${name}" is a ${kind} in the source but a ${targetKind} in the translation.`,
        severity: "error",
      });
    }
  }

  if (source.tags.join("\u0000") !== target.tags.join("\u0000")) {
    issues.push({
      code: "icu-tag-mismatch",
      message:
        `Expected rich-text tag(s) ${describeList(source.tags) || "none"} but received ` +
        `${describeList(target.tags) || "none"}.`,
      severity: "error",
    });
  }

  for (const sourceSelector of source.selectors) {
    const targetSelector = target.selectors.find(
      (candidate) => candidate.name === sourceSelector.name && candidate.kind === sourceSelector.kind,
    );
    if (targetSelector !== undefined) {
      validateSelectorBlock({ issues, locale: args.locale, source: sourceSelector, target: targetSelector });
    }
  }

  return issues;
}

/**
 * ICU MessageFormat, as used by next-intl, react-intl, and Lingui.
 *
 * The reason this cannot be validated with the flat tokenizer: a plural lives
 * *inside* the message, and the number of arms is a property of the target
 * language, not of the source. English `{n, plural, one {} other {}}` must
 * become four arms in Polish and one in Japanese. Comparing token sequences
 * would reject every correct translation into a language whose plural rules
 * differ from the source's.
 *
 * So parity here is structural: same arguments, same rich-text tags, same
 * `select` options, and plural arms that match the target locale's CLDR
 * categories rather than the source's.
 */
export function createIcuMessageFormat(options: { id?: string } = {}): MessageFormat {
  return {
    id: options.id ?? ICU_MESSAGE_FORMAT_ID,
    tokenize(value) {
      const elements = parseOrNull(value);
      if (elements === null) {
        return [{ raw: value, type: "text" }];
      }
      const tokens: Token[] = [];
      tokenizeElements(elements, tokens);
      return tokens.length === 0 ? [{ raw: value, type: "text" }] : tokens;
    },
    validateParity: validateIcuParity,
  };
}

export const icuMessageFormat: MessageFormat = createIcuMessageFormat();
