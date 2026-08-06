# @ai-translate/message-formats

Message format adapters for [ai-translate](https://github.com/thiagoperes/ai-translate). A message format decides how a single string encodes variables, markup, and plural selection — and therefore what "the translation preserved the source's structure" means for that string.

Without one, every message is compared as plain text with `{token}`-style placeholder parity. That is right for a marketing headline and wrong for `{count, plural, one {# item} other {# items}}`.

## Install

```bash
npm install @ai-translate/message-formats
```

## ICU MessageFormat

For `next-intl`, `react-intl`, and anything else that parses messages with ICU.

```ts
import { createLocalizedJsonDocument } from "@ai-translate/fs-json";
import { icuMessageFormat } from "@ai-translate/message-formats";

createLocalizedJsonDocument({
  messageFormat: icuMessageFormat,
  rootDir: "messages",
  sourceLocale: "en",
  unitId: "messages",
});
```

Parity is checked structurally rather than textually:

- every argument in the source is present in the target, with the same type
- tags (`<b>…</b>`) match in name and nesting
- plural and select branches match the target locale's own CLDR categories, not the source's

That last point is what makes ICU work across locales. English `{count, plural, one {…} other {…}}` translated into Polish is *expected* to gain `few` and `many`; a Polish translation that keeps only two branches is the error, and a Japanese translation that keeps only `other` is correct.

## i18next

For `i18next`, `react-i18next`, and `next-i18next`.

```ts
import { createNamespaceJsonCatalog } from "@ai-translate/fs-json";
import { i18nextMessageFormat, i18nextPluralKeys } from "@ai-translate/message-formats";

createNamespaceJsonCatalog({
  messageFormat: i18nextMessageFormat,
  plurals: i18nextPluralKeys,
  rootDir: "public/locales",
  sourceLocale: "en",
});
```

Two separate concerns, because i18next splits them:

`i18nextMessageFormat` validates a single message — `{{variable}}` interpolation, HTML and indexed tags, and `$t(namespace:key)` nesting. Keys inside `$t()` are references, not prose, so a translated key is reported rather than accepted.

`i18nextPluralKeys` describes how plurals are spelled *across sibling keys* (`items_one`, `items_other`). Pass it as `plurals` and target files gain the forms their locale requires, seeded from the nearest source form and then translated like any other new entry:

```jsonc
// public/locales/en/inventory.json          // public/locales/pl/inventory.json
{                                            {
  "items_one":   "{{count}} item",             "items_one":   "…",
  "items_other": "{{count}} items"             "items_few":   "…",
}                                              "items_many":  "…",
                                               "items_other": "…"
                                             }
```

Forms the source declares are always kept, even where the target locale has no grammatical use for them. Japanese needs only `other`, but deleting `items_one` would leave the English source with a pointer the Japanese file lacks. Surplus keys are inert at runtime; absent ones are bugs. The same rule preserves i18next's `_zero`, which is a deliberate extra form outside CLDR.

## Writing your own

```ts
import type { MessageFormat } from "@ai-translate/core/message-format";

export const myFormat: MessageFormat = {
  id: "my-format",
  tokenize: (value) => [{ raw: value, type: "text" }],
  validateParity: ({ locale, sourceText, targetText }) => [],
};
```

Pass it to a catalog as `messageFormat` and it registers itself. Ids must be unique across a config, and they are part of the validation cache key, so changing what an id means invalidates the translations validated under it.

## License

MIT
