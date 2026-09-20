import * as path from "node:path";
import { globby } from "globby";

import { addressToJsonPointer } from "@ai-translate/core/address";
import type { CatalogAdapter, DocumentRef, JsonObject, LoadedDocument } from "@ai-translate/core/types";
import { applePrintfMessageFormat } from "@ai-translate/message-formats";

import { readText, withFileLock, writeTextAtomic } from "./files";
import {
  alignNode, buildCatalogEntries, entryValues, expandNode, isObject, isTranslatable, localeRoots,
  own, parseCatalog, put, setUnit, structureDigest,
} from "./xcstrings-model";
import type { CatalogState, StringCatalog } from "./xcstrings-model";

export interface AppleStringCatalogOptions {
  id?: string;
  /** Glob patterns relative to rootDir. Defaults to all authored .xcstrings. */
  include?: readonly string[];
  /** Exact catalog keys whose percent signs are literal text, not runtime printf arguments. */
  plainTextKeys?: readonly string[];
  rootDir: string;
  /** Must match each catalog's sourceLanguage exactly. */
  sourceLocale: string;
}

const IGNORE = [
  "**/node_modules/**", "**/.git/**", "**/.build/**", "**/build/**", "**/DerivedData/**",
  "**/Pods/**", "**/Carthage/**", "**/release/**", "**/dist/**", "**/.expo/**",
  "**/.next/**", "**/.turbo/**", "**/coverage/**", "**/*.xcarchive/**",
];

function loadedDocument(ref: DocumentRef, state: CatalogState, source: boolean, plainTextKeys: ReadonlySet<string>): LoadedDocument<CatalogState> {
  const entries = buildCatalogEntries(state.catalog, state.roots, source, plainTextKeys);
  return { entries, ref, state, structureDigest: structureDigest(entries) };
}

function localizedRoots(sourceRoots: JsonObject, locale: string, targetRoots: JsonObject = {}): JsonObject {
  return Object.fromEntries(Object.entries(sourceRoots)
    .map(([key, node]) => [key, expandNode(node as JsonObject, locale, own(targetRoots, key) as JsonObject | undefined,
      `key ${JSON.stringify(key)}`)]));
}

function unitAt(roots: JsonObject, keys: readonly string[]): unknown {
  let node: unknown = roots;
  for (const key of keys.slice(0, -1)) {
    node = isObject(node) ? own(node, key) : undefined;
  }
  return node;
}

