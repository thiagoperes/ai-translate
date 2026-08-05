import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { createJsonStateStore, createNamespaceJsonCatalog, importStartupV1State } from "../src/index";
import { reconcileJsonRoot } from "../src/shared";

describe("json state store", () => {
  it("loads and saves versioned state", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-state-"));
    const store = createJsonStateStore({ rootDir });
    const initial = await store.load();
    expect(initial).toEqual({
      entries: {},
      version: 2,
    });

    await store.save({
      entries: {
        "fr::namespace-json::common::/cta": {
          catalogId: "namespace-json",
          jsonPointer: "/cta",
          locale: "fr",
          origin: "generated",
          sourceDigest: "a",
          status: "synced",
          targetDigest: "b",
          translationContextDigest: "ctx",
          unitId: "common",
          updatedAt: "2026-03-17T00:00:00.000Z",
        },
      },
      version: 2,
    });

    const saved = await store.load();
    expect(saved.entries["fr::namespace-json::common::/cta"]?.targetDigest).toBe("b");
    expect(saved.version).toBe(2);
  });

  it("upgrades legacy v1 snapshots to state v2 on load", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-state-v1-"));
    await fs.mkdir(path.join(rootDir, ".ai-translate"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".ai-translate", "translation-state.json"),
      JSON.stringify({
        entries: {
          "fr::common::/cta": {
            jsonPointer: "/cta",
            locale: "fr",
            origin: "generated",
            sourceDigest: "a",
            status: "synced",
            targetDigest: "b",
            unitId: "common",
            updatedAt: "2026-03-17T00:00:00.000Z",
          },
        },
        version: 1,
      }),
      "utf8",
    );

    const store = createJsonStateStore({ rootDir });
    const loaded = await store.load();

    expect(loaded.version).toBe(2);
    expect(loaded.entries["fr::common::/cta"]?.targetDigest).toBe("b");
  });

  it("imports startup v1 hashes as legacy-aware state", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-import-"));
    const localesDir = path.join(rootDir, "locales");
    await fs.mkdir(path.join(localesDir, "en"), { recursive: true });
    await fs.mkdir(path.join(localesDir, "fr"), { recursive: true });

    await fs.writeFile(
      path.join(localesDir, "en", "common.json"),
      JSON.stringify({
        greeting: "Hello",
        shortcuts: {
          profile: "⇧⌘P",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(localesDir, "fr", "common.json"),
      JSON.stringify({
        greeting: "Bonjour",
        shortcuts: {
          profile: "⇧⌘P",
        },
      }),
      "utf8",
    );
    const legacyFilePath = path.join(rootDir, "translation-lock.json");
    await fs.writeFile(
      legacyFilePath,
      JSON.stringify({
        hashes: {
          common: {
            greeting: "legacy-hash",
          },
        },
        overrides: {
          common: {
            greeting: true,
          },
        },
      }),
      "utf8",
    );

    const catalog = createNamespaceJsonCatalog({
      rootDir: localesDir,
      sourceLocale: "en",
    });

    const imported = await importStartupV1State({
      catalogs: [catalog],
      legacyFilePath,
      sourceLocale: "en",
      targetLocales: ["fr"],
    });

    expect(imported.entries["fr::namespace-json::common::/greeting"]?.origin).toBe(
      "legacy-unknown",
    );
    expect(imported.entries["fr::namespace-json::common::/greeting"]?.catalogId).toBe(
      "namespace-json",
    );
    expect(
      imported.entries["fr::namespace-json::common::/shortcuts/profile"]?.origin,
    ).toBe("generated");
    expect(imported.version).toBe(2);
  });

  it("rejects invalid persisted state files", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-invalid-state-"));
    await fs.mkdir(path.join(rootDir, ".ai-translate"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".ai-translate", "translation-state.json"),
      JSON.stringify({ entries: [], version: 2 }),
      "utf8",
    );

    const store = createJsonStateStore({ rootDir });

    await expect(store.load()).rejects.toThrow(
      `Invalid ai-translate state file at ${path.join(rootDir, ".ai-translate", "translation-state.json")}.`,
    );
  });

  it("runs withLock operations exclusively and releases the lock file", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-lock-"));
    const store = createJsonStateStore({ retryDelayMs: 5, rootDir, timeoutMs: 2_000 });
    const lockPath = path.join(rootDir, ".ai-translate", "translation-sync.lock");

    const result = await store.withLock(async () => {
      await expect(fs.readFile(lockPath, "utf8")).resolves.toContain("acquiredAt");
      return "locked-result";
    });
    expect(result).toBe("locked-result");
    await expect(fs.access(lockPath)).rejects.toThrow();

    // A held lock forces the next caller to wait until it is released.
    let releaseOrder = "";
    await Promise.all([
      store.withLock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        releaseOrder += "first;";
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await store.withLock(async () => {
          releaseOrder += "second;";
        });
      })(),
    ]);
    expect(releaseOrder).toBe("first;second;");
  });

  it("times out when the lock is already held", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-lock-timeout-"));
    const store = createJsonStateStore({ retryDelayMs: 5, rootDir, timeoutMs: 30 });
    const lockPath = path.join(rootDir, ".ai-translate", "translation-sync.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: 0 }), "utf8");

    await expect(store.withLock(async () => "unreachable")).rejects.toThrow(
      `Timed out waiting for ai-translate lock at ${lockPath}.`,
    );
  });

  it("reconciles JSON roots by keeping target leaves at stable addresses", () => {
    const reconciled = reconcileJsonRoot(
      { changed: "New English", untouched: "Same English", added: "Fresh English" },
      { changed: "Ancienne traduction", untouched: "Même traduction" },
    );
    expect(reconciled).toEqual({
      added: "Fresh English",
      changed: "Ancienne traduction",
      untouched: "Même traduction",
    });

    // Without a target root the source is cloned as-is.
    expect(reconcileJsonRoot({ greeting: "Hello" }, undefined)).toEqual({
      greeting: "Hello",
    });
  });
});
