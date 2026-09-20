import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeTextAtomic } from "../src/files";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function targetPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-apple-files-"));
  workspaces.push(root);
  return path.join(root, "Localizable.strings");
}

describe.skipIf(process.platform === "win32")("atomic Apple resource write permissions", () => {
  it.each([0o664, 0o600])("preserves existing mode %i despite the process umask", async (mode) => {
    const target = await targetPath();
    await fs.writeFile(target, '"key" = "Before";\n');
    await fs.chmod(target, mode);
    const previousMask = process.umask(0o077);
    try {
      await writeTextAtomic(target, '"key" = "After";\n');
    } finally {
      process.umask(previousMask);
    }
    expect((await fs.stat(target)).mode & 0o777).toBe(mode);
    expect(await fs.readFile(target, "utf8")).toBe('"key" = "After";\n');
    expect(await fs.readdir(path.dirname(target))).toEqual(["Localizable.strings"]);
  });

  it("uses the process umask for new resource files", async () => {
    const target = await targetPath();
    const previousMask = process.umask(0o027);
    try {
      await writeTextAtomic(target, new Uint8Array([0xff, 0xfe, 0x61, 0x00]));
    } finally {
      process.umask(previousMask);
    }
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(target)).toEqual(Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    expect(await fs.readdir(path.dirname(target))).toEqual(["Localizable.strings"]);
  });
});
