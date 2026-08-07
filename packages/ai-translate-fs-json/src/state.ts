import { promises as fs } from "node:fs";
import * as path from "node:path";

import { addressToJsonPointer, makeStateKey } from "@ai-translate/core/address";
import { digestValue } from "@ai-translate/core/hash";
import type {
  CatalogAdapter,
  SyncStateSnapshot,
  SyncStateStore,
} from "@ai-translate/core/types";

import { readJsonFile, writeJsonFileAtomic } from "./shared";

interface JsonStateStoreOptions {
  lockFileName?: string;
  retryDelayMs?: number;
  rootDir: string;
  stateDir?: string;
  stateFileName?: string;
  timeoutMs?: number;
}

/**
 * How to treat a target value that is byte-identical to its source.
 *
 * Identical text is genuinely ambiguous: it is either a correct translation
 * that happens to match (brand names, `Status` in German, sample data) or a
 * placeholder left behind by a pipeline that backfilled missing keys with the
 * source string. Adopting is the cheaper default and never rewrites a term
 * that was deliberately left alone; skipping hands those entries to the next
 * sync so a model decides.
 */
export type IdenticalToSourcePolicy = "adopt" | "skip";

export interface AdoptExistingTranslationsOptions {
  catalogs: readonly CatalogAdapter[];
  identicalToSource?: IdenticalToSourcePolicy;
  sourceLocale: string;
  targetLocales: readonly string[];
}

export interface AdoptExistingTranslationsResult {
  /** Entries recorded in the returned state. */
  adopted: number;
  /** Target values byte-identical to the source, whether or not adopted. */
  identicalToSource: number;
  /** Source strings with no usable target text, left for the next sync. */
  untranslated: number;
  state: SyncStateSnapshot;
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

          await new Promise((resolve) => { setTimeout(resolve, retryDelayMs); });
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

/**
 * Seeds a state snapshot from translations that already exist on disk.
 *
 * This is the migration path off any prior pipeline. It reads nothing but the
 * catalogs themselves, so it does not care which tool produced the existing
 * text or what bespoke lock format that tool kept alongside it.
 *
 * Every adopted entry is recorded as `legacy-unknown` because the provenance
 * genuinely is unknown — the text may be human, machine, or a mix, and the
 * catalogs carry no evidence either way. `legacyOriginPolicy` then decides
 * whether a later sync preserves, validates, or retranslates them.
 */
export async function adoptExistingTranslations(
  options: AdoptExistingTranslationsOptions,
): Promise<AdoptExistingTranslationsResult> {
  const identicalToSourcePolicy = options.identicalToSource ?? "adopt";
  const state = createEmptyState();
  const adoptedAt = new Date().toISOString();
  let adopted = 0;
  let identicalToSource = 0;
  let untranslated = 0;

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
          const targetValue = targetEntry?.value;

          // A missing or blank target is not a translation. Recording one as
          // synced would strand the key: the next sync would see a satisfied
          // entry and never fill it in.
          if (typeof targetValue !== "string" || targetValue.length === 0) {
            untranslated += 1;
            continue;
          }

          if (targetValue === sourceEntry.value) {
            identicalToSource += 1;
            if (identicalToSourcePolicy === "skip") {
              continue;
            }
          }

          state.entries[makeStateKey(locale, catalog.id, sourceRef.unitId, pointer)] = {
            catalogId: catalog.id,
            jsonPointer: pointer,
            locale,
            origin: "legacy-unknown",
            sourceDigest: digestValue(sourceEntry.value),
            status: "synced",
            targetDigest: digestValue(targetValue),
            translationContextDigest: digestValue(""),
            unitId: sourceRef.unitId,
            updatedAt: adoptedAt,
          };
          adopted += 1;
        }
      }
    }
  }

  return { adopted, identicalToSource, state, untranslated };
}
