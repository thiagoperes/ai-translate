import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncCatalogs, validateCatalogs } from "@ai-translate/core";
import type { AiTranslateConfig, JsonObject, SyncStateSnapshot } from "@ai-translate/core/types";
import { afterEach, describe, expect, it } from "vitest";

import { createAppleStringCatalog } from "../src/xcstrings";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});
const hasXcode = process.platform === "darwin" &&
  spawnSync("xcrun", ["--find", "xcstringstool"]).status === 0 &&
  spawnSync("xcrun", ["--find", "swiftc"]).status === 0;
const unit = (value: string): JsonObject => ({ stringUnit: { state: "translated", value } });

describe("compiled String Catalog runtime", () => {
  it.skipIf(!hasXcode)("renders target plural categories and reordered named arguments through Foundation", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "apple-xcstrings-runtime-"));
    roots.push(rootDir);
    const filePath = path.join(rootDir, "Localizable.xcstrings");
    await fs.writeFile(filePath, JSON.stringify({
      sourceLanguage: "en",
      version: "1.0",
      strings: {
        counts: { localizations: { en: {
          ...unit("%#@animals@ and %#@birds@"),
          substitutions: {
            animals: { argNum: 1, formatSpecifier: "lld", variations: {
              plural: { one: unit("%arg animal"), other: unit("%arg animals") },
            } },
            birds: { argNum: 2, formatSpecifier: "lld", variations: {
              plural: { one: unit("%arg bird"), other: unit("%arg birds") },
            } },
          },
        } } },
      },
    }));
    let snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
    const config: AiTranslateConfig = {
      catalogs: [createAppleStringCatalog({ rootDir, sourceLocale: "en" })],
      sourceLocale: "en",
      targetLocales: ["de", "pl"],
      provider: { translate: async ({ locale, requests }) => requests.map(({ key, sourceText, context }) => {
        if (sourceText === "%#@animals@ and %#@birds@") {
          return { key, translation: locale === "de" ? "%#@birds@ und %#@animals@" : "%#@animals@ i %#@birds@" };
        }
        const one = context?.notes?.includes("Plural category: one.") === true;
        const few = context?.notes?.includes("Plural category: few.") === true;
        const animals = sourceText.includes("animal");
        const noun = locale === "de"
          ? animals ? one ? "Tier" : "Tiere" : one ? "Vogel" : "Vögel"
          : animals ? one ? "zwierzę" : few ? "zwierzęta" : "zwierząt" : one ? "ptak" : few ? "ptaki" : "ptaków";
        return { key, translation: `%arg ${noun}` };
      }) },
      state: {
        load: async () => structuredClone(snapshot),
        save: async (next) => { snapshot = structuredClone(next); },
        withLock: (operation) => operation(),
      },
    };
    expect((await syncCatalogs(config)).metrics).toMatchObject({ translatedEntries: 14, failedEntries: 0 });
    expect((await validateCatalogs(config)).issues).toEqual([]);
    expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(0);

    // A real bundle lets Foundation select resources and plural rules from the
    // requested language instead of relying only on compiler output snapshots.
    const contents = path.join(rootDir, "Runtime.app/Contents");
    const resources = path.join(contents, "Resources");
    const binary = path.join(contents, "MacOS/Runtime");
    await fs.mkdir(resources, { recursive: true });
    await fs.mkdir(path.dirname(binary));
    await fs.writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.ai-translate.runtime</string>
<key>CFBundleExecutable</key><string>Runtime</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleDevelopmentRegion</key><string>en</string>
</dict></plist>`);
    execFileSync("xcrun", ["xcstringstool", "compile", filePath, "--output-directory", resources]);
    const swiftPath = path.join(rootDir, "Runtime.swift");
    await fs.writeFile(swiftPath, `import Foundation
let format = Bundle.main.localizedString(forKey: "counts", value: nil, table: "Localizable")
let pairs: [(Int64, Int64)] = [(1, 2), (2, 1), (5, 22), (21, 5)]
let values = pairs.map { String.localizedStringWithFormat(format, $0.0, $0.1) }
let data = try JSONSerialization.data(withJSONObject: ["locale": Bundle.main.preferredLocalizations[0], "values": values])
print(String(decoding: data, as: UTF8.self))
`);
    execFileSync("xcrun", ["swiftc", swiftPath, "-o", binary]);
    for (const [locale, expected] of [
      ["de", ["2 Vögel und 1 Tier", "1 Vogel und 2 Tiere", "22 Vögel und 5 Tiere", "5 Vögel und 21 Tiere"]],
      ["pl", ["1 zwierzę i 2 ptaki", "2 zwierzęta i 1 ptak", "5 zwierząt i 22 ptaki", "21 zwierząt i 5 ptaków"]],
    ] as const) {
      const output = execFileSync(binary, ["-AppleLanguages", `(${locale})`, "-AppleLocale", locale], { encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({ locale, values: expected });
    }
  }, 30_000);
});
