import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SyncStateSnapshot } from "@ai-translate/core/types";
import { describe, expect, it, vi } from "vitest";

import { createShardedJsonStateStore, DURABLE_TRANSACTION_STATE_STORE } from "../src/index";

interface ShardFileV1 {
  catalogId: string | null;
  entries: Record<
    string,
    Record<
      string,
      {
        acceptedContractRevision?: string;
        generationRevision?: string;
        origin: string;
        requiresAcceptanceAudit?: true;
        sourceDigest: string;
        status: string;
        targetDigest: string;
        translationContextDigest?: string;
        updatedAt: string;
        validationAudits?: Record<
          string,
          {
            auditedAt: string;
            auditRevision: string;
            consensusEvaluations?: unknown[];
            deterministicEvaluations?: unknown[];
            adversarialModelId?: string;
            adversarialResponseDigest?: string;
            forwardModelId?: string;
            forwardResponseDigest?: string;
            inputDigest: string;
            providerRevision: string;
            schemaVersion: 1;
            status: string;
          }
        >;
      }
    >
  >;
  unitId: string;
  version: 1;
}

interface ShardFileV2 {
  c: string | null;
  e: unknown[];
  u: string;
  v: 2;
}

async function readShard(shardPath: string): Promise<ShardFileV2> {
  const raw = await fs.readFile(shardPath, "utf8");
  return JSON.parse(raw) as ShardFileV2;
}

function encodePathSegment(segment: string): string {
  if (segment !== "." && segment !== ".." && /^[a-z0-9._-]+$/u.test(segment)) {
    return segment;
  }
  return `%${Buffer.from(segment, "utf8").toString("hex")}`;
}

function forceEncodePathSegment(segment: string): string {
  return `%${Buffer.from(segment, "utf8").toString("hex")}`;
}

function stateShardPath(rootDir: string, catalogId: string | null, unitId: string): string {
  const catalogPathSegment =
    catalogId === null
      ? "__legacy__"
      : catalogId === "__legacy__"
        ? forceEncodePathSegment(catalogId)
        : encodePathSegment(catalogId);
  return path.join(
    rootDir,
    ".ai-translate",
    "state",
    catalogPathSegment,
    `${encodePathSegment(unitId)}.json`,
  );
}

function acceptedAuditProvenance() {
  const evaluation = {
    confidence: "high" as const,
    evidence: [
      { end: 4, field: "source" as const, quote: "Fuel", start: 0 },
      { end: 9, field: "target" as const, quote: "Kraftstoff", start: 0 },
    ],
    reason: "The claim is preserved.",
    requirementId: "claim",
    verdict: "preserved" as const,
  };
  return {
    adversarialModelId: "audit-model",
    adversarialResponseDigest: "adversarial-response",
    auditedAt: "2026-04-29T11:59:00.000Z",
    auditRevision: "claim-v3",
    consensusEvaluations: [
      {
        adversarial: evaluation,
        forward: evaluation,
        requirementId: "claim",
        status: "accepted" as const,
      },
    ],
    forwardModelId: "audit-model",
    forwardResponseDigest: "forward-response",
    inputDigest: "audit-input",
    providerRevision: "provider-v2",
    schemaVersion: 1 as const,
    status: "accepted" as const,
  };
}

function shardFile(args: {
  catalogId: string | null;
  targetDigest: string;
  unitId: string;
}): ShardFileV1 {
  return {
    catalogId: args.catalogId,
    entries: {
      "/title": {
        de: {
          origin: "generated",
          sourceDigest: "source",
          status: "synced",
          targetDigest: args.targetDigest,
          updatedAt: "2026-04-29T12:00:00.000Z",
        },
      },
    },
    unitId: args.unitId,
    version: 1,
  };
}

