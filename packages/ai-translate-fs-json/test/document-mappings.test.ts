import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { syncCatalogs } from "@ai-translate/core/sync";
import type { TranslationProvider } from "@ai-translate/core/types";
import { afterEach, describe, expect, it } from "vitest";

import { createJsonStateStore, createLocalizedJsonDocument } from "../src/index";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});
async function root() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-json-mapping-"));
  roots.push(directory);
  return directory;
}

describe("explicit locale document files", () => {
  it("syncs and re-syncs nonconventional nested paths without creating default filenames", async () => {
    const rootDir = await root();
    await fs.mkdir(path.join(rootDir, "source"));
    const source = '{"ios":{"NSCameraUsageDescription":"Take a photo"},"android":{"app_name":"Camera"},"version":1}';
    await fs.writeFile(path.join(rootDir, "source/English.json"), source);
    const catalog = createLocalizedJsonDocument({
      localeFiles: { en: "./source/English.json", fr: "target/French.json" },
      rootDir, sourceLocale: "en", unitId: "native",
    });
    let calls = 0;
    const provider: TranslationProvider = {
      translate: ({ requests }) => {
        calls += 1;
        return Promise.resolve(requests.map((request) => ({ key: request.key, translation: `FR ${request.sourceText}` })));
      },
    };
    const config = { catalogs: [catalog], provider, sourceLocale: "en", state: createJsonStateStore({ rootDir }), targetLocales: ["fr"] };
    await syncCatalogs(config);
    const translated = await fs.readFile(path.join(rootDir, "target/French.json"), "utf8");
    expect(JSON.parse(translated)).toEqual({ ios: { NSCameraUsageDescription: "FR Take a photo" }, android: { app_name: "FR Camera" }, version: 1 });
    expect(calls).toBe(1);
    await syncCatalogs(config);
    expect(calls).toBe(1);
    expect(await fs.readFile(path.join(rootDir, "source/English.json"), "utf8")).toBe(source);
    expect(await fs.readFile(path.join(rootDir, "target/French.json"), "utf8")).toBe(translated);
    await expect(fs.access(path.join(rootDir, "fr.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("scaffolds from mapped source or mapped existing target and preserves existing files", async () => {
    const rootDir = await root();
    const source = { title: "Hello" };
    await fs.writeFile(path.join(rootDir, "English.json"), JSON.stringify(source));
    const catalog = createLocalizedJsonDocument({ localeFiles: { en: "English.json", fr: "French.json", de: "German.json" }, rootDir, sourceLocale: "en", unitId: "main" });
    expect(await catalog.scaffoldLocale?.({ locale: "fr" })).toMatchObject({ createdDocuments: 1 });
    await fs.writeFile(path.join(rootDir, "French.json"), '{"title":"Bonjour"}');
    expect(await catalog.scaffoldLocale?.({ fromLocale: "fr", locale: "de", strategy: "copy-locale" })).toMatchObject({ createdDocuments: 1 });
    expect(JSON.parse(await fs.readFile(path.join(rootDir, "German.json"), "utf8"))).toEqual({ title: "Bonjour" });
    expect(await catalog.scaffoldLocale?.({ locale: "fr" })).toMatchObject({ skippedDocuments: 1 });
    expect(JSON.parse(await fs.readFile(path.join(rootDir, "French.json"), "utf8"))).toEqual({ title: "Bonjour" });
    expect(await catalog.scaffoldLocale?.({ locale: "ja" })).toMatchObject({ createdDocuments: 1 });
    expect(JSON.parse(await fs.readFile(path.join(rootDir, "ja.json"), "utf8"))).toEqual(source);
  });

  it.each(["", ".", "..", "../other.json", "nested/../../other.json", "/tmp/en.json", "C:en.json", "C:\\en.json", "nested\\en.json", "bad\0.json"])("rejects path outside the mapping boundary: %s", (file) => {
    expect(() => createLocalizedJsonDocument({ localeFiles: { en: file }, rootDir: ".", sourceLocale: "en", unitId: "main" })).toThrow("within rootDir");
  });

  it("rejects normalized duplicates and conventional fallback collisions", async () => {
    expect(() => createLocalizedJsonDocument({ localeFiles: { en: "en.json", fr: "nested/../en.json" }, rootDir: ".", sourceLocale: "en", unitId: "main" })).toThrow("multiple locales");
    const catalog = createLocalizedJsonDocument({ localeFiles: { fr: "en.json" }, rootDir: ".", sourceLocale: "en", unitId: "main" });
    expect(() => catalog.listDocumentRefs("en")).toThrow("overwrite another locale");
    const [ref] = await catalog.listDocumentRefs("fr");
    if (ref === undefined) { throw new Error("Expected mapped reference"); }
    expect(() => catalog.createDocumentRef(ref, "en")).toThrow("overwrite another locale");
  });

  it.each([
    ["English.json", "english.json"],
    ["Fran\u00e7ais.json", "Franc\u0327ais.json"],
  ])("rejects filenames that alias on common filesystems: %s and %s", (en, fr) => {
    expect(() => createLocalizedJsonDocument({ localeFiles: { en, fr }, rootDir: ".", sourceLocale: "en", unitId: "main" })).toThrow("multiple locales");
    const catalog = createLocalizedJsonDocument({ localeFiles: { fr: "EN.json" }, rootDir: ".", sourceLocale: "en", unitId: "main" });
    expect(() => catalog.listDocumentRefs("en")).toThrow("overwrite another locale");
  });

  it("captures a stable own-property mapping instead of reading mutated or inherited options", async () => {
    const files = { en: "English.json" };
    const catalog = createLocalizedJsonDocument({ localeFiles: files, rootDir: ".", sourceLocale: "en", unitId: "main" });
    files.en = "modified.json";
    expect((await catalog.listDocumentRefs("en"))[0]?.path).toBe("./English.json");
    expect((await catalog.listDocumentRefs("constructor"))[0]?.path).toBe("./constructor.json");
  });
});
