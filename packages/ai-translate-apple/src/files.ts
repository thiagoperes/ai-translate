import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const pendingWrites = new Map<string, Promise<unknown>>();

/** Serializes read/merge/write operations, including separate adapter instances. */
export async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pendingWrites.set(key, current);
  try {
    return await current;
  } finally {
    if (pendingWrites.get(key) === current) {
      pendingWrites.delete(key);
    }
  }
}

export async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeTextAtomic(filePath: string, contents: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}`);
  let mode: number | undefined;
  try {
    mode = (await fs.stat(filePath)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(contents);
    // Creation masks the requested mode with umask. An existing localization
    // file must retain its permissions when the temporary file replaces it.
    if (mode !== undefined) {
      await handle.chmod(mode);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await fs.rm(temporaryPath, { force: true });
  }
}
