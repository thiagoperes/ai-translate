---
"@ai-translate/message-formats": minor
"@ai-translate/provider-openai": minor
"@ai-translate/keystatic": minor
"@ai-translate/markdoc": minor
"@ai-translate/fs-json": minor
"@ai-translate/core": minor
"@ai-translate/html": minor
"@ai-translate/next": minor
"@ai-translate/cli": minor
---

Add drop-in Next.js support: auto-discovery, message formats, and locale-aware plurals.

`ai-translate init` detects a project's localization setup — next-intl or i18next — infers the message layout, locale list, and source locale, and writes an `ai-translate.config.ts` for it. Detection is read-only and never imports project code, and `@ai-translate/next` exposes the same engine as data, including a `defineIntegration` hook for setups the toolkit does not recognise.

`@ai-translate/message-formats` adds ICU and i18next message formats. A message format decides what structural parity means for one string, so ICU plural and select branches are now compared against the target locale's own CLDR categories rather than the source's, and i18next `$t()` nesting keys are checked for accidental translation.

Suffix-keyed plurals now work across locales. A `CatalogAdapter` may implement `localizeSourceDocument` to reshape the source for one target locale, and the JSON catalogs use it to give each locale the plural forms its grammar requires — seeded from the nearest source form and then translated like any other new entry. Forms the source declares are always preserved, so i18next's `_zero` and English's `one` survive into locales that have no grammatical use for them. Entries may also declare `meta.structureGroup`, which lets a plural family of differing cardinality compare equal during structural validation.
