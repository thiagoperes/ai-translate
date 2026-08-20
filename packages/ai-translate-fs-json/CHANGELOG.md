# @ai-translate/fs-json

## 0.2.0

### Minor Changes

- [`cdd21a6`](https://github.com/thiagoperes/ai-translate/commit/cdd21a6b623b9288d85d583296ca6b4338bff443) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Replace the lock-file importer with a generic `adopt` command that seeds state from translations already on disk.

  `importStartupV1State` and `ai-translate migrate-state --from startup-v1` are gone, replaced by `adoptExistingTranslations` and `ai-translate adopt`. The old importer required a `{ hashes, overrides }` lock file from one specific prior pipeline, and then made no real use of it: the hash comparison was a ternary with the same value in both branches, so the hashes were dead weight, and any entry whose target differed from its source was already classified as `legacy-unknown` regardless. Adoption now reads the catalogs and nothing else, which means it works as a migration path off any prior tool rather than off one bespoke format.

  Two behaviour fixes come with it:

  - A source string with no target text, or an empty one, is no longer recorded as synced. The old importer fell back to the source string and wrote a completed entry, which stranded the key: the next sync saw satisfied state and never translated it.
  - Adopted entries are always `legacy-unknown`. Catalogs carry no evidence of whether their text is human or machine, so claiming `generated` overstated what was known. `legacyOriginPolicy` decides what a later sync does with them, and still defaults to `preserve`.

  `adopt` reports `adopted`, `identicalToSource`, and `untranslated` counts, supports `--dry-run`, and takes `--identical-to-source <adopt|skip>` for target text byte-identical to its source — ambiguous between a correct translation that happens to match and a placeholder left by a pipeline that backfilled missing keys with the source string. It defaults to `adopt`.

- [`3da86ad`](https://github.com/thiagoperes/ai-translate/commit/3da86ad9998bce8a9bedf681a3c2875bff38a72d) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Let a locale-scoped sync stop loading the whole corpus

  Scoped loading already existed but was read-only, because saving means "this is
  everything" and anything the snapshot omits is deleted. A sync therefore had to
  materialise every locale even when it was only translating one, purely so it
  could write the rest back untouched.

  The sharded store now merges a scoped save instead of replacing: entries outside
  the declared locales are left alone rather than treated as deletions, and a
  shard is removed only once nothing survives in it. Shards are keyed by unit
  rather than by locale, so this is per-record and not just per-file — repacking a
  shard from a one-locale snapshot would otherwise drop the other locales inside
  it while leaving the file in place.

  Stores opt in with the `SCOPED_SAVE_STATE_STORE` marker; anything without it
  keeps the whole-corpus contract, since a store that merely ignored the new
  argument would delete every excluded locale. On a 15-locale, 82,000-entry
  corpus a single-locale sync now reads 5,489 state records instead of 82,335.

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

### Patch Changes

- [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Turn on type-aware linting and fix what it found.

  The config already asked for `no-floating-promises`, `no-misused-promises`,
  `no-confusing-void-expression` and `require-await`, but oxlint skips rules that
  need type information unless it is run with `--type-aware` and can find
  `oxlint-tsgolint`. Neither was in place, so those four rules had been inert.
  Both are now wired into every `lint` script, along with a set of type-aware
  rules that were clean on the first run and now hold that line: `await-thenable`,
  `no-base-to-string`, `restrict-template-expressions`, `restrict-plus-operands`,
  `prefer-readonly`, `use-unknown-in-catch-callback-variable`, and others.

  Two real defects came out of it:

  - The semantic-audit repair note was assembled as `text + reason ? a : b`.
    Because `+` binds tighter than `?:`, that parsed as `(text + reason) ? a : b`,
    whose left side is a non-empty string and therefore always truthy. Every
    repair prompt lost both the requirement description and the "preserve the
    English meaning" instruction, and printed `undefined` as the diagnostic reason
    when there was none. Now assembled as a single template, with a test that pins
    the note in full.
  - Four call sites detached a method from an object supplied by the caller — a
    candidate-cache store, a message format, the Markdoc runtime — and then called
    it unbound, which drops `this` for any implementation written as a class.
    These now call through their receiver.

  Rules deliberately left off, with the reasoning recorded in `.oxlintrc.json`:
  `no-unnecessary-condition` (reads concurrent state mutated across an `await` as
  always-false, and treats runtime guards over unverified JSON as dead code),
  `no-unsafe-type-assertion` (the assertions it flags are the correct idiom at
  this toolkit's dynamic boundaries), `unicorn/no-array-callback-reference`
  (wrapping `filter(isFoo)` in an arrow discards the type predicate), and
  `no-loop-func` (a `var`-era rule that here reports only safe code).

- Updated dependencies [[`11ba29d`](https://github.com/thiagoperes/ai-translate/commit/11ba29d663e87e86d40b4030b2f8f22b110ff4a1), [`d62127f`](https://github.com/thiagoperes/ai-translate/commit/d62127f7c6d7745765d13cf8f051203846c1ea3c), [`3da86ad`](https://github.com/thiagoperes/ai-translate/commit/3da86ad9998bce8a9bedf681a3c2875bff38a72d), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e), [`10723fc`](https://github.com/thiagoperes/ai-translate/commit/10723fc6443171641cb201f9f3d5ca2a5d7bb407), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e)]:
  - @ai-translate/core@0.2.0

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

- [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Add `createShardedJsonStateStore` for translation state that scales beyond a single
  monolithic JSON file. State is persisted as one JSON shard per
  `(catalogId, unitId)` source document under `<rootDir>/<stateDir>/state/`, with
  locale and json-pointer becoming structural keys instead of repeated fields. The
  new store implements the same `SyncStateStore` interface as
  `createJsonStateStore`, so swapping is a one-line config change.

  The first call to `load()` automatically migrates an existing legacy
  `translation-state.json` into shards and removes the legacy file.

  Per-shard files give cleaner PR diffs (one source change touches one shard) and
  keep individual files well under GitHub's 100 MB per-file limit even for projects
  with many catalogs and locales.

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

### Patch Changes

- Updated dependencies [[`2236243`](https://github.com/thiagoperes/ai-translate/commit/223624367f1870fcd0a8dcd753cbfa57b06c4c43), [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c), [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48)]:
  - @ai-translate/core@0.1.0
