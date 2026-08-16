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
import type { MessageFormat } from "@ai-translate/core/message-format";
import type { PluralKeyStrategy } from "@ai-translate/core/plural";
import { rebaseIndexedEntries } from "@ai-translate/core/reconcile";
import { tokenizeText } from "@ai-translate/core/tokens";
import type {
  DocumentFormat,
  DocumentRef,
  Entry,
  JsonValue,
  LoadedDocument,
  LocalizeSourceDocumentArgs,
  Policy,
  ReconcileHistoryEntry,
} from "@ai-translate/core/types";

import { collapsePluralFamilies, expandPluralKeys, pluralStructureGroups } from "./plurals";

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

export interface JsonEntryOptions {
  /** Interprets each string leaf. Defaults to the plain format, which keeps
   * output identical to callers that predate message formats. */
  messageFormat?: MessageFormat;
  /** When set, sibling plural keys are marked as one structure group so
   * locales with more plural forms than the source still validate. */
  plurals?: PluralKeyStrategy;
  /**
   * Set to `false` for entries that only need addresses and values. Tokenizing
   * is the most expensive part of building an entry list and every consumer of
   * `Entry.tokens` is a validator, so internal walks that do no validation skip
   * it. Entries built this way must not be handed to validation.
   */
  tokenize?: boolean;
}

export function buildEntriesFromJson(
  root: JsonValue,
  options: JsonEntryOptions = {},
): Entry[] {
  // Bound to its format: the message format is caller-supplied and may be a
  // class instance, which would lose `this` once `tokenize` is detached.
  const { messageFormat } = options;
  const tokenize =
    options.tokenize === false
      ? undefined
      : messageFormat === undefined
        ? tokenizeText
        : (text: string) => messageFormat.tokenize(text);
  const messageFormatId = messageFormat?.id;
  const structureGroups =
    options.plurals === undefined
      ? undefined
      : pluralStructureGroups(root, options.plurals);

  const entries: Entry[] = [];
  visitJsonLeaves(root, ({ address, value }) => {
    const structureGroup = structureGroups?.get(addressToJsonPointer(address));
    const baseEntry = {
      address: [...address],
      ...(messageFormatId === undefined ? {} : { messageFormatId }),
      ...(structureGroup === undefined ? {} : { meta: { structureGroup } }),
      policy: inferPolicy(value),
      storage: inferStorage(value),
      value,
    } satisfies Omit<Entry, "tokens">;

    entries.push(
      typeof value === "string" && tokenize !== undefined
        ? {
            ...baseEntry,
            tokens: [...tokenize(value)],
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

/** Whether any leaf sits inside an array, i.e. whether index rebasing applies. */
function hasIndexedLeaf(root: JsonValue): boolean {
  let found = false;
  visitJsonLeaves(root, ({ address }) => {
    found ||= address.some((segment) => segment.kind === "index");
  });
  return found;
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

  /*
   * Index rebasing exists so a reordered or renumbered array keeps its
   * translations, and it only ever inspects leaves addressed through an array.
   * A flat message catalog has none, which is the common case, so building two
   * full entry lists — tokenizing every string in both documents — to feed a
   * matcher that will look at nothing is the single most expensive thing a
   * no-op run used to do.
   *
   * Retirement still has to happen when the arrays are gone from the source but
   * the history remembers them, and that needs only the history.
   */
  const indexed = hasIndexedLeaf(sourceRoot)
    ? rebaseIndexedEntries({
        history,
        // Tokens are not part of index matching, which compares values and
        // address shape, so the tokenizer is left out of both walks.
        sourceEntries: buildEntriesFromJson(sourceRoot, { tokenize: false }),
        targetEntries: buildEntriesFromJson(targetRoot, { tokenize: false }),
      })
    : rebaseIndexedEntries({ history, sourceEntries: [], targetEntries: [] });

  visitJsonLeaves(sourceRoot, ({ address }) => {
    const targetValue = address.some((segment) => segment.kind === "index")
      ? indexed.valuesByPointer.get(addressToJsonPointer(address))
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

/**
 * Builds the `localizeSourceDocument` hook for a JSON catalog, or nothing when
 * the catalog has no plural strategy and the source is already locale-neutral.
 */
export function createJsonSourceLocalizer(
  plurals: PluralKeyStrategy | undefined,
  entryOptions: JsonEntryOptions,
): ((args: LocalizeSourceDocumentArgs) => Promise<LoadedDocument>) | undefined {
  if (plurals === undefined) {
    return undefined;
  }

  return ({ locale, source }) => {
    const root = expandPluralKeys((source.state as JsonRootState).root, locale, plurals);
    return Promise.resolve({
      entries: buildEntriesFromJson(root, entryOptions),
      ref: source.ref,
      state: { root } satisfies JsonRootState,
      structureDigest: jsonStructureDigest(root, plurals),
    });
  };
}

export function jsonStructureDigest(
  root: JsonValue,
  plurals?: PluralKeyStrategy,
): string {
  const normalized = plurals === undefined ? root : collapsePluralFamilies(root, plurals);
  return digestValue(JSON.stringify(jsonStructure(normalized)));
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

