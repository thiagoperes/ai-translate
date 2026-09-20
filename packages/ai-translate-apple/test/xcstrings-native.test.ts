import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncCatalogs, validateCatalogs } from "@ai-translate/core";
import type { AiTranslateConfig, SyncStateSnapshot } from "@ai-translate/core/types";
import { createDetectionContext } from "@ai-translate/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appleIntegration } from "../src/integration";
import { createAppleStringCatalog } from "../src/xcstrings";
import { parseCatalog } from "../src/xcstrings-model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const hasXcode = process.platform === "darwin" && spawnSync("xcrun", ["--find", "xcstringstool"]).status === 0;
const hasLightweightExtraction = hasXcode &&
  spawnSync("xcrun", ["xcstringstool", "help", "extract"], { encoding: "utf8" }).stdout?.includes("--output-format");

// Representative API usage from Hoioi and NewsBlocker, with explicit types so
// compiler extraction can resolve the printf arguments of Swift interpolation.
const swift = [
  "import SwiftUI",
  "struct SmokeView: View {",
  "    let version: String",
  "    let completedSteps: Int",
  "    let totalSteps: Int",
  '    let title = "Stored strings need explicit localization"',
  "    var body: some View {",
  "        VStack {",
  '            Text("Speak like a local")',
  '            Text("Private by design")',
  '            Text("Version \\(version)")',
  '            Text("\\(completedSteps) of \\(totalSteps) done")',
  "            Text(title)",
  "        }",
  "    }",
  "}",
].join("\n");

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apple-extraction-"));
  roots.push(root);
  const source = path.join(root, "Smoke.swift");
  await fs.writeFile(source, swift);
  return { file: path.join(root, "Localizable.xcstrings"), root, source };
}

async function roundTrip(root: string, file: string, expectedKeys: readonly string[]) {
  const before = parseCatalog(await fs.readFile(file, "utf8"), file, "en");
  expect(Object.keys(before.strings).toSorted()).toEqual([...expectedKeys].toSorted());
  const detected = await appleIntegration.detect(createDetectionContext(root));
  expect(detected?.confidence).toBe(0.98);
  const plan = detected?.plan.catalog;
  if (plan?.kind !== "adapter") {
    throw new Error("Expected native catalog detection");
  }
  expect(plan.options.include).toEqual(["Localizable.xcstrings"]);
  const adapter = createAppleStringCatalog({ ...plan.options, rootDir: root, sourceLocale: "en" });
  let snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
  const translate = vi.fn<AiTranslateConfig["provider"]["translate"]>(async ({ requests }) =>
    requests.map(({ key, sourceText }) => ({ key, translation: ["fr:", sourceText].join(" ") })));
  const config: AiTranslateConfig = {
    catalogs: [adapter], sourceLocale: "en", targetLocales: ["fr"], provider: { translate },
    state: {
      load: async () => structuredClone(snapshot),
      save: async (next) => { snapshot = structuredClone(next); },
      withLock: (operation) => operation(),
    },
  };
  expect((await syncCatalogs(config)).metrics).toMatchObject({
    failedEntries: 0, translatedEntries: expectedKeys.length,
  });
  expect((await validateCatalogs(config)).issues).toEqual([]);
  const bytes = await fs.readFile(file, "utf8");
  const after = parseCatalog(bytes, file, "en");
  expect(after.version).toBe(before.version);
  for (const key of expectedKeys) {
    const sourceString = before.strings[key] as { localizations?: { en?: unknown } };
    expect(after.strings[key]).toMatchObject(sourceString);
    const targetString = after.strings[key] as { localizations?: { en?: unknown } };
    expect(targetString.localizations?.en).toEqual(sourceString.localizations?.en);
  }
  translate.mockClear();
  expect((await syncCatalogs(config)).metrics.translatedEntries).toBe(0);
  expect(translate).not.toHaveBeenCalled();
  expect(await fs.readFile(file, "utf8")).toBe(bytes);
  const output = path.join(root, "compiled");
  await fs.mkdir(output);
  execFileSync("xcrun", ["xcstringstool", "compile", file, "--output-directory", output], { timeout: 30_000 });
  const compiled = JSON.parse(execFileSync("plutil", [
    "-convert", "json", "-o", "-", path.join(output, "fr.lproj/Localizable.strings"),
  ], { encoding: "utf8" })) as Record<string, string>;
  expect(compiled["Speak like a local"]).toBe("fr: Speak like a local");
  return compiled;
}

describe("Apple-produced catalogs", () => {
  it.skipIf(!hasLightweightExtraction)("detects, translates, and recompiles the installed Xcode extractor's catalog version", async () => {
    const { file, root, source } = await setup();
    execFileSync("xcrun", [
      "xcstringstool", "extract", "--SwiftUI", "--output-format", "xcstrings",
      "--output-directory", root, source,
    ], { timeout: 30_000 });
    const compiled = await roundTrip(root, file, ["Speak like a local", "Private by design", "Version %arg", "%arg of %arg done"]);
    expect(compiled["Private by design"]).toBe("fr: Private by design");
  }, 60_000);

  it.skipIf(!hasXcode)("preserves compiler-resolved interpolation types through extraction, detection, and sync", async () => {
    const { file, root, source } = await setup();
    execFileSync("xcrun", [
      "swiftc", "-emit-object", source, "-emit-localized-strings",
      "-emit-localized-strings-path", root, "-o", path.join(root, "Smoke.o"),
    ], { timeout: 30_000 });
    await fs.writeFile(file, JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {} }));
    execFileSync("xcrun", [
      "xcstringstool", "sync", file, "--stringsdata", path.join(root, "Smoke.stringsdata"),
    ], { timeout: 30_000 });
    const compiled = await roundTrip(root, file, [
      "Speak like a local", "Private by design", "Version %@", "%lld of %lld done",
    ]);
    expect(compiled["Version %@"]).toBe("fr: Version %@");
    expect(compiled["%lld of %lld done"]).toBe("fr: %1$lld of %2$lld done");
  }, 60_000);
});
