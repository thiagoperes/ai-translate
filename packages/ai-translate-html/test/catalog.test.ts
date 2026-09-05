import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { tokenizeText } from "@ai-translate/core/tokens";
import { syncCatalogs } from "@ai-translate/core/sync";
import type { SyncStateSnapshot, TranslationRequest } from "@ai-translate/core/types";

import { createHtmlCatalog } from "../src/index";

async function createFixtureWorkspace(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-html-"));
  await fs.cp(new URL("./fixtures/site", import.meta.url), rootDir, { recursive: true });
  return rootDir;
}

describe("createHtmlCatalog", () => {
  it("keeps ambiguous repeated links separate so translated titles retain their identities", async () => {
    const rootDir = await createFixtureWorkspace();
    await fs.writeFile(
      path.join(rootDir, "en/index.html"),
      '<p>Read <a href="/guide" title="Guide">the guide</a> or <a href="/guide" title="Details">the details</a>.</p>',
    );
    const catalog = createHtmlCatalog({ rootDir, sourceLocale: "en" });
    const [ref] = await catalog.listDocumentRefs("en");
    if (ref === undefined) {
      throw new Error("Missing fixture.");
    }
    const source = await catalog.loadDocument(ref);
    expect(source?.entries.map(({ value }) => value)).toEqual([
      "Read ",
      "Guide",
      "the guide",
      " or ",
      "Details",
      "the details",
      ".",
    ]);
  });

  it("extracts accessible labels and noscript prose while preserving code and translate=no", async () => {
    const rootDir = await createFixtureWorkspace();
    await fs.writeFile(
      path.join(rootDir, "en/index.html"),
      '<pre aria-label="Code example">const label = "Keep this";</pre><noscript>Enable JavaScript</noscript><p translate="no" title="Keep title">Keep prose</p>',
    );
    const catalog = createHtmlCatalog({ rootDir, sourceLocale: "en" });
    const [ref] = await catalog.listDocumentRefs("en");
    if (ref === undefined) {
      throw new Error("Missing fixture.");
    }
    const source = await catalog.loadDocument(ref);
    expect(source?.entries.map(({ value }) => value)).toEqual([
      "Code example",
      "Enable JavaScript",
    ]);
  });

  it("round-trips reordered inline blocks, their attributes, and opaque content", async () => {
    const rootDir = await createFixtureWorkspace();
    const sourceHtml =
      '<p title="Overview">Read <a href="/guide" title="Guide">the guide</a> before <strong>starting</strong>.</p><pre>const x = 1;</pre><p translate="no">Keep me</p><script>doNotTranslate()</script>';
    await fs.writeFile(path.join(rootDir, "en/index.html"), sourceHtml);
    const catalog = createHtmlCatalog({ rootDir, sourceLocale: "en" });
    const [ref] = await catalog.listDocumentRefs("en");
    if (!ref) {
      throw new Error("Missing fixture.");
    }
    const source = await catalog.loadDocument(ref);
    if (!source) {
      throw new Error("Missing source.");
    }
    expect(source.entries).toHaveLength(3);
    const target = await catalog.reconcileDocument({
      source,
      ref: catalog.createDocumentRef(ref, "de"),
      target: null,
    });
    const block = target.entries.find(({ meta }) => meta?.inlineMarkup === true);
    if (!block || typeof block.value !== "string") {
      throw new Error("Missing block.");
    }
    const tags = tokenizeText(block.value).flatMap((token) =>
      token.type === "tag" && token.tagKind === "open" ? [token.name] : [],
    );
    const [link, strong] = tags;
    block.value = `<${strong}>Vorbereitung</${strong}>: <${link}>Anleitung</${link}>.`;
    const title = target.entries.find(({ value }) => value === "Guide");
    if (!title) {
      throw new Error("Missing inline attribute.");
    }
    title.value = "Anleitung";
    await catalog.writeDocument(target);
    const html = await fs.readFile(target.ref.path, "utf8");
    expect(html).toContain(
      '<strong>Vorbereitung</strong>: <a href="/guide" title="Anleitung">Anleitung</a>.',
    );
    expect(html).toContain(
      '<pre>const x = 1;</pre><p translate="no">Keep me</p><script>doNotTranslate()</script>',
    );
    const reloaded = await catalog.loadDocument(target.ref);
    expect(reloaded?.entries.find(({ meta }) => meta?.inlineMarkup === true)?.value).toBe(
      block.value,
    );
    expect(reloaded?.entries.find(({ value }) => value === "Anleitung")?.address).toEqual(
      title.address,
    );
  });

  it("rejects malformed inline nesting before writing the file", async () => {
    const rootDir = await createFixtureWorkspace();
    await fs.writeFile(
      path.join(rootDir, "en/index.html"),
      "<p><strong>A <em>nested</em> phrase</strong>.</p>",
    );
    const catalog = createHtmlCatalog({ rootDir, sourceLocale: "en" });
    const [ref] = await catalog.listDocumentRefs("en");
    if (!ref) {
      throw new Error("Missing fixture.");
    }
    const source = await catalog.loadDocument(ref);
    if (!source) {
      throw new Error("Missing source.");
    }
    const target = await catalog.reconcileDocument({
      source,
      ref: catalog.createDocumentRef(ref, "de"),
      target: null,
    });
    const block = target.entries[0];
    if (!block || typeof block.value !== "string") {
      throw new Error("Missing block.");
    }
    const [a, b] = tokenizeText(block.value).flatMap((token) =>
      token.type === "tag" && token.tagKind === "open" ? [token.name] : [],
    );
    block.value = `<${a}>A <${b}>B</${a}></${b}>.`;
    await expect(catalog.writeDocument(target)).rejects.toThrow(
      "crossed inline element boundaries",
    );
    await expect(fs.stat(target.ref.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes roles and complete blocks to providers and performs no work on the next sync", async () => {
    const rootDir = await createFixtureWorkspace();
    await fs.writeFile(
      path.join(rootDir, "en/index.html"),
      '<h1>Welcome</h1><p>Read <a href="/guide">the guide</a>.</p>',
    );
    const catalog = createHtmlCatalog({ rootDir, sourceLocale: "en" });
    let snapshot: SyncStateSnapshot = { version: 2, entries: {} };
    let calls = 0;
    const config = {
      sourceLocale: "en",
      targetLocales: ["de"],
      catalogs: [catalog],
      state: {
        load: async () => structuredClone(snapshot),
        save: async (next: SyncStateSnapshot) => {
          snapshot = next;
        },
        withLock: <T>(f: () => Promise<T>) => f(),
      },
      provider: {
        async translate({ requests }: { requests: readonly TranslationRequest[] }) {
          calls += 1;
          expect(requests.map(({ contentRole }) => contentRole)).toEqual(["heading", "body"]);
          expect(requests.every(({ inlineMarkup }) => inlineMarkup)).toBe(true);
          return requests.map(({ key, sourceText }) => ({ key, translation: `DE ${sourceText}` }));
        },
      },
    };
    expect((await syncCatalogs(config)).metrics.failedEntries).toBe(0);
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(0);
    expect(calls).toBe(1);
  });
  it("extracts text nodes and whitelisted attributes", async () => {
    const catalog = createHtmlCatalog({
      rootDir: new URL("./fixtures/site", import.meta.url).pathname,
      sourceLocale: "en",
    });

    const [ref] = await catalog.listDocumentRefs("en");
    expect(ref).toBeDefined();
    if (!ref) {
      throw new Error("Expected an HTML fixture document.");
    }

    const document = await catalog.loadDocument(ref);
    expect(document?.entries.map((entry) => entry.value)).toEqual([
      "Hero title",
      "One card for your whole team",
      expect.stringMatching(/^Access <strong_[^>]+>1,000,000\+<\/strong_[^>]+> service points\.$/u),
      "Acme dashboard",
    ]);
  });

  it("reconciles, writes, and scaffolds localized HTML documents", async () => {
    const rootDir = await createFixtureWorkspace();
    const catalog = createHtmlCatalog({
      rootDir,
      sourceLocale: "en",
    });

    const [sourceRef] = await catalog.listDocumentRefs("en");
    expect(sourceRef).toBeDefined();
    if (!sourceRef) {
      throw new Error("Expected an HTML source fixture.");
    }

    const sourceDocument = await catalog.loadDocument(sourceRef);
    expect(sourceDocument).toBeDefined();
    if (!sourceDocument) {
      throw new Error("Expected a loaded HTML source document.");
    }

    const frRef = catalog.createDocumentRef(sourceRef, "fr");
    const reconciled = await catalog.reconcileDocument({
      ref: frRef,
      source: sourceDocument,
      target: null,
    });
    const titleEntry = reconciled.entries.find((entry) => entry.value === "Hero title");
    const headingEntry = reconciled.entries.find(
      (entry) => entry.value === "One card for your whole team",
    );
    expect(titleEntry).toBeDefined();
    expect(headingEntry).toBeDefined();
    if (!titleEntry || !headingEntry) {
      throw new Error("Expected title and heading entries in reconciled HTML.");
    }

    titleEntry.value = "Titre hero";
    headingEntry.value = "Une carte pour votre flotte";
    await catalog.writeDocument(reconciled);

    const written = await fs.readFile(frRef.path, "utf8");
    expect(written).toContain('title="Titre hero"');
    expect(written).toContain("Une carte pour votre flotte");

    const scaffoldResult = await catalog.scaffoldLocale?.({
      locale: "de",
    });
    expect(scaffoldResult).toMatchObject({
      createdDocuments: 1,
      locale: "de",
      skippedDocuments: 0,
      strategy: "copy-source",
    });
    const scaffolded = await fs.readFile(path.join(rootDir, "de", "index.html"), "utf8");
    expect(scaffolded).toContain("One card for your whole team");
  });
});
