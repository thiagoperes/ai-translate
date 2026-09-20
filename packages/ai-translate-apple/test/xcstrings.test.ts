import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { addressToJsonPointer } from "@ai-translate/core/address";
import type { CatalogAdapter, JsonObject, LoadedDocument } from "@ai-translate/core/types";
import { afterEach, describe, expect, it } from "vitest";

import { createAppleStringCatalog } from "../src/xcstrings";
import { isObject, own } from "../src/xcstrings-model";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const unit = (value: string, state = "translated"): JsonObject => ({ stringUnit: { state, value } });

async function setup(strings: JsonObject = { Hello: {} }, prefix = "") {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-xcstrings-"));
  roots.push(rootDir);
  const filePath = path.join(rootDir, "Localizable.xcstrings");
  await fs.writeFile(filePath, `${prefix}${JSON.stringify({ sourceLanguage: "en", strings, version: "1.0", customRoot: "keep" }, null, 2)}\n`);
  const adapter = createAppleStringCatalog({ rootDir, sourceLocale: "en" });
  const source = await adapter.loadDocument((await adapter.listDocumentRefs("en"))[0] as NonNullable<Awaited<ReturnType<CatalogAdapter["listDocumentRefs"]>>[number]>);
  if (source === null) { throw new Error("Missing source"); }
  return { adapter, filePath, rootDir, source };
}

async function reconcile(adapter: CatalogAdapter, source: LoadedDocument, locale = "de") {
  const ref = adapter.createDocumentRef(source.ref, locale);
  const localized = await adapter.localizeSourceDocument?.({ locale, source }) ?? source;
  return adapter.reconcileDocument({ ref, source: localized, target: await adapter.loadDocument(ref) });
}

function translated(document: LoadedDocument, transform: (pointer: string, index: number) => string | null): LoadedDocument {
  return { ...document, entries: document.entries.map((entry, index) => ({ ...entry, value: transform(addressToJsonPointer(entry.address), index) })) };
}

async function read(filePath: string): Promise<JsonObject> {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "")) as JsonObject;
}

function at(value: JsonObject, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) { current = isObject(current) ? own(current, key) : undefined; }
  return current;
}

