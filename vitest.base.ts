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

const workspaceAliases = [
  {
    find: /^@ai-translate\/cli$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-cli/src/index.ts"),
  },
  {
    find: /^@ai-translate\/cli\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-cli/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/core$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-core/src/index.ts"),
  },
  {
    find: /^@ai-translate\/core\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-core/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/fs-json$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-fs-json/src/index.ts"),
  },
  {
    find: /^@ai-translate\/fs-json\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-fs-json/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/html$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-html/src/index.ts"),
  },
  {
    find: /^@ai-translate\/html\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-html/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/keystatic$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-keystatic/src/index.ts"),
  },
  {
    find: /^@ai-translate\/keystatic\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-keystatic/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/markdoc$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-markdoc/src/index.ts"),
  },
  {
    find: /^@ai-translate\/markdoc\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-markdoc/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/provider-ai-sdk$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-provider-ai-sdk/src/index.ts"),
  },
  {
    find: /^@ai-translate\/provider-ai-sdk\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-provider-ai-sdk/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/provider-core$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-provider-core/src/index.ts"),
  },
  {
    find: /^@ai-translate\/provider-core\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-provider-core/src/$1.ts"),
  },
  {
    find: /^@ai-translate\/provider-openai$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-provider-openai/src/index.ts"),
  },
  {
    find: /^@ai-translate\/provider-openai\/(.+)$/u,
    replacement: path.join(workspaceRoot, "packages/ai-translate-provider-openai/src/$1.ts"),
  },
];

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
