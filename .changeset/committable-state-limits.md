---
"@ai-translate/fs-json": minor
---

Refuse to write a state file too large to commit

State is meant to be committed, and nothing stopped it growing past what a
repository will take. Measured: `createJsonStateStore` writes 183 MiB for a
247k-record corpus, over GitHub's 100 MiB hard limit, and at around 1.5M records
`JSON.stringify` exceeds V8's maximum string length and fails with
`RangeError: Invalid string length` — after a run that may have spent real money,
and saying nothing about what went wrong.

Both stores now refuse a state file over 40 MiB, naming the file and what to do
about it: switch to the sharded store, or split the oversized document. The
`RangeError` is translated into the same message. `maxFileBytes` raises or
disables the limit for state that is not committed.

Sharding is not automatically safe either: a shard holds every locale of one
document unit, so a single 60k-pointer document across 15 locales reaches 150 MiB
on its own. That case now fails with advice to split the document rather than
producing a file that cannot be pushed.

For reference, healthy shapes measured with the same probe: 1.5M records across
5,000 documents is 255 MiB over 5,000 files with the largest at 0.1 MiB, and
247k records across 84 documents is 41 MiB with the largest at 0.5 MiB.
