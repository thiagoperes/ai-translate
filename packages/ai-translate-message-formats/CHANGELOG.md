# @ai-translate/message-formats

## 0.1.0

### Minor Changes

- [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Add drop-in Next.js support: auto-discovery, message formats, and locale-aware plurals.

  `ai-translate init` detects a project's localization setup — next-intl or i18next — infers the message layout, locale list, and source locale, and writes an `ai-translate.config.ts` for it. Detection is read-only and never imports project code, and `@ai-translate/next` exposes the same engine as data, including a `defineIntegration` hook for setups the toolkit does not recognise.

  `@ai-translate/message-formats` adds ICU and i18next message formats. A message format decides what structural parity means for one string, so ICU plural and select branches are now compared against the target locale's own CLDR categories rather than the source's, and i18next `$t()` nesting keys are checked for accidental translation.

  Suffix-keyed plurals now work across locales. A `CatalogAdapter` may implement `localizeSourceDocument` to reshape the source for one target locale, and the JSON catalogs use it to give each locale the plural forms its grammar requires — seeded from the nearest source form and then translated like any other new entry. Forms the source declares are always preserved, so i18next's `_zero` and English's `one` survive into locales that have no grammatical use for them. Entries may also declare `meta.structureGroup`, which lets a plural family of differing cardinality compare equal during structural validation.

### Patch Changes

- Updated dependencies [[`2236243`](https://github.com/thiagoperes/ai-translate/commit/223624367f1870fcd0a8dcd753cbfa57b06c4c43), [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c), [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48)]:
  - @ai-translate/core@0.1.0
