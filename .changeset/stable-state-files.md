---
"@ai-translate/core": patch
"@ai-translate/fs-json": minor
---

Stop rewriting the whole corpus's state on a run that changed nothing

State is committed, so a run that translates nothing has to leave it byte for
byte as it was. It did not. Two things conspired:

A generated entry recorded no `generationRevision` when the config named none,
but the same entry reaching the preserve path on the next run was stamped
`legacy-unverified`. So the run after a first pass rewrote every record in the
corpus to add a value that changes no decision — and because the record changed,
`updatedAt` moved too. It converged after that, which is exactly why it was easy
to miss. Generated entries now record the value up front.

The sharded store also rewrote every shard on every save regardless of content.
It now compares against what is on disk first and skips the write when the bytes
match, which costs one read instead of two fsyncs and a rename, and leaves the
mtime alone.

Measured on 40 documents across 2 locales: a no-op run rewrote 40 of 40 shards
and left a dirty tree; it now rewrites none and leaves the tree clean. Editing
one document produced 43 git-visible changes; it now produces 4 — the one shard,
the source, and its two translations.
