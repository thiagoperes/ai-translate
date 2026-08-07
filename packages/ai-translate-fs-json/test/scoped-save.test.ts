import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SyncStateEntry, SyncStateSnapshot } from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import { createShardedJsonStateStore } from "../src/index";

/**
 * A scoped save is the dangerous half of scoped loading. Saving normally means
 * "this is the whole corpus", so anything the snapshot omits is deleted; a
 * snapshot narrowed to one locale omits almost everything. Shards are keyed by
 * unit rather than by locale, so the loss is not limited to whole files that
 * disappear: a shard that gets rewritten is repacked from the snapshot alone
 * and quietly loses every other locale inside it.
 *
 * These tests therefore assert an equivalence rather than a shape. A scoped
 * save must be indistinguishable from loading everything, replacing exactly the
 * in-scope locales, and saving that. Asserting the shape instead would keep
 * passing if the merge dropped records it was meant to carry over.
 */

const LOCALES = ["de", "es", "fr", "it", "nl"] as const;

/** The reference implementation a scoped save must be indistinguishable from. */
function applyScopedSave(
  full: SyncStateSnapshot,
  scoped: SyncStateSnapshot,
  locales: readonly string[],
): SyncStateSnapshot {
  const inScope = new Set(locales);
  const entries = Object.fromEntries(
    Object.entries(full.entries).filter(([, entry]) => !inScope.has(entry.locale)),
  );
  for (const [key, entry] of Object.entries(scoped.entries)) {
    entries[key] = entry;
  }
  return { entries, version: full.version };
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

function buildCorpus(options: { pointers: number; units: number }): SyncStateSnapshot {
  const entries: Record<string, SyncStateEntry> = {};
  for (let unit = 0; unit < options.units; unit += 1) {
    const catalogId = unit % 3 === 0 ? "posts" : `catalog-${unit % 3}`;
    const unitId = `unit-${unit}.mdoc`;
    for (let pointer = 0; pointer < options.pointers; pointer += 1) {
      const jsonPointer = `/section/${pointer}`;
      for (const [index, locale] of LOCALES.entries()) {
        const seed = unit * 1000 + pointer * 10 + index;
        const entry: SyncStateEntry = {
          catalogId,
          jsonPointer,
          locale,
          origin: seed % 7 === 0 ? "manual" : "generated",
          sourceDigest: `source-${unit}-${pointer}`,
          status: seed % 5 === 0 ? "pending" : "synced",
          targetDigest: `target-${seed}`,
          unitId,
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seed % 90)).toISOString(),
        };
        if (seed % 2 === 0) {
          entry.generationRevision = `generation-${seed % 4}`;
        }
        if (seed % 3 === 0) {
          entry.acceptedContractRevision = `accepted-${seed}`;
        }
        entry.translationContextDigest =
          seed % 11 === 0 ? `context-override-${seed}` : `context-${pointer % 4}`;
        if (seed % 13 === 0) {
          entry.validationAudits = {};
        }
        if (seed % 17 === 0) {
          entry.requiresAcceptanceAudit = true;
        }
        entries[`${locale}::${catalogId}::${unitId}::${jsonPointer}`] = entry;
      }
    }
  }
  return { entries, version: 2 };
}

async function seedStore(corpus: SyncStateSnapshot): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-save-"));
  await createShardedJsonStateStore({ rootDir }).save(corpus);
  return rootDir;
}

async function listShards(rootDir: string): Promise<string[]> {
  const shardsDir = path.join(rootDir, ".ai-translate", "state");
  const found: string[] = [];
  async function walk(dir: string, relative: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(child, childRelative);
      } else if (entry.name.endsWith(".json")) {
        found.push(childRelative);
      }
    }
  }
  await walk(shardsDir, "");
  return found.toSorted();
}

