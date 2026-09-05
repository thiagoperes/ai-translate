import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { addressToJsonPointer, makeStateKey } from "@ai-translate/core/address";
import { digestValue } from "@ai-translate/core/hash";
import { syncCatalogs } from "@ai-translate/core/sync";
import type {
  ReconcileHistoryEntry,
  SyncStateSnapshot,
  SyncStateStore,
  TranslationRequest,
} from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import { createMarkdocCatalog } from "../src/index";

async function createFixtureWorkspace(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-"));
  await fs.cp(new URL("./fixtures/docs", import.meta.url), rootDir, { recursive: true });
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

describe("createMarkdocCatalog", () => {
  it("translates soft-wrapped paragraphs, list items, and quotes as complete units", async () => {
    const rootDir = await createFixtureWorkspace();
    const raw =
      "# Guide\n\nA paragraph with **important\nwords** and a complete\nsentence.\n\n- A list item that\n  continues here.\n\n> A quotation that\n> continues here.\n\n```js\nconst untouched = 1;\n```\n";
    await fs.writeFile(path.join(rootDir, "en/guide.md"), raw);
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const state = createMemoryStateStore();
    const observed: string[] = [];
    const config = {
      sourceLocale: "en",
      targetLocales: ["de"],
      catalogs: [catalog],
      state,
      provider: {
        async translate({ requests }: { requests: readonly TranslationRequest[] }) {
          observed.push(...requests.map(({ sourceText }) => sourceText));
          return requests.map(({ key, sourceText }) => ({ key, translation: `DE ${sourceText}` }));
        },
      },
    };
    const result = await syncCatalogs(config);
    expect(result.metrics.failedEntries).toBe(0);
    expect(observed).toEqual([
      "Guide",
      "A paragraph with **important words** and a complete sentence.",
      "A list item that continues here.",
      "A quotation that continues here.",
    ]);
    const written = await fs.readFile(path.join(rootDir, "de/guide.md"), "utf8");
    expect(written).toContain("```js\nconst untouched = 1;\n```");
    expect(written).toContain("- DE A list item that continues here.");
    expect(written).toContain("> DE A quotation that continues here.");
    const next = await syncCatalogs(config);
    expect(next.metrics.translatedEntries).toBe(0);
    expect(next.metrics.failedEntries).toBe(0);
    expect(observed).toHaveLength(4);
    expect(await fs.readFile(path.join(rootDir, "en/guide.md"), "utf8")).toBe(raw);
  });

  it("preserves intentional hard breaks instead of merging their lines", async () => {
    const rootDir = await createFixtureWorkspace();
    await fs.writeFile(
      path.join(rootDir, "en/guide.md"),
      "First line  \nSecond line\n\nAnother paragraph.\n",
    );
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [ref] = await catalog.listDocumentRefs("en");
    if (!ref) {
      throw new Error("Missing fixture.");
    }
    const source = await catalog.loadDocument(ref);
    expect(source?.entries.map(({ value }) => value)).toEqual([
      "First line",
      "Second line",
      "Another paragraph.",
    ]);
  });
  it("extracts frontmatter and body lines", async () => {
    const catalog = createMarkdocCatalog({
      rootDir: new URL("./fixtures/docs", import.meta.url).pathname,
      sourceLocale: "en",
    });

    const [ref] = await catalog.listDocumentRefs("en");
    expect(ref).toBeDefined();
    if (!ref) {
      throw new Error("Expected a Markdoc fixture document.");
    }

    const document = await catalog.loadDocument(ref);

    expect(document?.entries.map((entry) => entry.value)).toContain("Fleet guide");
    expect(document?.entries.map((entry) => entry.value)).toContain(
      "Use Acme to keep your fleet moving.",
    );
    expect(document?.entries.map((entry) => entry.value)).toContain("Track expenses in real time.");
    expect(document?.entries.map((entry) => entry.value)).toContain("What Acme solves");
    expect(document?.entries.map((entry) => entry.value)).toContain("Better visibility");
    expect(document?.entries.map((entry) => entry.value)).not.toContain("---");
    expect(document?.entries.map((entry) => entry.value)).not.toContain(":-:");
    expect(
      document?.entries.find(
        (entry) => entry.value === "Fleet guide" && entry.storage === "markdoc",
      )?.meta,
    ).toMatchObject({ contentRole: "heading" });
    expect(
      document?.entries.find(
        (entry) => entry.value === "Fleet guide" && entry.storage === "markdoc",
      )?.meta,
    ).toMatchObject({ structureSignature: "heading:1" });
    expect(
      document?.entries.find((entry) => entry.value === "Use Acme to keep your fleet moving.")
        ?.meta,
    ).toMatchObject({ contentRole: "body" });
    expect(
      document?.entries.find((entry) => entry.value === "What Acme solves")?.meta,
    ).toMatchObject({ contentRole: "table-cell" });
    expect(
      document?.entries.find((entry) => entry.value === "What Acme solves")?.meta,
    ).toMatchObject({ structureSignature: "table-cell:0:of:2" });
  });

  it("reconciles, writes, and scaffolds localized Markdoc documents", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createMarkdocCatalog({
      rootDir,
      sourceLocale: "en",
    });

    const [sourceRef] = await catalog.listDocumentRefs("en");
    expect(sourceRef).toBeDefined();
    if (!sourceRef) {
      throw new Error("Expected a Markdoc source fixture.");
    }

    const sourceDocument = await catalog.loadDocument(sourceRef);
    expect(sourceDocument).toBeDefined();
    if (!sourceDocument) {
      throw new Error("Expected a loaded Markdoc source document.");
    }

    const frRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({
      ref: frRef,
      source: sourceDocument,
      target: null,
    });
    const titleEntry = reconciled.entries.find((entry) => entry.value === "Fleet guide");
    const bulletEntry = reconciled.entries.find(
      (entry) => entry.value === "Track expenses in real time.",
    );
    const tableHeaderEntry = reconciled.entries.find((entry) => entry.value === "What Acme solves");
    const tableValueEntry = reconciled.entries.find((entry) => entry.value === "Better visibility");
    expect(titleEntry).toBeDefined();
    expect(bulletEntry).toBeDefined();
    expect(tableHeaderEntry).toBeDefined();
    expect(tableValueEntry).toBeDefined();
    if (!titleEntry || !bulletEntry || !tableHeaderEntry || !tableValueEntry) {
      throw new Error("Expected title, bullet, and table entries in reconciled Markdoc.");
    }

    titleEntry.value = "Guide flotte";
    bulletEntry.value = "Suivez les depenses en temps reel.";
    tableHeaderEntry.value = "Ce que Acme resout";
    tableValueEntry.value = "Meilleure visibilite";
    await catalog.writeDocument(reconciled);

    const written = await fs.readFile(frRef.path, "utf8");
    expect(written).toContain("title: Guide flotte");
    expect(written).toContain("- Suivez les depenses en temps reel.");
    expect(written).toContain("{% callout %}");
    expect(written).toContain("| :-- | :-: |");
    expect(written).toContain("| Ce que Acme resout | Outcome |");
    expect(written).toContain("| Fuel spend sprawl | Meilleure visibilite |");

    const scaffoldResult = await catalog.scaffoldLocale?.({
      locale: "de",
    });
    expect(scaffoldResult).toMatchObject({
      createdDocuments: 1,
      locale: "de",
      skippedDocuments: 0,
      strategy: "copy-source",
    });
    const scaffolded = await fs.readFile(path.join(rootDir, "de", "guide.md"), "utf8");
    expect(scaffolded).toContain("Fleet guide");
  });

  it("rebases translated body blocks by verified history instead of line position", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source fixture.");
    }
    const source = await catalog.loadDocument(sourceRef);
    if (!source) {
      throw new Error("Expected loaded source.");
    }
    const targetRef = catalog.createDocumentRef(sourceRef, "fr");
    const translated = await catalog.reconcileDocument({ ref: targetRef, source, target: null });
    for (const entry of translated.entries) {
      if (entry.storage === "markdoc" && typeof entry.value === "string") {
        entry.value = `fr:${entry.value}`;
      }
    }
    await catalog.writeDocument(translated);
    const target = await catalog.loadDocument(targetRef);
    if (!target) {
      throw new Error("Expected loaded target.");
    }

    const targetByPointer = new Map(
      target.entries.map((entry) => [addressToJsonPointer(entry.address), entry]),
    );
    const history: ReconcileHistoryEntry[] = source.entries
      .filter((entry) => entry.storage === "markdoc")
      .map((entry) => {
        const pointer = addressToJsonPointer(entry.address);
        const targetEntry = targetByPointer.get(pointer);
        if (!targetEntry) {
          throw new Error(`Missing target ${pointer}.`);
        }
        return {
          catalogId: "markdoc",
          jsonPointer: pointer,
          locale: "fr",
          origin: "generated" as const,
          sourceDigest: digestValue(entry.value),
          stateKey: makeStateKey("fr", "markdoc", "guide.md", pointer),
          status: "synced" as const,
          targetDigest: digestValue(targetEntry.value),
          unitId: "guide.md",
          updatedAt: "2026-07-21T00:00:00.000Z",
        };
      });

    const sourceRaw = await fs.readFile(sourceRef.path, "utf8");
    await fs.writeFile(
      sourceRef.path,
      sourceRaw.replace(
        "Use Acme to keep your fleet moving.",
        "Use Acme to keep your fleet moving.\n\nA newly inserted paragraph.",
      ),
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

    expect(
      rebased.entries.find((entry) => entry.value === "A newly inserted paragraph.")?.value,
    ).toBe("A newly inserted paragraph.");
    expect(rebased.entries.map((entry) => entry.value)).toContain(
      "fr:Track expenses in real time.",
    );
    const movedBullet = rebased.entries.find(
      (entry) => entry.value === "fr:Track expenses in real time.",
    );
    expect(movedBullet).toBeDefined();
    if (!movedBullet) {
      throw new Error("Expected moved bullet.");
    }
    expect(
      rebased.reconciliation?.previousPointers?.[addressToJsonPointer(movedBullet.address)],
    ).toBe("/@node:body.line.9");

    const tamperedRaw = (await fs.readFile(targetRef.path, "utf8")).replace(
      "fr:Track expenses in real time.",
      "tampered translation",
    );
    await fs.writeFile(targetRef.path, tamperedRaw, "utf8");
    const tamperedTarget = await catalog.loadDocument(targetRef);
    if (!tamperedTarget) {
      throw new Error("Expected tampered target.");
    }
    const afterTamper = await catalog.reconcileDocument({
      history,
      ref: targetRef,
      source: changedSource,
      target: tamperedTarget,
    });
    expect(afterTamper.entries.map((entry) => entry.value)).not.toContain("tampered translation");
    expect(afterTamper.reconciliation?.retiredStateKeys).toContain(
      makeStateKey("fr", "markdoc", "guide.md", "/@node:body.line.9"),
    );
  });

  it("fingerprints skipped Markdoc skeleton content", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source fixture.");
    }
    const source = await catalog.loadDocument(sourceRef);
    if (!source) {
      throw new Error("Expected source document.");
    }
    const targetRef = catalog.createDocumentRef(sourceRef, "fr");
    await fs.mkdir(path.dirname(targetRef.path), { recursive: true });
    await fs.writeFile(
      targetRef.path,
      (await fs.readFile(sourceRef.path, "utf8")).replaceAll("callout", "note"),
      "utf8",
    );
    const target = await catalog.loadDocument(targetRef);

    expect(target?.structureDigest).not.toBe(source.structureDigest);
  });

  it("preserves unchanged legacy formatting while validating every changed body entry", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-legacy-"));
    await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "en", "guide.mdoc"),
      [
        "# Automated invoices",
        "",
        "Automated invoices remain visible.",
        "",
        "This release updates another paragraph.",
        "",
      ].join("\n"),
      "utf8",
    );
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source document.");
    }
    const source = await catalog.loadDocument(sourceRef);
    if (!source) {
      throw new Error("Expected loaded source document.");
    }
    const targetRef = catalog.createDocumentRef(sourceRef, "de");
    await fs.mkdir(path.dirname(targetRef.path), { recursive: true });
    await fs.writeFile(
      targetRef.path,
      [
        "# Automatisierte Rechnungen",
        "",
        "Automatisierte **Rechnungen** bleiben sichtbar.",
        "",
        "Dieser Text bleibt zunächst unverändert.",
        "",
      ].join("\n"),
      "utf8",
    );
    const target = await catalog.loadDocument(targetRef);
    if (!target) {
      throw new Error("Expected loaded target document.");
    }
    const sourceLegacyEntry = source.entries.find(
      (entry) => entry.value === "Automated invoices remain visible.",
    );
    const targetLegacyEntry = target.entries.find(
      (entry) => entry.value === "Automatisierte **Rechnungen** bleiben sichtbar.",
    );
    if (!sourceLegacyEntry || !targetLegacyEntry) {
      throw new Error("Expected source and legacy target body entries.");
    }
    const pointer = addressToJsonPointer(sourceLegacyEntry.address);
    const history: ReconcileHistoryEntry[] = [
      {
        catalogId: "markdoc",
        jsonPointer: pointer,
        locale: "de",
        origin: "legacy-unknown",
        sourceDigest: digestValue(sourceLegacyEntry.value),
        stateKey: makeStateKey("de", "markdoc", "guide.mdoc", pointer),
        status: "synced",
        targetDigest: digestValue(targetLegacyEntry.value),
        unitId: "guide.mdoc",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    ];
    const reconciled = await catalog.reconcileDocument({
      history,
      ref: targetRef,
      source,
      target,
    });
    const legacyEntry = reconciled.entries.find(
      (entry) => entry.value === "Automatisierte **Rechnungen** bleiben sichtbar.",
    );
    const changedEntry = reconciled.entries.find(
      (entry) => entry.value === "This release updates another paragraph.",
    );
    if (!legacyEntry || !changedEntry) {
      throw new Error("Expected reconciled legacy and changed body entries.");
    }

    changedEntry.value = "Diese Version aktualisiert einen anderen Absatz.";
    await catalog.writeDocument(reconciled);
    const written = await fs.readFile(targetRef.path, "utf8");
    expect(written).toContain("Automatisierte **Rechnungen** bleiben sichtbar.");
    expect(written).toContain("Diese Version aktualisiert einen anderen Absatz.");

    legacyEntry.value = "Automatisierte **Belege** bleiben sichtbar.";
    await expect(catalog.writeDocument(reconciled)).rejects.toThrow(
      "would change protected Markdown structure",
    );
    expect(await fs.readFile(targetRef.path, "utf8")).toBe(written);
  });

  it("preserves thematic breaks and rejects malformed inline link or image structure", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-structure-"));
    await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "en", "guide.mdoc"),
      [
        "# Guide",
        "",
        "Read [the guide](/guide) and ![the chart](/chart.webp).",
        "",
        "---",
        "",
        "* * *",
        "",
        "_ _ _",
        "",
        "> ---",
        "",
        "- ---",
        "",
        "Costs [estimated] vary and shipping --- costs remain visible.",
        "",
      ].join("\n"),
      "utf8",
    );
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source document.");
    }
    const source = await catalog.loadDocument(sourceRef);
    if (!source) {
      throw new Error("Expected loaded source document.");
    }

    expect(source.entries.map((entry) => entry.value)).not.toContain("---");
    expect(source.entries.map((entry) => entry.value)).not.toContain("* * *");
    expect(source.entries.map((entry) => entry.value)).not.toContain("_ _ _");
    expect(source.entries.map((entry) => entry.value)).toContain(
      "Costs [estimated] vary and shipping --- costs remain visible.",
    );

    const targetRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({ ref: targetRef, source, target: null });
    const inlineEntry = reconciled.entries.find(
      (entry) => entry.value === "Read [the guide](/guide) and ![the chart](/chart.webp).",
    );
    const proseEntry = reconciled.entries.find(
      (entry) => entry.value === "Costs [estimated] vary and shipping --- costs remain visible.",
    );
    if (!inlineEntry || !proseEntry) {
      throw new Error("Expected inline Markdown and ordinary prose entries.");
    }
    inlineEntry.value = "Lisez le guide](/guide) et [le graphique](/chart.webp).";
    proseEntry.value = "Les coûts estimés et les frais de livraison restent visibles.";

    await expect(catalog.writeDocument(reconciled)).rejects.toThrow(
      "would change protected Markdown structure",
    );
    await expect(fs.access(targetRef.path)).rejects.toMatchObject({ code: "ENOENT" });

    inlineEntry.value = "Lisez [le guide](/guide) et ![le graphique](/chart.webp).";
    await catalog.writeDocument(reconciled);
    const written = await fs.readFile(targetRef.path, "utf8");
    expect(written).toContain("Lisez [le guide](/guide) et ![le graphique](/chart.webp).");
    expect(written).toContain("\n---\n");
    expect(written).toContain("\n* * *\n");
    expect(written).toContain("\n_ _ _\n");
    expect(written).toContain("\n> ---\n");
    expect(written).toContain("\n- ---\n");
    expect(written).toContain("Les coûts estimés et les frais de livraison restent visibles.");
  });

  it("validates path-scoped replacements against English tokens while preserving localized backing content", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-scoped-"));
    await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "nl"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "en", "guide.mdoc"),
      [
        "# Guide",
        "",
        "Current prose with [**source label**](/guide).",
        "",
        "Unchanged English paragraph.",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "nl", "guide.mdoc"),
      [
        "# Gids",
        "",
        "Old prose with **extra claim** and [**old label**](/guide).",
        "",
        "Deze bestaande vertaling blijft staan.",
        "",
      ].join("\n"),
      "utf8",
    );

    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const state = createMemoryStateStore();
    const pointer = "/@node:body.line.2";
    let providerCalls = 0;
    const result = await syncCatalogs(
      {
        catalogs: [catalog],
        provider: {
          translate: ({ requests }) => {
            providerCalls += 1;
            return Promise.resolve(
              requests.map((request) => ({
                key: request.key,
                translation: "Actuele tekst met [**doellabel**](/guide).",
              })),
            );
          },
        },
        sourceLocale: "en",
        state,
        targetLocales: ["nl"],
      },
      {
        forceRetranslate: true,
        forceRetranslatePaths: [pointer],
        includePaths: [pointer],
        locales: ["nl"],
      },
    );

    expect(providerCalls).toBe(1);
    expect(result.metrics.translatedEntries).toBe(1);
    const written = await fs.readFile(path.join(rootDir, "nl", "guide.mdoc"), "utf8");
    expect(written).toContain("Actuele tekst met [**doellabel**](/guide).");
    expect(written).toContain("Deze bestaande vertaling blijft staan.");
  });

  it("preserves bold, italic, and inline-code structure inside Markdown tables", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-inline-"));
    await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "en", "guide.mdoc"),
      [
        "# Guide",
        "",
        "Use **Acme** with _care_.",
        "",
        "| Command | Meaning |",
        "| --- | --- |",
        "| `pnpm test | tee results.txt` | Run tests |",
        "| `unfinished | Still another cell |",
        "",
      ].join("\n"),
      "utf8",
    );
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source document.");
    }
    const source = await catalog.loadDocument(sourceRef);
    if (!source) {
      throw new Error("Expected loaded source document.");
    }

    expect(source.entries.map((entry) => entry.value)).toContain("`pnpm test | tee results.txt`");
    expect(source.entries.map((entry) => entry.value)).toContain("Still another cell");
    expect(
      source.entries.find((entry) => entry.value === "`pnpm test | tee results.txt`")?.meta,
    ).toMatchObject({ structureSignature: "table-cell:0:of:2" });

    const targetRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({ ref: targetRef, source, target: null });
    const formattedEntry = reconciled.entries.find(
      (entry) => entry.value === "Use **Acme** with _care_.",
    );
    const codeEntry = reconciled.entries.find(
      (entry) => entry.value === "`pnpm test | tee results.txt`",
    );
    const meaningEntry = reconciled.entries.find((entry) => entry.value === "Run tests");
    if (!formattedEntry || !codeEntry || !meaningEntry) {
      throw new Error("Expected formatted prose and table entries.");
    }

    formattedEntry.value = "Utilisez **Acme** avec _soin_.";
    meaningEntry.value = "Exécuter les tests";
    await catalog.writeDocument(reconciled);
    const validWritten = await fs.readFile(targetRef.path, "utf8");
    expect(validWritten).toContain("Utilisez **Acme** avec _soin_.");
    expect(validWritten).toContain("| `pnpm test | tee results.txt` | Exécuter les tests |");

    formattedEntry.value = "Utilisez Acme avec soin.";
    await expect(catalog.writeDocument(reconciled)).rejects.toThrow(
      "would change protected Markdown structure",
    );
    expect(await fs.readFile(targetRef.path, "utf8")).toBe(validWritten);

    formattedEntry.value = "Utilisez **Acme** avec _soin_.";
    codeEntry.value = "`npm test | tee results.txt`";
    await expect(catalog.writeDocument(reconciled)).rejects.toThrow(
      "would change protected Markdown structure",
    );
    expect(await fs.readFile(targetRef.path, "utf8")).toBe(validWritten);

    codeEntry.value = "`pnpm test | tee results.txt`";
    meaningEntry.value = "Exécuter | inspecter les tests";
    await expect(catalog.writeDocument(reconciled)).rejects.toThrow(
      "would change the assembled Markdoc document structure",
    );
    expect(await fs.readFile(targetRef.path, "utf8")).toBe(validWritten);
  });

  it("names the entries responsible for an assembled-structure rejection", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-drift-"));
    try {
      await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
      await fs.writeFile(
        path.join(rootDir, "en", "guide.mdoc"),
        "# Guide\n\n-   Keep receipts tidy.\n",
        "utf8",
      );
      const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
      const [sourceRef] = await catalog.listDocumentRefs("en");
      if (!sourceRef) {
        throw new Error("Expected a source document.");
      }
      const source = await catalog.loadDocument(sourceRef);
      if (!source) {
        throw new Error("Expected a loaded source document.");
      }
      const targetRef = catalog.createDocumentRef(sourceRef, "fi");
      const reconciled = await catalog.reconcileDocument({
        history: [],
        ref: targetRef,
        source,
        target: null,
      });
      const listEntry = reconciled.entries.find((entry) => entry.value === "Keep receipts tidy.");
      if (!listEntry) {
        throw new Error("Expected the list-item entry.");
      }

      // A leading non-breaking space is absorbed into the list marker's
      // trailing whitespace, so the binding prefix no longer matches.
      listEntry.value = "\u00a0Pidä kuitit järjestyksessä.";
      await expect(catalog.writeDocument(reconciled)).rejects.toThrow(
        /Affected entries: \/@node:/u,
      );
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });

  it("parses and validates the fully assembled Markdoc before creating the target file", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-parse-"));
    await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "en", "guide.mdoc"), "# Guide\n\nPlain body.\n", "utf8");
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source document.");
    }
    const source = await catalog.loadDocument(sourceRef);
    if (!source) {
      throw new Error("Expected loaded source document.");
    }
    const targetRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({ ref: targetRef, source, target: null });
    const state = reconciled.state as { bodyLines: string[] };
    state.bodyLines.push("{% /orphan %}");

    await expect(catalog.writeDocument(reconciled)).rejects.toThrow("Invalid Markdoc syntax");
    await expect(fs.access(targetRef.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed source and target documents while loading them", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-load-"));
    await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "en", "guide.mdoc"),
      "# Guide\n\n{% /orphan %}\n",
      "utf8",
    );
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source document.");
    }

    await expect(catalog.loadDocument(sourceRef)).rejects.toThrow("Invalid Markdoc syntax");
  });

  it("fails closed when a body or table binding cannot be persisted", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const [sourceRef] = await catalog.listDocumentRefs("en");
    if (!sourceRef) {
      throw new Error("Expected source document.");
    }
    const source = await catalog.loadDocument(sourceRef);
    if (!source) {
      throw new Error("Expected loaded source document.");
    }
    const targetRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({ ref: targetRef, source, target: null });
    const bodyEntry = reconciled.entries.find((entry) => entry.storage === "markdoc");
    if (!bodyEntry) {
      throw new Error("Expected a body entry.");
    }
    const bodyNodeId = bodyEntry.address[0]?.kind === "node" ? bodyEntry.address[0].id : undefined;
    if (!bodyNodeId) {
      throw new Error("Expected a body node identifier.");
    }
    const state = reconciled.state as { bodyBindings: Map<string, unknown> };
    state.bodyBindings.delete(bodyNodeId);

    await expect(catalog.writeDocument(reconciled)).rejects.toThrow(
      "Missing Markdoc target binding",
    );
    await expect(fs.access(targetRef.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a localized file atomic when an inserted paragraph fails while another document succeeds", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-markdoc-atomic-"));
    await fs.mkdir(path.join(rootDir, "en"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "en", "guide.mdoc"),
      "# Guide\n\nOriginal body.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "en", "other.mdoc"),
      "# Other\n\nOriginal other.\n",
      "utf8",
    );
    const catalog = createMarkdocCatalog({ rootDir, sourceLocale: "en" });
    const state = createMemoryStateStore();
    let rejectInserted = false;
    const config = {
      catalogs: [catalog],
      provider: {
        translate: ({ requests }: { requests: readonly { key: string; sourceText: string }[] }) =>
          Promise.resolve(
            requests.map((request) => ({
              key: request.key,
              translation:
                rejectInserted && request.sourceText === "Inserted paragraph."
                  ? "INVALID"
                  : `fr:${request.sourceText}`,
            })),
          ),
      },
      sourceLocale: "en",
      state,
      targetLocales: ["fr"],
      validators: [
        ({ sourceText, targetText }: { sourceText: string; targetText: string }) =>
          sourceText === "Inserted paragraph." && targetText === "INVALID"
            ? {
                code: "invalid-insertion",
                message: "Reject insertion.",
                severity: "error" as const,
              }
            : null,
      ],
    };

    await syncCatalogs(config);
    const guidePath = path.join(rootDir, "fr", "guide.mdoc");
    const otherPath = path.join(rootDir, "fr", "other.mdoc");
    const guideBeforeFailure = await fs.readFile(guidePath, "utf8");
    const otherBeforeFailure = await fs.readFile(otherPath, "utf8");
    await fs.writeFile(
      path.join(rootDir, "en", "guide.mdoc"),
      "# Guide\n\nUpdated body.\n\nInserted paragraph.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "en", "other.mdoc"),
      "# Other\n\nUpdated other.\n",
      "utf8",
    );
    rejectInserted = true;

    const failed = await syncCatalogs(config);

    expect(await fs.readFile(guidePath, "utf8")).toBe(guideBeforeFailure);
    expect(await fs.readFile(otherPath, "utf8")).not.toBe(otherBeforeFailure);
    expect(await fs.readFile(otherPath, "utf8")).toContain("fr:Updated other.");
    expect(failed.documents.find((document) => document.unitId === "guide.mdoc")).toMatchObject({
      failedEntries: 1,
      wroteFile: false,
    });
    expect(failed.documents.find((document) => document.unitId === "other.mdoc")).toMatchObject({
      translatedEntries: 1,
      wroteFile: true,
    });
    expect(
      Object.values(state.snapshot.entries).some(
        (entry) => entry.unitId === "guide.mdoc" && entry.status === "failed",
      ),
    ).toBe(true);

    rejectInserted = false;
    const repaired = await syncCatalogs(config);
    expect(await fs.readFile(guidePath, "utf8")).toContain("fr:Updated body.");
    expect(await fs.readFile(guidePath, "utf8")).toContain("fr:Inserted paragraph.");
    expect(repaired.documents.find((document) => document.unitId === "guide.mdoc")).toMatchObject({
      failedEntries: 0,
      translatedEntries: 2,
      wroteFile: true,
    });
  });
});
