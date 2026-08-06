import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SyncStateEntry, SyncStateSnapshot } from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import { createShardedJsonStateStore } from "../src/index";

/**
 * Scoped loading exists purely to avoid materialising the whole corpus. It is
 * only safe while it stays indistinguishable from loading everything and
 * filtering, so these tests assert that equivalence directly rather than
 * asserting the narrowed shape, which would pass even if scoping dropped or
 * corrupted entries it was supposed to keep.
 */

const LOCALES = ["de", "es", "fr", "it", "nl"] as const;

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

/**
 * Deterministic corpus that exercises every branch of the packed record: the
 * narrow 6-field form, the wide form driven by a context-digest override, an
 * empty `validationAudits` object, a source-digest override, and the optional
 * `requiresAcceptanceAudit` flag.
 */
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
        // Pointer-level digest for most locales, per-locale override for some:
        // this is what forces the wide packed record on real corpora.
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
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-"));
  await createShardedJsonStateStore({ rootDir }).save(corpus);
  return rootDir;
}

describe("scoped state loading", () => {
  it("returns exactly the unscoped snapshot filtered to the scope, for every locale subset", async () => {
    const corpus = buildCorpus({ pointers: 4, units: 3 });
    const rootDir = await seedStore(corpus);
    const store = createShardedJsonStateStore({ rootDir });
    const unscoped = await store.load();

    // All 31 non-empty subsets of the locale set. Equivalence has to hold for
    // every combination, not just the single-locale case the benchmark uses.
    for (let mask = 1; mask < 1 << LOCALES.length; mask += 1) {
      const locales = LOCALES.filter((_, index) => (mask & (1 << index)) !== 0);
      const scoped = await store.load({ locales });
      expect(scoped).toEqual(projectLocales(unscoped, locales));
    }
  });

  it("treats an omitted or empty scope as no narrowing", async () => {
    const corpus = buildCorpus({ pointers: 3, units: 2 });
    const rootDir = await seedStore(corpus);
    const store = createShardedJsonStateStore({ rootDir });
    const unscoped = await store.load();

    expect(await store.load(undefined)).toEqual(unscoped);
    expect(await store.load({})).toEqual(unscoped);
    expect(await store.load({ locales: [] })).toEqual(unscoped);
  });

  it("returns an empty snapshot for a locale that has no entries", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 2, units: 1 }));
    const scoped = await createShardedJsonStateStore({ rootDir }).load({ locales: ["zz"] });
    expect(scoped.entries).toEqual({});
  });

  it("ignores unknown locales while still returning the known ones", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 2, units: 1 }));
    const store = createShardedJsonStateStore({ rootDir });
    const scoped = await store.load({ locales: ["de", "zz"] });
    const expected = projectLocales(await store.load(), ["de"]);
    expect(scoped).toEqual(expected);
  });

  it("preserves every optional field through a scoped load", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 6, units: 2 }));
    const store = createShardedJsonStateStore({ rootDir });
    const scoped = await store.load({ locales: ["de"] });
    const values = Object.values(scoped.entries);

    // Guard the guard: if the corpus stopped producing these shapes the
    // equivalence assertions above would still pass while testing nothing.
    expect(values.some((entry) => entry.requiresAcceptanceAudit === true)).toBe(true);
    expect(values.some((entry) => entry.validationAudits !== undefined)).toBe(true);
    expect(values.some((entry) => entry.acceptedContractRevision !== undefined)).toBe(true);
    expect(values.some((entry) => entry.generationRevision !== undefined)).toBe(true);
    expect(values.some((entry) => entry.origin === "manual")).toBe(true);
    expect(
      values.some((entry) => entry.translationContextDigest?.startsWith("context-override-")),
    ).toBe(true);
  });

  it("round-trips a full load through save without loss", async () => {
    const corpus = buildCorpus({ pointers: 3, units: 2 });
    const rootDir = await seedStore(corpus);
    const store = createShardedJsonStateStore({ rootDir });
    const first = await store.load();
    await store.save(first);
    expect(await store.load()).toEqual(first);
  });

  it("honours the scope when reading legacy v1 shards", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-v1-"));
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
    const scoped = await store.load({ locales: ["fr"] });
    expect(Object.keys(scoped.entries)).toEqual(["fr::posts::legacy::/title"]);
    expect(scoped).toEqual(projectLocales(await store.load(), ["fr"]));
  });

  it("honours the scope when migrating a legacy monolithic state file", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-legacy-"));
    const legacyPath = path.join(rootDir, ".ai-translate", "translation-state.json");
    const corpus = buildCorpus({ pointers: 2, units: 1 });
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify(corpus), "utf8");

    const scoped = await createShardedJsonStateStore({ rootDir }).load({ locales: ["es"] });
    expect(Object.values(scoped.entries).every((entry) => entry.locale === "es")).toBe(true);
    expect(Object.keys(scoped.entries)).toHaveLength(2);

    // Migration must still have written every locale to disk, not just the scope.
    const migrated = await createShardedJsonStateStore({ rootDir }).load();
    expect(Object.keys(migrated.entries)).toHaveLength(Object.keys(corpus.entries).length);
  });

  it("still detects shard corruption in records outside the scope", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-corrupt-"));
    const shardPath = path.join(rootDir, ".ai-translate", "state", "posts", "unit.json");
    await fs.mkdir(path.dirname(shardPath), { recursive: true });
    // Two records for the same locale in one pointer bucket: a scoped load that
    // skipped structural checks for out-of-scope records would silently accept.
    await fs.writeFile(
      shardPath,
      JSON.stringify({
        c: "posts",
        e: [["/title", "rsource", null, [["fr", "rtarget", 0, null, null, 0], ["fr", "rother", 0, null, null, 0]]]],
        u: "unit",
        v: 2,
      }),
      "utf8",
    );

    await expect(
      createShardedJsonStateStore({ rootDir }).load({ locales: ["de"] }),
    ).rejects.toThrow(/Invalid ai-translate shard locale record/u);
  });

  /**
   * The decode pool is keyed by the packed string and shared across fields, so
   * a value that appears as both a source digest and a context digest must
   * still decode correctly for both. Whether pooling actually happened is a
   * memory property that JavaScript cannot observe (strings compare by value),
   * so that regression is guarded by bench/state.bench.mjs against a committed
   * baseline rather than here.
   */
  it("decodes correctly when the same packed value appears in several fields", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-scoped-pool-"));
    const shardPath = path.join(rootDir, ".ai-translate", "state", "posts", "unit.json");
    const shared = "a".repeat(64);
    await fs.mkdir(path.dirname(shardPath), { recursive: true });
    await fs.writeFile(
      shardPath,
      JSON.stringify({
        c: "posts",
        e: [
          [
            "/title",
            `h${Buffer.from(shared, "hex").toString("base64url")}`,
            `h${Buffer.from(shared, "hex").toString("base64url")}`,
            [
              ["de", "rtarget-de", 0, null, `h${Buffer.from(shared, "hex").toString("base64url")}`, 0],
              ["fr", "rtarget-fr", 0, null, null, 0],
            ],
          ],
        ],
        u: "unit",
        v: 2,
      }),
      "utf8",
    );

    const snapshot = await createShardedJsonStateStore({ rootDir }).load();
    const german = snapshot.entries["de::posts::unit::/title"];
    const french = snapshot.entries["fr::posts::unit::/title"];
    expect(german?.sourceDigest).toBe(shared);
    expect(german?.translationContextDigest).toBe(shared);
    expect(german?.generationRevision).toBe(shared);
    expect(french?.sourceDigest).toBe(shared);
    expect(french?.generationRevision).toBeUndefined();
  });

  it("shares pooled strings without letting entries alias mutable state", async () => {
    const rootDir = await seedStore(buildCorpus({ pointers: 4, units: 2 }));
    const store = createShardedJsonStateStore({ rootDir });
    const snapshot = await store.load();
    const entries = Object.values(snapshot.entries);

    // Interning must not hand two entries the same object; only strings, which
    // are immutable, may be shared.
    const seen = new Set<SyncStateEntry>();
    for (const entry of entries) {
      expect(seen.has(entry)).toBe(false);
      seen.add(entry);
    }

    const withAudits = entries.filter((entry) => entry.validationAudits !== undefined);
    expect(withAudits.length).toBeGreaterThan(1);
    expect(withAudits[0]?.validationAudits).not.toBe(withAudits[1]?.validationAudits);
  });
});