describe("scoped state saving", () => {
  it("advertises the capability so callers can tell it apart from a store that ignores the scope", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 1, units: 1 }));
    const store = createShardedJsonStateStore({ rootDir });
    const marker = Symbol.for("@ai-translate/core/scoped-save-state-store");
    expect((store as unknown as Record<symbol, unknown>)[marker]).toBe(true);
  });

  it("leaves every locale outside the scope untouched, for every locale subset", async () => {
    for (let mask = 1; mask < 1 << LOCALES.length; mask += 1) {
      const locales = LOCALES.filter((_, index) => (mask & (1 << index)) !== 0);
      const corpus = buildCorpus({ pointers: 3, units: 3 });
      const rootDir = await seedStore(corpus);
      const store = createShardedJsonStateStore({ rootDir });
      const before = await store.load();

      // Mutate every in-scope entry so a merge that silently kept the old
      // records would be caught alongside one that dropped the new ones.
      const scoped = projectLocales(before, locales);
      for (const entry of Object.values(scoped.entries)) {
        entry.targetDigest = `rewritten-${entry.locale}`;
      }

      await store.save(scoped, { locales });
      expect(await store.load()).toEqual(applyScopedSave(before, scoped, locales));
    }
  });

  it("deletes in-scope entries the snapshot drops while keeping the same unit's other locales", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 3, units: 2 }));
    const store = createShardedJsonStateStore({ rootDir });
    const before = await store.load();

    const scoped = projectLocales(before, ["fr"]);
    // Drop half of French, keeping the rest, inside shards shared with 4 other
    // locales. This is the case a whole-file merge would not catch.
    for (const key of Object.keys(scoped.entries).slice(0, 3)) {
      delete scoped.entries[key];
    }

    await store.save(scoped, { locales: ["fr"] });
    const after = await store.load();
    expect(after).toEqual(applyScopedSave(before, scoped, ["fr"]));
    expect(Object.values(after.entries).filter((entry) => entry.locale === "de")).toHaveLength(
      Object.values(before.entries).filter((entry) => entry.locale === "de").length,
    );
  });

  it("removes a shard only when the scope emptied it completely", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-save-drop-"));
    const store = createShardedJsonStateStore({ rootDir });
    await store.save({
      entries: {
        "fr::posts::lonely::/title": {
          catalogId: "posts",
          jsonPointer: "/title",
          locale: "fr",
          origin: "generated",
          sourceDigest: "source",
          status: "synced",
          targetDigest: "target",
          unitId: "lonely",
          updatedAt: "2026-04-29T12:00:00.000Z",
        },
        "fr::posts::shared::/title": {
          catalogId: "posts",
          jsonPointer: "/title",
          locale: "fr",
          origin: "generated",
          sourceDigest: "source",
          status: "synced",
          targetDigest: "target-fr",
          unitId: "shared",
          updatedAt: "2026-04-29T12:00:00.000Z",
        },
        "de::posts::shared::/title": {
          catalogId: "posts",
          jsonPointer: "/title",
          locale: "de",
          origin: "generated",
          sourceDigest: "source",
          status: "synced",
          targetDigest: "target-de",
          unitId: "shared",
          updatedAt: "2026-04-29T12:00:00.000Z",
        },
      },
      version: 2,
    });
    expect(await listShards(rootDir)).toHaveLength(2);

    // French disappears entirely. "lonely" held nothing else and must go;
    // "shared" still holds German and must survive with only that record.
    await store.save({ entries: {}, version: 2 }, { locales: ["fr"] });

    expect(await listShards(rootDir)).toEqual([path.join("posts", "shared.json")]);
    const after = await store.load();
    expect(Object.keys(after.entries)).toEqual(["de::posts::shared::/title"]);
  });

  it("creates shards for units that did not exist yet", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 2, units: 1 }));
    const store = createShardedJsonStateStore({ rootDir });
    const before = await store.load();

    const scoped = projectLocales(before, ["fr"]);
    scoped.entries["fr::posts::brand-new::/title"] = {
      catalogId: "posts",
      jsonPointer: "/title",
      locale: "fr",
      origin: "generated",
      sourceDigest: "source",
      status: "synced",
      targetDigest: "target-new",
      unitId: "brand-new",
      updatedAt: "2026-04-29T12:00:00.000Z",
    };

    await store.save(scoped, { locales: ["fr"] });
    expect(await store.load()).toEqual(applyScopedSave(before, scoped, ["fr"]));
  });

  it("preserves out-of-scope records held in a legacy v1 shard", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-save-v1-"));
    const shardPath = path.join(rootDir, ".ai-translate", "state", "posts", "legacy.json");
    await fs.mkdir(path.dirname(shardPath), { recursive: true });
    await fs.writeFile(
      shardPath,
      JSON.stringify({
        catalogId: "posts",
        entries: {
          "/title": {
            de: {
              origin: "generated",
              sourceDigest: "source",
              status: "synced",
              targetDigest: "target-de",
              updatedAt: "2026-04-29T12:00:00.000Z",
            },
            fr: {
              origin: "generated",
              sourceDigest: "source",
              status: "synced",
              targetDigest: "target-fr",
              updatedAt: "2026-04-29T12:00:00.000Z",
            },
          },
        },
        unitId: "legacy",
        version: 1,
      }),
      "utf8",
    );

    const store = createShardedJsonStateStore({ rootDir });
    const before = await store.load();
    const scoped = projectLocales(before, ["fr"]);
    const french = scoped.entries["fr::posts::legacy::/title"];
    if (french !== undefined) {
      french.targetDigest = "target-fr-updated";
    }

    await store.save(scoped, { locales: ["fr"] });
    const after = await store.load();
    expect(after).toEqual(applyScopedSave(before, scoped, ["fr"]));
    expect(after.entries["de::posts::legacy::/title"]?.targetDigest).toBe("target-de");
  });

  it("treats an omitted or empty scope as a whole-corpus save", async () => {
    for (const scope of [undefined, {}, { locales: [] }]) {
      const rootDir = await seedStore(buildCorpus({ pointers: 2, units: 2 }));
      const store = createShardedJsonStateStore({ rootDir });
      const before = await store.load();
      const french = projectLocales(before, ["fr"]);

      // Without narrowing this snapshot claims the corpus is French-only, and
      // the store must honour that rather than quietly merging.
      await store.save(french, scope);
      expect(await store.load()).toEqual(french);
    }
  });

  it("rejects a snapshot carrying a locale the scope excludes", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 2, units: 1 }));
    const store = createShardedJsonStateStore({ rootDir });
    const before = await store.load();

    // Silently accepting this would apply the entry to units the snapshot
    // happens to mention and drop it everywhere else.
    await expect(store.save(projectLocales(before, ["de", "fr"]), { locales: ["fr"] })).rejects
      .toThrow(/outside the declared scope/u);
  });

  it("still prunes shards on an unscoped save", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 2, units: 3 }));
    const store = createShardedJsonStateStore({ rootDir });
    expect((await listShards(rootDir)).length).toBeGreaterThan(1);

    await store.save({ entries: {}, version: 2 });
    expect(await listShards(rootDir)).toEqual([]);
  });

  it("round-trips repeated scoped saves without drift", async () => {
    const corpus = buildCorpus({ pointers: 3, units: 2 });
    const rootDir = await seedStore(corpus);
    const store = createShardedJsonStateStore({ rootDir });
    const original = await store.load();

    // One locale at a time, as a sharded CI pipeline would run them.
    for (const locale of LOCALES) {
      await store.save(projectLocales(await store.load({ locales: [locale] }), [locale]), {
        locales: [locale],
      });
    }

    expect(await store.load()).toEqual(original);
  });
});
