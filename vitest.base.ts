import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type ViteUserConfigExport } from "vitest/config";

interface PackageVitestConfigOptions {
  coverageExclude?: string[];
  coverageThresholds?: {
    branches: number;
    functions: number;
    lines: number;
    statements: number;
  };
}

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tests import sibling packages by their published name, and must resolve them
 * to `src` so a run reflects the working tree rather than whatever was last
 * built. This list used to be written out by hand and drifted twice: a package
 * missing an alias silently falls through to its stale `dist`, which still
 * passes and hides the problem. Reading the workspace removes the chance.
 */
const workspaceAliases = readdirSync(path.join(workspaceRoot, "packages"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const packageDir = path.join(workspaceRoot, "packages", entry.name);
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    const name = (manifest as { name?: unknown }).name;
    if (typeof name !== "string") {
      throw new Error(`packages/${entry.name}/package.json declares no name.`);
    }
    return { name, packageDir };
  })
  .toSorted((a, b) => a.name.localeCompare(b.name))
  .flatMap(({ name, packageDir }) => {
    const escaped = name.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");
    return [
      {
        find: new RegExp(`^${escaped}$`, "u"),
        replacement: path.join(packageDir, "src/index.ts"),
      },
      {
        find: new RegExp(`^${escaped}\\/(.+)$`, "u"),
        replacement: path.join(packageDir, "src/$1.ts"),
      },
    ];
  });

function toDirectoryPath(packageUrl: URL | string): string {
  if (typeof packageUrl === "string") {
    return packageUrl;
  }

  return fileURLToPath(packageUrl);
}

export function createPackageVitestConfig(
  packageUrl: URL | string,
  options: PackageVitestConfigOptions = {},
): ViteUserConfigExport {
  const packageDir = toDirectoryPath(packageUrl);
  const srcGlob = path.join(packageDir, "src/**/*.ts");
  const testGlob = path.join(packageDir, "test/**/*.test.ts");
  const coverageThresholds = options.coverageThresholds ?? {
    branches: 70,
    functions: 80,
    lines: 80,
    statements: 80,
  };

  return defineConfig({
    resolve: {
      alias: workspaceAliases,
    },
    test: {
      coverage: {
        exclude: (options.coverageExclude ?? []).map((pattern) => path.join(packageDir, pattern)),
        include: [srcGlob],
        provider: "v8",
        reporter: ["text", "lcov"],
        reportsDirectory: path.join(packageDir, "coverage"),
        thresholds: {
          branches: coverageThresholds.branches,
          functions: coverageThresholds.functions,
          lines: coverageThresholds.lines,
          statements: coverageThresholds.statements,
        },
      },
      environment: "node",
      exclude: ["**/dist/**", "**/node_modules/**"],
      globals: false,
      include: [testGlob],
      mockReset: true,
      restoreMocks: true,
    },
  });
}
