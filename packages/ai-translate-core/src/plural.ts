/**
 * The six CLDR plural categories, in the canonical order the Unicode plural
 * rules table lists them. Ordering matters because it decides the order
 * expanded keys are written to disk, and an unstable order would churn every
 * localized file on every sync.
 */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

export type PluralType = "cardinal" | "ordinal";

const CATEGORY_RANK = new Map<string, number>(
  PLURAL_CATEGORIES.map((category, index) => [category, index]),
);

const categoriesByLocale = new Map<string, readonly PluralCategory[]>();

export function isPluralCategory(value: string): value is PluralCategory {
  return CATEGORY_RANK.has(value);
}

/** Orders an arbitrary category set canonically and drops anything unknown. */
export function sortPluralCategories(
  categories: readonly string[],
): readonly PluralCategory[] {
  return categories
    .filter(isPluralCategory)
    .toSorted((left, right) => (CATEGORY_RANK.get(left) ?? 0) - (CATEGORY_RANK.get(right) ?? 0));
}

function readCategories(locale: string, type: PluralType): readonly PluralCategory[] {
  try {
    return sortPluralCategories(
      new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories,
    );
  } catch {
    return ["other"];
  }
}

/**
 * The plural categories a locale actually distinguishes, straight from ICU via
 * `Intl.PluralRules`.
 *
 * English yields `one, other`; Polish `one, few, many, other`; Japanese only
 * `other`. This is the number of forms a translator — or the model — has to
 * produce, and it is why a source language cannot dictate the shape of a
 * target catalog.
 *
 * Unknown or malformed locale tags fall back to `["other"]` rather than
 * throwing: a bad tag should surface as a locale configuration problem
 * elsewhere, not as a crash deep inside validation.
 */
export function pluralCategoriesFor(
  locale: string,
  type: PluralType = "cardinal",
): readonly PluralCategory[] {
  const cacheKey = `${type}:${locale}`;
  const cached = categoriesByLocale.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const categories = readCategories(locale, type);
  // `other` is mandatory in every ICU plural block and is the fallback arm for
  // every runtime, so never hand back a set without it.
  const resolved: readonly PluralCategory[] = categories.includes("other")
    ? categories
    : [...categories, "other"];
  categoriesByLocale.set(cacheKey, resolved);
  return resolved;
}

/**
 * Picks the source arm that should seed a target arm.
 *
 * When English (`one`, `other`) seeds Polish (`one`, `few`, `many`, `other`),
 * `one` seeds from `one` and the rest seed from `other`. Seeding is only a
 * starting point for the model — the entry is still marked as needing
 * translation — but starting from the closest form produces better output than
 * starting from an empty string.
 */
export function seedPluralCategory(
  target: PluralCategory,
  available: readonly PluralCategory[],
): PluralCategory {
  return available.includes(target) ? target : "other";
}

export interface PluralKeyGroup {
  /** The key without its category suffix. */
  base: string;
  /** Present categories mapped to the full key that carries them. */
  members: ReadonlyMap<PluralCategory, string>;
}

/**
 * How a catalog format encodes plural forms as sibling keys.
 *
 * This is the extension point for suffix-keyed ecosystems such as i18next,
 * where the *set of keys* differs per locale. ICU-style formats need nothing
 * here because their arms live inside a single message and are handled by
 * {@link import("./message-format").MessageFormat} instead.
 */
export interface PluralKeyStrategy {
  readonly id: string;
  categoriesFor(locale: string): readonly PluralCategory[];
  formatKey(base: string, category: PluralCategory): string;
  /**
   * Groups the keys of one JSON object level into plural families. Only
   * siblings are considered, because a plural family is by definition a set of
   * keys at the same level.
   */
  groupKeys(keys: readonly string[]): readonly PluralKeyGroup[];
}
