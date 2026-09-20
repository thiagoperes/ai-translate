import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncCatalogs, validateCatalogs } from "@ai-translate/core";
import type {
  AiTranslateConfig,
  CatalogAdapter,
  DocumentRef,
  LoadedDocument,
  SyncStateSnapshot,
  TranslationProvider,
} from "@ai-translate/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppleStringsCatalog } from "../src/strings";
import { decodeStrings, encodeStrings, parseStrings } from "../src/strings-parser";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup(files: Record<string, string | Uint8Array> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apple-strings-test-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
  return root;
}

async function source(catalog: CatalogAdapter): Promise<LoadedDocument> {
  const ref = (await catalog.listDocumentRefs("en"))[0];
  if (ref === undefined) {
    throw new Error("No source ref");
  }
  const result = await catalog.loadDocument(ref);
  if (result === null) {
    throw new Error("No source document");
  }
  return result;
}

function translated(document: LoadedDocument, values: Record<string, string>): LoadedDocument {
  return {
    ...document,
    entries: document.entries.map((entry) => {
      const key = entry.address[0];
      return {
        ...entry,
        value:
          key?.kind === "key" && values[key.key] !== undefined
            ? (values[key.key] as string)
            : entry.value,
      };
    }),
  };
}

describe("createAppleStringsCatalog", () => {
  it("discovers nested source tables deterministically and honors include/Base.lproj", async () => {
    const rootDir = await setup({
      "Base.lproj/z.strings": '"z"="Z";',
      "Base.lproj/sub/a.strings": '"a"="A";',
      "Base.lproj/not.json": "{}",
      "de.lproj/ignore.strings": '"x"="X";',
    });
    const catalog = createAppleStringsCatalog({
      rootDir,
      sourceLocale: "en",
      sourceLocaleDirectory: "Base.lproj",
    });
    expect((await catalog.listDocumentRefs("en")).map((ref) => ref.unitId)).toEqual([
      "sub/a.strings",
      "z.strings",
    ]);
    expect(
      await createAppleStringsCatalog({
        rootDir,
        sourceLocale: "en",
        sourceLocaleDirectory: "Base.lproj",
        include: "z.strings",
      }).listDocumentRefs("en"),
    ).toHaveLength(1);
    const document = await source(catalog);
    expect(catalog.createDocumentRef(document.ref, "pt-BR").path).toBe(
      path.join(rootDir, "pt-BR.lproj/sub/a.strings"),
    );
  });

  it("registers printf tokens and source comments as entry context", async () => {
    const rootDir = await setup({
      "en.lproj/Localizable.strings": '/* Greeting for a person */\n"greet" = "Hello %@";',
    });
    const catalog = createAppleStringsCatalog({ id: "native", rootDir, sourceLocale: "en" });
    const document = await source(catalog);
    expect(catalog.id).toBe("native");
    expect(catalog.messageFormats?.[0]?.id).toBe("apple-printf");
    expect(document.entries[0]).toMatchObject({
      context: { notes: "Greeting for a person" },
      messageFormatId: "apple-printf",
      value: "Hello %@",
    });
    expect(document.entries[0]?.tokens).toContainEqual(
      expect.objectContaining({ raw: "%@", syntax: "printf" }),
    );
  });

  it("preserves human edits, comments, unknown keys and source encoding", async () => {
    const rootDir = await setup({
      "en.lproj/Localizable.strings": '"known"="Known";\n/* Added comment */\n"new"="New";',
      "de.lproj/Localizable.strings": encodeStrings(
        '/* Human comment */\r\n"known" = "Handarbeit";\r\n"unknown"="Leave alone";\r\n',
        "utf16be",
      ),
    });
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const original = await source(catalog);
    const ref = catalog.createDocumentRef(original.ref, "de");
    const target = await catalog.loadDocument(ref);
    expect(target?.entries.map((entry) => entry.value)).toEqual(["Handarbeit"]);
    const reconciled = await catalog.reconcileDocument({ ref, source: original, target });
    expect(reconciled.entries.map((entry) => entry.value)).toEqual(["Handarbeit", null]);
    await catalog.writeDocument(translated(reconciled, { new: "Neu" }));
    const result = decodeStrings(await fs.readFile(ref.path));
    expect(result.encoding).toBe("utf16be");
    expect(result.text).toContain(
      '/* Human comment */\r\n"known" = "Handarbeit";\r\n"unknown"="Leave alone";\r\n',
    );
    expect(result.text).toContain('/* Added comment */\n"new"="Neu";');
  });

  it("writes only populated entries when a scope leaves other keys missing", async () => {
    const rootDir = await setup({ "en.lproj/Localizable.strings": '"a"="A";\n"b"="B";' });
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const original = await source(catalog);
    const ref = catalog.createDocumentRef(original.ref, "de");
    expect(await catalog.loadDocument(ref)).toBeNull();
    const reconciled = await catalog.reconcileDocument({ ref, source: original, target: null });
    await catalog.writeDocument(translated(reconciled, { a: "A" }));
    expect(
      parseStrings(await fs.readFile(ref.path, "utf8")).records.map(({ key, value }) => [
        key,
        value,
      ]),
    ).toEqual([["a", "A"]]);
  });

  it("supports temporary staged paths and preserves sibling concurrent writes", async () => {
    const rootDir = await setup({ "en.lproj/Localizable.strings": '"a"="A";\n"b"="B";' });
    const tempRoot = await setup();
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const original = await source(catalog);
    const ref = {
      ...catalog.createDocumentRef(original.ref, "de"),
      path: path.join(tempRoot, "0.strings"),
    };
    const reconciled = await catalog.reconcileDocument({ ref, source: original, target: null });
    await Promise.all([
      catalog.writeDocument(translated(reconciled, { a: "Ein" })),
      catalog.writeDocument(translated(reconciled, { b: "Zwei" })),
    ]);
    expect((await catalog.loadDocument(ref))?.entries.map((entry) => entry.value)).toEqual([
      "Ein",
      "Zwei",
    ]);
  });

  it("scaffolds once, supports copy-locale, and empty creates nothing", async () => {
    const rootDir = await setup({
      "en.lproj/Localizable.strings": encodeStrings('/* Source */\n"a"="A";', "utf16le"),
    });
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    expect(await catalog.scaffoldLocale?.({ locale: "de" })).toMatchObject({
      createdDocuments: 1,
      skippedDocuments: 0,
      strategy: "copy-source",
    });
    expect(await catalog.scaffoldLocale?.({ locale: "de" })).toMatchObject({
      createdDocuments: 0,
      skippedDocuments: 1,
    });
    expect(
      await catalog.scaffoldLocale?.({ locale: "fr", fromLocale: "de", strategy: "copy-locale" }),
    ).toMatchObject({ createdDocuments: 1 });
    expect(await fs.readFile(path.join(rootDir, "fr.lproj/Localizable.strings"))).toEqual(
      await fs.readFile(path.join(rootDir, "en.lproj/Localizable.strings")),
    );
    expect(await catalog.scaffoldLocale?.({ locale: "es", strategy: "empty" })).toMatchObject({
      createdDocuments: 0,
      skippedDocuments: 1,
    });
    await expect(fs.access(path.join(rootDir, "es.lproj"))).rejects.toThrow();
  });

  it("merges only changed entries into an existing table and preserves concurrent human edits", async () => {
    const rootDir = await setup({
      "en.lproj/Localizable.strings": '"a"="A";\n"b"="B";',
      "de.lproj/Localizable.strings": '"a"="Alt A";\n"b"="Alt B";',
    });
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const original = await source(catalog);
    const ref = catalog.createDocumentRef(original.ref, "de");
    const target = await catalog.loadDocument(ref);
    const next = await catalog.reconcileDocument({ ref, source: original, target });
    await Promise.all([
      catalog.writeDocument(translated(next, { a: "Neu A" })),
      catalog.writeDocument(translated(next, { b: "Neu B" })),
    ]);
    expect((await catalog.loadDocument(ref))?.entries.map(({ value }) => value)).toEqual(["Neu A", "Neu B"]);
    const fresh = await catalog.loadDocument(ref);
    if (!fresh) { throw new Error("Missing target fixture"); }
    await fs.writeFile(ref.path, '/* Human comment */\n"a"="Mensch A";\n"b"="Neu B";');
    await catalog.writeDocument(translated(fresh, { b: "Neueste B" }));
    expect(await fs.readFile(ref.path, "utf8")).toBe('/* Human comment */\n"a"="Mensch A";\n"b"="Neueste B";');
    await expect(catalog.writeDocument(translated(fresh, { a: "Unsafe A" }))).rejects.toThrow("translation changed before writing");
  });

  it("does not rewrite unchanged bytes", async () => {
    const text = '/* Hello */\r\n"a"  =  "A";\r\n';
    const rootDir = await setup({ "en.lproj/Localizable.strings": text });
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const document = await source(catalog);
    await catalog.writeDocument(document);
    expect(await fs.readFile(document.ref.path, "utf8")).toBe(text);
  });

  it("syncs wrapped mixed-value tables incrementally without changing keys or human translations", async () => {
    const sourceText = '{\n/* Greeting */\n"Hello";\n"title"="Title";\n"Added";\n}';
    const targetText = '/* Human header */\r\n{\r\n"Hello";\r\n"title" = "Handarbeit";\r\n"orphan";\r\n/* Footer */\r\n}';
    const rootDir = await setup({
      "en.lproj/Localizable.strings": sourceText,
      "de.lproj/Localizable.strings": encodeStrings(targetText, "utf16be"),
    });
    let state: SyncStateSnapshot = { entries: {}, version: 2 };
    const translations: Record<string, string> = { Hello: "Hallo", Added: "Neu", Next: "Nächste" };
    const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) => Promise.resolve(
      requests.map((request) => ({ key: request.key, translation: translations[request.sourceText] ?? "Unexpected" })),
    ));
    const config: AiTranslateConfig = {
      catalogs: [createAppleStringsCatalog({ rootDir, sourceLocale: "en" })],
      sourceLocale: "en",
      targetLocales: ["de"],
      provider: { translate },
      state: {
        load: () => Promise.resolve(structuredClone(state)),
        save: (next) => { state = structuredClone(next); return Promise.resolve(); },
        withLock: (operation) => operation(),
      },
    };
    const targetPath = path.join(rootDir, "de.lproj/Localizable.strings");
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(2);
    const first = await fs.readFile(targetPath);
    const result = decodeStrings(first);
    expect(result.encoding).toBe("utf16be");
    expect(result.text.startsWith('/* Human header */\r\n{\r\n"Hello" = "Hallo";')).toBe(true);
    expect(result.text).toContain('"title" = "Handarbeit";\r\n"orphan";');
    expect(result.text.endsWith('\r\n/* Footer */\r\n}')).toBe(true);
    expect(parseStrings(result.text).records.map(({ key, value }) => [key, value])).toEqual([
      ["Hello", "Hallo"], ["title", "Handarbeit"], ["orphan", "orphan"], ["Added", "Neu"],
    ]);
    expect((await validateCatalogs(config)).issues).toEqual([]);
    translate.mockClear();
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(0);
    expect(translate).not.toHaveBeenCalled();
    expect(await fs.readFile(targetPath)).toEqual(first);
    const sourcePath = path.join(rootDir, "en.lproj/Localizable.strings");
    expect(await fs.readFile(sourcePath, "utf8")).toBe(sourceText);
    await fs.writeFile(sourcePath, `${sourceText.slice(0, -1)}"Next";\n}`);
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(1);
    const added = decodeStrings(await fs.readFile(targetPath)).text;
    expect(parseStrings(added).records.at(-1)).toMatchObject({ key: "Next", value: "Nächste" });
    expect(added.endsWith('\r\n/* Footer */\r\n}')).toBe(true);
  });

  it("rejects path traversal, invalid entry addresses, and symlink escapes", async () => {
    const rootDir = await setup({ "en.lproj/Localizable.strings": '"a"="A";' });
    const outside = await setup();
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const document = await source(catalog);
    for (const locale of ["../escape", "de/fr", "de\\fr", ".", ""]) {
      expect(() => catalog.createDocumentRef(document.ref, locale)).toThrow("Invalid locale");
    }
    expect(() =>
      catalog.createDocumentRef({ ...document.ref, unitId: "../bad.strings" }, "de"),
    ).toThrow("Invalid Apple strings unit");
    expect(() =>
      createAppleStringsCatalog({ rootDir, sourceLocale: "en", include: "../*.strings" }),
    ).toThrow("include");
    expect(() =>
      createAppleStringsCatalog({
        rootDir,
        sourceLocale: "en",
        sourceLocaleDirectory: "../Base.lproj",
      }),
    ).toThrow("source locale directory");
    await expect(
      catalog.writeDocument({
        ...document,
        entries: document.entries.map((entry) => ({ ...entry, address: [] })),
      }),
    ).rejects.toThrow("entry address");
    await fs.symlink(outside, path.join(rootDir, "de.lproj"));
    const targetRef = catalog.createDocumentRef(document.ref, "de");
    await expect(catalog.writeDocument({ ...document, ref: targetRef })).rejects.toThrow(
      "escapes rootDir",
    );
  });

  it("checks source templates even when loading a transaction-staged target", async () => {
    const rootDir = await setup({ "en.lproj/Localizable.strings": '"a"="A";' });
    const outside = await setup({ "Localizable.strings": '"a"="Outside";' });
    const staging = await setup({ "target.strings": '"a"="Target";' });
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const original = await source(catalog);
    await fs.rm(path.join(rootDir, "en.lproj"), { recursive: true });
    await fs.symlink(outside, path.join(rootDir, "en.lproj"));
    const ref = { ...catalog.createDocumentRef(original.ref, "de"), path: path.join(staging, "target.strings") };
    await expect(catalog.loadDocument(ref)).rejects.toThrow("escapes rootDir");
  });

  it("propagates malformed table and non-file errors without treating them as missing", async () => {
    const rootDir = await setup({ "en.lproj/Localizable.strings": '"a"="A"; "a"="B";' });
    const catalog = createAppleStringsCatalog({ rootDir, sourceLocale: "en" });
    const ref = (await catalog.listDocumentRefs("en"))[0] as DocumentRef;
    await expect(catalog.loadDocument(ref)).rejects.toThrow("Duplicate key");
    await expect(catalog.loadDocument({ ...ref, path: rootDir })).rejects.toThrow();
  });
});
