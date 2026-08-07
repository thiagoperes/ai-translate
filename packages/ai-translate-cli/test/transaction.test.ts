import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AiTranslateConfig,
  LoadedDocument,
  SyncStateSnapshot,
} from "@ai-translate/core/types";
import {
  createBundleJsonCatalog,
  createNamespaceJsonCatalog,
  createShardedJsonStateStore,
  type DurableTransactionFaultPoint,
} from "@ai-translate/fs-json";
import { createMarkdocCatalog } from "@ai-translate/markdoc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runStagedCatalogTransaction } from "../src/transaction";

interface Harness {
  config: AiTranslateConfig;
  lockCount(): number;
  localesDir: string;
  save: ReturnType<typeof vi.fn<(next: SyncStateSnapshot) => Promise<void>>>;
  setFailNextSave(value: boolean): void;
  snapshot(): SyncStateSnapshot;
}

async function createHarness(initialTargetValue?: string): Promise<Harness> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-transaction-test-"));
  const localesDir = path.join(cwd, "locales");
  await fs.mkdir(path.join(localesDir, "en"), { recursive: true });
  await fs.writeFile(
    path.join(localesDir, "en", "common.json"),
    JSON.stringify({ claim: "Source claim" }),
  );
  if (initialTargetValue !== undefined) {
    await fs.mkdir(path.join(localesDir, "de"), { recursive: true });
    await fs.writeFile(
      path.join(localesDir, "de", "common.json"),
      JSON.stringify({ claim: initialTargetValue }),
    );
  }

  const catalog = createNamespaceJsonCatalog({ rootDir: localesDir, sourceLocale: "en" });
  let snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
  let lockCount = 0;
  let failNextSave = false;
  const save = vi.fn(async (next: SyncStateSnapshot) => {
    snapshot = structuredClone(next);
    if (failNextSave) {
      failNextSave = false;
      throw new Error("state save failed");
    }
  });
  return {
    config: {
      catalogs: [catalog],
      provider: { translate: () => Promise.resolve([]) },
      sourceLocale: "en",
      state: {
        load: () => Promise.resolve(structuredClone(snapshot)),
        save,
        withLock: async (operation) => {
          lockCount += 1;
          return operation();
        },
      },
      targetLocales: ["de"],
    },
    lockCount: () => lockCount,
    localesDir,
    save,
    setFailNextSave(value) {
      failNextSave = value;
    },
    snapshot: () => snapshot,
  };
}

async function targetValue(harness: Harness): Promise<string | undefined> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(harness.localesDir, "de", "common.json"), "utf8"),
    ) as { claim?: string };
    return raw.claim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeStagedTarget(
  config: AiTranslateConfig,
  value: string,
): Promise<LoadedDocument> {
  const catalog = config.catalogs[0];
  if (!catalog) {
    throw new Error("Missing test catalog.");
  }
  const sourceRef = (await catalog.listDocumentRefs("en"))[0];
  if (!sourceRef) {
    throw new Error("Missing test source document.");
  }
  const source = await catalog.loadDocument(sourceRef);
  if (!source) {
    throw new Error("Missing test source document contents.");
  }
  const targetRef = catalog.createDocumentRef(sourceRef, "de");
  const target = await catalog.reconcileDocument({
    ref: targetRef,
    source,
    target: await catalog.loadDocument(targetRef),
  });
  const claim = target.entries[0];
  if (!claim) {
    throw new Error("Missing test claim entry.");
  }
  claim.value = value;
  await catalog.writeDocument(target);
  const persisted = await catalog.loadDocument(targetRef);
  if (!persisted) {
    throw new Error("Missing staged target after write.");
  }
  return persisted;
}

