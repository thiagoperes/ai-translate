---
"@ai-translate/fs-json": minor
---

Add `createShardedJsonStateStore` for translation state that scales beyond a single
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
