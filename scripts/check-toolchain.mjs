/**
 * Fails when the workspace is not compiling on TypeScript 7.
 *
 * TypeScript 7 is the native compiler, and the gap is not a matter of taste:
 * a full typecheck of this workspace runs in about a second, which is what lets
 * `typecheck` sit in the pre-commit hook instead of being deferred to CI. A
 * silent downgrade — an override, a stale lockfile, a package pinning its own
 * copy — would restore minute-scale checks without failing anything, so the
 * version is asserted rather than assumed.
 *
 * Tools that bundle their own TypeScript to emulate older module resolution
 * (`@arethetypeswrong/core` ships 5.6) are deliberately not covered: that copy
 * is an input to their analysis, never a compiler for our sources. Only the
 * `typescript` our own `tsc` resolves to is checked, plus the declarations that
 * could redirect it.
 */
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_MAJOR = 7;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const problems = [];

const rootManifest = JSON.parse(
  await readFile(path.join(rootDir, "package.json"), "utf8"),
);

const declared =
  rootManifest.devDependencies?.typescript ?? rootManifest.dependencies?.typescript;
if (declared === undefined) {
  problems.push("The workspace root does not declare a typescript dependency.");
} else if (!/^[\^~]?7\./u.test(declared)) {
  problems.push(
    `The workspace root declares typescript "${declared}"; it must be a ${REQUIRED_MAJOR}.x range.`,
  );
}

/*
 * The declared range and the installed compiler can disagree whenever the
 * lockfile predates a bump, and the installed one is what actually runs.
 */
const resolved = JSON.parse(
  await readFile(require.resolve("typescript/package.json"), "utf8"),
).version;
if (Number(resolved.split(".")[0]) !== REQUIRED_MAJOR) {
  problems.push(
    `The resolved typescript is ${resolved}; the workspace requires ${REQUIRED_MAJOR}.x.`,
  );
}

/*
 * A per-package pin resolves ahead of the root copy for that package alone, so
 * one member of the workspace can quietly compile on a different compiler than
 * everything typechecked beside it.
 */
const entries = await readdir(path.join(rootDir, "packages"), {
  withFileTypes: true,
});
for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }
  const manifest = JSON.parse(
    await readFile(
      path.join(rootDir, "packages", entry.name, "package.json"),
      "utf8",
    ),
  );
  const own =
    manifest.dependencies?.typescript ?? manifest.devDependencies?.typescript;
  if (own !== undefined) {
    problems.push(
      `${manifest.name} declares its own typescript "${own}"; the root pin is the only one.`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems.toSorted()) {
    console.error(problem);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Toolchain OK: TypeScript ${resolved} (native).\n`);
}