describe("runStagedCatalogTransaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes and reloads staged documents before committing final bytes and state", async () => {
    const test = await createHarness("Old claim");
    const nextState: SyncStateSnapshot = {
      entries: {
        claim: {
          jsonPointer: "/claim",
          locale: "de",
          origin: "generated",
          sourceDigest: "source",
          status: "synced",
          targetDigest: "target",
          unitId: "common",
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      },
      version: 2,
    };

    const result = await runStagedCatalogTransaction(test.config, async (staged) => {
      const persisted = await writeStagedTarget(staged, "Safe claim");
      expect(persisted.entries[0]?.value).toBe("Safe claim");
      expect((persisted.state as { root: { claim: string } }).root.claim).toBe("Safe claim");
      await staged.state.save(nextState);
      expect(await targetValue(test)).toBe("Old claim");
      return "converged";
    });

    expect(result).toBe("converged");
    expect(await targetValue(test)).toBe("Safe claim");
    expect(test.snapshot()).toEqual(nextState);
    expect(test.save).toHaveBeenCalledOnce();
    expect(test.lockCount()).toBe(1);
  });

  it("uses Markdoc serialization state from the staged file during read-back", async () => {
    const test = await createHarness();
    const markdocRoot = path.join(test.localesDir, "markdoc");
    await fs.mkdir(path.join(markdocRoot, "en"), { recursive: true });
    await fs.writeFile(
      path.join(markdocRoot, "en", "guide.md"),
      "# Source heading\n\nSource body\n",
    );
    const catalog = createMarkdocCatalog({ rootDir: markdocRoot, sourceLocale: "en" });
    const config = { ...test.config, catalogs: [catalog] };

    await runStagedCatalogTransaction(config, async (staged) => {
      const stagedCatalog = staged.catalogs[0];
      const sourceRef = (await stagedCatalog?.listDocumentRefs("en"))?.[0];
      const source = sourceRef ? await stagedCatalog?.loadDocument(sourceRef) : null;
      if (!stagedCatalog || !sourceRef || !source) {
        throw new Error("Missing Markdoc test source.");
      }
      const targetRef = stagedCatalog.createDocumentRef(sourceRef, "de");
      const target = await stagedCatalog.reconcileDocument({
        ref: targetRef,
        source,
        target: null,
      });
      const heading = target.entries.find((entry) => entry.value === "Source heading");
      if (!heading) {
        throw new Error("Missing Markdoc test heading.");
      }
      heading.value = "Deutsche Überschrift";
      await stagedCatalog.writeDocument(target);
      const persisted = await stagedCatalog.loadDocument(targetRef);
      if (!persisted) {
        throw new Error("Missing staged Markdoc target.");
      }
      expect(persisted.entries.map((entry) => entry.value)).toContain("Deutsche Überschrift");
      expect((persisted.state as { bodyLines: string[] }).bodyLines).toContain(
        "# Deutsche Überschrift",
      );
      await expect(fs.access(targetRef.path)).rejects.toThrow();
      return true;
    });

    await expect(fs.readFile(path.join(markdocRoot, "de", "guide.md"), "utf8")).resolves.toContain(
      "# Deutsche Überschrift",
    );
  });

  it("uses reconciled source structure instead of stale localized Markdoc formatting", async () => {
    const test = await createHarness();
    const markdocRoot = path.join(test.localesDir, "markdoc-structure");
    await fs.mkdir(path.join(markdocRoot, "en"), { recursive: true });
    await fs.mkdir(path.join(markdocRoot, "de"), { recursive: true });
    await fs.writeFile(path.join(markdocRoot, "en", "guide.md"), "Source body\n");
    await fs.writeFile(path.join(markdocRoot, "de", "guide.md"), "**Alter Text**\n");
    const catalog = createMarkdocCatalog({ rootDir: markdocRoot, sourceLocale: "en" });
    const config = { ...test.config, catalogs: [catalog] };

    await runStagedCatalogTransaction(config, async (staged) => {
      const stagedCatalog = staged.catalogs[0];
      const sourceRef = (await stagedCatalog?.listDocumentRefs("en"))?.[0];
      const source = sourceRef ? await stagedCatalog?.loadDocument(sourceRef) : null;
      if (!stagedCatalog || !sourceRef || !source) {
        throw new Error("Missing Markdoc structural source.");
      }
      const targetRef = stagedCatalog.createDocumentRef(sourceRef, "de");
      const target = await stagedCatalog.reconcileDocument({
        ref: targetRef,
        source,
        target: null,
      });
      const body = target.entries.find((entry) => entry.storage === "markdoc");
      if (!body) {
        throw new Error("Missing Markdoc structural body.");
      }
      body.value = "Neuer Text";
      await stagedCatalog.writeDocument(target);
      return true;
    });

    await expect(fs.readFile(path.join(markdocRoot, "de", "guide.md"), "utf8")).resolves.toBe(
      "Neuer Text\n",
    );
  });

  it("drops localized keys the source no longer has", async () => {
    const test = await createHarness("Alte Aussage");
    await fs.writeFile(
      path.join(test.localesDir, "de", "common.json"),
      JSON.stringify({ claim: "Alte Aussage", retired: "Alter Schlüssel" }),
    );

    await runStagedCatalogTransaction(test.config, async (staged) => {
      await writeStagedTarget(staged, "Neue Aussage");
      return true;
    });

    const committed = JSON.parse(
      await fs.readFile(path.join(test.localesDir, "de", "common.json"), "utf8"),
    ) as Record<string, string>;
    expect(committed).toEqual({ claim: "Neue Aussage" });
  });

  it("keeps sibling bundle units while dropping keys the source no longer has", async () => {
    const test = await createHarness();
    const bundleRoot = path.join(test.localesDir, "bundle");
    await fs.mkdir(bundleRoot, { recursive: true });
    await fs.writeFile(
      path.join(bundleRoot, "en.json"),
      JSON.stringify({ common: { home: "Home" }, demo: { cta: "Start" } }),
    );
    await fs.writeFile(
      path.join(bundleRoot, "de.json"),
      JSON.stringify({ common: { home: "Zuhause", retired: "Alt" }, demo: { cta: "Los" } }),
    );
    const catalog = createBundleJsonCatalog({
      rootDir: bundleRoot,
      sourceLocale: "en",
      split: "top-level-key",
    });

    await runStagedCatalogTransaction({ ...test.config, catalogs: [catalog] }, async (staged) => {
      const stagedCatalog = staged.catalogs[0];
      if (!stagedCatalog) {
        throw new Error("Missing bundle catalog.");
      }
      // Sync plans every document before it writes any of them, so each
      // reconciled unit carries a bundle snapshot taken before its siblings
      // were written.
      const targets: LoadedDocument[] = [];
      for (const sourceRef of await stagedCatalog.listDocumentRefs("en")) {
        const source = await stagedCatalog.loadDocument(sourceRef);
        if (!source) {
          throw new Error(`Missing bundle source ${sourceRef.unitId}.`);
        }
        const targetRef = stagedCatalog.createDocumentRef(sourceRef, "de");
        targets.push(
          await stagedCatalog.reconcileDocument({
            ref: targetRef,
            source,
            target: await stagedCatalog.loadDocument(targetRef),
          }),
        );
      }
      for (const target of targets) {
        const entry = target.entries[0];
        if (!entry) {
          throw new Error(`Missing bundle entry ${target.ref.unitId}.`);
        }
        entry.value = `${String(entry.value)} (neu)`;
        await stagedCatalog.writeDocument(target);
      }
      return true;
    });

    const committed = JSON.parse(
      await fs.readFile(path.join(bundleRoot, "de.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    expect(committed).toEqual({
      common: { home: "Zuhause (neu)" },
      demo: { cta: "Los (neu)" },
    });
  });

  it("discards normalized staged output and state when an audit provider throws", async () => {
    const test = await createHarness("Old claim");

    await expect(
      runStagedCatalogTransaction(test.config, async (staged) => {
        await writeStagedTarget(staged, "Unsafe claim");
        await staged.state.save({ entries: { unsafe: {} as never }, version: 2 });
        throw new Error("audit provider failed");
      }),
    ).rejects.toThrow("audit provider failed");

    expect(await targetValue(test)).toBe("Old claim");
    expect(test.snapshot()).toEqual({ entries: {}, version: 2 });
    expect(test.save).not.toHaveBeenCalled();
    expect(test.lockCount()).toBe(1);
  });

  it.each(["unresolved", "nonconverged"])(
    "discards staged output when semantic audits remain %s",
    async (status) => {
      const test = await createHarness("Old claim");
      const result = await runStagedCatalogTransaction(
        test.config,
        async (staged) => {
          await writeStagedTarget(staged, "Rejected claim");
          await staged.state.save({ entries: { rejected: {} as never }, version: 2 });
          return status;
        },
        () => false,
      );

      expect(result).toBe(status);
      expect(await targetValue(test)).toBe("Old claim");
      expect(test.snapshot()).toEqual({ entries: {}, version: 2 });
      expect(test.save).not.toHaveBeenCalled();
    },
  );

  it("stages new targets and collapses nested core locks into one real lock", async () => {
    const test = await createHarness();

    await runStagedCatalogTransaction(test.config, async (staged) => {
      await staged.state.withLock(async () => {
        await writeStagedTarget(staged, "New target");
      });
      await staged.state.withLock(async () => {
        expect((await writeStagedTarget(staged, "Repaired target")).entries[0]?.value).toBe(
          "Repaired target",
        );
      });
      expect(await targetValue(test)).toBeUndefined();
      return true;
    });

    expect(await targetValue(test)).toBe("Repaired target");
    expect(test.lockCount()).toBe(1);
  });

  it("rolls existing document bytes back when a commit write fails", async () => {
    const test = await createHarness("Old claim");
    const realPath = path.join(test.localesDir, "de", "common.json");
    const originalBytes = await fs.readFile(realPath);
    const rename = fs.rename.bind(fs);
    let failedPromotion = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === realPath && !failedPromotion) {
        failedPromotion = true;
        throw new Error("commit write failed");
      }
      return rename(from, to);
    });

    await expect(
      runStagedCatalogTransaction(test.config, async (staged) => {
        await writeStagedTarget(staged, "Uncommitted claim");
        return true;
      }),
    ).rejects.toThrow("commit write failed");

    expect(await fs.readFile(realPath)).toEqual(originalBytes);
    expect(test.snapshot()).toEqual({ entries: {}, version: 2 });
  });

  it("restores documents and the exact initial state when state commit fails", async () => {
    const test = await createHarness("Old claim");
    const realPath = path.join(test.localesDir, "de", "common.json");
    const originalBytes = await fs.readFile(realPath);
    test.setFailNextSave(true);

    await expect(
      runStagedCatalogTransaction(test.config, async (staged) => {
        await writeStagedTarget(staged, "Uncommitted claim");
        await staged.state.save({ entries: { changed: {} as never }, version: 2 });
        return true;
      }),
    ).rejects.toThrow("state save failed");

    expect(await fs.readFile(realPath)).toEqual(originalBytes);
    expect(test.snapshot()).toEqual({ entries: {}, version: 2 });
    expect(test.save).toHaveBeenCalledTimes(2);
  });

  it("keeps new-locale scaffolding staged until the caller allows commit", async () => {
    const test = await createHarness();

    await runStagedCatalogTransaction(
      test.config,
      async (staged) => {
        const result = await staged.catalogs[0]?.scaffoldLocale?.({
          fromLocale: "en",
          locale: "de",
          strategy: "copy-source",
        });
        expect(result).toMatchObject({ createdDocuments: 1, locale: "de" });
        expect(await writeStagedTarget(staged, "Scaffolded target")).toBeDefined();
        return false;
      },
      (converged) => converged,
    );

    expect(await targetValue(test)).toBeUndefined();
  });

  it.each([
    ["after-journal-prepared", "Old claim", "old-target"],
    ["after-document-write", "Old claim", "old-target"],
    ["after-state-write", "Old claim", "old-target"],
    ["after-rollforward-marker", "Committed claim", "new-target"],
  ] as const)(
    "recovers an abrupt termination at %s without retaining mixed content and state",
    async (faultPoint, expectedClaim, expectedDigest) => {
      const test = await createHarness("Old claim");
      const rootDir = path.dirname(test.localesDir);
      let injected = false;
      const initialEntry = {
        catalogId: "namespace-json",
        jsonPointer: "/claim",
        locale: "de",
        origin: "generated" as const,
        sourceDigest: "source",
        status: "synced" as const,
        targetDigest: "old-target",
        unitId: "common",
        updatedAt: "2026-07-21T00:00:00.000Z",
      };
      const initialState: SyncStateSnapshot = {
        entries: {
          claim: initialEntry,
        },
        version: 2,
      };
      const state = createShardedJsonStateStore({
        rootDir,
        transactionFaultInjector(point: DurableTransactionFaultPoint) {
          if (!injected && point === faultPoint) {
            injected = true;
            return "simulate-crash";
          }
          return undefined;
        },
      });
      await state.save(initialState);
      const config: AiTranslateConfig = { ...test.config, state };
      const nextState: SyncStateSnapshot = {
        entries: {
          claim: {
            ...initialEntry,
            targetDigest: "new-target",
            updatedAt: "2026-07-21T00:01:00.000Z",
          },
        },
        version: 2,
      };

      await expect(
        runStagedCatalogTransaction(config, async (staged) => {
          await writeStagedTarget(staged, "Committed claim");
          await staged.state.save(nextState);
          return true;
        }),
      ).rejects.toThrow("Simulated abrupt process termination");

      // A fresh process/store recovers the journal before exposing the lock to
      // the next operation. Recovery is repeatable if it is interrupted too.
      const restarted = createShardedJsonStateStore({ rootDir });
      const recovered = await restarted.withLock(async () => ({
        claim: await targetValue(test),
        state: await restarted.load(),
      }));
      expect(recovered.claim).toBe(expectedClaim);
      expect(Object.values(recovered.state.entries)[0]?.targetDigest).toBe(expectedDigest);
      await expect(
        fs.access(path.join(rootDir, ".ai-translate", "translation-transaction.json")),
      ).rejects.toThrow(/ENOENT/u);
    },
  );

  it("rolls durable documents and sharded state back after an ordinary commit error", async () => {
    const test = await createHarness("Old claim");
    const rootDir = path.dirname(test.localesDir);
    const state = createShardedJsonStateStore({ rootDir });
    const initialEntry = {
      catalogId: "namespace-json",
      jsonPointer: "/claim",
      locale: "de",
      origin: "generated" as const,
      sourceDigest: "source",
      status: "synced" as const,
      targetDigest: "old-target",
      unitId: "common",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const initialState: SyncStateSnapshot = {
      entries: {
        claim: initialEntry,
      },
      version: 2,
    };
    await state.save(initialState);
    const stateShard = path.join(
      rootDir,
      ".ai-translate",
      "state",
      "namespace-json",
      "common.json",
    );
    const rename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!failed && String(to) === stateShard) {
        failed = true;
        throw new Error("state shard promotion failed");
      }
      await rename(from, to);
    });

    await expect(
      runStagedCatalogTransaction({ ...test.config, state }, async (staged) => {
        await writeStagedTarget(staged, "Uncommitted claim");
        await staged.state.save({
          entries: {
            claim: {
              ...initialEntry,
              targetDigest: "new-target",
            },
          },
          version: 2,
        });
        return true;
      }),
    ).rejects.toThrow("state shard promotion failed");

    expect(await targetValue(test)).toBe("Old claim");
    expect(Object.values((await state.load()).entries)[0]?.targetDigest).toBe("old-target");
    await expect(
      fs.access(path.join(rootDir, ".ai-translate", "translation-transaction.json")),
    ).rejects.toThrow(/ENOENT/u);
  });

  it("retries recovery idempotently when recovery itself is interrupted", async () => {
    const test = await createHarness("Old claim");
    const rootDir = path.dirname(test.localesDir);
    let injected = false;
    const state = createShardedJsonStateStore({
      rootDir,
      transactionFaultInjector(point) {
        if (!injected && point === "after-document-write") {
          injected = true;
          return "simulate-crash";
        }
        return undefined;
      },
    });
    await state.save({ entries: {}, version: 2 });
    await expect(
      runStagedCatalogTransaction({ ...test.config, state }, async (staged) => {
        await writeStagedTarget(staged, "Interrupted claim");
        await staged.state.save({ entries: { changed: {} as never }, version: 2 });
        return true;
      }),
    ).rejects.toThrow("Simulated abrupt process termination");

    const realPath = path.join(test.localesDir, "de", "common.json");
    const rename = fs.rename.bind(fs);
    let recoveryFailed = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!recoveryFailed && String(to) === realPath) {
        recoveryFailed = true;
        throw new Error("recovery interrupted");
      }
      await rename(from, to);
    });
    const firstRestart = createShardedJsonStateStore({ rootDir });
    await expect(firstRestart.withLock(async () => undefined)).rejects.toThrow(
      "recovery interrupted",
    );
    renameSpy.mockRestore();

    const secondRestart = createShardedJsonStateStore({ rootDir });
    await expect(secondRestart.withLock(async () => undefined)).resolves.toBeUndefined();
    expect(await targetValue(test)).toBe("Old claim");
    expect((await secondRestart.load()).entries).toEqual({});
  });

  it("does not create a durable journal for a no-op transaction", async () => {
    const test = await createHarness("Old claim");
    const rootDir = path.dirname(test.localesDir);
    const state = createShardedJsonStateStore({
      rootDir,
      transactionFaultInjector: () => "simulate-crash",
    });

    await expect(
      runStagedCatalogTransaction({ ...test.config, state }, async () => "no-op"),
    ).resolves.toBe("no-op");
    expect(await targetValue(test)).toBe("Old claim");
    await expect(
      fs.access(path.join(rootDir, ".ai-translate", "translation-transaction.json")),
    ).rejects.toThrow(/ENOENT/u);
  });
});