describe("createAppleStringCatalog", () => {
  it("discovers authored catalogs deterministically and excludes generated/dependency trees", async () => {
    const { rootDir, filePath } = await setup();
    for (const name of ["Feature/Z.xcstrings", "Feature/A.xcstrings", "Pods/Ignore.xcstrings", "node_modules/Ignore.xcstrings", "build/Ignore.xcstrings", "DerivedData/Ignore.xcstrings", "release/Ignore.xcstrings"]) {
      const file = path.join(rootDir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(filePath, file);
    }
    const adapter = createAppleStringCatalog({ id: "ios", rootDir, sourceLocale: "en" });
    const refs = await adapter.listDocumentRefs("de");
    expect(refs.map(({ unitId }) => unitId)).toEqual(["Feature/A", "Feature/Z", "Localizable"]);
    expect(refs[0]).toMatchObject({ catalogId: "ios", format: "xcstrings", locale: "de" });
    expect((await createAppleStringCatalog({ rootDir, sourceLocale: "en", include: ["Feature/A.xcstrings"] }).listDocumentRefs("en"))).toHaveLength(1);
    expect(adapter.createDocumentRef(refs[0] as NonNullable<typeof refs[0]>, "fr")).toMatchObject({ path: refs[0]?.path, unitId: "Feature/A", locale: "fr" });
  });

  it("preserves root/key/unit metadata, unrelated locales, nontranslated and stale entries, and BOM", async () => {
    const strings = {
      Hello: { comment: "Shown first", customKey: true, localizations: { en: unit("Hello"), de: { stringUnit: { value: "Hallo", state: "translated", customUnit: "keep" }, customLocale: true }, fr: unit("Bonjour") } },
      skipped: { shouldTranslate: false, localizations: { de: unit("Unverändert") } },
      old: { extractionState: "stale", localizations: { de: unit("Alt") } },
    };
    const { adapter, source, filePath } = await setup(strings, "\uFEFF");
    await adapter.writeDocument(translated(await reconcile(adapter, source), () => "Guten Tag"));
    const result = await read(filePath);
    expect(result.customRoot).toBe("keep");
    expect(at(result, "strings", "Hello", "localizations", "de")).toEqual({ stringUnit: { value: "Guten Tag", state: "translated", customUnit: "keep" }, customLocale: true });
    expect(at(result, "strings", "Hello", "localizations", "fr")).toEqual(unit("Bonjour"));
    expect(at(result, "strings", "skipped")).toEqual(strings.skipped);
    expect(at(result, "strings", "old")).toEqual(strings.old);
    expect(at(result, "strings", "Hello", "comment")).toBe("Shown first");
    expect((await fs.readFile(filePath, "utf8")).startsWith("\uFEFF")).toBe(true);
  });

  it("loads missing locales as null and writes only populated source keys", async () => {
    const { adapter, source, filePath } = await setup({ a: {}, b: {} });
    const ref = adapter.createDocumentRef(source.ref, "de");
    expect(await adapter.loadDocument(ref)).toBeNull();
    const target = await reconcile(adapter, source);
    expect(target.entries.map(({ value }) => value)).toEqual([null, null]);
    await adapter.writeDocument(translated(target, (_pointer, index) => index === 0 ? "Ein" : null));
    const result = await read(filePath);
    expect(at(result, "strings", "a", "localizations", "de")).toEqual(unit("Ein"));
    expect(at(result, "strings", "b", "localizations")).toBeUndefined();
  });

  it("keeps pending fallback siblings when writing one plural leaf", async () => {
    const sourceNode = { variations: { plural: { one: unit("%lld file"), other: unit("%lld files") } } };
    const { adapter, source, filePath } = await setup({ files: { localizations: { en: sourceNode } }, untouched: {} });
    const target = await reconcile(adapter, source, "pl");
    await adapter.writeDocument(translated(target, (pointer) => pointer.includes("/few/") ? "%lld pliki" : null));
    const result = await read(filePath);
    expect(at(result, "strings", "files", "localizations", "pl", "variations", "plural", "few")).toEqual(unit("%lld pliki"));
    expect(at(result, "strings", "files", "localizations", "pl", "variations", "plural", "other")).toEqual(unit("%lld files", "new"));
    expect(at(result, "strings", "untouched", "localizations")).toBeUndefined();
    expect((await adapter.loadDocument(adapter.createDocumentRef(source.ref, "pl")))?.entries.map(({ value }) => value)).toEqual([null, "%lld pliki", null, null]);
  });

  it("merges simultaneous locale and same-locale sibling writes across adapter instances", async () => {
    const { adapter, rootDir, source, filePath } = await setup({ a: {}, b: {} });
    const second = createAppleStringCatalog({ rootDir, sourceLocale: "en" });
    const de = await reconcile(adapter, source, "de");
    const fr = await reconcile(second, source, "fr");
    await Promise.all([
      adapter.writeDocument(translated(de, (_pointer, index) => index === 0 ? "A deutsch" : null)),
      second.writeDocument(translated(de, (_pointer, index) => index === 1 ? "B deutsch" : null)),
      second.writeDocument(translated(fr, (_pointer, index) => index === 0 ? "A français" : "B français")),
    ]);
    const result = await read(filePath);
    expect(at(result, "strings", "a", "localizations", "de")).toEqual(unit("A deutsch"));
    expect(at(result, "strings", "b", "localizations", "de")).toEqual(unit("B deutsch"));
    expect(at(result, "strings", "a", "localizations", "fr")).toEqual(unit("A français"));
    expect(at(result, "strings", "b", "localizations", "fr")).toEqual(unit("B français"));
  });

  it("preserves edits to untouched entries and refuses conflicting human edits to the same leaf", async () => {
    const { adapter, source, filePath } = await setup({ a: { localizations: { de: unit("Alt A") } }, b: { localizations: { de: unit("Alt B") } } });
    const target = await reconcile(adapter, source);
    const current = await read(filePath);
    ((at(current, "strings", "a", "localizations", "de") as JsonObject).stringUnit as JsonObject).value = "Menschlich";
    await fs.writeFile(filePath, JSON.stringify(current));
    await adapter.writeDocument(translated(target, (_pointer, index) => index === 0 ? "Alt A" : "Neu B"));
    expect(at(await read(filePath), "strings", "a", "localizations", "de", "stringUnit", "value")).toBe("Menschlich");
    await expect(adapter.writeDocument(translated(target, (_pointer, index) => index === 0 ? "Neu A" : "Alt B"))).rejects.toThrow("translation changed before writing");
  });

  it("refuses stale source content, removed keys, and source-locale writes", async () => {
    const { adapter, source, filePath } = await setup({ a: { localizations: { en: unit("Original") } } });
    const target = translated(await reconcile(adapter, source), () => "Übersetzung");
    const current = await read(filePath);
    ((at(current, "strings", "a", "localizations", "en") as JsonObject).stringUnit as JsonObject).value = "Changed";
    await fs.writeFile(filePath, JSON.stringify(current));
    await expect(adapter.writeDocument(target)).rejects.toThrow("source changed before writing");
    (current.strings as JsonObject).a = { shouldTranslate: false };
    await fs.writeFile(filePath, JSON.stringify(current));
    await expect(adapter.writeDocument(target)).rejects.toThrow("source key changed before writing");
    await expect(adapter.writeDocument(source)).rejects.toThrow("Refusing to write the source locale");
  });

  it("refuses to erase a concurrently added native variation", async () => {
    const { adapter, source, filePath } = await setup({ a: {} });
    const target = translated(await reconcile(adapter, source), () => "Generated");
    const current = await read(filePath);
    (at(current, "strings", "a") as JsonObject).localizations = { de: { variations: { device: { applewatch: unit("Handwritten short"), other: unit("Handwritten") } } } };
    await fs.writeFile(filePath, JSON.stringify(current));
    await expect(adapter.writeDocument(target)).rejects.toThrow("translation structure changed before writing");
    expect(at(await read(filePath), "strings", "a", "localizations", "de", "variations", "device", "applewatch")).toEqual(unit("Handwritten short"));
  });

  it("preserves locale-owned variants even when canonical source text is plain", async () => {
    const { adapter, source, filePath } = await setup({ a: { localizations: { en: unit("Now plain"), de: { ...unit("Alt"), variations: { plural: { one: unit("Ein"), other: unit("Viele") } } } } } });
    const target = await reconcile(adapter, source);
    expect(target.entries.map(({ address }) => addressToJsonPointer(address))).toContain("/a/variations/plural/other/stringUnit/value");
    await adapter.writeDocument(translated(target, () => "Neu"));
    expect(at(await read(filePath), "strings", "a", "localizations", "de", "variations", "plural", "other")).toEqual(unit("Neu"));
  });

  it("removes an obsolete plain target leaf when the source introduces plurals", async () => {
    const { adapter, source, filePath } = await setup({ files: { localizations: { en: { variations: { plural: { one: unit("%lld file"), other: unit("%lld files") } } }, de: unit("%lld Dateien") } } });
    await adapter.writeDocument(translated(await reconcile(adapter, source), () => "%lld Dateien"));
    expect(at(await read(filePath), "strings", "files", "localizations", "de", "stringUnit")).toBeUndefined();
    expect((await adapter.loadDocument(adapter.createDocumentRef(source.ref, "de")))?.entries).toHaveLength(2);
  });

  it("updates substitution metadata and treats changed bindings as untranslated", async () => {
    const node = (argNum: number, formatSpecifier: string, value: string) => ({ ...unit("%#@count@"), substitutions: { count: { argNum, formatSpecifier, variations: { plural: { other: unit(value) } } } } });
    const { adapter, source, filePath } = await setup({ count: { localizations: { en: node(2, "d", "%arg items"), de: node(1, "lld", "%arg Dinge") } } });
    const target = await reconcile(adapter, source);
    expect(target.entries.every(({ value }) => value === null)).toBe(true);
    await adapter.writeDocument(translated(target, (pointer) => pointer.includes("/substitutions/") ? "%arg Dinge" : "%#@count@"));
    expect(at(await read(filePath), "strings", "count", "localizations", "de", "substitutions", "count", "argNum")).toBe(2);
    expect(at(await read(filePath), "strings", "count", "localizations", "de", "substitutions", "count", "formatSpecifier")).toBe("d");
  });

  it("protects target-only substitutions when callers write without loading or localizing the target", async () => {
    const { adapter, source, filePath } = await setup({
      "Found %lld birds": { localizations: { de: { ...unit("%#@birds@ entdeckt"), substitutions: { birds: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg Vogel"), other: unit("%arg Vögel") } } } } } } },
    });
    const before = await fs.readFile(filePath, "utf8");
    const ref = adapter.createDocumentRef(source.ref, "de");
    const target = await adapter.reconcileDocument({ ref, source, target: null });
    await expect(adapter.writeDocument(translated(target, () => "%lld Vögel entdeckt"))).rejects.toThrow('Unsupported target-only String Catalog substitution "birds"');
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
  });

  it("scaffolds every leaf as new, never overwrites an existing locale, and copies the selected locale", async () => {
    const node = { ...unit("%#@count@ things"), substitutions: { count: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg thing"), other: unit("%arg things") } } } } };
    const { adapter, source, filePath } = await setup({ count: { localizations: { en: node } }, hello: {} });
    expect(await adapter.scaffoldLocale?.({ locale: "de" })).toMatchObject({ createdDocuments: 1, skippedDocuments: 0 });
    const result = await read(filePath);
    expect(at(result, "strings", "count", "localizations", "de", "substitutions", "count", "variations", "plural", "other")).toEqual(unit("%arg things", "new"));
    expect((await adapter.loadDocument(adapter.createDocumentRef(source.ref, "de")))?.entries.every(({ value }) => value === null)).toBe(true);
    expect(await adapter.scaffoldLocale?.({ locale: "de" })).toMatchObject({ createdDocuments: 0, skippedDocuments: 1 });
    const de = await reconcile(adapter, source, "de");
    await adapter.writeDocument(translated(de, (pointer) => pointer.includes("/substitutions/") ? "%arg Dinge" : pointer.startsWith("/count/") ? "%#@count@ Dinge" : "Hallo"));
    expect(await adapter.scaffoldLocale?.({ locale: "fr", fromLocale: "de", strategy: "copy-locale" })).toMatchObject({ createdDocuments: 1 });
    expect(at(await read(filePath), "strings", "hello", "localizations", "fr")).toEqual(unit("Hallo", "new"));
    expect(await adapter.scaffoldLocale?.({ locale: "es", strategy: "empty" })).toMatchObject({ createdDocuments: 0, skippedDocuments: 1 });
    expect(await adapter.loadDocument(adapter.createDocumentRef(source.ref, "es"))).toBeNull();
    expect(await adapter.scaffoldLocale?.({ locale: "it", fromLocale: "missing", strategy: "copy-locale" })).toMatchObject({ createdDocuments: 0, skippedDocuments: 1 });
  });

  it("writes prototype-like keys and locale names as own data properties", async () => {
    const { adapter, source, filePath } = await setup(Object.fromEntries([["__proto__", {}], ["constructor", {}], ["a/b~c", {}]]));
    await adapter.writeDocument(translated(await reconcile(adapter, source, "__proto__"), (_pointer, index) => `Value ${String(index)}`));
    const result = await read(filePath);
    expect(at(result, "strings", "__proto__", "localizations", "__proto__")).toEqual(unit("Value 0"));
    expect({}).not.toHaveProperty("stringUnit");
  });

  it("supports staged physical paths and no-op writes without byte churn", async () => {
    const { adapter, source, filePath, rootDir } = await setup({ a: { localizations: { de: unit("Ein") } } });
    const target = await reconcile(adapter, source);
    const original = await fs.readFile(filePath, "utf8");
    await adapter.writeDocument(target);
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    const temporary = path.join(rootDir, "stage.xcstrings");
    await fs.copyFile(filePath, temporary);
    await adapter.writeDocument({ ...translated(target, () => "Zwei"), ref: { ...target.ref, path: temporary } });
    expect(at(await read(temporary), "strings", "a", "localizations", "de")).toEqual(unit("Zwei"));
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
  });

  it("propagates missing-file, malformed-file, invalid-address, and filesystem errors", async () => {
    const { adapter, source, filePath, rootDir } = await setup();
    const target = translated(await reconcile(adapter, source), () => "Hallo");
    await expect(adapter.writeDocument({ ...target, entries: target.entries.map((entry) => ({ ...entry, address: [{ kind: "index", index: 0 }] })) })).rejects.toThrow("only object keys");
    await fs.rm(filePath);
    expect(await adapter.loadDocument(source.ref)).toBeNull();
    await expect(adapter.writeDocument(target)).rejects.toThrow("disappeared before writing");
    await fs.writeFile(filePath, "{");
    await expect(adapter.loadDocument(source.ref)).rejects.toThrow("Invalid JSON");
    await expect(adapter.loadDocument({ ...source.ref, path: rootDir })).rejects.toThrow();
  });
});
