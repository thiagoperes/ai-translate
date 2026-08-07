---
"@ai-translate/core": minor
"@ai-translate/fs-json": minor
---

Let a locale-scoped sync stop loading the whole corpus

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
