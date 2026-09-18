import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packages = new URL("../packages/", import.meta.url);
for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const report = new URL(`${entry.name}/coverage/lcov.info`, packages);
  const contents = await readFile(report, "utf8");
  // A misconfigured coverage glob can pass every threshold with zero files.
  if (!/^SF:/mu.test(contents) || !/^LF:[1-9]\d*$/mu.test(contents)) {
    throw new Error(`Coverage report contains no instrumented source lines: ${fileURLToPath(report)}`);
  }
}
process.stdout.write("Coverage reports contain instrumented source lines for every package.\n");
