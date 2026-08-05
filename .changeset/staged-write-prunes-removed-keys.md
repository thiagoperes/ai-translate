---
"@ai-translate/core": minor
"@ai-translate/fs-json": minor
"@ai-translate/cli": patch
---

Prune target keys that no longer exist in the source when a sync commits.

Staged writes previously reused the state of the partially written file for
every JSON format, so a key renamed or removed in the source stayed in every
localized document forever. `check` then reported the leftovers as
`extra-target-entry` and the only remedy was editing localized files by hand.

The reconciled document is now authoritative for the write. Formats that pack
several logical documents into one file implement the new optional
`CatalogAdapter.mergeStagedState` hook to fold their own reconciled unit into
the staged file, which keeps sibling units written earlier in the same
transaction while still dropping removed keys from their own unit.
