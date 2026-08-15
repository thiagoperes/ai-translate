---
"@ai-translate/cli": patch
"@ai-translate/core": minor
"@ai-translate/provider-core": minor
---

Let the provider report its own candidate-cache identity

The candidate cache is what stops the same English string being paid for twice
when it appears in two documents, and it was effectively unreachable: enabling it
meant hand-writing `candidateCache.identity` with a model id, a vendor id, and a
provider revision that had to match the provider you had already constructed, and
none of it appeared in any README or in what `ai-translate init` generates.

Hand-written identities also drift. Change `model` and forget the identity, and
every cache hit serves the previous model's output with no signal that anything is
wrong.

`TranslationProvider` gained an optional `candidateCacheIdentity`, which
`StructuredTranslationProvider` reports from the model it calls, the transport's
label, and the translation output contract revision. `candidateCache.identity`
becomes optional and defaults to it, so turning the cache on is a store plus a
`generationRevision`. Providers that cannot describe themselves still supply an
identity in config, and a cache configured without either now fails with an
explicit error instead of silently never keying.

Documented in the CLI README, which previously did not mention the cache at all.
