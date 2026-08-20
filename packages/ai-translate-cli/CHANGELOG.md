# @ai-translate/cli

## 0.2.0

### Minor Changes

- [`cdd21a6`](https://github.com/thiagoperes/ai-translate/commit/cdd21a6b623b9288d85d583296ca6b4338bff443) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Replace the lock-file importer with a generic `adopt` command that seeds state from translations already on disk.

  `importStartupV1State` and `ai-translate migrate-state --from startup-v1` are gone, replaced by `adoptExistingTranslations` and `ai-translate adopt`. The old importer required a `{ hashes, overrides }` lock file from one specific prior pipeline, and then made no real use of it: the hash comparison was a ternary with the same value in both branches, so the hashes were dead weight, and any entry whose target differed from its source was already classified as `legacy-unknown` regardless. Adoption now reads the catalogs and nothing else, which means it works as a migration path off any prior tool rather than off one bespoke format.

  Two behaviour fixes come with it:

  - A source string with no target text, or an empty one, is no longer recorded as synced. The old importer fell back to the source string and wrote a completed entry, which stranded the key: the next sync saw satisfied state and never translated it.
  - Adopted entries are always `legacy-unknown`. Catalogs carry no evidence of whether their text is human or machine, so claiming `generated` overstated what was known. `legacyOriginPolicy` decides what a later sync does with them, and still defaults to `preserve`.

  `adopt` reports `adopted`, `identicalToSource`, and `untranslated` counts, supports `--dry-run`, and takes `--identical-to-source <adopt|skip>` for target text byte-identical to its source — ambiguous between a correct translation that happens to match and a placeholder left by a pipeline that backfilled missing keys with the source string. It defaults to `adopt`.

- [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Narrow the staged transaction's state to the locales a run actually writes.

  Every CLI write is wrapped in a staged transaction that loaded the whole corpus
  and cloned it several times on the way to a commit, so a one-locale sync carried
  fourteen other locales through every copy. The scope a sync already computes is
  now threaded through the transaction to the store, which merges rather than
  replaces, leaving untouched locales on disk.

  On a 246k-record, 15-locale corpus a one-locale run peaks at 743 MB instead of
  1,616 MB (−54%); four locales at 1,014 MB (−37%). Full runs are deliberately
  left unscoped: naming every locale saves nothing, and a scoped save preserves
  what it does not mention, so a locale dropped from the config would never be
  pruned. `bench/transaction.bench.mjs` measures this and runs under `pnpm bench`.

  The scope is recorded in the transaction journal, which moves to version 2 when
  and only when one is present. Recovery usually happens in a later process, and a
  reader that ignored the scope would restore a narrowed snapshot as the whole
  corpus and delete every locale the run never loaded — so unscoped transactions
  stay on version 1 and remain readable in both directions across an upgrade,
  while a scoped journal an older client cannot understand is rejected outright
  rather than applied broadly.

  Stores opt in by declaring the `SCOPED_SAVE_STATE_STORE` marker; anything
  without it keeps the whole-corpus contract, where omitting an entry means
  deleting it.

- [`10723fc`](https://github.com/thiagoperes/ai-translate/commit/10723fc6443171641cb201f9f3d5ca2a5d7bb407) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Stop rejecting correct translations, and make semantic preservation free by default.

  **Token parity no longer checks order.** `validateTokenParity` compared protected tokens by position, so any translation that moved a placeholder to satisfy target grammar failed. On a 82,335-pair production corpus, five of the seven reported failures were correct translations — German fronting `{{count}}` ahead of `{{language}}`, Irish reordering a parenthetical, Lithuanian moving `{{method}}` before `{{time}}`.

  The consequence was worse than a noisy report. With the default `candidateRepairAttempts: 0`, a failed candidate is discarded and the entry marked `failed`, leaving the target absent and the string falling back to source at runtime. Because the model keeps producing the same correct text, it failed identically on every subsequent sync — a permanent hole that never healed.

  Parity now compares tokens as a set and ignores position entirely. Placeholders resolve by name and indexed tags by index, so order never carried meaning.

  **Severity now follows runtime impact.** Placeholder and tag differences stay errors: a dropped one loses data, an invented one renders as literal braces. Markdown differences — emphasis, inline code, link destinations, formatting-scope expansion — are warnings that record and ship. The same corpus now reports one error, a genuine dropped `{{last4}}`, plus two warnings.

  Issue codes `token-count-mismatch` and `token-order-mismatch` are replaced by `token-missing` and `token-unexpected`, which name the differing token. Update any `validation.existingIssueSeverity` keys.

  Two boundaries stay strict, because there the tokens are masked placeholders the model must echo back verbatim rather than translator judgement: Markdoc write-time structure checks, where the value is spliced into an AST and markdown _is_ structure, and provider-level protected-text restoration.

  **`semanticAuditExecution` now defaults to `generator-self-check`.** Self-check folds semantic preservation into the translation request for zero extra provider calls, against one or two calls per 50-entry batch for a separate replay. Set `"provider"` to keep a second model's independent opinion.

  Flipping that default surfaced two places where the mode was standing in for "attestations are required", both of which would have silently degraded every existing setup:

  - The candidate cache switches to the optional `getAttested`/`putAttested` pair in self-check mode, and both call sites bail out silently when a store does not implement them. Every ordinary `get`/`put` store would have stopped caching with no error and a doubled model bill.
  - Segment-delta reuse disabled itself in self-check mode.

  Both now key off whether semantic audits are actually configured. With none, nothing can demand an attestation, so caching and delta reuse behave exactly as before.

  Generated entries no longer carry an empty `validationAudits: {}`, which self-check would otherwise have written onto every entry in the state file.

### Patch Changes

- Updated dependencies [[`cdd21a6`](https://github.com/thiagoperes/ai-translate/commit/cdd21a6b623b9288d85d583296ca6b4338bff443), [`11ba29d`](https://github.com/thiagoperes/ai-translate/commit/11ba29d663e87e86d40b4030b2f8f22b110ff4a1), [`d62127f`](https://github.com/thiagoperes/ai-translate/commit/d62127f7c6d7745765d13cf8f051203846c1ea3c), [`3da86ad`](https://github.com/thiagoperes/ai-translate/commit/3da86ad9998bce8a9bedf681a3c2875bff38a72d), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e), [`10723fc`](https://github.com/thiagoperes/ai-translate/commit/10723fc6443171641cb201f9f3d5ca2a5d7bb407), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e)]:
  - @ai-translate/fs-json@0.2.0
  - @ai-translate/core@0.2.0
  - @ai-translate/next@0.1.1

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
