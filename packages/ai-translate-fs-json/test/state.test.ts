import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { digestValue } from "@ai-translate/core/hash";

import {
  adoptExistingTranslations,
  createJsonStateStore,
  createNamespaceJsonCatalog,
} from "../src/index";
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

  describe("adoptExistingTranslations", () => {
    async function seedCatalog(source: unknown, target: unknown) {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-adopt-"));
      const localesDir = path.join(rootDir, "locales");
      await fs.mkdir(path.join(localesDir, "en"), { recursive: true });
      await fs.mkdir(path.join(localesDir, "fr"), { recursive: true });
      await fs.writeFile(
        path.join(localesDir, "en", "common.json"),
        JSON.stringify(source),
        "utf8",
      );
      await fs.writeFile(
        path.join(localesDir, "fr", "common.json"),
        JSON.stringify(target),
        "utf8",
      );

      return createNamespaceJsonCatalog({ rootDir: localesDir, sourceLocale: "en" });
    }

    it("records translated text as legacy-unknown, since the catalogs carry no provenance", async () => {
      const catalog = await seedCatalog(
        { greeting: "Hello", shortcuts: { profile: "Profile" } },
        { greeting: "Bonjour", shortcuts: { profile: "Profil" } },
      );

      const result = await adoptExistingTranslations({
        catalogs: [catalog],
        sourceLocale: "en",
        targetLocales: ["fr"],
      });

      expect(result.adopted).toBe(2);
      expect(result.untranslated).toBe(0);
      expect(result.identicalToSource).toBe(0);
      expect(result.state.version).toBe(2);

      const entry = result.state.entries["fr::namespace-json::common::/greeting"];
      expect(entry?.origin).toBe("legacy-unknown");
      expect(entry?.status).toBe("synced");
      expect(entry?.catalogId).toBe("namespace-json");
      expect(entry?.targetDigest).toBe(digestValue("Bonjour"));
      expect(entry?.sourceDigest).toBe(digestValue("Hello"));
    });

    it("leaves missing and blank targets out of state so the next sync still translates them", async () => {
      const catalog = await seedCatalog(
        { blank: "Save", missing: "Cancel", present: "Hello" },
        { blank: "", present: "Bonjour" },
      );

      const result = await adoptExistingTranslations({
        catalogs: [catalog],
        sourceLocale: "en",
        targetLocales: ["fr"],
      });

      expect(result.adopted).toBe(1);
      expect(result.untranslated).toBe(2);
      expect(Object.keys(result.state.entries)).toEqual([
        "fr::namespace-json::common::/present",
      ]);
    });

    it("adopts targets identical to the source by default", async () => {
      const catalog = await seedCatalog(
        { brand: "Excel", greeting: "Hello" },
        { brand: "Excel", greeting: "Bonjour" },
      );

      const result = await adoptExistingTranslations({
        catalogs: [catalog],
        sourceLocale: "en",
        targetLocales: ["fr"],
      });

      expect(result.adopted).toBe(2);
      expect(result.identicalToSource).toBe(1);
      expect(result.state.entries["fr::namespace-json::common::/brand"]).toBeDefined();
    });

    it("counts but omits identical targets when asked to skip them", async () => {
      const catalog = await seedCatalog(
        { brand: "Excel", greeting: "Hello" },
        { brand: "Excel", greeting: "Bonjour" },
      );

      const result = await adoptExistingTranslations({
        catalogs: [catalog],
        identicalToSource: "skip",
        sourceLocale: "en",
        targetLocales: ["fr"],
      });

      expect(result.adopted).toBe(1);
      expect(result.identicalToSource).toBe(1);
      expect(result.state.entries["fr::namespace-json::common::/brand"]).toBeUndefined();
    });

    it("ignores non-string source values", async () => {
      const catalog = await seedCatalog(
        { count: 3, enabled: true, greeting: "Hello" },
        { count: 3, enabled: true, greeting: "Bonjour" },
      );

      const result = await adoptExistingTranslations({
        catalogs: [catalog],
        sourceLocale: "en",
        targetLocales: ["fr"],
      });

      expect(result.adopted).toBe(1);
      expect(Object.keys(result.state.entries)).toEqual([
        "fr::namespace-json::common::/greeting",
      ]);
    });

    it("treats a locale with no document at all as fully untranslated", async () => {
      const catalog = await seedCatalog({ greeting: "Hello" }, { greeting: "Bonjour" });

      const result = await adoptExistingTranslations({
        catalogs: [catalog],
        sourceLocale: "en",
        targetLocales: ["fr", "de"],
      });

      expect(result.adopted).toBe(1);
      expect(result.untranslated).toBe(1);
    });
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
        await new Promise((resolve) => { setTimeout(resolve, 25); });
        releaseOrder += "first;";
      }),
      (async () => {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
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
