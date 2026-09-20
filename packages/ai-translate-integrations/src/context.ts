import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { DetectionContext } from "./types";

export function createDetectionContext(root: string): DetectionContext {
  const absoluteRoot = path.resolve(root);
  const realRoot = fs.realpath(absoluteRoot).catch(() => null);

  /** Treat a linked project root as the project itself, but never follow links
   * inside it into another tree or through an alternate name for a source. */
  async function resolve(relativePath: string): Promise<string | null> {
    if (path.isAbsolute(relativePath)) {
      return null;
    }
    const candidate = path.resolve(absoluteRoot, relativePath);
    const relative = path.relative(absoluteRoot, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([realRoot, fs.realpath(candidate)]);
      return canonicalRoot !== null && canonicalPath === path.resolve(canonicalRoot, relative)
        ? canonicalPath : null;
    } catch {
      return null;
    }
  }

  async function readDirectory(
    relativePath: string,
    kind: "directory" | "file",
  ): Promise<readonly string[]> {
    try {
      const resolved = await resolve(relativePath);
      if (resolved === null) {
        return [];
      }
      const dirents = await fs.readdir(resolved, { withFileTypes: true });
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
      const resolved = await resolve(relativePath);
      return resolved === null ? null : await fs.readFile(resolved, "utf8");
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
      const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ""));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
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
      return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
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

const GENERATED_DIRECTORIES = new Set([
  "node_modules", "Pods", "Carthage", "DerivedData", "build", "Build", "dist",
  "coverage", "release", "vendor", "generated", "gen", "target",
]);
const BUILT_BUNDLE_SUFFIX = /\.(?:app|xcarchive|framework|xcframework)$/u;

/** Discover authored project files without following directory symlinks or
 * descending into dependencies, generated outputs, or hidden tool caches. */
export async function findProjectFiles(
  context: DetectionContext,
  matches: (relativePath: string) => boolean,
  shouldVisitDirectory?: (relativePath: string) => boolean | Promise<boolean>,
): Promise<readonly string[]> {
  const pending = [""];
  const found: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    const [files, directories] = await Promise.all([
      context.listFiles(directory),
      context.listDirectories(directory),
    ]);
    const join = (name: string): string => directory === "" ? name : `${directory}/${name}`;
    found.push(...files.map(join).filter(matches));
    const candidates = directories
      .filter((name) => !name.startsWith(".") && !GENERATED_DIRECTORIES.has(name) && !BUILT_BUNDLE_SUFFIX.test(name))
      .map(join);
    const permitted = await Promise.all(candidates.map(async (directoryPath) => ({
      directoryPath,
      visit: await shouldVisitDirectory?.(directoryPath) ?? true,
    })));
    pending.push(...permitted.filter(({ visit }) => visit).map(({ directoryPath }) => directoryPath));
  }
  return found.toSorted((left, right) => left.localeCompare(right));
}
