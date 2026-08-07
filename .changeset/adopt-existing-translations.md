---
"@ai-translate/fs-json": minor
"@ai-translate/cli": minor
---

Replace the lock-file importer with a generic `adopt` command that seeds state from translations already on disk.

`importStartupV1State` and `ai-translate migrate-state --from startup-v1` are gone, replaced by `adoptExistingTranslations` and `ai-translate adopt`. The old importer required a `{ hashes, overrides }` lock file from one specific prior pipeline, and then made no real use of it: the hash comparison was a ternary with the same value in both branches, so the hashes were dead weight, and any entry whose target differed from its source was already classified as `legacy-unknown` regardless. Adoption now reads the catalogs and nothing else, which means it works as a migration path off any prior tool rather than off one bespoke format.

Two behaviour fixes come with it:

- A source string with no target text, or an empty one, is no longer recorded as synced. The old importer fell back to the source string and wrote a completed entry, which stranded the key: the next sync saw satisfied state and never translated it.
- Adopted entries are always `legacy-unknown`. Catalogs carry no evidence of whether their text is human or machine, so claiming `generated` overstated what was known. `legacyOriginPolicy` decides what a later sync does with them, and still defaults to `preserve`.

`adopt` reports `adopted`, `identicalToSource`, and `untranslated` counts, supports `--dry-run`, and takes `--identical-to-source <adopt|skip>` for target text byte-identical to its source — ambiguous between a correct translation that happens to match and a placeholder left by a pipeline that backfilled missing keys with the source string. It defaults to `adopt`.
