import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncCatalogs, validateCatalogs } from "@ai-translate/core";
import type {
  AiTranslateConfig,
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

async function setup() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-strings-sync-"));
  roots.push(rootDir);
  await fs.mkdir(path.join(rootDir, "en.lproj"));
  const sourcePath = path.join(rootDir, "en.lproj/Localizable.strings");
  await fs.writeFile(
    sourcePath,
    '/* Greeting shown on the welcome screen */\n"greet" = "Hello %@";\n"cancel" = "Cancel";\n',
  );
  let snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
  const translate = vi.fn<TranslationProvider["translate"]>(({ requests }) =>
    Promise.resolve(requests.map((request) => ({
      key: request.key,
      translation: request.sourceText
        .replace("Hello", "Hallo")
        .replace("Cancel", "Abbrechen")
        .replace("Welcome", "Willkommen"),
    }))),
  );
  const config: AiTranslateConfig = {
    catalogs: [createAppleStringsCatalog({ rootDir, sourceLocale: "en" })],
    provider: { translate },
    sourceLocale: "en",
    state: {
      load: () => Promise.resolve(structuredClone(snapshot)),
      save: (next) => {
        snapshot = structuredClone(next);
        return Promise.resolve();
      },
      withLock: (operation) => operation(),
    },
    targetLocales: ["de", "fr"],
  };
  return { config, rootDir, sourcePath, translate };
}

async function table(filePath: string): Promise<Record<string, string>> {
  const { text } = decodeStrings(await fs.readFile(filePath));
  return Object.fromEntries(parseStrings(text).records.map(({ key, value }) => [key, value]));
}

