/**
 * Fails when a workspace package is missing its `tsconfig.base.json` path
 * mapping.
 *
 * Typecheck runs before build in CI, so a cross-package import only resolves
 * through these mappings. Without one the import falls through to the sibling's
 * `dist`, which passes locally — where a previous build left `dist` behind — and
 * fails on a clean checkout. That is exactly how
 * `@ai-translate/message-formats` shipped broken: it was the one package absent
 * from the list.
 *
 * The equivalent Vitest alias list is derived from the filesystem in
 * `vitest.base.ts` and needs no check. JSON cannot compute itself, so this
 * stands in for the same guarantee.
 */
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `tsconfig.base.json` allows comments, which JSON.parse does not. */
function parseJsonc(text) {
  return JSON.parse(
    text
      .replaceAll(/^\s*\/\/.*$/gmu, "")
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      .replaceAll(/,(\s*[\]}])/gu, "$1"),
  );
}

const tsconfigPath = path.join(rootDir, "tsconfig.base.json");
const tsconfig = parseJsonc(await readFile(tsconfigPath, "utf8"));
const paths = tsconfig.compilerOptions?.paths ?? {};

const entries = await readdir(path.join(rootDir, "packages"), { withFileTypes: true });
const problems = [];

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }
  const relativeDir = `./packages/${entry.name}`;
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, "packages", entry.name, "package.json"), "utf8"),
  );
  const name = manifest.name;

  const expected = {
    [name]: [`${relativeDir}/src/index.ts`],
    [`${name}/*`]: [`${relativeDir}/src/*`],
  };
  for (const [specifier, [target]] of Object.entries(expected)) {
    const actual = paths[specifier];
    if (actual === undefined) {
      problems.push(`tsconfig.base.json is missing a paths entry for "${specifier}".`);
    } else if (actual.length !== 1 || actual[0] !== target) {
      problems.push(
        `tsconfig.base.json maps "${specifier}" to ${JSON.stringify(actual)}, expected ["${target}"].`,
      );
    }
  }
}

const packageNames = new Set(
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        JSON.parse(
          await readFile(path.join(rootDir, "packages", entry.name, "package.json"), "utf8"),
        ).name,
      ),
  ),
);
for (const specifier of Object.keys(paths)) {
  const bare = specifier.endsWith("/*") ? specifier.slice(0, -2) : specifier;
  if (!packageNames.has(bare)) {
    problems.push(
      `tsconfig.base.json maps "${specifier}", which no longer matches a workspace package.`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems.toSorted()) {
    console.error(problem);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Workspace wiring OK: ${packageNames.size} packages mapped in tsconfig.base.json.\n`,
  );
}
