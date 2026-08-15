---
"@ai-translate/cli": minor
"@ai-translate/core": minor
"@ai-translate/fs-json": minor
"@ai-translate/provider-core": patch
---

Stop serializing the corpus on one file at a time

`concurrency.documents` only ever reached provider dispatch. Every phase that
touched the filesystem awaited one document before starting the next, so loading
sources, reconciling targets, writing results, the read-only `validate`/`check`
pass, and an audit's candidate collection each cost a round trip per document
per locale no matter what the setting said or what the disk could do.

Those phases now fan out under one shared budget, and the sharded state store
reads shards in bounded parallel batches instead of one at a time. Results are
still collected and folded in input order, so a run produces the same documents,
the same state, and the same issue list at any concurrency.

The budget is also reachable now: `--concurrency <count>` overrides
`concurrency.documents` for a single `sync`, `check`, `audit`, or `validate`, and
`SyncCatalogsOptions.documentConcurrency` does the same for library callers. It
bounds the engine, not the network — how many requests reach the model at once
is still the provider's own `concurrentRequests`, and the lower of the two wins.

Sync metrics gained a `documentWriteMs` phase, which was previously the largest
unmeasured part of a run.

On 800 source documents across 4 locales (64,000 entries) against a provider at
20ms per call, raising concurrency from 1 to 64 takes the run from 15.2s to 2.5s,
with document write-back dropping from 2585ms to 721ms. `bench/throughput.bench.mjs`
reproduces it.
