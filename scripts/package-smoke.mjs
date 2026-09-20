import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(rootDir, "packages");

async function getPackageDirectories() {
  const entries = await readdir(packagesDir, {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ai-translate-"))
    .map((entry) => path.join(packagesDir, entry.name))
    .toSorted();
}

async function packPackages(packageDirs, tarballDir) {
  const packages = [];
  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(packageDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const packageName = packageJson.name;
    if (typeof packageName !== "string" || packageName.length === 0) {
      throw new Error(`Package name missing in ${packageJsonPath}.`);
    }

    const { stdout } = await execa(
      "pnpm",
      ["--dir", packageDir, "pack", "--pack-destination", tarballDir],
      {
        cwd: rootDir,
      },
    );
    const tarballName = stdout.trim().split("\n").at(-1);
    if (!tarballName) {
      throw new Error(`pnpm pack did not return a tarball name for ${packageDir}.`);
    }

    packages.push({
      name: packageName,
      tarballPath: path.isAbsolute(tarballName) ? tarballName : path.join(tarballDir, tarballName),
    });
  }

  return packages;
}

async function writePackedWorkspace(packages, consumerDir) {
  const dependencyEntries = packages.map((pkg) => [pkg.name, `file:${pkg.tarballPath}`]);
  await writeFile(
    path.join(consumerDir, "pnpm-workspace.yaml"),
    [
      "packages:",
      "  - .",
      "overrides:",
      ...dependencyEntries.map(
        ([packageName, tarballPath]) =>
          `  ${JSON.stringify(packageName)}: ${JSON.stringify(tarballPath)}`,
      ),
      "",
    ].join("\n"),
  );
}

async function installTarballs(packages, consumerDir, dependencies = packages) {
  await mkdir(consumerDir, { recursive: true });
  await writeFile(
    path.join(consumerDir, "package.json"),
    JSON.stringify(
      {
        dependencies: Object.fromEntries(dependencies.map((pkg) => [pkg.name, `file:${pkg.tarballPath}`])),
        name: "ai-translate-smoke-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  await writePackedWorkspace(packages, consumerDir);
  await execa("pnpm", ["install"], {
    cwd: consumerDir,
  });
}

async function verifyConsumer(consumerDir) {
  await execa(
    "node",
    [
      "--input-type=module",
      "-e",
      [
        "await Promise.all([",
        "  import('ai-translate'),",
        "  import('@ai-translate/apple'),",
        "  import('@ai-translate/integrations'),",
        "  import('@ai-translate/core'),",
        "  import('@ai-translate/core/address'),",
        "  import('@ai-translate/core/acceptance'),",
        "  import('@ai-translate/core/audit'),",
        "  import('@ai-translate/core/constraints'),",
        "  import('@ai-translate/core/hash'),",
        "  import('@ai-translate/core/json'),",
        "  import('@ai-translate/core/message-format'),",
        "  import('@ai-translate/core/plural'),",
        "  import('@ai-translate/core/policies'),",
        "  import('@ai-translate/core/reconcile'),",
        "  import('@ai-translate/core/sync'),",
        "  import('@ai-translate/core/tokens'),",
        "  import('@ai-translate/core/types'),",
        "  import('@ai-translate/fs-json'),",
        "  import('@ai-translate/fs-json/bundle-json'),",
        "  import('@ai-translate/fs-json/document-json'),",
        "  import('@ai-translate/fs-json/namespace-json'),",
        "  import('@ai-translate/fs-json/state'),",
        "  import('@ai-translate/provider-openai'),",
        "  import('@ai-translate/html'),",
        "  import('@ai-translate/markdoc'),",
        "  import('@ai-translate/keystatic'),",
        "  import('@ai-translate/message-formats'),",
        "  import('@ai-translate/next'),",
        "  import('@ai-translate/cli')",
        "]);",
      ].join("\n"),
    ],
    {
      cwd: consumerDir,
    },
  );
  await execa("pnpm", ["exec", "ai-translate", "--help"], {
    cwd: consumerDir,
  });
}

/** Exercise detection, generated TypeScript, installed imports, and real adapter
 * discovery together. Dry runs never ask the configured transport to translate. */
async function verifyDetectedConfigs(consumerDir) {
  const nativeFiles = {
    "App.xcodeproj/project.pbxproj": "developmentRegion = en; knownRegions = (en, Base, fr);",
    "App[AB]/Localizable.xcstrings": JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: { Hello: {} } }),
    "Resources/Base.lproj/Localizable.strings": '"greeting" = "Hello %@";',
    "Resources/en.lproj/InfoPlist.strings": '"name" = "Camera permission";',
  };
  const webFiles = {
    "package.json": JSON.stringify({ dependencies: { "next-intl": "1" } }),
    "messages/en/placeholder.txt": "An empty higher-priority layout must not hide JSON files.",
    "messages/en.json": JSON.stringify({ hello: "Hello" }),
    "i18n/routing.mts": 'throw new Error("Detection must never execute project modules");\n// defaultLocale: "de"\nexport const routing = { locales: ["en", "fr"], defaultLocale: "en" };',
  };
  for (const { name, files, pending } of [
    { name: "native-shape", files: nativeFiles, pending: 3 },
    { name: "web-shape", files: webFiles, pending: 1 },
  ]) {
    const cwd = path.join(consumerDir, name);
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), contents);
    }
    const options = { cwd, env: { OPENAI_API_KEY: "package-smoke-no-network" } };
    const initialization = await execa("pnpm", ["exec", "ai-translate", "init", "--no-install"], options);
    assert.match(initialization.stdout, /(?:pnpm|npm|yarn|bun) (?:add|install)/u);
    const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    assert.ok(Object.values(manifest.scripts).some((script) => script.includes("ai-translate sync")));
    assert.ok(Object.values(manifest.scripts).some((script) => script.includes("ai-translate check")));
    if ("package.json" in files) {
      assert.deepEqual(manifest.dependencies, JSON.parse(files["package.json"]).dependencies);
    }
    const result = await execa("pnpm", ["exec", "ai-translate", "sync", "--dry-run"], options);
    assert.match(result.stdout, new RegExp(`"translatedEntries":\\s*${String(pending)}\\b`, "u"));
    for (const [file, contents] of Object.entries(files)) {
      if (file !== "package.json") {
        assert.equal(await readFile(path.join(cwd, file), "utf8"), contents);
      }
    }
  }
}

