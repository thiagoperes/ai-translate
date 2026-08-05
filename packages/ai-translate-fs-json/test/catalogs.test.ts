import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { addressToJsonPointer, makeStateKey } from "@ai-translate/core/address";
import { digestValue } from "@ai-translate/core/hash";
import { syncCatalogs } from "@ai-translate/core/sync";
import type {
  ReconcileHistoryEntry,
  SyncStateSnapshot,
  SyncStateStore,
} from "@ai-translate/core/types";

import {
  createBundleJsonCatalog,
  createLocalizedJsonDocument,
  createNamespaceJsonCatalog,
} from "../src/index";

async function createFixtureWorkspace(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-fs-json-"));
  await fs.cp(new URL("./fixtures", import.meta.url), rootDir, { recursive: true });
  return rootDir;
}

function createMemoryStateStore(): SyncStateStore & { snapshot: SyncStateSnapshot } {
  const snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
  return {
    load: () => Promise.resolve(structuredClone(snapshot)),
    save: (next) => {
      snapshot.entries = structuredClone(next.entries);
      snapshot.version = next.version;
      return Promise.resolve();
    },
    snapshot,
    withLock: (operation) => operation(),
  };
}

describe("JSON catalogs", () => {
  it("discovers namespace files and preserves keys with spaces", async () => {
    const catalog = createNamespaceJsonCatalog({
      rootDir: new URL("./fixtures/startup-source", import.meta.url).pathname,
      sourceLocale: "en",
    });

    const refs = await catalog.listDocumentRefs("en");
    expect(refs.map((ref) => ref.unitId)).toEqual(["common"]);
    const [ref] = refs;
    expect(ref).toBeDefined();
    if (!ref) {
      throw new Error("Expected a namespace JSON fixture.");
    }

    const document = await catalog.loadDocument(ref);
    expect(document?.entries.map((entry) => addressToJsonPointer(entry.address))).toContain(
      "/routes/charge insights",
    );
  });

  it("splits bundle JSON documents by top-level key", async () => {
    const catalog = createBundleJsonCatalog({
      rootDir: new URL("./fixtures/acme-messages", import.meta.url).pathname,
      sourceLocale: "en",
      split: "top-level-key",
      unitPrefix: "messages",
    });

    const refs = await catalog.listDocumentRefs("en");
    expect(refs.map((ref) => ref.unitId)).toEqual(["messages/common", "messages/demo"]);
  });

  it("loads localized whole-document JSON files", async () => {
    const catalog = createLocalizedJsonDocument({
      rootDir: new URL("./fixtures/acme-home-content", import.meta.url).pathname,
      sourceLocale: "en",
      unitId: "home-content",
    });

    const [ref] = await catalog.listDocumentRefs("en");
    expect(ref).toBeDefined();
    if (!ref) {
      throw new Error("Expected a localized JSON fixture.");
    }

    const document = await catalog.loadDocument(ref);
    expect(document?.entries.map((entry) => addressToJsonPointer(entry.address))).toEqual([
      "/teams/tabs/0/key",
      "/teams/tabs/0/label",
      "/teams/tabs/0/captionIndex",
    ]);
  });

  it("reconciles, writes, and scaffolds namespace JSON catalogs", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createNamespaceJsonCatalog({
      rootDir: path.join(rootDir, "startup-source"),
      sourceLocale: "en",
    });

    const [sourceRef] = await catalog.listDocumentRefs("en");
    expect(sourceRef).toBeDefined();
    if (!sourceRef) {
      throw new Error("Expected a namespace JSON source fixture.");
    }

    const sourceDocument = await catalog.loadDocument(sourceRef);
    expect(sourceDocument).toBeDefined();
    if (!sourceDocument) {
      throw new Error("Expected a loaded namespace JSON source document.");
    }

    const frRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({
      ref: frRef,
      source: sourceDocument,
      target: null,
    });
    const ctaEntry = reconciled.entries.find(
      (entry) => addressToJsonPointer(entry.address) === "/getStartedWithPlan",
    );
    expect(ctaEntry).toBeDefined();
    if (!ctaEntry) {
      throw new Error("Expected a translatable namespace entry.");
    }

    ctaEntry.value = "Commencer avec {{plan}}";
    await catalog.writeDocument(reconciled);

    const written = JSON.parse(await fs.readFile(frRef.path, "utf8")) as {
      getStartedWithPlan: string;
    };
    expect(written.getStartedWithPlan).toBe("Commencer avec {{plan}}");

    const scaffoldResult = await catalog.scaffoldLocale?.({
      fromLocale: "en",
      locale: "de",
      strategy: "copy-source",
    });
    expect(scaffoldResult).toEqual({
      catalogId: "namespace-json",
      createdDocuments: 1,
      locale: "de",
      skippedDocuments: 0,
      strategy: "copy-source",
    });
    const scaffolded = JSON.parse(
      await fs.readFile(path.join(rootDir, "startup-source", "de", "common.json"), "utf8"),
    ) as { getStartedWithPlan: string };
    expect(scaffolded.getStartedWithPlan).toBe("Get Started with {{plan}}");
  });

  it("reconciles and writes bundle JSON catalogs by top-level key", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createBundleJsonCatalog({
      rootDir: path.join(rootDir, "acme-messages"),
      sourceLocale: "en",
      split: "top-level-key",
      unitPrefix: "messages",
    });

    const refs = await catalog.listDocumentRefs("en");
    const sourceRef = refs.find((ref) => ref.unitId === "messages/common");
    expect(sourceRef).toBeDefined();
    if (!sourceRef) {
      throw new Error("Expected a bundle JSON source fixture.");
    }

    const sourceDocument = await catalog.loadDocument(sourceRef);
    expect(sourceDocument).toBeDefined();
    if (!sourceDocument) {
      throw new Error("Expected a loaded bundle JSON source document.");
    }

    const frRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({
      ref: frRef,
      source: sourceDocument,
      target: null,
    });
    const homeEntry = reconciled.entries.find(
      (entry) => addressToJsonPointer(entry.address) === "/home",
    );
    expect(homeEntry).toBeDefined();
    if (!homeEntry) {
      throw new Error("Expected a bundle JSON home entry.");
    }

    homeEntry.value = "Accueil";
    await catalog.writeDocument(reconciled);

    const written = JSON.parse(await fs.readFile(frRef.path, "utf8")) as {
      common: { home: string };
    };
    expect(written.common.home).toBe("Accueil");

    const scaffoldResult = await catalog.scaffoldLocale?.({
      fromLocale: "en",
      locale: "de",
      strategy: "copy-source",
    });
    expect(scaffoldResult).toEqual({
      catalogId: "bundle-json",
      createdDocuments: 2,
      locale: "de",
      skippedDocuments: 0,
      strategy: "copy-source",
    });
    const scaffolded = JSON.parse(
      await fs.readFile(path.join(rootDir, "acme-messages", "de.json"), "utf8"),
    ) as { common: { home: string } };
    expect(scaffolded.common.home).toBe("Home");
  });

  it("reconciles and writes localized whole-document JSON files", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createLocalizedJsonDocument({
      rootDir: path.join(rootDir, "acme-home-content"),
      sourceLocale: "en",
      unitId: "home-content",
    });

    const [sourceRef] = await catalog.listDocumentRefs("en");
    expect(sourceRef).toBeDefined();
    if (!sourceRef) {
      throw new Error("Expected a localized JSON source fixture.");
    }

    const sourceDocument = await catalog.loadDocument(sourceRef);
    expect(sourceDocument).toBeDefined();
    if (!sourceDocument) {
      throw new Error("Expected a loaded localized JSON source document.");
    }

    const frRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({
      ref: frRef,
      source: sourceDocument,
      target: null,
    });
    const labelEntry = reconciled.entries.find(
      (entry) => addressToJsonPointer(entry.address) === "/teams/tabs/0/label",
    );
    expect(labelEntry).toBeDefined();
    if (!labelEntry) {
      throw new Error("Expected a localized JSON label entry.");
    }

    labelEntry.value = "Dirigeants";
    await catalog.writeDocument(reconciled);

    const written = JSON.parse(await fs.readFile(frRef.path, "utf8")) as {
      teams: { tabs: { label: string }[] };
    };
    expect(written.teams.tabs[0]?.label).toBe("Dirigeants");

    const scaffoldResult = await catalog.scaffoldLocale?.({
      fromLocale: "en",
      locale: "de",
      strategy: "copy-source",
    });
    expect(scaffoldResult).toEqual({
      catalogId: "localized-json",
      createdDocuments: 1,
      locale: "de",
      skippedDocuments: 0,
      strategy: "copy-source",
    });
    const scaffolded = JSON.parse(
      await fs.readFile(path.join(rootDir, "acme-home-content", "de.json"), "utf8"),
    ) as { teams: { tabs: { label: string }[] } };
    expect(scaffolded.teams.tabs[0]?.label).toBe("Team Leads");
  });

  it("rebases inserted and reordered indexed entries by stable identity and history", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-array-rebase-"));
    await fs.writeFile(
      path.join(rootDir, "en.json"),
      JSON.stringify({
        items: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "fr.json"),
      JSON.stringify({
        items: [
          { id: "a", label: "fr:Alpha" },
          { id: "b", label: "fr:Beta" },
        ],
      }),
      "utf8",
    );
    const catalog = createLocalizedJsonDocument({
      rootDir,
      sourceLocale: "en",
      unitId: "content",
    });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source ref.");
    }
    const source = await catalog.loadDocument(sourceRef);
    const targetRef = catalog.createDocumentRef(sourceRef, "fr");
    const target = await catalog.loadDocument(targetRef);
    if (!source || !target) {
      throw new Error("Expected source and target documents.");
    }
    const targetByPointer = new Map(
      target.entries.map((entry) => [addressToJsonPointer(entry.address), entry]),
    );
    const history: ReconcileHistoryEntry[] = source.entries.map((entry) => {
      const pointer = addressToJsonPointer(entry.address);
      const targetEntry = targetByPointer.get(pointer);
      if (!targetEntry) {
        throw new Error(`Missing target entry ${pointer}.`);
      }
      return {
        catalogId: "localized-json",
        jsonPointer: pointer,
        locale: "fr",
        origin: "generated" as const,
        sourceDigest: digestValue(entry.value),
        stateKey: makeStateKey("fr", "localized-json", "content", pointer),
        status: "synced" as const,
        targetDigest: digestValue(targetEntry.value),
        unitId: "content",
        updatedAt: "2026-07-21T00:00:00.000Z",
      };
    });

    await fs.writeFile(
      path.join(rootDir, "en.json"),
      JSON.stringify({
        items: [
          { id: "x", label: "Extra" },
          { id: "b", label: "Beta" },
          { id: "a", label: "Alpha" },
        ],
      }),
      "utf8",
    );
    const changedSource = await catalog.loadDocument(sourceRef);
    if (!changedSource) {
      throw new Error("Expected changed source.");
    }
    const rebased = await catalog.reconcileDocument({
      history,
      ref: targetRef,
      source: changedSource,
      target,
    });
    const labels = rebased.entries
      .filter((entry) => {
        const last = entry.address.at(-1);
        return last?.kind === "key" && last.key === "label";
      })
      .map((entry) => entry.value);

    expect(labels).toEqual(["Extra", "fr:Beta", "fr:Alpha"]);
    expect(rebased.reconciliation?.previousPointers).toMatchObject({
      "/items/2/label": "/items/0/label",
    });

    await fs.writeFile(
      path.join(rootDir, "en.json"),
      JSON.stringify({ items: [{ id: "b", label: "Beta" }] }),
      "utf8",
    );
    const reducedSource = await catalog.loadDocument(sourceRef);
    if (!reducedSource) {
      throw new Error("Expected reduced source.");
    }
    const reduced = await catalog.reconcileDocument({
      history,
      ref: targetRef,
      source: reducedSource,
      target,
    });
    expect(reduced.reconciliation?.retiredStateKeys).toContain(
      makeStateKey("fr", "localized-json", "content", "/items/0/label"),
    );
  });

  it("does not create or partially overwrite localized JSON when an inserted entry fails", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-json-atomic-"));
    const sourcePath = path.join(rootDir, "en.json");
    const targetPath = path.join(rootDir, "fr.json");
    await fs.writeFile(sourcePath, JSON.stringify({ items: [{ id: 1, label: "Alpha" }] }), "utf8");
    const catalog = createLocalizedJsonDocument({
      rootDir,
      sourceLocale: "en",
      unitId: "content",
    });
    const state = createMemoryStateStore();
    let rejectedSource = "Alpha";
    const config = {
      catalogs: [catalog],
      provider: {
        translate: ({ requests }: { requests: readonly { key: string; sourceText: string }[] }) =>
          Promise.resolve(
            requests.map((request) => ({
              key: request.key,
              translation:
                request.sourceText === rejectedSource ? "INVALID" : `fr:${request.sourceText}`,
            })),
          ),
      },
      sourceLocale: "en",
      state,
      targetLocales: ["fr"],
      validators: [
        ({ sourceText, targetText }: { sourceText: string; targetText: string }) =>
          sourceText === rejectedSource && targetText === "INVALID"
            ? {
                code: "invalid-insertion",
                message: "Reject insertion.",
                severity: "error" as const,
              }
            : null,
      ],
    };

    const missingTargetFailure = await syncCatalogs(config);
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(missingTargetFailure.documents[0]).toMatchObject({
      failedEntries: 1,
      wroteFile: false,
    });
    expect(Object.values(state.snapshot.entries)).toContainEqual(
      expect.objectContaining({ jsonPointer: "/items/0/label", status: "failed" }),
    );

    rejectedSource = "";
    await syncCatalogs(config);
    const beforeInsertionFailure = await fs.readFile(targetPath, "utf8");
    const originalAlphaStateKey = makeStateKey("fr", "localized-json", "content", "/items/0/label");
    const originalAlphaState = structuredClone(state.snapshot.entries[originalAlphaStateKey]);
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        items: [
          { id: 2, label: "Beta" },
          { id: 1, label: "Alpha" },
        ],
      }),
      "utf8",
    );
    rejectedSource = "Beta";

    const insertionFailure = await syncCatalogs(config);
    expect(await fs.readFile(targetPath, "utf8")).toBe(beforeInsertionFailure);
    expect(insertionFailure.documents[0]).toMatchObject({ failedEntries: 1, wroteFile: false });
    expect(state.snapshot.entries[originalAlphaStateKey]).toEqual(originalAlphaState);

    rejectedSource = "";
    const repaired = await syncCatalogs(config);
    expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({
      items: [
        { id: 2, label: "fr:Beta" },
        { id: 1, label: "fr:Alpha" },
      ],
    });
    expect(repaired.documents[0]).toMatchObject({
      failedEntries: 0,
      translatedEntries: 1,
      wroteFile: true,
    });
  });
});
