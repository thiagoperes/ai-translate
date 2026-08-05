import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createHtmlCatalog } from "../src/index";

async function createFixtureWorkspace(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-html-"));
  await fs.cp(
    new URL("./fixtures/site", import.meta.url),
    rootDir,
    { recursive: true },
  );
  return rootDir;
}

describe("createHtmlCatalog", () => {
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
      "Access ",
      "1,000,000+",
      " service points.",
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
