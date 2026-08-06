/**
 * Prints the pnpm filter flags selecting every workspace package that claims
 * support for a given Node version.
 *
 * The compatibility leg of CI exists to back the `engines.node` field each
 * package publishes. Hardcoding the package list there meant the leg drifted
 * silently: adding a package that needs a newer Node either broke the leg or,
 * worse, quietly widened what the leg appeared to prove. Deriving the list from
 * the same field the leg is testing removes that gap.
 *
 *   node scripts/packages-supporting-node.mjs 20.19.0
 *   --filter '@ai-translate/core' --filter '@ai-translate/cli' ...
 */
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(rootDir, "packages");

/**
 * Only the `>=x.y.z` form is understood. Anything else throws rather than
 * being guessed at, because a misread range would hand back a filter that
 * looks right and tests the wrong set of packages.
 */
function parseMinimum(range, packageName) {
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (match === null) {
    throw new Error(
      `${packageName} declares engines.node as "${range}". This script only understands ">=x.y.z". ` +
        `Extend it before using another range form.`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) {
    throw new Error(`Expected a Node version as "x.y.z", received "${version}".`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function satisfies(version, minimum) {
  for (const [index, part] of version.entries()) {
    const floor = minimum[index] ?? 0;
    if (part !== floor) {
      return part > floor;
    }
  }
  return true;
}

const requested = process.argv[2];
if (requested === undefined) {
  throw new Error("Usage: node scripts/packages-supporting-node.mjs <node-version>");
}
const version = parseVersion(requested);

const entries = await readdir(packagesDir, { withFileTypes: true });
const supported = [];
for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) {
    continue;
  }
  const manifestPath = path.join(packagesDir, entry.name, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  const range = manifest.engines?.node;
  if (typeof range !== "string") {
    throw new Error(`${manifest.name ?? entry.name} does not declare engines.node.`);
  }
  if (satisfies(version, parseMinimum(range, manifest.name ?? entry.name))) {
    supported.push(manifest.name);
  }
}

if (supported.length === 0) {
  throw new Error(`No workspace package claims support for Node ${requested}.`);
}

process.stdout.write(supported.map((name) => `--filter '${name}'`).join(" "));
