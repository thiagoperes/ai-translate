import { plainMessageFormat } from "@ai-translate/core/message-format";
import type { MessageFormat, MessageParityArgs } from "@ai-translate/core/message-format";
import { PLURAL_CATEGORIES, pluralCategoriesFor } from "@ai-translate/core/plural";
import type {
  PluralCategory,
  PluralKeyGroup,
  PluralKeyStrategy,
} from "@ai-translate/core/plural";
import type { TranslationValidationIssue } from "@ai-translate/core/types";

export const I18NEXT_MESSAGE_FORMAT_ID = "i18next";

/** i18next nesting: `$t(common:greeting)` inlines another key at runtime. The
 * argument is a key, never prose, so it must survive translation verbatim. */
const NESTING_PATTERN = /\$t\([^()]*\)/gu;

function nestingCalls(value: string): readonly string[] {
  return [...value.matchAll(NESTING_PATTERN)]
    .map((match) => match[0])
    .toSorted((left, right) => left.localeCompare(right));
}

function validateI18nextParity(args: MessageParityArgs): readonly TranslationValidationIssue[] {
  const base = plainMessageFormat.validateParity(args);
  const source = nestingCalls(args.sourceText);
  const target = nestingCalls(args.targetText);

  return source.join("\u0000") === target.join("\u0000")
    ? base
    : [
        ...base,
        {
          code: "i18next-nesting-mismatch",
          message:
            `Expected nesting call(s) ${source.join(", ") || "none"} but received ` +
            `${target.join(", ") || "none"}. The key inside $t() must not be translated.`,
          severity: "error" as const,
        },
      ];
}

/**
 * The i18next JSON format: `{{variable}}` interpolation, HTML and `<0>`-indexed
 * Trans placeholders, and `$t()` nesting.
 *
 * Plurals are deliberately *not* handled here. Unlike ICU, i18next expresses
 * them as sibling keys (`items_one`, `items_other`) rather than inside the
 * message, so they are a catalog-shape concern — see {@link i18nextPluralKeys}.
 */
export function createI18nextMessageFormat(options: { id?: string } = {}): MessageFormat {
  return {
    id: options.id ?? I18NEXT_MESSAGE_FORMAT_ID,
    tokenize: (text) => plainMessageFormat.tokenize(text),
    validateParity: validateI18nextParity,
  };
}

export const i18nextMessageFormat: MessageFormat = createI18nextMessageFormat();

const SUFFIX_PATTERN = new RegExp(`^(.*)_(${PLURAL_CATEGORIES.join("|")})$`, "u");

function splitKey(key: string): { base: string; category: PluralCategory } | null {
  const match = SUFFIX_PATTERN.exec(key);
  if (match === null) {
    return null;
  }
  const [, base = "", category = ""] = match;
  return base.length === 0 ? null : { base, category: category as PluralCategory };
}

/**
 * i18next v4 suffixes: `key_one`, `key_other`, and so on.
 *
 * Grouping is deliberately conservative. A key ending in `_other` is only a
 * plural form when a sibling shares its base under a *different* category —
 * otherwise `miscellaneous_other` in a list of merchant categories would be
 * mistaken for the plural of `miscellaneous`, and syncing would rewrite an
 * enum value into grammar.
 */
export function createI18nextPluralKeyStrategy(
  options: { id?: string } = {},
): PluralKeyStrategy {
  return {
    id: options.id ?? "i18next-v4",
    categoriesFor: (locale) => pluralCategoriesFor(locale),
    formatKey: (base, category) => `${base}_${category}`,
    groupKeys(keys): readonly PluralKeyGroup[] {
      const candidates = new Map<string, Map<PluralCategory, string>>();
      for (const key of keys) {
        const split = splitKey(key);
        if (split === null) {
          continue;
        }
        const members = candidates.get(split.base) ?? new Map<PluralCategory, string>();
        members.set(split.category, key);
        candidates.set(split.base, members);
      }

      return [...candidates.entries()]
        .filter(([, members]) => members.size > 1)
        .map(([base, members]) => ({ base, members }))
        .toSorted((left, right) => left.base.localeCompare(right.base));
    },
  };
}

export const i18nextPluralKeys: PluralKeyStrategy = createI18nextPluralKeyStrategy();
