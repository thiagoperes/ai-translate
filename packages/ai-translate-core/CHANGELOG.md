# @ai-translate/core

## 0.1.0

### Minor Changes

- [`2236243`](https://github.com/thiagoperes/ai-translate/commit/223624367f1870fcd0a8dcd753cbfa57b06c4c43) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Cut state-loading memory by scoping loads to the locales a command actually needs.

  `SyncStateStore.load()` now accepts an optional `{ locales }` scope. The sharded
  JSON store honours it while unpacking, so a single-locale check no longer
  materialises the whole corpus, and it pools the decoded low-cardinality fields
  (generation revisions, context digests, timestamps) that previously allocated
  one string per record.

  On a 246k-record corpus a full load drops from 137 MB to 89 MB and a
  single-locale load to 7.9 MB; peak RSS for `ai-translate check --locale de`
  drops from ~550 MB to ~340 MB.

  The scope is an optimisation, not a filter contract: a store may ignore it and
  return a superset, so callers that depend on the narrowing must still project
  the result. A scoped snapshot is read-only — passing one to `save()` would
  delete every entry the scope excluded.

- [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Add drop-in Next.js support: auto-discovery, message formats, and locale-aware plurals.

  `ai-translate init` detects a project's localization setup — next-intl or i18next — infers the message layout, locale list, and source locale, and writes an `ai-translate.config.ts` for it. Detection is read-only and never imports project code, and `@ai-translate/next` exposes the same engine as data, including a `defineIntegration` hook for setups the toolkit does not recognise.

  `@ai-translate/message-formats` adds ICU and i18next message formats. A message format decides what structural parity means for one string, so ICU plural and select branches are now compared against the target locale's own CLDR categories rather than the source's, and i18next `$t()` nesting keys are checked for accidental translation.

  Suffix-keyed plurals now work across locales. A `CatalogAdapter` may implement `localizeSourceDocument` to reshape the source for one target locale, and the JSON catalogs use it to give each locale the plural forms its grammar requires — seeded from the nearest source form and then translated like any other new entry. Forms the source declares are always preserved, so i18next's `_zero` and English's `one` survive into locales that have no grammatical use for them. Entries may also declare `meta.structureGroup`, which lets a plural family of differing cardinality compare equal during structural validation.

- [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Prune target keys that no longer exist in the source when a sync commits.

  Staged writes previously reused the state of the partially written file for
  every JSON format, so a key renamed or removed in the source stayed in every
  localized document forever. `check` then reported the leftovers as
  `extra-target-entry` and the only remedy was editing localized files by hand.

  The reconciled document is now authoritative for the write. Formats that pack
  several logical documents into one file implement the new optional
  `CatalogAdapter.mergeStagedState` hook to fold their own reconciled unit into
  the staged file, which keeps sibling units written earlier in the same
  transaction while still dropping removed keys from their own unit.
