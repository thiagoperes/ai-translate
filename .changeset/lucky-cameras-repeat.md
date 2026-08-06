---
"@ai-translate/fs-json": minor
"@ai-translate/core": minor
"@ai-translate/cli": patch
---

Cut state-loading memory by scoping loads to the locales a command actually needs.

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
