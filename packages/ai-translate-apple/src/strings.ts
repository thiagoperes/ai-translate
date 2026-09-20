import { promises as fs } from "node:fs";
import path from "node:path";

import { digestValue } from "@ai-translate/core/hash";
import { plainMessageFormat } from "@ai-translate/core/message-format";
import type { CatalogAdapter, DocumentRef, Entry, LoadedDocument } from "@ai-translate/core/types";
import { applePrintfMessageFormat } from "@ai-translate/message-formats";
import { globby } from "globby";

import { withFileLock, writeTextAtomic } from "./files";
import { decodeStrings, encodeStrings, parseStrings, renderStrings } from "./strings-parser";
import type { StringsEncoding, StringsRecord, StringsTable } from "./strings-parser";

export interface AppleStringsCatalogOptions {
  id?: string;
  /** Glob(s) relative to the source locale directory; all nested tables by default. */
  include?: string | readonly string[];
  /** Exact keys whose percent signs are literal text, not runtime printf arguments. */
  plainTextKeys?: readonly string[];
  rootDir: string;
  sourceLocale: string;
  /** For projects whose source files are in Base.lproj. Defaults to <locale>.lproj. */
  sourceLocaleDirectory?: string;
}

interface StringsState {
  encoding: StringsEncoding;
  scaffold?: true;
  table: StringsTable;
  templates: StringsTable;
}

