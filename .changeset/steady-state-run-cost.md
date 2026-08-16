---
"@ai-translate/core": minor
"@ai-translate/fs-json": patch
---

Make a run that changes little cost little

The first pass over a corpus is dominated by the provider, but every run after it
is dominated by the engine deciding what *not* to translate — and that decision
was doing far more work than the decision requires. Profiling a run that
translated nothing found most of its time in work whose answer was already known:

- The same entry text was hashed four to six times per run: once to decide
  whether it changed, again to record the state it produced, again while
  resolving acceptance, again by validation. `digestValue` now caches short
  values, which covers entry text and excludes the one-shot contract material and
  prompt payloads that are too large to be worth keeping.
- `normalizeTranslationContext` re-normalized the same `context.project` object
  once per entry — trimming the same strings, sorting and stringifying the same
  constraints — and `digestTranslationContext` re-hashed the result. Both are now
  keyed on object identity, which is what makes them cheap to reuse.
- Reconciliation built two fully tokenized entry lists per document per locale to
  feed a matcher that only inspects array-addressed leaves. A flat message
  catalog has none, so the work was entirely dead; where arrays do exist the
  walks now skip tokenizing, which index matching never reads.
- Saving a shard reformatted a throwaway `Date` per record to validate its
  timestamp. A pattern check answers the same question.
- Path-scoped audits and forced narrow retranslations scanned an array per entry
  where a set does.

Measured on 500 documents x 4 locales (40,000 entries), against a provider with
no latency so only engine time shows:

| run | before | after |
| --- | --- | --- |
| first pass | 1782ms | 1497ms |
| no-op sync | 1115ms | 719ms |
| check (read-only) | 525ms | 450ms |
| delta (5 documents edited) | 1045ms | 689ms |
| removal (5 keys deleted) | 986ms | 640ms |

Per-entry cost holds from 40,000 to 320,000 entries (18.0 to 20.4 microseconds for
a no-op), so the shape is linear rather than quadratic.
`bench/lifecycle.bench.mjs` reproduces all of it.
