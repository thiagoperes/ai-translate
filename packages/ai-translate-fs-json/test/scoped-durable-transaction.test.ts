import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SyncStateEntry, SyncStateSnapshot } from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import { createShardedJsonStateStore, DURABLE_TRANSACTION_STATE_STORE } from "../src/index";

/**
 * The durable transaction is where a scoped save is easiest to get wrong,
 * because the snapshot outlives the process that produced it. A scope that is
 * honoured at commit but forgotten in the journal looks completely correct
 * until a crash, and then recovery replays the narrowed snapshot as if it were
 * the whole corpus and deletes every locale the run never loaded. So the
 * interesting assertions here are the ones made *after* an interrupted commit,
 * not the ones made after a clean one.
 */

const LOCALES = ["de", "es", "fr", "it", "nl"] as const;

function buildCorpus(): SyncStateSnapshot {
  const entries: Record<string, SyncStateEntry> = {};
  for (let unit = 0; unit < 6; unit += 1) {
    const catalogId = unit % 2 === 0 ? "posts" : "pages";
    const unitId = `unit-${unit}.mdoc`;
    for (const [index, locale] of LOCALES.entries()) {
      const seed = unit * 10 + index;
      entries[`${locale}::${catalogId}::${unitId}::/title`] = {
        catalogId,
        jsonPointer: "/title",
        locale,
        origin: "generated",
        sourceDigest: `source-${unit}`,
        status: "synced",
        targetDigest: `target-${seed}`,
        unitId,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seed)).toISOString(),
      };
    }
  }
  return { entries, version: 2 };
}

function projectLocales(
  snapshot: SyncStateSnapshot,
  locales: readonly string[],
): SyncStateSnapshot {
  const included = new Set(locales);
  return {
    entries: Object.fromEntries(
      Object.entries(snapshot.entries).filter(([, entry]) => included.has(entry.locale)),
    ),
    version: snapshot.version,
  };
}

/** Retranslates one locale in place, the shape a scoped sync produces. */
function retranslate(scoped: SyncStateSnapshot, marker: string): SyncStateSnapshot {
  return {
    entries: Object.fromEntries(
      Object.entries(scoped.entries).map(([key, entry]) => [
        key,
        { ...entry, targetDigest: `${marker}-${entry.targetDigest}` },
      ]),
    ),
    version: scoped.version,
  };
}

async function createStore(): Promise<{
  rootDir: string;
  store: ReturnType<typeof createShardedJsonStateStore>;
}> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-txn-"));
  return { rootDir, store: createShardedJsonStateStore({ rootDir }) };
}

const journalPathFor = (rootDir: string): string =>
  path.join(rootDir, ".ai-translate", "translation-transaction.json");

/**
 * Recovery is driven by the lock, not by reading, so a bare `load` would report
 * whatever the crash happened to leave behind and quietly pass. This is the
 * shape every CLI command uses to open the state.
 */
async function loadAfterRecovery(rootDir: string): Promise<SyncStateSnapshot> {
  const store = createShardedJsonStateStore({ rootDir });
  return store.withLock(async () => store.load());
}