function segment(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)}.`);
  }
  return value;
}

function unit(value: string): string {
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "." || part === "") ||
    !value.endsWith(".strings")
  ) {
    throw new Error(`Invalid Apple strings unit: ${JSON.stringify(value)}.`);
  }
  return value;
}

async function readTable(
  filePath: string,
): Promise<(StringsTable & { encoding: StringsEncoding }) | null> {
  try {
    const decoded = decodeStrings(await fs.readFile(filePath));
    return { ...parseStrings(decoded.text, filePath), encoding: decoded.encoding };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function entry(record: StringsRecord, value: string | null, plainTextKeys: ReadonlySet<string>): Entry {
  const format = plainTextKeys.has(record.key) ? plainMessageFormat : applePrintfMessageFormat;
  return {
    address: [{ kind: "key", key: record.key }],
    ...(record.comment.length === 0 ? {} : { context: { notes: record.comment } }),
    messageFormatId: format.id,
    policy: "translate",
    storage: "string",
    tokens: value === null ? [] : [...format.tokenize(value)],
    value,
  };
}

function document(
  ref: DocumentRef,
  state: StringsState,
  entries: Entry[],
): LoadedDocument<StringsState> {
  return {
    entries,
    ref,
    state,
    structureDigest: digestValue(JSON.stringify(entries.map((item) => item.address))),
  };
}

/** Translate .lproj tables without replacing comments or unrelated translations. */
export function createAppleStringsCatalog(options: AppleStringsCatalogOptions): CatalogAdapter {
  const id = options.id ?? "apple-strings";
  const root = path.resolve(options.rootDir);
  const plainTextKeys = new Set(options.plainTextKeys);
  segment(options.sourceLocale, "source locale");
  const sourceDirectory = segment(
    options.sourceLocaleDirectory ?? `${options.sourceLocale}.lproj`,
    "source locale directory",
  );
  const includes =
    typeof options.include === "string"
      ? [options.include]
      : [...(options.include ?? ["**/*.strings"])];
  for (const include of includes) {
    // Globs may escape a literal filename's metacharacters. Backslashes used
    // as platform-specific path separators are still rejected.
    const literalEscapesRemoved = include.replace(/\\[!()[\]{}*?+@]/gu, "_");
    if (path.isAbsolute(include) || literalEscapesRemoved.includes("\\") || include.split("/").includes("..")) {
      throw new Error(`Invalid Apple strings include: ${JSON.stringify(include)}.`);
    }
  }

  function file(locale: string, unitId: string): string {
    const directory =
      locale === options.sourceLocale ? sourceDirectory : `${segment(locale, "locale")}.lproj`;
    return path.join(root, directory, unit(unitId));
  }

  // Ref paths can be temporary transaction files outside root. Generated paths
  // inside root must not cross a symlink into another project's resources.
  async function checkWithinRoot(filePath: string): Promise<void> {
    const relative = path.relative(root, path.resolve(filePath));
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return;
    }
    const realRoot = await fs.realpath(root);
    let existing = filePath;
    for (;;) {
      try {
        const actual = await fs.realpath(existing);
        const remainder = path.relative(realRoot, actual);
        if (
          remainder === ".." ||
          remainder.startsWith(`..${path.sep}`) ||
          path.isAbsolute(remainder)
        ) {
          throw new Error(`Apple strings path escapes rootDir: ${filePath}.`);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        const parent = path.dirname(existing);
        if (parent === existing) {
          throw error;
        }
        existing = parent;
      }
    }
  }

  const adapter: CatalogAdapter = {
    id,
    messageFormats: [applePrintfMessageFormat],
    createDocumentRef(sourceRef, locale) {
      return {
        catalogId: id,
        format: "apple-strings",
        locale,
        path: file(locale, sourceRef.unitId),
        unitId: sourceRef.unitId,
      };
    },
    createScaffoldDocument({ ref, source }) {
      return Promise.resolve({
        ...source,
        ref,
        state: { ...(source.state as StringsState), scaffold: true },
      });
    },
    async listDocumentRefs(locale) {
      const directory =
        locale === options.sourceLocale ? sourceDirectory : `${segment(locale, "locale")}.lproj`;
      const files = await globby(includes, {
        cwd: path.join(root, directory),
        followSymbolicLinks: false,
        onlyFiles: true,
      });
      const refs: DocumentRef[] = [];
      for (const unitId of files.toSorted()) {
        const filePath = file(locale, unitId);
        await checkWithinRoot(filePath);
        refs.push({ catalogId: id, format: "apple-strings", locale, path: filePath, unitId });
      }
      return refs;
    },
    async loadDocument(ref) {
      unit(ref.unitId);
      await checkWithinRoot(ref.path);
      const table = await readTable(ref.path);
      if (table === null) {
        return null;
      }
      const sourcePath = file(options.sourceLocale, ref.unitId);
      await checkWithinRoot(sourcePath);
      const templates =
        ref.locale === options.sourceLocale
          ? table
          : ((await readTable(sourcePath)) ?? table);
      const sourceRecords = new Map(templates.records.map((record) => [record.key, record]));
      const entries = table.records.flatMap((record) => {
        const source = sourceRecords.get(record.key);
        return source === undefined ? [] : [entry(source, record.value, plainTextKeys)];
      });
      return document(ref, { encoding: table.encoding, table, templates }, entries);
    },
    reconcileDocument({ ref, source, target }) {
      const sourceState = source.state as StringsState;
      const targetState = target?.state as StringsState | undefined;
      const values = new Map(
        target?.entries.map((item) => [
          item.address[0]?.kind === "key" ? item.address[0].key : "",
          item.value,
        ]),
      );
      const entries = sourceState.table.records.map((record) =>
        entry(
          record,
          typeof values.get(record.key) === "string" ? (values.get(record.key) as string) : null,
          plainTextKeys,
        ),
      );
      return Promise.resolve(
        document(
          ref,
          {
            encoding: targetState?.encoding ?? sourceState.encoding,
            table: targetState?.table ?? { records: [], text: "" },
            templates: sourceState.table,
          },
          entries,
        ),
      );
    },
    async scaffoldLocale(scaffold) {
      const strategy = scaffold.strategy ?? "copy-source";
      const from =
        strategy === "copy-source"
          ? options.sourceLocale
          : (scaffold.fromLocale ?? options.sourceLocale);
      const refs = await adapter.listDocumentRefs(from);
      let createdDocuments = 0;
      let skippedDocuments = 0;
      for (const ref of refs) {
        const target = adapter.createDocumentRef(ref, scaffold.locale);
        if (strategy === "empty") {
          skippedDocuments += 1;
          continue;
        }
        await checkWithinRoot(target.path);
        await withFileLock(target.path, async () => {
          if ((await readTable(target.path)) !== null) {
            skippedDocuments += 1;
            return;
          }
          const contents = await fs.readFile(ref.path);
          await writeTextAtomic(target.path, contents);
          createdDocuments += 1;
        });
      }
      return {
        catalogId: id,
        createdDocuments,
        locale: scaffold.locale,
        skippedDocuments,
        strategy,
      };
    },
    async writeDocument(next) {
      await checkWithinRoot(next.ref.path);
      const state = next.state as StringsState;
      const originalValues = new Map(state.table.records.map(({ key, value }) => [key, value]));
      const values = new Map<string, string>();
      for (const item of next.entries) {
        const address = item.address[0];
        if (item.address.length !== 1 || address?.kind !== "key") {
          throw new Error("Invalid Apple strings entry address.");
        }
        if (
          typeof item.value === "string" &&
          (state.scaffold === true || item.value !== originalValues.get(address.key))
        ) {
          values.set(address.key, item.value);
        }
      }
      if (values.size === 0 && state.scaffold !== true) {
        return;
      }
      await withFileLock(next.ref.path, async () => {
        const current = await readTable(next.ref.path);
        if (state.scaffold === true && current !== null) {
          return;
        }
        const currentValues = new Map(current?.records.map(({ key, value }) => [key, value]));
        for (const [key, value] of values) {
          const currentValue = currentValues.get(key);
          if (
            state.scaffold !== true &&
            currentValue !== originalValues.get(key) &&
            currentValue !== value
          ) {
            throw new Error(`Apple strings translation changed before writing ${JSON.stringify(key)}.`);
          }
        }
        const text = renderStrings(current ?? state.table, values, state.templates);
        await writeTextAtomic(
          next.ref.path,
          encodeStrings(text, current?.encoding ?? state.encoding),
        );
      });
    },
  };
  return adapter;
}
