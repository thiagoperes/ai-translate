import { promises as fs } from "node:fs";

import type { MessageFormat } from "@ai-translate/core/message-format";
import type { PluralKeyStrategy } from "@ai-translate/core/plural";
import type {
  CatalogAdapter,
  ScaffoldLocaleOptions,
  ScaffoldLocaleResult,
} from "@ai-translate/core/types";

import {
  buildEntriesFromJson,
  createJsonSourceLocalizer,
  createDocumentRef,
  readJsonFile,
  jsonStructureDigest,
  reconcileJsonRootWithHistory,
  updateJsonRootFromEntries,
  writeJsonFileAtomic,
} from "./shared";
import type { JsonEntryOptions, JsonRootState } from "./shared";

interface LocalizedJsonDocumentOptions {
  id?: string;
  /** Interprets each string leaf; also registered with the engine so
   * validation resolves it without the user listing it separately. */
  messageFormat?: MessageFormat;
  /** Enables suffix-key plural handling. ICU-based setups need nothing here
   * because their plurals live inside the message. */
  plurals?: PluralKeyStrategy;
  rootDir: string;
  sourceLocale: string;
  unitId: string;
}

function toFilePath(rootDir: string, locale: string): string {
  return `${rootDir}/${locale}.json`;
}

export function createLocalizedJsonDocument(
  options: LocalizedJsonDocumentOptions,
): CatalogAdapter {
  const catalogId = options.id ?? "localized-json";
  const entryOptions: JsonEntryOptions = {
    ...(options.messageFormat === undefined ? {} : { messageFormat: options.messageFormat }),
    ...(options.plurals === undefined ? {} : { plurals: options.plurals }),
  };
  const localizeSourceDocument = createJsonSourceLocalizer(options.plurals, entryOptions);

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
        path: toFilePath(options.rootDir, locale),
        unitId: sourceRef.unitId,
      });
    },
    id: catalogId,
    ...(options.messageFormat === undefined ? {} : { messageFormats: [options.messageFormat] }),
    ...(localizeSourceDocument === undefined ? {} : { localizeSourceDocument }),
    listDocumentRefs(sourceLocale) {
      return Promise.resolve([
        createDocumentRef({
          catalogId,
          locale: sourceLocale,
          path: toFilePath(options.rootDir, sourceLocale),
          unitId: options.unitId,
        }),
      ]);
    },
    async loadDocument(ref) {
      const root = await readJsonFile(ref.path);
      if (root === null) {
        return null;
      }

      return {
        entries: buildEntriesFromJson(root, entryOptions),
        ref,
        state: {
          root,
        } satisfies JsonRootState,
        structureDigest: jsonStructureDigest(root, options.plurals),
      };
    },
    reconcileDocument({ history = [], ref, source, target }) {
      // Already reshaped for this locale by localizeSourceDocument.
      const sourceRoot = (source.state as JsonRootState).root;
      const targetRoot = target ? (target.state as JsonRootState).root : undefined;
      const { reconciliation, root: nextRoot } = reconcileJsonRootWithHistory(
        sourceRoot,
        targetRoot,
        history,
      );

      return Promise.resolve({
        entries: buildEntriesFromJson(nextRoot, entryOptions),
        ...(reconciliation === undefined ? {} : { reconciliation }),
        ref,
        state: {
          root: nextRoot,
        } satisfies JsonRootState,
        structureDigest: jsonStructureDigest(nextRoot, options.plurals),
      });
    },
    async scaffoldLocale(scaffoldOptions: ScaffoldLocaleOptions): Promise<ScaffoldLocaleResult> {
      const strategy = scaffoldOptions.strategy ?? "copy-source";
      if (strategy === "empty") {
        return {
          catalogId,
          createdDocuments: 0,
          locale: scaffoldOptions.locale,
          skippedDocuments: 1,
          strategy,
        };
      }

      const fromLocale =
        strategy === "copy-source"
          ? options.sourceLocale
          : scaffoldOptions.fromLocale ?? options.sourceLocale;
      const targetPath = toFilePath(options.rootDir, scaffoldOptions.locale);
      if (await pathExists(targetPath)) {
        return {
          catalogId,
          createdDocuments: 0,
          locale: scaffoldOptions.locale,
          skippedDocuments: 1,
          strategy,
        };
      }

      const sourceRoot = await readJsonFile(toFilePath(options.rootDir, fromLocale));
      if (sourceRoot === null) {
        return {
          catalogId,
          createdDocuments: 0,
          locale: scaffoldOptions.locale,
          skippedDocuments: 1,
          strategy,
        };
      }

      await writeJsonFileAtomic(targetPath, sourceRoot);
      return {
        catalogId,
        createdDocuments: 1,
        locale: scaffoldOptions.locale,
        skippedDocuments: 0,
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
