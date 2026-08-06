import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { DetectionContext } from "./types";

export function createDetectionContext(root: string): DetectionContext {
  const resolve = (relativePath: string): string => path.resolve(root, relativePath);

  async function readDirectory(
    relativePath: string,
    kind: "directory" | "file",
  ): Promise<readonly string[]> {
    try {
      const dirents = await fs.readdir(resolve(relativePath), { withFileTypes: true });
      return dirents
        .filter((dirent) => (kind === "directory" ? dirent.isDirectory() : dirent.isFile()))
        .map((dirent) => dirent.name)
        .toSorted((left, right) => left.localeCompare(right));
    } catch {
      return [];
    }
  }

  async function readFile(relativePath: string): Promise<string | null> {
    try {
      return await fs.readFile(resolve(relativePath), "utf8");
    } catch {
      return null;
    }
  }

  async function readPackageJson(): Promise<Record<string, unknown> | null> {
    const raw = await readFile("package.json");
    if (raw === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  let packageJsonPromise: Promise<Record<string, unknown> | null> | undefined;

  return {
    listDirectories: (relativePath) => readDirectory(relativePath, "directory"),
    listFiles: (relativePath) => readDirectory(relativePath, "file"),
    packageJson: () => (packageJsonPromise ??= readPackageJson()),
    readFile,
    root,
  };
}

/** Every declared dependency, regardless of which section it sits in. */
export async function dependencyNames(context: DetectionContext): Promise<ReadonlySet<string>> {
  const manifest = await context.packageJson();
  const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;

  return new Set(
    sections.flatMap((section) => {
      const value = manifest?.[section];
      return typeof value === "object" && value !== null ? Object.keys(value) : [];
    }),
  );
}

/**
 * Resolves the first path that exists.
 *
 * Candidates are ordered by convention precedence — Next.js allows most config
 * files at both the project root and under `src/` — so the first hit is the
 * answer and later candidates must not be probed.
 */
export async function firstExistingFile(
  context: DetectionContext,
  candidates: readonly string[],
): Promise<string | null> {
  const found = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: (await context.readFile(candidate)) !== null,
    })),
  );

  return found.find((entry) => entry.exists)?.candidate ?? null;
}
