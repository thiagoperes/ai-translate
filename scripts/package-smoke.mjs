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

async function installTarballs(packages, consumerDir) {
  await mkdir(consumerDir, { recursive: true });
  const dependencyEntries = packages.map((pkg) => [pkg.name, `file:${pkg.tarballPath}`]);
  await writeFile(
    path.join(consumerDir, "package.json"),
    JSON.stringify(
      {
        dependencies: Object.fromEntries(dependencyEntries),
        name: "ai-translate-smoke-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
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
    await execa("pnpm", ["exec", "ai-translate", "init"], options);
    const result = await execa("pnpm", ["exec", "ai-translate", "sync", "--dry-run"], options);
    assert.match(result.stdout, new RegExp(`"translatedEntries":\\s*${String(pending)}\\b`, "u"));
    for (const [file, contents] of Object.entries(files)) {
      assert.equal(await readFile(path.join(cwd, file), "utf8"), contents);
    }
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-translate-pack-"));

try {
  const packageDirs = await getPackageDirectories();
  const packages = await packPackages(packageDirs, tempRoot);
  const consumerDir = path.join(tempRoot, "consumer");
  await installTarballs(packages, consumerDir);
  await verifyConsumer(consumerDir);
  await verifyDetectedConfigs(consumerDir);
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}