describe("scoped durable transactions", () => {
  it("commits a scoped snapshot without deleting out-of-scope locales", async () => {
    const { store } = await createStore();
    const initial = buildCorpus();
    await store.save(initial);

    const scope = { locales: ["de"] } as const;
    const scoped = projectLocales(initial, scope.locales);
    const next = retranslate(scoped, "commit");

    await store[DURABLE_TRANSACTION_STATE_STORE].commit({
      documents: [],
      initialState: scoped,
      nextState: next,
      scope,
    });

    const loaded = await store.load();
    expect(loaded).toEqual({
      entries: { ...initial.entries, ...next.entries },
      version: 2,
    });
    // The untouched locales must be byte-identical, not merely present: a merge
    // that round-trips them through a lossy repack would still pass a key count.
    expect(projectLocales(loaded, ["es", "fr", "it", "nl"])).toEqual(
      projectLocales(initial, ["es", "fr", "it", "nl"]),
    );
  });

  it("keeps out-of-scope locales when a crashed commit is rolled forward", async () => {
    const { rootDir } = await createStore();
    const initial = buildCorpus();
    await createShardedJsonStateStore({ rootDir }).save(initial);

    const scope = { locales: ["de"] } as const;
    const scoped = projectLocales(initial, scope.locales);
    const next = retranslate(scoped, "rollforward");

    // Crash after the state write but before the journal is cleaned up, which
    // leaves a journal a later process has to finish.
    const crashing = createShardedJsonStateStore({
      rootDir,
      transactionFaultInjector: (point) =>
        point === "after-rollforward-marker" ? "simulate-crash" : undefined,
    });
    await expect(
      crashing[DURABLE_TRANSACTION_STATE_STORE].commit({
        documents: [],
        initialState: scoped,
        nextState: next,
        scope,
      }),
    ).rejects.toThrow();
    // The journal survives the crash; the next process is what finishes it.
    await expect(fs.access(journalPathFor(rootDir))).resolves.toBeUndefined();

    const recovered = await loadAfterRecovery(rootDir);
    expect(recovered).toEqual({
      entries: { ...initial.entries, ...next.entries },
      version: 2,
    });
  });

  it("keeps out-of-scope locales when a crashed commit is rolled back", async () => {
    const { rootDir } = await createStore();
    const initial = buildCorpus();
    await createShardedJsonStateStore({ rootDir }).save(initial);

    const scope = { locales: ["de"] } as const;
    const scoped = projectLocales(initial, scope.locales);
    const next = retranslate(scoped, "rollback");

    const crashing = createShardedJsonStateStore({
      rootDir,
      transactionFaultInjector: (point) =>
        point === "after-state-write" ? "simulate-crash" : undefined,
    });
    await expect(
      crashing[DURABLE_TRANSACTION_STATE_STORE].commit({
        documents: [],
        initialState: scoped,
        nextState: next,
        scope,
      }),
    ).rejects.toThrow();

    // Rolling back restores the scoped *initial* snapshot, which is just as
    // narrow as the next one — the undo path has to respect the scope too.
    expect(await loadAfterRecovery(rootDir)).toEqual(initial);
  });

  it("records the scope in the journal so another process can honour it", async () => {
    const { rootDir } = await createStore();
    const initial = buildCorpus();
    await createShardedJsonStateStore({ rootDir }).save(initial);

    const scope = { locales: ["de", "fr"] } as const;
    const scoped = projectLocales(initial, scope.locales);

    const crashing = createShardedJsonStateStore({
      rootDir,
      transactionFaultInjector: (point) =>
        point === "after-journal-prepared" ? "simulate-crash" : undefined,
    });
    await expect(
      crashing[DURABLE_TRANSACTION_STATE_STORE].commit({
        documents: [],
        initialState: scoped,
        nextState: retranslate(scoped, "journal"),
        scope,
      }),
    ).rejects.toThrow();

    const journal: unknown = JSON.parse(await fs.readFile(journalPathFor(rootDir), "utf8"));
    expect(journal).toMatchObject({ scope: { locales: ["de", "fr"] }, version: 2 });
  });

  it("writes a version 1 journal when the commit is unscoped", async () => {
    const { rootDir } = await createStore();
    const initial = buildCorpus();
    await createShardedJsonStateStore({ rootDir }).save(initial);

    const crashing = createShardedJsonStateStore({
      rootDir,
      transactionFaultInjector: (point) =>
        point === "after-journal-prepared" ? "simulate-crash" : undefined,
    });
    await expect(
      crashing[DURABLE_TRANSACTION_STATE_STORE].commit({
        documents: [],
        initialState: initial,
        nextState: retranslate(initial, "unscoped"),
      }),
    ).rejects.toThrow();

    // Staying on v1 for unscoped commits is what keeps journals readable in
    // both directions across an upgrade; bumping unconditionally would make
    // every ordinary transaction unrecoverable by an older install.
    const journal = JSON.parse(await fs.readFile(journalPathFor(rootDir), "utf8")) as {
      scope?: unknown;
      version: number;
    };
    expect(journal.version).toBe(1);
    expect(journal.scope).toBeUndefined();
  });

  it("refuses a scoped journal whose scope is unusable rather than applying it broadly", async () => {
    const { rootDir } = await createStore();
    const initial = buildCorpus();
    const store = createShardedJsonStateStore({ rootDir });
    await store.save(initial);

    const scope = { locales: ["de"] } as const;
    const scoped = projectLocales(initial, scope.locales);
    const crashing = createShardedJsonStateStore({
      rootDir,
      transactionFaultInjector: (point) =>
        point === "after-journal-prepared" ? "simulate-crash" : undefined,
    });
    await expect(
      crashing[DURABLE_TRANSACTION_STATE_STORE].commit({
        documents: [],
        initialState: scoped,
        nextState: retranslate(scoped, "corrupt"),
        scope,
      }),
    ).rejects.toThrow();

    const journalPath = journalPathFor(rootDir);
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(journalPath, JSON.stringify({ ...journal, scope: { locales: [] } }));

    // Failing loudly is the point: silently widening a v2 journal to the whole
    // corpus is precisely the data loss the version exists to prevent.
    await expect(loadAfterRecovery(rootDir)).rejects.toThrow(/transaction journal/u);
  });
});
