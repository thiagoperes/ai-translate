# @ai-translate/cli

## 0.1.0

### Minor Changes

- [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Add drop-in Next.js support: auto-discovery, message formats, and locale-aware plurals.

  `ai-translate init` detects a project's localization setup — next-intl or i18next — infers the message layout, locale list, and source locale, and writes an `ai-translate.config.ts` for it. Detection is read-only and never imports project code, and `@ai-translate/next` exposes the same engine as data, including a `defineIntegration` hook for setups the toolkit does not recognise.

  `@ai-translate/message-formats` adds ICU and i18next message formats. A message format decides what structural parity means for one string, so ICU plural and select branches are now compared against the target locale's own CLDR categories rather than the source's, and i18next `$t()` nesting keys are checked for accidental translation.

  Suffix-keyed plurals now work across locales. A `CatalogAdapter` may implement `localizeSourceDocument` to reshape the source for one target locale, and the JSON catalogs use it to give each locale the plural forms its grammar requires — seeded from the nearest source form and then translated like any other new entry. Forms the source declares are always preserved, so i18next's `_zero` and English's `one` survive into locales that have no grammatical use for them. Entries may also declare `meta.structureGroup`, which lets a plural family of differing cardinality compare equal during structural validation.

- [`18f220e`](https://github.com/thiagoperes/ai-translate/commit/18f220e63f5ce99ffa4197d52dfc28b396fdd2fc) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Make the model vendor a choice rather than a dependency.

  The translation and semantic-audit engine — prompt assembly, batching, key
  aliasing, response decoding, the repair loop, self-check attestation — now
  lives in `@ai-translate/provider-core` and talks to exactly one vendor
  interface, `StructuredCompletionTransport.complete`.

  `@ai-translate/provider-openai` keeps its API and becomes a thin transport over
  that engine. The new `@ai-translate/provider-ai-sdk` is a second transport over
  the same engine, so any AI SDK model works — Anthropic, Google, Bedrock, Groq,
  xAI, a gateway, or a local model — for both translation and semantic audits:

  ```ts
  import { anthropic } from "@ai-sdk/anthropic";
  import { createAiSdkTranslationProvider } from "@ai-translate/provider-ai-sdk";

  provider: createAiSdkTranslationProvider({
    model: anthropic("claude-sonnet-4"),
  });
  ```

  `ai-translate init` can generate either wiring: `--provider ai-sdk`,
  `--provider-package @ai-sdk/anthropic`, and `--model <id>` pick the provider
  package, the vendor factory, and the model written into the config.

  The output contract material is now a vendor-neutral JSON Schema rather than an
  OpenAI response format object, so the translation and semantic-audit contract
  revisions change and previously accepted translations are re-verified on the
  next sync. Semantic audits also gained the wall-clock deadline the translation
  path already had, so a transport that ignores its own timeout can no longer
  hang a run.

  Both provider packages require Node 22 or newer, matching the `openai` and `ai`
  SDKs they wrap. Everything else still runs on Node 20.19.

### Patch Changes

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

- Updated dependencies [[`2236243`](https://github.com/thiagoperes/ai-translate/commit/223624367f1870fcd0a8dcd753cbfa57b06c4c43), [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c), [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48), [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48), [`9cb4e88`](https://github.com/thiagoperes/ai-translate/commit/9cb4e88b323c6c6831c630e116e255c276bd2fce), [`18f220e`](https://github.com/thiagoperes/ai-translate/commit/18f220e63f5ce99ffa4197d52dfc28b396fdd2fc)]:
  - @ai-translate/fs-json@0.1.0
  - @ai-translate/core@0.1.0
  - @ai-translate/next@0.1.0
