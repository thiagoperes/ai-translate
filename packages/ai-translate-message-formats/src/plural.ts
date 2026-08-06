/**
 * The plural primitives live in core so that storage adapters can expand keys
 * without depending on a format package. They are re-exported here because
 * users configuring a format expect to find them alongside it.
 */
export {
  PLURAL_CATEGORIES,
  isPluralCategory,
  pluralCategoriesFor,
  seedPluralCategory,
  sortPluralCategories,
} from "@ai-translate/core/plural";
export type {
  PluralCategory,
  PluralKeyGroup,
  PluralKeyStrategy,
  PluralType,
} from "@ai-translate/core/plural";
