import type { ReconcileHistoryEntry, SyncStateEntry, SyncStateSnapshot } from "./types";

interface IndexedStateHistoryEntry {
  entry: SyncStateEntry;
  stateKey: string;
}

export type StateHistoryIndex = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly IndexedStateHistoryEntry[]>
>;

/**
 * Indexes reconciliation history once by locale and unit. Keeping each bucket
 * in snapshot iteration order preserves the legacy/canonical precedence used
 * by adapters without rescanning the complete state for every document.
 */
export function buildStateHistoryIndex(snapshot: SyncStateSnapshot): StateHistoryIndex {
  const mutableIndex = new Map<string, Map<string, IndexedStateHistoryEntry[]>>();

  for (const [stateKey, entry] of Object.entries(snapshot.entries)) {
    const { locale, unitId } = entry;
    let localeBuckets = mutableIndex.get(locale);
    if (localeBuckets === undefined) {
      localeBuckets = new Map();
      mutableIndex.set(locale, localeBuckets);
    }

    const unitEntries = localeBuckets.get(unitId) ?? [];
    unitEntries.push({ entry, stateKey });
    localeBuckets.set(unitId, unitEntries);
  }

  return mutableIndex;
}

export function getStateHistory(args: {
  catalogId: string;
  index: StateHistoryIndex;
  locale: string;
  unitId: string;
}): ReconcileHistoryEntry[] {
  const bucket = args.index.get(args.locale)?.get(args.unitId) ?? [];
  return bucket.flatMap(({ entry, stateKey }) =>
    entry.catalogId === undefined || entry.catalogId === args.catalogId
      ? [{ ...entry, stateKey }]
      : [],
  );
}

/** Removes state records in O(number of unique keys) without copying the corpus. */
export function removeStateEntriesInPlace(
  entries: Record<string, SyncStateEntry>,
  stateKeys: Iterable<string>,
): void {
  for (const stateKey of new Set(stateKeys)) {
    Reflect.deleteProperty(entries, stateKey);
  }
}