describe("Apple strings engine integration", () => {
  it("translates explicitly literal percentages while keeping other keys protected as printf", async () => {
    const { config, rootDir, sourcePath, translate } = await setup();
    await fs.writeFile(sourcePath, '"progress"="100% done";\n"progress.detail"="Hello %@";\n');
    const literalConfig = {
      ...config,
      catalogs: [createAppleStringsCatalog({ rootDir, sourceLocale: "en", plainTextKeys: ["progress"] })],
      targetLocales: ["fr"],
    };
    translate.mockImplementation(async ({ requests }) => requests.map((request) => ({
      key: request.key,
      translation: request.sourceText === "100% done" ? "100 % terminé" : "Bonjour %@",
    })));
    expect((await syncCatalogs(literalConfig)).metrics).toMatchObject({ failedEntries: 0, translatedEntries: 2 });
    const requests = translate.mock.calls.flatMap(([args]) => args.requests);
    expect(requests.find(({ sourceText }) => sourceText === "100% done")?.tokens).toEqual([
      { raw: "100% done", type: "text" },
    ]);
    expect(requests.find(({ sourceText }) => sourceText === "Hello %@")?.tokens).toContainEqual(
      expect.objectContaining({ raw: "%@", syntax: "printf" }),
    );
    const targetPath = path.join(rootDir, "fr.lproj/Localizable.strings");
    expect(await table(targetPath)).toEqual({ progress: "100 % terminé", "progress.detail": "Bonjour %@" });
    expect((await validateCatalogs(literalConfig)).issues).toEqual([]);
    expect((await syncCatalogs(literalConfig)).metrics.translatedEntries).toBe(0);
    await fs.writeFile(targetPath, '"progress"="100 % terminé";\n"progress.detail"="Bonjour";\n');
    expect((await validateCatalogs(literalConfig)).issues.map(({ code }) => code))
      .toContain("apple-printf-argument-mismatch");
  });

  it("syncs two locales, forwards comments, stays incremental, and detects source edits", async () => {
    const { config, rootDir, sourcePath, translate } = await setup();
    const first = await syncCatalogs(config);
    expect(first.metrics.translatedEntries).toBe(4);
    expect(first.metrics.failedEntries).toBe(0);
    const greetingRequest = translate.mock.calls
      .flatMap(([{ requests }]) => requests)
      .find((request) => request.sourceText.startsWith("Hello"));
    expect(greetingRequest?.context?.notes).toContain("Greeting shown on the welcome screen");
    const targetPath = path.join(rootDir, "de.lproj/Localizable.strings");
    expect(await table(targetPath)).toEqual({ greet: "Hallo %@", cancel: "Abbrechen" });
    expect((await validateCatalogs(config)).issues).toEqual([]);
    translate.mockClear();
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(0);
    expect(translate).not.toHaveBeenCalled();
    await fs.writeFile(
      sourcePath,
      '/* Greeting shown on the welcome screen */\n"greet" = "Welcome %@";\n"cancel" = "Cancel";\n',
    );
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(2);
    expect(await table(targetPath)).toEqual({ greet: "Willkommen %@", cancel: "Abbrechen" });
  });

  it("requires an existing target for path scope and does not seed excluded source keys", async () => {
    const { config, rootDir, translate } = await setup();
    const options = { includePaths: ["/greet"], locales: ["de"] };
    await expect(syncCatalogs(config, options)).rejects.toThrow("existing target document");
    expect(translate).not.toHaveBeenCalled();
    const targetPath = path.join(rootDir, "de.lproj/Localizable.strings");
    await fs.mkdir(path.dirname(targetPath));
    await fs.writeFile(targetPath, "/* Empty target */\n");
    const result = await syncCatalogs(config, options);
    expect(result.metrics.failedEntries).toBe(0);
    expect(await table(targetPath)).toEqual({ greet: "Hallo %@" });
    expect(await fs.readFile(targetPath, "utf8")).toContain("/* Empty target */");
    await expect(fs.access(path.join(rootDir, "fr.lproj"))).rejects.toThrow();
  });

  it("preserves manual edits and unselected generated translations and state during scoped sync", async () => {
    const { config, rootDir, sourcePath } = await setup();
    await syncCatalogs(config);
    const targetPath = path.join(rootDir, "de.lproj/Localizable.strings");
    const frenchPath = path.join(rootDir, "fr.lproj/Localizable.strings");
    const frenchBefore = await fs.readFile(frenchPath);
    const beforeState = await config.state.load();
    await fs.writeFile(targetPath, '/* Human */\n"greet"="Hallo %@";\n"cancel"="Handarbeit";\n');
    await fs.writeFile(sourcePath, '"greet"="Welcome %@";\n"cancel"="Cancel now";\n');
    const result = await syncCatalogs(config, { includePaths: ["/greet"], locales: ["de"] });
    expect(result.metrics.translatedEntries).toBe(1);
    expect(await table(targetPath)).toEqual({ greet: "Willkommen %@", cancel: "Handarbeit" });
    expect(await fs.readFile(targetPath, "utf8")).toContain("/* Human */");
    expect(await fs.readFile(frenchPath)).toEqual(frenchBefore);
    const afterState = await config.state.load();
    const untouched = Object.entries(beforeState.entries)
      .filter(([, previous]) => previous.locale === "fr" || previous.jsonPointer === "/cancel");
    for (const [key, previous] of untouched) {
      expect(afterState.entries[key]).toEqual(previous);
    }
  });

  it("keeps human translations after source changes and preserves obsolete target keys", async () => {
    const { config, rootDir, sourcePath, translate } = await setup();
    await syncCatalogs(config);
    const targetPath = path.join(rootDir, "de.lproj/Localizable.strings");
    await fs.writeFile(targetPath, '/* Human */\n"greet"="Moin %@";\n"cancel"="Abbrechen";\n');
    await syncCatalogs(config, { locales: ["de"] });
    await fs.writeFile(sourcePath, '"greet"="Welcome %@";\n');
    translate.mockClear();
    const result = await syncCatalogs(config, { locales: ["de"] });
    expect(result.metrics.translatedEntries).toBe(0);
    expect(result.metrics.staleManualEntries).toBe(1);
    expect(translate).not.toHaveBeenCalled();
    expect(await table(targetPath)).toEqual({ greet: "Moin %@", cancel: "Abbrechen" });
    expect((await validateCatalogs(config, { locales: ["de"] })).issues).toEqual([]);
  });

  it("preserves a human translation when source and target both changed before the next sync", async () => {
    const { config, rootDir, sourcePath, translate } = await setup();
    await syncCatalogs(config);
    const targetPath = path.join(rootDir, "de.lproj/Localizable.strings");
    const target = '/* Reviewed by a person */\n"greet"="Moin %@";\n"cancel"="Abbrechen";\n';
    await fs.writeFile(targetPath, target);
    await fs.writeFile(sourcePath, '"greet"="Welcome %@";\n"cancel"="Cancel";\n');
    translate.mockClear();
    const result = await syncCatalogs(config, { locales: ["de"] });
    expect(result.metrics.translatedEntries).toBe(0);
    expect(result.metrics.staleManualEntries).toBe(1);
    expect(translate).not.toHaveBeenCalled();
    expect(await fs.readFile(targetPath, "utf8")).toBe(target);
  });

  it("keeps dry runs read-only and preserves a source UTF-16 encoding on new targets", async () => {
    const { config, rootDir, sourcePath, translate } = await setup();
    const sourceBytes = encodeStrings('"greet"="Hello %@";\n', "utf16le");
    await fs.writeFile(sourcePath, sourceBytes);
    const beforeState = await config.state.load();
    expect((await syncCatalogs(config, { dryRun: true })).metrics.translatedEntries).toBe(2);
    expect(translate).not.toHaveBeenCalled();
    expect(await config.state.load()).toEqual(beforeState);
    await expect(fs.access(path.join(rootDir, "de.lproj"))).rejects.toThrow();
    await syncCatalogs(config);
    const decoded = decodeStrings(await fs.readFile(path.join(rootDir, "de.lproj/Localizable.strings")));
    expect(decoded).toEqual({ encoding: "utf16le", text: '"greet"="Hallo %@";\n' });
    expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
  });

  it("refuses incompatible native argument types without writing invalid output", async () => {
    const { config, rootDir, sourcePath } = await setup();
    const sourceBefore = await fs.readFile(sourcePath);
    config.provider = {
      translate: ({ requests }) => Promise.resolve(requests.map((request) => ({
        key: request.key,
        translation: request.sourceText.replace("%@", "%d"),
      }))),
    };
    const result = await syncCatalogs(config);
    expect(result.metrics.failedEntries).toBeGreaterThan(0);
    expect(result.documents.flatMap((document) => document.issues.map((issue) => issue.code)))
      .toContain("apple-printf-argument-mismatch");
    expect(await fs.readFile(sourcePath)).toEqual(sourceBefore);
    await expect(fs.access(path.join(rootDir, "de.lproj/Localizable.strings"))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "darwin")(
    "matches Apple's property-list reader for generated UTF-8/UTF-16 and legacy strings syntax",
    async () => {
      const { rootDir } = await setup();
      const octal = Array.from({ length: 254 }, (_, byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
      const text = `${String.raw`/* Unicode and quoted prose */
"greet" = "你好 \"%@\" 🚀";
"line" = "First\nSecond\t\U0001";
"legacy" = "\200\335\375 \u00e9 \q";
"short-unicode" = "\U1 \U123g \U12345";
'single' = 'Quoted value';
name:part = foo/bar;
`}// CR comment\r"continuation"="one\\\ntwo\\\r\nthree";\r// Unicode line comment\u2028"octal"="${octal}";`;
      const parsed = Object.fromEntries(parseStrings(text).records.map(({ key, value }) => [key, value]));
      for (const encoding of ["utf8", "utf8-bom", "utf16le", "utf16be"] as const) {
        const filePath = path.join(rootDir, `${encoding}.strings`);
        await fs.writeFile(filePath, encodeStrings(text, encoding));
        const native = execFileSync("plutil", ["-convert", "json", "-o", "-", filePath], { encoding: "utf8" });
        expect(JSON.parse(native)).toEqual(parsed);
      }
    },
  );
});
