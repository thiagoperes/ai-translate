---
"@ai-translate/fs-json": minor
"@ai-translate/core": minor
"@ai-translate/cli": minor
---

Narrow the staged transaction's state to the locales a run actually writes.

Every CLI write is wrapped in a staged transaction that loaded the whole corpus
and cloned it several times on the way to a commit, so a one-locale sync carried
fourteen other locales through every copy. The scope a sync already computes is
now threaded through the transaction to the store, which merges rather than
replaces, leaving untouched locales on disk.

On a 246k-record, 15-locale corpus a one-locale run peaks at 743 MB instead of
1,616 MB (−54%); four locales at 1,014 MB (−37%). Full runs are deliberately
left unscoped: naming every locale saves nothing, and a scoped save preserves
what it does not mention, so a locale dropped from the config would never be
pruned. `bench/transaction.bench.mjs` measures this and runs under `pnpm bench`.

The scope is recorded in the transaction journal, which moves to version 2 when
and only when one is present. Recovery usually happens in a later process, and a
reader that ignored the scope would restore a narrowed snapshot as the whole
corpus and delete every locale the run never loaded — so unscoped transactions
stay on version 1 and remain readable in both directions across an upgrade,
while a scoped journal an older client cannot understand is rejected outright
rather than applied broadly.

Stores opt in by declaring the `SCOPED_SAVE_STATE_STORE` marker; anything
without it keeps the whole-corpus contract, where omitting an entry means
deleting it.