/** Install only the unscoped package directly, as npx does, so the scoped CLI's
 * own binary cannot accidentally stand in for a broken launcher. */
async function verifyLauncher(packages, tempRoot) {
  const launcher = packages.find(({ name }) => name === "ai-translate");
  assert.ok(launcher, "The unscoped npx launcher must be included in package smoke tests.");
  const cwd = path.join(tempRoot, "launcher-consumer");
  await installTarballs(packages, cwd, [launcher]);
  const help = await execa("npx", ["--no-install", "ai-translate", "--help"], { cwd });
  assert.match(help.stdout, /ai-translate init/u);
  const version = await execa("npx", ["--no-install", "ai-translate", "--version"], { cwd });
  const cliManifest = JSON.parse(await readFile(path.join(packagesDir, "ai-translate-cli/package.json"), "utf8"));
  assert.equal(version.stdout, cliManifest.version);

  const previewDir = path.join(cwd, "preview");
  await mkdir(previewDir);
  const catalog = JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: { Hello: {} } });
  await writeFile(path.join(previewDir, "Localizable.xcstrings"), catalog);
  const preview = await execa("npx", ["--no-install", "ai-translate", "init", "--preview"], { cwd: previewDir });
  assert.match(preview.stdout, /createAppleStringCatalog/u);
  assert.deepEqual(await readdir(previewDir), ["Localizable.xcstrings"]);
  assert.equal(await readFile(path.join(previewDir, "Localizable.xcstrings"), "utf8"), catalog);
  return path.join(cwd, "node_modules/ai-translate/dist/bin.mjs");
}

/** Exercise init's real package-manager invocation. Overrides keep unpublished
 * workspace changes local; pnpm still resolves and installs the entire graph. */
async function verifyAutomaticInstallation(packages, tempRoot, launcherBin) {
  const cwd = path.join(tempRoot, "automatic-installation");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({
    name: "ai-translate-auto-install-smoke",
    packageManager: "pnpm@10.32.1",
    private: true,
    scripts: { existing: "node --version", postinstall: 'node -e "process.exit(99)"' },
    type: "module",
  }));
  await writePackedWorkspace(packages, cwd);
  await mkdir(path.join(cwd, "App.xcodeproj"));
  await writeFile(path.join(cwd, "App.xcodeproj/project.pbxproj"), "developmentRegion = en; knownRegions = (en, Base, fr);");
  const catalog = JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: { Hello: {} } });
  await writeFile(path.join(cwd, "Localizable.xcstrings"), catalog);
  const options = { cwd, env: { OPENAI_API_KEY: undefined } };
  const initialized = await execa("node", [launcherBin, "init"], options);
  assert.match(initialized.stdout, /Generated configuration and source resources validated/u);
  const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  assert.equal(manifest.scripts.existing, "node --version");
  assert.equal(manifest.scripts.postinstall, 'node -e "process.exit(99)"');
  for (const name of ["@ai-translate/cli", "@ai-translate/apple", "@ai-translate/fs-json", "@ai-translate/provider-openai"]) {
    assert.ok(manifest.devDependencies?.[name] ?? manifest.dependencies?.[name], `${name} must be installed by init.`);
  }
  const sync = await execa("pnpm", ["exec", "ai-translate", "sync", "--dry-run"], options);
  assert.match(sync.stdout, /"translatedEntries":\s*1\b/u);
  assert.equal(await readFile(path.join(cwd, "Localizable.xcstrings"), "utf8"), catalog);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-translate-pack-"));

try {
  const packageDirs = await getPackageDirectories();
  const packages = await packPackages(packageDirs, tempRoot);
  const consumerDir = path.join(tempRoot, "consumer");
  await installTarballs(packages, consumerDir);
  await verifyConsumer(consumerDir);
  await verifyDetectedConfigs(consumerDir);
  const launcherBin = await verifyLauncher(packages, tempRoot);
  await verifyAutomaticInstallation(packages, tempRoot, launcherBin);
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}
