import { promises as fs } from "node:fs";

import type {
  CatalogAdapter,
  JsonObject,
  JsonValue,
  ScaffoldLocaleOptions,
  ScaffoldLocaleResult,
} from "@ai-translate/core/types";

import {
  buildEntriesFromJson,
  createDocumentRef,
  readJsonFile,
  jsonStructureDigest,
  reconcileJsonRootWithHistory,
  updateJsonRootFromEntries,
  writeJsonFileAtomic,
} from "./shared";

interface BundleJsonCatalogOptions {
  id?: string;
  rootDir: string;
  sourceLocale: string;
  split: "top-level-key";
  unitPrefix?: string;
}

interface BundleState {
  bundleRoot: JsonObject;
  topLevelKey: string;
  unitRoot: JsonValue;
}

function toTopLevelKey(unitId: string, unitPrefix?: string): string {
  if (!unitPrefix) {
    return unitId;
  }

  return unitId.startsWith(`${unitPrefix}/`) ? unitId.slice(unitPrefix.length + 1) : unitId;
}

function createBundleFilePath(rootDir: string, locale: string): string {
  return `${rootDir}/${locale}.json`;
}

export function createBundleJsonCatalog(options: BundleJsonCatalogOptions): CatalogAdapter {
  const catalogId = options.id ?? "bundle-json";

  async function pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  const adapter: CatalogAdapter = {
    createDocumentRef(sourceRef, locale) {
      return createDocumentRef({
        catalogId,
        locale,
        path: createBundleFilePath(options.rootDir, locale),
        unitId: sourceRef.unitId,
      });
    },
    id: catalogId,
    async listDocumentRefs(sourceLocale) {
      const bundlePath = createBundleFilePath(options.rootDir, sourceLocale);
      const root = await readJsonFile(bundlePath);
      if (!root || typeof root !== "object" || Array.isArray(root)) {
        throw new Error(`Bundle catalog expects an object root at ${bundlePath}.`);
      }

      return Object.keys(root)
        .toSorted()
        .map((topLevelKey) =>
          createDocumentRef({
            catalogId,
            locale: sourceLocale,
            path: bundlePath,
            unitId: options.unitPrefix ? `${options.unitPrefix}/${topLevelKey}` : topLevelKey,
          }),
        );
    },
    async loadDocument(ref) {
      const bundleRoot = await readJsonFile(ref.path);
      if (bundleRoot === null) {
        return null;
      }

      if (typeof bundleRoot !== "object" || Array.isArray(bundleRoot)) {
        throw new Error(`Bundle catalog expects an object root at ${ref.path}.`);
      }

      const topLevelKey = toTopLevelKey(ref.unitId, options.unitPrefix);
      const unitRoot = bundleRoot[topLevelKey];
      if (unitRoot === undefined) {
        return {
          entries: [],
          ref,
          state: {
            bundleRoot,
            topLevelKey,
            unitRoot: {},
          } satisfies BundleState,
        };
      }

      return {
        entries: buildEntriesFromJson(unitRoot),
        ref,
        state: {
          bundleRoot,
          topLevelKey,
          unitRoot,
        } satisfies BundleState,
        structureDigest: jsonStructureDigest(unitRoot),
      };
    },
    // One bundle file backs every top-level key, so a staged write has to keep
    // the sibling units another document already wrote in this transaction
    // while still taking its own unit wholly from the reconciled document.
    mergeStagedState({ document, staged }) {
      const documentState = document.state as BundleState;
      const stagedState = staged.state as BundleState;
      return {
        bundleRoot: {
          ...stagedState.bundleRoot,
          [documentState.topLevelKey]: documentState.unitRoot,
        },
        topLevelKey: documentState.topLevelKey,
        unitRoot: documentState.unitRoot,
      } satisfies BundleState;
    },
    reconcileDocument({ history = [], ref, source, target }) {
      const sourceState = source.state as BundleState;
      const targetState = target?.state as BundleState | undefined;
      const { reconciliation, root: nextUnitRoot } = reconcileJsonRootWithHistory(
        sourceState.unitRoot,
        targetState?.unitRoot,
        history,
      );
      const nextBundleRoot = {
        ...targetState?.bundleRoot,
        [sourceState.topLevelKey]: nextUnitRoot,
      };

      return Promise.resolve({
        entries: buildEntriesFromJson(nextUnitRoot),
        ...(reconciliation === undefined ? {} : { reconciliation }),
        ref,
        state: {
          bundleRoot: nextBundleRoot,
          topLevelKey: sourceState.topLevelKey,
          unitRoot: nextUnitRoot,
        } satisfies BundleState,
        structureDigest: jsonStructureDigest(nextUnitRoot),
      });
    },
    async scaffoldLocale(scaffoldOptions: ScaffoldLocaleOptions): Promise<ScaffoldLocaleResult> {
      const strategy = scaffoldOptions.strategy ?? "copy-source";
      const refs = await adapter.listDocumentRefs(options.sourceLocale);
      if (strategy === "empty") {
        return {
          catalogId,
          createdDocuments: 0,
          locale: scaffoldOptions.locale,
          skippedDocuments: refs.length,
          strategy,
        };
      }

      const fromLocale =
        strategy === "copy-source"
          ? options.sourceLocale
          : (scaffoldOptions.fromLocale ?? options.sourceLocale);
      const sourcePath = createBundleFilePath(options.rootDir, fromLocale);
      const targetPath = createBundleFilePath(options.rootDir, scaffoldOptions.locale);
      if (await pathExists(targetPath)) {
        return {
          catalogId,
          createdDocuments: 0,
          locale: scaffoldOptions.locale,
          skippedDocuments: refs.length,
          strategy,
        };
      }

      const sourceRoot = await readJsonFile(sourcePath);
      if (sourceRoot === null) {
        return {
          catalogId,
          createdDocuments: 0,
          locale: scaffoldOptions.locale,
          skippedDocuments: refs.length,
          strategy,
        };
      }

      await writeJsonFileAtomic(targetPath, sourceRoot);
      return {
        catalogId,
        createdDocuments: refs.length,
        locale: scaffoldOptions.locale,
        skippedDocuments: 0,
        strategy,
      };
    },
    async writeDocument(document) {
      const state = document.state as BundleState;
      const nextUnitRoot = updateJsonRootFromEntries(state.unitRoot, document.entries);
      const nextBundleRoot = {
        ...state.bundleRoot,
        [state.topLevelKey]: nextUnitRoot,
      };
      await writeJsonFileAtomic(document.ref.path, nextBundleRoot);
    },
  };

  return adapter;
}