function twoShardSnapshot(targetDigest: string): SyncStateSnapshot {
  return {
    entries: {
      "de::posts::alpha.mdoc::/title": {
        catalogId: "posts",
        jsonPointer: "/title",
        locale: "de",
        origin: "generated",
        sourceDigest: "source-alpha",
        status: "synced",
        targetDigest: `${targetDigest}-alpha`,
        unitId: "alpha.mdoc",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
      "de::posts::beta.mdoc::/title": {
        catalogId: "posts",
        jsonPointer: "/title",
        locale: "de",
        origin: "generated",
        sourceDigest: "source-beta",
        status: "synced",
        targetDigest: `${targetDigest}-beta`,
        unitId: "beta.mdoc",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
    },
    version: 2,
  };
}

async function writeShard(shardPath: string, shard: ShardFileV1): Promise<void> {
  await fs.mkdir(path.dirname(shardPath), { recursive: true });
  await fs.writeFile(shardPath, `${JSON.stringify(shard, null, 2)}\n`, "utf8");
}

describe("sharded json state store", () => {
  it("returns an empty snapshot when no shards exist", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-"));
    const store = createShardedJsonStateStore({ rootDir });
    const initial = await store.load();
    expect(initial).toEqual({ entries: {}, version: 2 });
  });

  it("reads every state field from legacy v1 shards", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-v1-"));
    const shard = shardFile({
      catalogId: "posts",
      targetDigest: "legacy-target",
      unitId: "legacy.mdoc",
    });
    const record = shard.entries["/title"]?.de;
    if (record === undefined) {
      throw new Error("Expected legacy test shard record.");
    }
    record.acceptedContractRevision = "contract-v1";
    record.generationRevision = "generation-v1";
    record.requiresAcceptanceAudit = true;
    record.translationContextDigest = "context-v1";
    record.validationAudits = { "claim-integrity": acceptedAuditProvenance() };
    await writeShard(stateShardPath(rootDir, "posts", "legacy.mdoc"), shard);

    const loaded = await createShardedJsonStateStore({ rootDir }).load();
    expect(loaded.entries["de::posts::legacy.mdoc::/title"]).toEqual({
      acceptedContractRevision: "contract-v1",
      catalogId: "posts",
      generationRevision: "generation-v1",
      jsonPointer: "/title",
      locale: "de",
      origin: "generated",
      requiresAcceptanceAudit: true,
      sourceDigest: "source",
      status: "synced",
      targetDigest: "legacy-target",
      translationContextDigest: "context-v1",
      unitId: "legacy.mdoc",
      updatedAt: "2026-04-29T12:00:00.000Z",
      validationAudits: { "claim-integrity": acceptedAuditProvenance() },
    });
  });

  it("writes deterministic compact v2 shards and round-trips every state field", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-v2-"));
    const store = createShardedJsonStateStore({ rootDir });
    const snapshot: SyncStateSnapshot = {
      entries: {
        "de::posts::packed.mdoc::/z": {
          catalogId: "posts",
          jsonPointer: "/z",
          locale: "de",
          origin: "legacy-unknown",
          sourceDigest: "1".repeat(64),
          status: "pending",
          targetDigest: "2".repeat(64),
          unitId: "packed.mdoc",
          updatedAt: "not-a-canonical-timestamp",
        },
        "fr::posts::packed.mdoc::/title": {
          acceptedContractRevision: "contract-literal",
          catalogId: "posts",
          generationRevision: `sha256:${"3".repeat(64)}`,
          jsonPointer: "/title",
          locale: "fr",
          origin: "manual",
          requiresAcceptanceAudit: true,
          sourceDigest: "4".repeat(64),
          status: "stale-manual",
          targetDigest: "5".repeat(64),
          unitId: "packed.mdoc",
          updatedAt: "2026-04-29T12:01:00.000Z",
        },
        "de::posts::packed.mdoc::/title": {
          acceptedContractRevision: `sha256:${"6".repeat(64)}`,
          catalogId: "posts",
          generationRevision: "generation-literal",
          jsonPointer: "/title",
          locale: "de",
          origin: "generated",
          sourceDigest: "4".repeat(64),
          status: "synced",
          targetDigest: "7".repeat(64),
          translationContextDigest: "8".repeat(64),
          unitId: "packed.mdoc",
          updatedAt: "2026-04-29T12:00:00.000Z",
          validationAudits: {
            "z-claim-integrity": acceptedAuditProvenance(),
            "a-claim-integrity": acceptedAuditProvenance(),
          },
        },
      },
      version: 2,
    };

    await store.save(snapshot);
    const shardPath = stateShardPath(rootDir, "posts", "packed.mdoc");
    const first = await fs.readFile(shardPath, "utf8");
    expect(JSON.parse(first)).toMatchObject({ c: "posts", u: "packed.mdoc", v: 2 });
    expect(first.endsWith("\n")).toBe(true);
    expect(first.slice(0, -1)).not.toContain("\n");
    expect(first).not.toContain("sourceDigest");
    expect(first).not.toContain("4".repeat(64));
    expect(first.indexOf('"a-claim-integrity"')).toBeLessThan(first.indexOf('"z-claim-integrity"'));
    expect(await store.load()).toEqual(snapshot);

    await store.save({
      entries: Object.fromEntries(Object.entries(snapshot.entries).toReversed()),
      version: 2,
    });
    expect(await fs.readFile(shardPath, "utf8")).toBe(first);
  });

  it("groups entries by (catalogId, unitId) into separate shard files", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-"));
    const store = createShardedJsonStateStore({ rootDir });

    await store.save({
      entries: {
        "de::comparison-pages::right-fuel-card-alternative.mdoc::/title": {
          acceptedContractRevision: `sha256:${"a".repeat(64)}`,
          catalogId: "comparison-pages",
          generationRevision: "openai:gpt-5.4:prompt-v3",
          jsonPointer: "/title",
          locale: "de",
          origin: "generated",
          requiresAcceptanceAudit: true,
          sourceDigest: "src-de-title",
          status: "synced",
          targetDigest: "tgt-de-title",
          translationContextDigest: "ctx-de",
          unitId: "right-fuel-card-alternative.mdoc",
          updatedAt: "2026-04-29T12:00:00.000Z",
          validationAudits: {
            "claim-integrity": acceptedAuditProvenance(),
          },
        },
        "nl::comparison-pages::right-fuel-card-alternative.mdoc::/title": {
          catalogId: "comparison-pages",
          jsonPointer: "/title",
          locale: "nl",
          origin: "generated",
          sourceDigest: "src-nl-title",
          status: "synced",
          targetDigest: "tgt-nl-title",
          translationContextDigest: "ctx-nl",
          unitId: "right-fuel-card-alternative.mdoc",
          updatedAt: "2026-04-29T12:01:00.000Z",
        },
        "de::comparison-pages::dci-fuel-card-alternative.mdoc::/title": {
          catalogId: "comparison-pages",
          jsonPointer: "/title",
          locale: "de",
          origin: "generated",
          sourceDigest: "src-dci-de-title",
          status: "synced",
          targetDigest: "tgt-dci-de-title",
          translationContextDigest: "ctx-dci-de",
          unitId: "dci-fuel-card-alternative.mdoc",
          updatedAt: "2026-04-29T12:02:00.000Z",
        },
        "de::posts::welcome.mdoc::/intro": {
          catalogId: "posts",
          jsonPointer: "/intro",
          locale: "de",
          origin: "generated",
          sourceDigest: "src-post",
          status: "synced",
          targetDigest: "tgt-post",
          unitId: "welcome.mdoc",
          updatedAt: "2026-04-29T12:03:00.000Z",
        },
      },
      version: 2,
    });

    const rightShardPath = stateShardPath(
      rootDir,
      "comparison-pages",
      "right-fuel-card-alternative.mdoc",
    );
    const dciShardPath = stateShardPath(
      rootDir,
      "comparison-pages",
      "dci-fuel-card-alternative.mdoc",
    );
    const postsShardPath = stateShardPath(rootDir, "posts", "welcome.mdoc");

    const rightShard = await readShard(rightShardPath);
    expect(rightShard.u).toBe("right-fuel-card-alternative.mdoc");
    expect(rightShard.c).toBe("comparison-pages");
    expect(rightShard.v).toBe(2);
    const rightRaw = await fs.readFile(rightShardPath, "utf8");
    expect(rightRaw.endsWith("\n")).toBe(true);
    expect(rightRaw.slice(0, -1)).not.toContain("\n");
    expect(rightRaw).not.toContain("sourceDigest");

    const dciShard = await readShard(dciShardPath);
    expect(dciShard.u).toBe("dci-fuel-card-alternative.mdoc");
    expect(dciShard.v).toBe(2);

    const postsShard = await readShard(postsShardPath);
    expect(postsShard.u).toBe("welcome.mdoc");

    const reloaded = await store.load();
    expect(reloaded.version).toBe(2);
    expect(
      reloaded.entries["de::comparison-pages::right-fuel-card-alternative.mdoc::/title"]
        ?.targetDigest,
    ).toBe("tgt-de-title");
    expect(
      reloaded.entries["de::comparison-pages::right-fuel-card-alternative.mdoc::/title"]
        ?.generationRevision,
    ).toBe("openai:gpt-5.4:prompt-v3");
    expect(
      reloaded.entries["de::comparison-pages::right-fuel-card-alternative.mdoc::/title"]
        ?.acceptedContractRevision,
    ).toBe(`sha256:${"a".repeat(64)}`);
    expect(
      reloaded.entries["de::comparison-pages::right-fuel-card-alternative.mdoc::/title"]
        ?.requiresAcceptanceAudit,
    ).toBe(true);
    expect(
      reloaded.entries["nl::comparison-pages::right-fuel-card-alternative.mdoc::/title"]
        ?.targetDigest,
    ).toBe("tgt-nl-title");
    expect(
      reloaded.entries["de::comparison-pages::dci-fuel-card-alternative.mdoc::/title"]
        ?.translationContextDigest,
    ).toBe("ctx-dci-de");
    expect(
      reloaded.entries["de::comparison-pages::right-fuel-card-alternative.mdoc::/title"]
        ?.validationAudits?.["claim-integrity"]?.status,
    ).toBe("accepted");
    expect(reloaded.entries["de::posts::welcome.mdoc::/intro"]?.targetDigest).toBe("tgt-post");
  });

  it("waits for a delayed sibling shard write before rolling a failed commit back", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-race-"));
    const store = createShardedJsonStateStore({ rootDir });
    const initialState = twoShardSnapshot("old");
    const nextState = twoShardSnapshot("new");
    await store.save(initialState);

    const failingPath = stateShardPath(rootDir, "posts", "alpha.mdoc");
    const delayedPath = stateShardPath(rootDir, "posts", "beta.mdoc");
    const originalRename = fs.rename.bind(fs);
    let failNextAlpha = true;
    let betaRenameCount = 0;
    let releaseDelayedBeta: () => void = () => undefined;
    let markDelayedBetaStarted: () => void = () => undefined;
    let markDelayedBetaRenamed: () => void = () => undefined;
    const delayedBetaRelease = new Promise<void>((resolve) => {
      releaseDelayedBeta = resolve;
    });
    const delayedBetaStarted = new Promise<void>((resolve) => {
      markDelayedBetaStarted = resolve;
    });
    const delayedBetaRenamed = new Promise<void>((resolve) => {
      markDelayedBetaRenamed = resolve;
    });
    const fallback = setTimeout(releaseDelayedBeta, 100);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const destination = String(to);
      if (destination === delayedPath) {
        betaRenameCount += 1;
        if (betaRenameCount === 1) {
          markDelayedBetaStarted();
          await delayedBetaRelease;
          await originalRename(from, to);
          markDelayedBetaRenamed();
          return;
        }

        await originalRename(from, to);
        releaseDelayedBeta();
        await delayedBetaRenamed;
        return;
      }
      if (destination === failingPath && failNextAlpha) {
        failNextAlpha = false;
        await delayedBetaStarted;
        throw new Error("forced alpha shard promotion failure");
      }
      await originalRename(from, to);
    });

    try {
      await expect(
        store[DURABLE_TRANSACTION_STATE_STORE].commit({
          documents: [],
          initialState,
          nextState,
        }),
      ).rejects.toThrow("forced alpha shard promotion failure");
    } finally {
      clearTimeout(fallback);
      releaseDelayedBeta();
      rename.mockRestore();
    }

    expect(await store.load()).toEqual(initialState);
    expect((await readShard(delayedPath)).v).toBe(2);
    await expect(
      fs.access(path.join(rootDir, ".ai-translate", "translation-transaction.json")),
    ).rejects.toThrow(/ENOENT/u);
  });

  it("uses lossless shard identities for unit ids that collided under legacy sanitization", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-collision-"));
    const store = createShardedJsonStateStore({ rootDir });
    const stateEntry = (unitId: string, targetDigest: string) => ({
      catalogId: "comparison-pages",
      jsonPointer: "/title",
      locale: "de",
      origin: "generated" as const,
      sourceDigest: `source-${unitId}`,
      status: "synced" as const,
      targetDigest,
      unitId,
      updatedAt: "2026-04-29T12:00:00.000Z",
    });

    await store.save({
      entries: {
        uppercase: stateEntry("Page", "uppercase-target"),
        lowercase: stateEntry("page", "lowercase-target"),
        slash: stateEntry("nested/page", "slash-target"),
        question: stateEntry("nested?page", "question-target"),
      },
      version: 2,
    });

    const reloaded = await store.load();
    expect(reloaded.entries["de::comparison-pages::nested/page::/title"]?.targetDigest).toBe(
      "slash-target",
    );
    expect(reloaded.entries["de::comparison-pages::nested?page::/title"]?.targetDigest).toBe(
      "question-target",
    );
    expect(reloaded.entries["de::comparison-pages::Page::/title"]?.targetDigest).toBe(
      "uppercase-target",
    );
    expect(reloaded.entries["de::comparison-pages::page::/title"]?.targetDigest).toBe(
      "lowercase-target",
    );
    await expect(
      fs.access(stateShardPath(rootDir, "comparison-pages", "nested/page")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(stateShardPath(rootDir, "comparison-pages", "nested?page")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(stateShardPath(rootDir, "comparison-pages", "Page")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(stateShardPath(rootDir, "comparison-pages", "page")),
    ).resolves.toBeUndefined();
  });

  it("keeps the reserved legacy bucket distinct from a catalog with the same id", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-legacy-bucket-"));
    const store = createShardedJsonStateStore({ rootDir });
    const baseEntry = {
      jsonPointer: "/title",
      locale: "de",
      origin: "generated" as const,
      sourceDigest: "source",
      status: "synced" as const,
      unitId: "common",
      updatedAt: "2026-04-29T12:00:00.000Z",
    };
    await store.save({
      entries: {
        "de::common::/title": { ...baseEntry, targetDigest: "legacy-target" },
        "de::__legacy__::common::/title": {
          ...baseEntry,
          catalogId: "__legacy__",
          targetDigest: "catalog-target",
        },
      },
      version: 2,
    });

    const loaded = await store.load();
    expect(loaded.entries["de::common::/title"]?.targetDigest).toBe("legacy-target");
    expect(loaded.entries["de::__legacy__::common::/title"]?.targetDigest).toBe("catalog-target");
    await expect(fs.access(stateShardPath(rootDir, null, "common"))).resolves.toBeUndefined();
    await expect(
      fs.access(stateShardPath(rootDir, "__legacy__", "common")),
    ).resolves.toBeUndefined();
  });

  it("loads legacy shard paths and migrates them on the next state save", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-path-v1-"));
    const legacyShardPath = path.join(
      rootDir,
      ".ai-translate",
      "state",
      "comparison-pages",
      "nested_welcome.mdoc.json",
    );
    await writeShard(
      legacyShardPath,
      shardFile({
        catalogId: "comparison-pages",
        targetDigest: "legacy-target",
        unitId: "nested/welcome.mdoc",
      }),
    );
    const store = createShardedJsonStateStore({ rootDir });

    const loaded = await store.load();
    expect(loaded.entries["de::comparison-pages::nested/welcome.mdoc::/title"]?.targetDigest).toBe(
      "legacy-target",
    );

    await store.save(loaded);
    await expect(fs.access(legacyShardPath)).rejects.toThrow(/ENOENT/u);
    await expect(
      fs.access(stateShardPath(rootDir, "comparison-pages", "nested/welcome.mdoc")),
    ).resolves.toBeUndefined();
  });

  it("fails closed when legacy and canonical shards conflict for one logical state entry", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-conflict-"));
    const legacyShardPath = path.join(
      rootDir,
      ".ai-translate",
      "state",
      "comparison-pages",
      "nested_welcome.mdoc.json",
    );
    await writeShard(
      legacyShardPath,
      shardFile({
        catalogId: "comparison-pages",
        targetDigest: "legacy-target",
        unitId: "nested/welcome.mdoc",
      }),
    );
    await writeShard(
      stateShardPath(rootDir, "comparison-pages", "nested/welcome.mdoc"),
      shardFile({
        catalogId: "comparison-pages",
        targetDigest: "canonical-target",
        unitId: "nested/welcome.mdoc",
      }),
    );

    await expect(createShardedJsonStateStore({ rootDir }).load()).rejects.toThrow(
      "Conflicting ai-translate shard records",
    );
  });

  it("recovers an interrupted path migration when duplicate shards are identical", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-translate-sharded-duplicate-migration-"),
    );
    const legacyShardPath = path.join(
      rootDir,
      ".ai-translate",
      "state",
      "comparison-pages",
      "nested_welcome.mdoc.json",
    );
    const shard = shardFile({
      catalogId: "comparison-pages",
      targetDigest: "same-target",
      unitId: "nested/welcome.mdoc",
    });
    await writeShard(legacyShardPath, shard);
    await writeShard(stateShardPath(rootDir, "comparison-pages", "nested/welcome.mdoc"), shard);
    const store = createShardedJsonStateStore({ rootDir });

    const loaded = await store.load();
    expect(loaded.entries["de::comparison-pages::nested/welcome.mdoc::/title"]?.targetDigest).toBe(
      "same-target",
    );
    await store.save(loaded);
    await expect(fs.access(legacyShardPath)).rejects.toThrow(/ENOENT/u);
  });

  it("rejects incomplete accepted semantic-audit provenance instead of trusting the cache", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-audit-"));
    const shard = shardFile({
      catalogId: "comparison-pages",
      targetDigest: "translated",
      unitId: "welcome.mdoc",
    });
    const record = shard.entries["/title"]?.de;
    if (!record) {
      throw new Error("Expected test shard record.");
    }
    record.validationAudits = {
      "claim-integrity": {
        inputDigest: "matching-input",
        status: "accepted",
      } as never,
    };
    await writeShard(stateShardPath(rootDir, "comparison-pages", "welcome.mdoc"), shard);

    await expect(createShardedJsonStateStore({ rootDir }).load()).rejects.toThrow(
      "Invalid ai-translate shard locale record",
    );
  });

  it("rejects deterministic acceptance without high-confidence two-sided evidence", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-audit-"));
    const shard = shardFile({
      catalogId: "comparison-pages",
      targetDigest: "translated",
      unitId: "welcome.mdoc",
    });
    const record = shard.entries["/title"]?.de;
    if (!record) {
      throw new Error("Expected test shard record.");
    }
    record.validationAudits = {
      "claim-integrity": {
        auditedAt: "2026-04-29T11:59:00.000Z",
        auditRevision: "claim-v3",
        deterministicEvaluations: [
          {
            requirementId: "claim",
            verdict: "preserved",
          },
        ],
        inputDigest: "audit-input",
        providerRevision: "provider-v2",
        schemaVersion: 1,
        status: "accepted",
      },
    };
    await writeShard(stateShardPath(rootDir, "comparison-pages", "welcome.mdoc"), shard);

    await expect(createShardedJsonStateStore({ rootDir }).load()).rejects.toThrow(
      "Invalid ai-translate shard locale record",
    );
  });

  it("removes shard files for catalog/unit pairs no longer present", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-"));
    const store = createShardedJsonStateStore({ rootDir });

    await store.save({
      entries: {
        "de::comparison-pages::keep.mdoc::/title": {
          catalogId: "comparison-pages",
          jsonPointer: "/title",
          locale: "de",
          origin: "generated",
          sourceDigest: "src-keep",
          status: "synced",
          targetDigest: "tgt-keep",
          unitId: "keep.mdoc",
          updatedAt: "2026-04-29T12:00:00.000Z",
        },
        "de::comparison-pages::remove.mdoc::/title": {
          catalogId: "comparison-pages",
          jsonPointer: "/title",
          locale: "de",
          origin: "generated",
          sourceDigest: "src-remove",
          status: "synced",
          targetDigest: "tgt-remove",
          unitId: "remove.mdoc",
          updatedAt: "2026-04-29T12:01:00.000Z",
        },
      },
      version: 2,
    });

    const removePath = stateShardPath(rootDir, "comparison-pages", "remove.mdoc");
    expect(await fs.readFile(removePath, "utf8")).toContain("remove.mdoc");

    await store.save({
      entries: {
        "de::comparison-pages::keep.mdoc::/title": {
          catalogId: "comparison-pages",
          jsonPointer: "/title",
          locale: "de",
          origin: "generated",
          sourceDigest: "src-keep",
          status: "synced",
          targetDigest: "tgt-keep",
          unitId: "keep.mdoc",
          updatedAt: "2026-04-29T12:02:00.000Z",
        },
      },
      version: 2,
    });

    await expect(fs.readFile(removePath, "utf8")).rejects.toThrow(/ENOENT/u);
  });

  it("migrates the legacy monolithic translation-state.json on first load", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-legacy-"));
    const stateDir = path.join(rootDir, ".ai-translate");
    await fs.mkdir(stateDir, { recursive: true });
    const legacyPath = path.join(stateDir, "translation-state.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        entries: {
          "de::comparison-pages::right-fuel-card-alternative.mdoc::/title": {
            catalogId: "comparison-pages",
            jsonPointer: "/title",
            locale: "de",
            origin: "generated",
            sourceDigest: "src",
            status: "synced",
            targetDigest: "tgt",
            translationContextDigest: "ctx",
            unitId: "right-fuel-card-alternative.mdoc",
            updatedAt: "2026-04-29T12:00:00.000Z",
          },
          "fr::common::/cta": {
            jsonPointer: "/cta",
            locale: "fr",
            origin: "legacy-unknown",
            sourceDigest: "src-cta",
            status: "synced",
            targetDigest: "tgt-cta",
            unitId: "common",
            updatedAt: "2026-03-17T00:00:00.000Z",
          },
        },
        version: 2,
      }),
      "utf8",
    );

    const store = createShardedJsonStateStore({ rootDir });
    const loaded = await store.load();

    expect(loaded.version).toBe(2);
    expect(
      loaded.entries["de::comparison-pages::right-fuel-card-alternative.mdoc::/title"]
        ?.targetDigest,
    ).toBe("tgt");
    expect(loaded.entries["fr::common::/cta"]?.targetDigest).toBe("tgt-cta");

    await expect(fs.access(legacyPath)).rejects.toThrow(/ENOENT/u);

    const shardPath = stateShardPath(
      rootDir,
      "comparison-pages",
      "right-fuel-card-alternative.mdoc",
    );
    const shard = await readShard(shardPath);
    expect(shard).toMatchObject({
      c: "comparison-pages",
      u: "right-fuel-card-alternative.mdoc",
      v: 2,
    });

    const legacyShardPath = stateShardPath(rootDir, null, "common");
    const legacyShard = await readShard(legacyShardPath);
    expect(legacyShard.c).toBeNull();
    expect(legacyShard.u).toBe("common");

    const reloaded = await store.load();
    expect(reloaded.entries["fr::common::/cta"]?.targetDigest).toBe("tgt-cta");
  });

  it("serializes concurrent writers via the file lock", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-lock-"));
    const store = createShardedJsonStateStore({ rootDir, retryDelayMs: 5, timeoutMs: 5_000 });

    const events: string[] = [];
    const operationOne = store.withLock(async () => {
      events.push("a-start");
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      events.push("a-end");
    });
    const operationTwo = store.withLock(async () => {
      events.push("b-start");
      await Promise.resolve();
      events.push("b-end");
    });

    await Promise.all([operationOne, operationTwo]);
    const aStart = events.indexOf("a-start");
    const aEnd = events.indexOf("a-end");
    const bStart = events.indexOf("b-start");
    const bEnd = events.indexOf("b-end");

    expect(events).toHaveLength(4);
    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(bEnd);
    expect(aEnd < bStart || bEnd < aStart).toBe(true);
  });

  it("reclaims old locks whose recorded process is no longer alive", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-stale-lock-"));
    const stateDir = path.join(rootDir, ".ai-translate");
    const lockPath = path.join(stateDir, "translation-sync.lock");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        acquiredAt: "2000-01-01T00:00:00.000Z",
        pid: 99_999_999,
        token: "abandoned-owner",
      }),
      "utf8",
    );
    const store = createShardedJsonStateStore({
      retryDelayMs: 2,
      rootDir,
      staleLockMs: 5,
      timeoutMs: 100,
    });

    await expect(store.withLock(async () => "recovered")).resolves.toBe("recovered");
    await expect(fs.access(lockPath)).rejects.toThrow(/ENOENT/u);
  });

  it("supports stale recovery for legacy lock records without ownership tokens", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-stale-v1-lock-"));
    const stateDir = path.join(rootDir, ".ai-translate");
    const lockPath = path.join(stateDir, "translation-sync.lock");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ acquiredAt: "2000-01-01T00:00:00.000Z", pid: 99_999_999 }),
      "utf8",
    );
    const store = createShardedJsonStateStore({
      retryDelayMs: 2,
      rootDir,
      staleLockMs: 5,
      timeoutMs: 100,
    });

    await expect(store.withLock(async () => "recovered")).resolves.toBe("recovered");
  });

  it("never reclaims an old lock while its recorded process is alive", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-sharded-live-lock-"));
    const stateDir = path.join(rootDir, ".ai-translate");
    const lockPath = path.join(stateDir, "translation-sync.lock");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        acquiredAt: "2000-01-01T00:00:00.000Z",
        pid: process.pid,
        token: "live-owner",
      }),
      "utf8",
    );
    const store = createShardedJsonStateStore({
      retryDelayMs: 2,
      rootDir,
      staleLockMs: 1,
      timeoutMs: 20,
    });

    await expect(store.withLock(async () => undefined)).rejects.toThrow(
      "Timed out waiting for ai-translate lock",
    );
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
      token: "live-owner",
    });
  });

  it("does not remove a replacement lock that it no longer owns", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-translate-sharded-lock-ownership-"),
    );
    const stateDir = path.join(rootDir, ".ai-translate");
    const lockPath = path.join(stateDir, "translation-sync.lock");
    const store = createShardedJsonStateStore({ rootDir });

    await store.withLock(async () => {
      await fs.rm(lockPath);
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          acquiredAt: new Date().toISOString(),
          pid: process.pid,
          token: "replacement-owner",
        }),
        "utf8",
      );
    });

    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
      token: "replacement-owner",
    });
  });
});