/** Native Xcode catalogs: one physical file, independently reconciled locales. */
export function createAppleStringCatalog(options: AppleStringCatalogOptions): CatalogAdapter {
  const rootDir = path.resolve(options.rootDir);
  const id = options.id ?? "apple-xcstrings";
  const plainTextKeys = new Set(options.plainTextKeys);

  function refFor(filePath: string, locale: string, unitId?: string): DocumentRef {
    return {
      catalogId: id,
      format: "xcstrings",
      locale,
      path: filePath,
      unitId: unitId ?? path.relative(rootDir, filePath).split(path.sep).join("/").replace(/\.xcstrings$/u, ""),
    };
  }

  async function readCatalog(filePath: string): Promise<StringCatalog | null> {
    const text = await readText(filePath);
    return text === null ? null : parseCatalog(text, filePath, options.sourceLocale);
  }

  const adapter: CatalogAdapter = {
    id,
    messageFormats: [applePrintfMessageFormat],
    createDocumentRef(sourceRef, locale) {
      return refFor(sourceRef.path, locale, sourceRef.unitId);
    },
    async listDocumentRefs(locale) {
      const files = await globby([...(options.include ?? ["**/*.xcstrings"])], {
        absolute: true, cwd: rootDir, followSymbolicLinks: false, ignore: IGNORE, onlyFiles: true,
      });
      return files.toSorted().map((filePath) => refFor(filePath, locale));
    },
    async loadDocument(ref) {
      const catalog = await readCatalog(ref.path);
      if (catalog === null) {
        return null;
      }
      const canonicalRoots = localeRoots(catalog, options.sourceLocale);
      const sourceRoots = ref.locale === options.sourceLocale
        ? canonicalRoots : localizedRoots(canonicalRoots, ref.locale, localeRoots(catalog, ref.locale));
      const roots = ref.locale === options.sourceLocale ? sourceRoots : localeRoots(catalog, ref.locale);
      if (ref.locale !== options.sourceLocale && Object.keys(roots).length === 0 &&
        Object.keys(canonicalRoots).length > 0) {
        return null;
      }
      const entries = buildCatalogEntries(catalog, roots, ref.locale === options.sourceLocale, plainTextKeys);
      return loadedDocument(ref, { catalog, originalValues: entryValues(entries), roots, sourceRoots }, ref.locale === options.sourceLocale, plainTextKeys);
    },
    localizeSourceDocument({ locale, source }) {
      const sourceState = source.state as CatalogState;
      const roots = localizedRoots(sourceState.sourceRoots, locale, localeRoots(sourceState.catalog, locale));
      return Promise.resolve(loadedDocument(source.ref, { ...sourceState, roots, sourceRoots: roots }, true, plainTextKeys));
    },
    reconcileDocument({ ref, source, target }) {
      const sourceState = source.state as CatalogState;
      const targetState = target?.state as CatalogState | undefined;
      const targetEntries = new Map(target?.entries.map((entry) => [addressToJsonPointer(entry.address), entry]));
      const values = entryValues(source.entries.flatMap((entry) => {
        const existing = targetEntries.get(addressToJsonPointer(entry.address));
        return existing?.meta?.structureSignature === entry.meta?.structureSignature && existing !== undefined ? [existing] : [];
      }));
      const entries = source.entries.map((entry) => ({
        ...entry,
        value: values.get(addressToJsonPointer(entry.address)) ?? null,
      }));
      return Promise.resolve({
        entries,
        ref,
        state: {
          catalog: sourceState.catalog,
          originalValues: values,
          roots: targetState?.roots ?? {},
          sourceRoots: sourceState.sourceRoots,
        } satisfies CatalogState,
        structureDigest: structureDigest(entries),
      });
    },
    createScaffoldDocument({ ref, source }) {
      if (source.entries.length === 0) {
        return Promise.resolve(null);
      }
      const sourceState = source.state as CatalogState;
      const roots = localizedRoots(sourceState.roots, ref.locale);
      return Promise.resolve(loadedDocument(ref, {
        catalog: sourceState.catalog, originalValues: new Map(), roots, sourceRoots: roots, writeState: "new",
      }, true, plainTextKeys));
    },
    async scaffoldLocale(scaffoldOptions) {
      const strategy = scaffoldOptions.strategy ?? "copy-source";
      const refs = await adapter.listDocumentRefs(options.sourceLocale);
      let createdDocuments = 0;
      let skippedDocuments = 0;
      const fromLocale = strategy === "copy-source" ? options.sourceLocale : scaffoldOptions.fromLocale ?? options.sourceLocale;
      for (const sourceRef of refs) {
        const targetRef = adapter.createDocumentRef(sourceRef, scaffoldOptions.locale);
        if (strategy === "empty" || await adapter.loadDocument(targetRef) !== null) {
          skippedDocuments += 1;
          continue;
        }
        const source = await adapter.loadDocument(adapter.createDocumentRef(sourceRef, fromLocale));
        if (source === null || source.entries.length === 0) {
          skippedDocuments += 1;
          continue;
        }
        const document = await adapter.createScaffoldDocument?.({ ref: targetRef, source, strategy });
        if (document !== undefined && document !== null) {
          await adapter.writeDocument(document);
          createdDocuments += 1;
        }
      }
      return { catalogId: id, createdDocuments, locale: scaffoldOptions.locale, skippedDocuments, strategy };
    },
    async writeDocument(document) {
      if (document.ref.locale === options.sourceLocale) {
        throw new Error(`Refusing to write the source locale "${options.sourceLocale}" in a String Catalog.`);
      }
      const state = document.state as CatalogState;
      const changed = document.entries.filter((entry) => typeof entry.value === "string" &&
        (state.writeState !== undefined || entry.value !== state.originalValues.get(addressToJsonPointer(entry.address))));
      if (changed.length === 0) {
        return;
      }
      await withFileLock(document.ref.path, async () => {
        const text = await readText(document.ref.path);
        if (text === null) {
          throw new Error(`String Catalog disappeared before writing: ${document.ref.path}.`);
        }
        const catalog = parseCatalog(text, document.ref.path, options.sourceLocale);
        const targetRoots = localeRoots(catalog, document.ref.locale);
        const originalTargets = structuredClone(targetRoots);
        const existingKeys = new Set(Object.keys(targetRoots));
        const originalSources = localeRoots(state.catalog, options.sourceLocale);
        const currentSources = localeRoots(catalog, options.sourceLocale);
        const aligned = new Set<string>();
        let wrote = false;
        for (const entry of changed) {
          const keys = entry.address.map((segment) => {
            if (segment.kind !== "key") {
              throw new Error("String Catalog addresses must contain only object keys.");
            }
            return segment.key;
          });
          const key = keys[0];
          const string = key === undefined ? undefined : own(catalog.strings, key);
          if (key === undefined || !isObject(string) || !isTranslatable(key, string)) {
            throw new Error(`String Catalog source key changed before writing ${JSON.stringify(key)}.`);
          }
          if (state.writeState !== undefined && existingKeys.has(key)) {
            continue;
          }
          if (JSON.stringify(own(originalSources, key)) !== JSON.stringify(own(currentSources, key))) {
            throw new Error(`String Catalog source changed before writing ${JSON.stringify(key)}.`);
          }
          if (!aligned.has(key)) {
            const node = own(targetRoots, key);
            const template = own(state.sourceRoots, key);
            if (isObject(node) && isObject(template)) {
              const original = own(state.roots, key);
              alignNode(node, template, isObject(original) ? original : {});
            }
            aligned.add(key);
          }
          const currentUnit = unitAt(originalTargets, keys);
          if (state.writeState === undefined && JSON.stringify(currentUnit) !== JSON.stringify(unitAt(state.roots, keys)) &&
            (!isObject(currentUnit) || currentUnit.value !== entry.value)) {
            throw new Error(`String Catalog translation changed before writing ${JSON.stringify(keys)}.`);
          }
          setUnit(targetRoots, state.sourceRoots, keys, entry.value as string, state.writeState ?? "translated");
          wrote = true;
        }
        if (!wrote) {
          return;
        }
        for (const [key, target] of Object.entries(targetRoots)) {
          const string = own(catalog.strings, key) as JsonObject;
          if (!isObject(string.localizations)) {
            string.localizations = {};
          }
          put(string.localizations, document.ref.locale, target);
        }
        const next = `${text.startsWith("\uFEFF") ? "\uFEFF" : ""}${JSON.stringify(catalog, null, 2)}\n`;
        if (next !== text) {
          await writeTextAtomic(document.ref.path, next);
        }
      });
    },
  };
  return adapter;
}
