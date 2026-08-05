import { promises as fs } from "node:fs";
import * as path from "node:path";

import { addressToJsonPointer, makeStateKey } from "@ai-translate/core/address";
import { digestValue } from "@ai-translate/core/hash";
import type {
  CatalogAdapter,
  SyncStateSnapshot,
  SyncStateStore,
} from "@ai-translate/core/types";

import { addressToLegacyKey, readJsonFile, writeJsonFileAtomic } from "./shared";

interface JsonStateStoreOptions {
  lockFileName?: string;
  retryDelayMs?: number;
  rootDir: string;
  stateDir?: string;
  stateFileName?: string;
  timeoutMs?: number;
}

interface StartupLockFile {
  hashes?: Record<string, Record<string, string>>;
  overrides?: Record<string, Record<string, boolean>>;
}

interface StartupImportOptions {
  catalogs: readonly CatalogAdapter[];
  legacyFilePath: string;
  sourceLocale: string;
  targetLocales: readonly string[];
}

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
const CURRENT_STATE_VERSION = 2;

function createEmptyState(): SyncStateSnapshot {
  return {
    entries: {},
    version: CURRENT_STATE_VERSION,
  };
}

function isSyncStateSnapshot(value: unknown): value is SyncStateSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.version === 1 || candidate.version === CURRENT_STATE_VERSION) &&
    typeof candidate.entries === "object" &&
    candidate.entries !== null &&
    !Array.isArray(candidate.entries)
  );
}

function normalizeStateSnapshot(snapshot: SyncStateSnapshot): SyncStateSnapshot {
  return {
    entries: snapshot.entries,
    version: CURRENT_STATE_VERSION,
  };
}

async function ensureDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function createJsonStateStore(
  options: JsonStateStoreOptions,
): SyncStateStore {
  const stateDir = path.join(options.rootDir, options.stateDir ?? ".ai-translate");
  const statePath = path.join(
    stateDir,
    options.stateFileName ?? "translation-state.json",
  );
  const lockPath = path.join(
    stateDir,
    options.lockFileName ?? "translation-sync.lock",
  );

  return {
    async load() {
      const state = await readJsonFile(statePath);
      if (state === null) {
        return createEmptyState();
      }

      if (!isSyncStateSnapshot(state)) {
        throw new Error(`Invalid ai-translate state file at ${statePath}.`);
      }

      return normalizeStateSnapshot(state);
    },
    async save(state) {
      await ensureDirectory(statePath);
      await writeJsonFileAtomic(statePath, normalizeStateSnapshot(state));
    },
    async withLock(operation) {
      await ensureDirectory(lockPath);
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      const startedAt = Date.now();
      let handle: fs.FileHandle | undefined;

      while (!handle) {
        try {
          handle = await fs.open(lockPath, "wx");
          await handle.writeFile(
            JSON.stringify({
              acquiredAt: new Date().toISOString(),
              pid: process.pid,
            }),
            "utf8",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }

          if (Date.now() - startedAt > timeoutMs) {
            throw new Error(
              `Timed out waiting for ai-translate lock at ${lockPath}.`,
              { cause: error },
            );
          }

          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }

      try {
        return await operation();
      } finally {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      }
    },
  };
}

export async function importStartupV1State(
  options: StartupImportOptions,
): Promise<SyncStateSnapshot> {
  const legacy = (await readJsonFile(options.legacyFilePath)) as StartupLockFile | null;
  const hashes = legacy?.hashes ?? {};
  const overrides = legacy?.overrides ?? {};
  const nextState = createEmptyState();

  for (const catalog of options.catalogs) {
    const sourceRefs = await catalog.listDocumentRefs(options.sourceLocale);
    for (const sourceRef of sourceRefs) {
      const sourceDocument = await catalog.loadDocument(sourceRef);
      if (!sourceDocument) {
        continue;
      }

      for (const locale of options.targetLocales) {
        const targetRef = catalog.createDocumentRef(sourceRef, locale);
        const targetDocument = await catalog.loadDocument(targetRef);
        const targetEntries = new Map(
          (targetDocument?.entries ?? []).map((entry) => [
            addressToJsonPointer(entry.address),
            entry,
          ]),
        );

        for (const sourceEntry of sourceDocument.entries) {
          if (typeof sourceEntry.value !== "string") {
            continue;
          }

          const pointer = addressToJsonPointer(sourceEntry.address);
          const targetEntry = targetEntries.get(pointer);
          const targetValue =
            typeof targetEntry?.value === "string" ? targetEntry.value : sourceEntry.value;
          const legacyKey = addressToLegacyKey(sourceEntry.address);
          const legacyNamespaceHashes = hashes[sourceRef.unitId] ?? {};
          const legacyNamespaceOverrides = overrides[sourceRef.unitId] ?? {};
          const stateKey = makeStateKey(
            locale,
            catalog.id,
            sourceRef.unitId,
            pointer,
          );

          nextState.entries[stateKey] = {
            catalogId: catalog.id,
            jsonPointer: pointer,
            locale,
            origin:
              legacyNamespaceOverrides[legacyKey] === true ||
              targetValue !== sourceEntry.value
                ? "legacy-unknown"
                : legacyNamespaceHashes[legacyKey]
                  ? "generated"
                  : "generated",
            sourceDigest: digestValue(sourceEntry.value),
            status: "synced",
            targetDigest: digestValue(targetValue),
            translationContextDigest: digestValue(""),
            unitId: sourceRef.unitId,
            updatedAt: new Date().toISOString(),
          };
        }
      }
    }
  }

  return nextState;
}
