import { globby } from "globby";
import { promises as fs } from "node:fs";

import type {
  CatalogAdapter,
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
import type { JsonRootState } from "./shared";

interface NamespaceJsonCatalogOptions {
  id?: string;
  rootDir: string;
  sourceLocale: string;
}

export function createNamespaceJsonCatalog(options: NamespaceJsonCatalogOptions): CatalogAdapter {
  const catalogId = options.id ?? "namespace-json";

  const toFilePath = (locale: string, unitId: string): string =>
    `${options.rootDir}/${locale}/${unitId}.json`;

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

  async function scaffoldFromLocale(
    locale: string,
    fromLocale: string,
  ): Promise<ScaffoldLocaleResult> {
    const refs = await adapter.listDocumentRefs(fromLocale);
    let createdDocuments = 0;
    let skippedDocuments = 0;

    await Promise.all(
      refs.map(async (ref) => {
        const sourceDocument = await adapter.loadDocument(ref);
        if (!sourceDocument) {
          skippedDocuments += 1;
          return;
        }

        const nextRef = adapter.createDocumentRef(ref, locale);
        if (await pathExists(nextRef.path)) {
          skippedDocuments += 1;
          return;
        }

        await writeJsonFileAtomic(nextRef.path, (sourceDocument.state as JsonRootState).root);
        createdDocuments += 1;
      }),
    );

    return {
      catalogId,
      createdDocuments,
      locale,
      skippedDocuments,
      strategy: fromLocale === options.sourceLocale ? "copy-source" : "copy-locale",
    };
  }

  const adapter: CatalogAdapter = {
    createDocumentRef(sourceRef, locale) {
      return createDocumentRef({
        catalogId,
        locale,
        path: toFilePath(locale, sourceRef.unitId),
        unitId: sourceRef.unitId,
      });
    },
    id: catalogId,
    async listDocumentRefs(sourceLocale) {
      const files = await globby("*.json", {
        absolute: true,
        cwd: `${options.rootDir}/${sourceLocale}`,
      });

      return files.toSorted().map((filePath) => {
        const fileName = filePath.split("/").at(-1) ?? "";
        const unitId = fileName.replace(/\.json$/u, "");
        return createDocumentRef({
          catalogId,
          locale: sourceLocale,
          path: filePath,
          unitId,
        });
      });
    },
    async loadDocument(ref) {
      const root = await readJsonFile(ref.path);
      if (root === null) {
        return null;
      }

      return {
        entries: buildEntriesFromJson(root),
        ref,
        state: {
          root,
        } satisfies JsonRootState,
        structureDigest: jsonStructureDigest(root),
      };
    },
    reconcileDocument({ history = [], ref, source, target }) {
      const sourceRoot = (source.state as JsonRootState).root;
      const targetRoot = target ? (target.state as JsonRootState).root : undefined;
      const { reconciliation, root: nextRoot } = reconcileJsonRootWithHistory(
        sourceRoot,
        targetRoot,
        history,
      );

      return Promise.resolve({
        entries: buildEntriesFromJson(nextRoot),
        ...(reconciliation === undefined ? {} : { reconciliation }),
        ref,
        state: {
          root: nextRoot,
        } satisfies JsonRootState,
        structureDigest: jsonStructureDigest(nextRoot),
      });
    },
    async scaffoldLocale(scaffoldOptions: ScaffoldLocaleOptions): Promise<ScaffoldLocaleResult> {
      const strategy = scaffoldOptions.strategy ?? "copy-source";
      if (strategy === "empty") {
        const refs = await adapter.listDocumentRefs(options.sourceLocale);
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
      const result = await scaffoldFromLocale(scaffoldOptions.locale, fromLocale);

      return {
        ...result,
        strategy,
      };
    },
    async writeDocument(document) {
      const nextRoot = updateJsonRootFromEntries(
        (document.state as JsonRootState).root,
        document.entries,
      );
      await writeJsonFileAtomic(document.ref.path, nextRoot);
    },
  };

  return adapter;
}
