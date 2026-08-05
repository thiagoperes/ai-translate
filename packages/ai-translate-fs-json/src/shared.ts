import { promises as fs } from "node:fs";
import * as path from "node:path";

import { addressToJsonPointer } from "@ai-translate/core/address";
import { digestValue } from "@ai-translate/core/hash";
import {
  cloneJsonValue,
  getJsonValueAtAddress,
  setJsonValueAtAddress,
  visitJsonLeaves,
} from "@ai-translate/core/json";
import { rebaseIndexedEntries } from "@ai-translate/core/reconcile";
import { tokenizeText } from "@ai-translate/core/tokens";
import type {
  AddressSegment,
  DocumentFormat,
  DocumentRef,
  Entry,
  JsonValue,
  Policy,
  ReconcileHistoryEntry,
} from "@ai-translate/core/types";

export interface JsonRootState {
  root: JsonValue;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath: string): Promise<JsonValue | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.tmp-${String(process.pid)}-${String(Date.now())}`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close();
    await fs.rm(tempPath, { force: true });
  }
}

function inferPolicy(value: boolean | number | string | null): Policy {
  return typeof value === "string" ? "translate" : "copy";
}

function inferStorage(value: boolean | number | string | null): Entry["storage"] {
  return typeof value === "string" ? "string" : "scalar";
}

export function buildEntriesFromJson(root: JsonValue): Entry[] {
  const entries: Entry[] = [];
  visitJsonLeaves(root, ({ address, value }) => {
    const baseEntry = {
      address: [...address],
      policy: inferPolicy(value),
      storage: inferStorage(value),
      value,
    } satisfies Omit<Entry, "tokens">;

    entries.push(
      typeof value === "string"
        ? {
            ...baseEntry,
            tokens: tokenizeText(value),
          }
        : baseEntry,
    );
  });

  return entries;
}

export function reconcileJsonRoot(
  sourceRoot: JsonValue,
  targetRoot: JsonValue | undefined,
): JsonValue {
  const nextRoot = cloneJsonValue(sourceRoot);
  if (targetRoot === undefined) {
    return nextRoot;
  }

  visitJsonLeaves(sourceRoot, ({ address }) => {
    if (address.some((segment) => segment.kind === "index")) {
      return;
    }
    const targetValue = getJsonValueAtAddress(targetRoot, address);
    if (targetValue !== undefined) {
      setJsonValueAtAddress(nextRoot, address, targetValue);
    }
  });
  return nextRoot;
}

export function reconcileJsonRootWithHistory(
  sourceRoot: JsonValue,
  targetRoot: JsonValue | undefined,
  history: readonly ReconcileHistoryEntry[],
): {
  reconciliation?: ReturnType<typeof rebaseIndexedEntries>["reconciliation"];
  root: JsonValue;
} {
  const nextRoot = cloneJsonValue(sourceRoot);
  if (targetRoot === undefined) {
    return { root: nextRoot };
  }

  const sourceEntries = buildEntriesFromJson(sourceRoot);
  const targetEntries = buildEntriesFromJson(targetRoot);
  const indexed = rebaseIndexedEntries({ history, sourceEntries, targetEntries });
  visitJsonLeaves(sourceRoot, ({ address }) => {
    const pointer = addressToJsonPointer(address);
    const targetValue = address.some((segment) => segment.kind === "index")
      ? indexed.valuesByPointer.get(pointer)
      : getJsonValueAtAddress(targetRoot, address);
    if (targetValue !== undefined) {
      setJsonValueAtAddress(nextRoot, address, targetValue);
    }
  });
  return {
    ...(indexed.reconciliation === undefined
      ? {}
      : { reconciliation: indexed.reconciliation }),
    root: nextRoot,
  };
}

function jsonStructure(value: JsonValue): unknown {
  if (Array.isArray(value)) {
    return value.map(jsonStructure);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, nextValue]) => [key, jsonStructure(nextValue)]),
    );
  }
  return typeof value;
}

export function jsonStructureDigest(root: JsonValue): string {
  return digestValue(JSON.stringify(jsonStructure(root)));
}

export function updateJsonRootFromEntries(
  root: JsonValue,
  entries: readonly Entry[],
): JsonValue {
  const nextRoot = cloneJsonValue(root);
  for (const entry of entries) {
    setJsonValueAtAddress(nextRoot, entry.address, entry.value);
  }

  return nextRoot;
}

export function createDocumentRef(args: {
  catalogId: string;
  format?: DocumentFormat;
  locale: string;
  path: string;
  unitId: string;
}): DocumentRef {
  return {
    catalogId: args.catalogId,
    format: args.format ?? "json",
    locale: args.locale,
    path: args.path,
    unitId: args.unitId,
  };
}

export function addressToLegacyKey(address: readonly AddressSegment[]): string {
  let result = "";
  for (const segment of address) {
    if (segment.kind === "node") {
      continue;
    }

    if (segment.kind === "index") {
      result += `[${String(segment.index)}]`;
      continue;
    }

    result = result.length === 0 ? segment.key : `${result}.${segment.key}`;
  }

  return result;
}
