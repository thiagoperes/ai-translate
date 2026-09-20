import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createDetectionContext, renderConfig, requiredConfigPackages } from "@ai-translate/integrations";
import { afterEach, describe, expect, it } from "vitest";

import { readStaticExpoConfig } from "../src/expo-config";
import { expoIntegration } from "../src/expo-integration";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function seed(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-expo-"));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}

const metadata = '{"ios":{"NSCameraUsageDescription":"Take a photo","Localizable.strings":{"hello":"Hello %@"}},"android":{"app_name":"App"}}';
function project(locales: Record<string, unknown> = { en: "./native/english.json", fr: "./native/french.json" }, extra: Record<string, string> = {}) {
  return {
    "app.json": JSON.stringify({ expo: { locales } }),
    "native/english.json": metadata,
    ...extra,
  };
}

async function detect(files: Record<string, string>) {
  return expoIntegration.detect(createDetectionContext(await seed(files)));
}

describe("Expo native metadata discovery", () => {
  it("detects explicit arbitrary paths and mapped missing target files without changing anything", async () => {
    const root = await seed(project());
    const result = await expoIntegration.detect(createDetectionContext(root));
    expect(result).toMatchObject({
      integrationId: "expo",
      plan: {
        catalog: { id: "expo-native-metadata", kind: "document-json", rootDir: ".", localeFiles: { en: "native/english.json", fr: "native/french.json" } },
        sourceLocale: "en", targetLocales: ["fr"],
        messageFormat: { name: "applePrintfMessageFormat" },
      },
    });
    expect(await fs.readdir(path.join(root, "native"))).toEqual(["english.json"]);
    if (result === null) { throw new Error("Expected Expo metadata"); }
    expect(renderConfig(result.plan)).toContain('localeFiles: {"en":"native/english.json","fr":"native/french.json"}');
    expect(requiredConfigPackages(result.plan)).toContain("@ai-translate/message-formats");
    expect(result.plan.warnings.join(" ")).toContain("provisionally");
    expect(result.plan.warnings.join(" ")).toContain("Shared React Native UI");
  });

  it("honors a declared source alias while preserving mapped spelling and filenames", async () => {
    const result = await detect(project({}, {
      "app.json": JSON.stringify({ expo: { ios: { infoPlist: { CFBundleDevelopmentRegion: "FR" } }, locales: { fr: "native/french.json", EN: "native/english.json" } } }),
      "native/french.json": metadata,
    }));
    expect(result?.plan.sourceLocale).toBe("fr");
    expect(result?.plan.targetLocales).toEqual(["EN"]);
    expect(result?.plan.warnings.join(" ")).not.toContain("provisionally");
  });

  it("recognizes a BOM and a single source locale without inventing targets", async () => {
    const result = await detect(project({ EN: "native/english.json" }, { "native/english.json": `\uFEFF${metadata}` }));
    expect(result?.plan.sourceLocale).toBe("EN");
    expect(result?.plan.targetLocales).toEqual([]);
    expect(result?.plan.warnings.join(" ")).toContain("No target languages");
  });

  it("chooses a deterministic non-English source when no source declaration exists", async () => {
    const result = await detect(project({ ja: "native/english.json", fr: "native/french.json" }, { "native/french.json": metadata }));
    expect(result?.plan.sourceLocale).toBe("fr");
  });

  it.each(["app.config.ts", "app.config.js"])("detects a static %s export and gives it precedence over app.json", async (file) => {
    const result = await detect(project({}, {
      "package.json": '{"dependencies":{"expo":"57"}}',
      [file]: "export default {name: 'App', locales: {en: './native/english.json', de: './native/german.json'}};",
    }));
    expect(result?.plan.targetLocales).toEqual(["de"]);
    expect(result?.evidence[0]?.source).toBe(file);
  });

  it("accepts root-level static config only when Expo is declared", async () => {
    const files = project({}, { "app.json": JSON.stringify({ locales: { en: "native/english.json" } }) });
    expect(await detect(files)).toBeNull();
    expect(await detect({ ...files, "package.json": '{"optionalDependencies":{"expo":"57"}}' })).not.toBeNull();
  });

  it("does not fall back to app.json when a dynamic config controls the locale mapping", async () => {
    const files = project(undefined, { "app.config.ts": 'export default ({config}) => ({...config, locales: process.env.LOCALES});', "app.config.js": 'export default {expo:{locales:{en:"native/english.json"}}};' });
    expect(await detect(files)).toBeNull();
  });

  it.each([
    {}, { en: "native/missing.json" }, { "pt_BR": "native/english.json" },
    { en: "native/english.json", EN: "native/another.json" },
    { en: "native/english.json", fr: "native/../native/english.json" },
    { en: "native/english.json", fr: "native/English.json" },
    { en: "native/Fran\u00e7ais.json", fr: "native/Franc\u0327ais.json" },
    { en: { ios: { title: "inline" } } }, { en: "/tmp/en.json" },
    { en: "../en.json" }, { en: "C:en.json" }, { en: "C:\\en.json" },
    { en: "https://example.test/en.json" }, { en: "native/en.js" },
    { en: "missing/en.json" }, { en: "native/\0.json" },
  ])("rejects an unsafe, ambiguous, or unreadable mapping %j", async (locales) => {
    expect(await detect(project(locales))).toBeNull();
  });

  it.each(["[]", "null", '"Hello"', "{broken"])("rejects malformed source JSON %s", async (source) => {
    expect(await detect(project(undefined, { "native/english.json": source }))).toBeNull();
  });

  it.each(["{broken", "null", "[]", '{"expo":null}', '{"expo":{"locales":[]}}', '{"expo":{}}'])("ignores unsupported app configuration %s", async (config) => {
    expect(await detect(project(undefined, { "app.json": config }))).toBeNull();
  });

  it("does not follow a mapped source or output directory symlink", async () => {
    const root = await seed(project({ en: "native/english.json", fr: "linked/fr.json" }));
    await fs.symlink(path.join(root, "native"), path.join(root, "linked"));
    expect(await expoIntegration.detect(createDetectionContext(root))).toBeNull();
    await fs.writeFile(path.join(root, "app.json"), JSON.stringify({ expo: { locales: { en: "native/linked.json" } } }));
    await fs.symlink(path.join(root, "native/english.json"), path.join(root, "native/linked.json"));
    expect(await expoIntegration.detect(createDetectionContext(root))).toBeNull();
  });

  it("ignores projects with no authored Expo configuration", async () => {
    expect(await detect({ "package.json": '{"dependencies":{"expo":"57"}}' })).toBeNull();
  });
});

describe("static Expo config parsing", () => {
  it.each([
    "export default {locales:{en:'en.json'}, plugins: [], enabled: true, disabled: false, blank:null, scale: -1.5e2};",
    "module.exports = {locales:{en:`en.json`}, plugins: [['plugin', {enabled: true}],],};",
    'import type {ExpoConfig} from "expo/config"; const config: ExpoConfig = {locales: {en: "en.json"}} as const; export default config;',
    "const config = {locales: {en: 'en.json'}} satisfies ExpoConfig; export default config",
    '/* locales: ignored */ export default {"locales": {"en":"en.json"}} // tail',
  ])("reads only literal data from %s", (source) => {
    expect(readStaticExpoConfig(source)?.locales).toEqual({ en: "en.json" });
  });

  it.each([
    "export default () => ({locales:{en:'en.json'}})",
    "export default {locales: {en: process.env.FILE}}",
    "export default {...config, locales:{en:'en.json'}}",
    "export default {locales: {en: 'en.json'}, ...config}",
    "export default {locales: {en: `${path}.json`}}",
    "export default {locales: {en: 'en.json' + suffix}}",
    "export default {locales: {en: 'en.json'}, get extra() { throw 1 }}",
    "export default {locales: {en: 'a.json', en: 'b.json'}}",
    "export default {locales: {en: 'en.json'}, extra: /locales:/}",
    "import config from './config'; export default config",
    "import type {Config} from './config'",
    "const config = {locales: {en: 'en.json'}}; config.locales.en = 'other.json'; export default config",
    "const = {}; export default config", "const config: {} = {}; export default config",
    "const config {}; export default config", "const config = {}; export default other",
    "export default {broken}", "export default {foo: 1 bar: 2}",
    "export default [1 2]", "export default [Infinity]", "export default {value: 1e309}",
    "export default {} as Config", "export default {} satisfies {}",
    "export default {} ; sideEffect()", "export default null", "export default []",
    'export default {broken: "\\q"}', "export default {broken: 'can\\'t'}", "export default {",
  ])("declines executable or unsupported syntax %s", (source) => {
    expect(readStaticExpoConfig(source)).toBeNull();
  });

  it("bounds pathological nesting and token counts", () => {
    expect(readStaticExpoConfig(`export default ${"{x:".repeat(66)}0${"}".repeat(66)}`)).toBeNull();
    expect(readStaticExpoConfig(`export default [${"0,".repeat(50_001)}]`)).toBeNull();
  });
});
