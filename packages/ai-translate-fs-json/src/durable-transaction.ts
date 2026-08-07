import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { SyncStateLoadScope, SyncStateSnapshot } from "@ai-translate/core/types";

export const DURABLE_TRANSACTION_STATE_STORE: unique symbol = Symbol.for(
  "@ai-translate/fs-json/durable-transaction-state-store",
);

export type DurableTransactionFaultPoint =
  | "after-document-write"
  | "after-journal-prepared"
  | "after-rollforward-marker"
  | "after-state-write";

export interface DurableDocumentChange {
  mode?: number;
  next: Uint8Array | null;
  original: Uint8Array | null;
  path: string;
}

export interface DurableTransactionCommit {
  documents: readonly DurableDocumentChange[];
  initialState: SyncStateSnapshot;
  nextState: SyncStateSnapshot;
  /**
   * Restricts both the commit and any later recovery to these locales. Without
   * it the staged snapshot is read as the whole corpus, which for a scoped run
   * would delete every locale it never loaded.
   */
  scope?: SyncStateLoadScope;
}

export interface DurableTransactionStateStore {
  [DURABLE_TRANSACTION_STATE_STORE]: {
    commit(transaction: DurableTransactionCommit): Promise<void>;
  };
}

interface DurableTransactionCoordinatorOptions {
  faultInjector?: (point: DurableTransactionFaultPoint) => Promise<"simulate-crash" | void> | "simulate-crash" | void;
  journalPath: string;
  saveState(state: SyncStateSnapshot, scope?: SyncStateLoadScope): Promise<void>;
  transactionsDir: string;
}

interface JournalDocument {
  mode?: number;
  next: string | null;
  original: string | null;
  path: string;
}

interface TransactionJournalV1 {
  documents: readonly JournalDocument[];
  id: string;
  initialState: string;
  nextState: string;
  phase: "rollback" | "rollforward";
  scope?: undefined;
  version: 1;
}

/**
 * Identical to v1 plus the scope the transaction was staged under.
 *
 * The version is raised only when a scope is actually present, so unscoped
 * transactions stay readable by any version in both directions. The bump
 * matters because recovery usually runs in a later process: a reader that does
 * not understand the scope would restore the snapshot as the whole corpus and
 * delete every locale the run never loaded. Rejecting the journal as unreadable
 * is a loud, recoverable failure; applying it is silent data loss.
 */
interface TransactionJournalV2 extends Omit<TransactionJournalV1, "scope" | "version"> {
  scope: { locales: readonly string[] };
  version: 2;
}

type TransactionJournal = TransactionJournalV1 | TransactionJournalV2;

class SimulatedProcessCrash extends Error {
  constructor(point: DurableTransactionFaultPoint) {
    super(`Simulated abrupt process termination at durable transaction fault point "${point}".`);
    this.name = "SimulatedProcessCrash";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseJournalScope(value: unknown): { locales: readonly string[] } | null {
  if (!isRecord(value) || !Array.isArray(value.locales) || value.locales.length === 0) {
    return null;
  }
  return value.locales.every((locale) => typeof locale === "string" && locale.length > 0)
    ? { locales: value.locales as readonly string[] }
    : null;
}

function parseJournal(value: unknown, journalPath: string): TransactionJournal {
  if (!isRecord(value)) {
    throw new Error(`Invalid ai-translate transaction journal at ${journalPath}.`);
  }
  // Bound to locals so the narrowing below survives the document callback, which
  // would otherwise invalidate it for properties read off a mutable record.
  const { documents, id, initialState, nextState, phase, version } = value;
  if (
    (version !== 1 && version !== 2) ||
    typeof id !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(id) ||
    (phase !== "rollback" && phase !== "rollforward") ||
    typeof initialState !== "string" ||
    typeof nextState !== "string" ||
    !Array.isArray(documents)
  ) {
    throw new Error(`Invalid ai-translate transaction journal at ${journalPath}.`);
  }

  const parsedDocuments: JournalDocument[] = documents.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== "string" ||
      !path.isAbsolute(candidate.path) ||
      !isNullableString(candidate.original) ||
      !isNullableString(candidate.next) ||
      (candidate.mode !== undefined &&
        (!Number.isInteger(candidate.mode) || (candidate.mode as number) < 0))
    ) {
      throw new Error(`Invalid ai-translate transaction journal at ${journalPath}.`);
    }
    return {
      ...(candidate.mode === undefined ? {} : { mode: candidate.mode as number }),
      next: candidate.next,
      original: candidate.original,
      path: candidate.path,
    };
  });

  const common: Omit<TransactionJournalV1, "scope" | "version"> = {
    documents: parsedDocuments,
    id,
    initialState,
    nextState,
    phase,
  };

  if (version === 1) {
    return { ...common, version: 1 };
  }

  const scope = parseJournalScope(value.scope);
  if (scope === null) {
    // A v2 journal without a usable scope cannot be recovered safely: applying
    // its snapshot unscoped is exactly the deletion the version guards against.
    throw new Error(`Invalid ai-translate transaction journal at ${journalPath}.`);
  }
  return { ...common, scope, version: 2 };
}

function parseState(contents: Uint8Array, stateArtifactPath: string): SyncStateSnapshot {
  const value: unknown = JSON.parse(Buffer.from(contents).toString("utf8"));
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !isRecord(value.entries)
  ) {
    throw new Error(`Invalid ai-translate state transaction artifact at ${stateArtifactPath}.`);
  }
  return value as unknown as SyncStateSnapshot;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  await fs.mkdir(directory, { recursive: true });
  await syncDirectory(parent);
}

async function writeFileDurable(
  filePath: string,
  contents: Uint8Array,
  mode?: number,
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (mode !== undefined) {
      await fs.chmod(temporaryPath, mode);
    }
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await fs.rm(temporaryPath, { force: true });
  }
}

async function removeFileDurable(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function readFileRequired(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`Missing ai-translate transaction artifact at ${filePath}.`, { cause: error });
  }
}

async function readJournal(journalPath: string): Promise<TransactionJournal | null> {
  try {
    return parseJournal(JSON.parse(await fs.readFile(journalPath, "utf8")), journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function artifactPath(
  transactionsDir: string,
  journal: Pick<TransactionJournalV1, "id">,
  relativePath: string,
): string {
  const transactionRoot = path.resolve(transactionsDir, journal.id);
  const resolved = path.resolve(transactionRoot, relativePath);
  if (resolved !== transactionRoot && !resolved.startsWith(`${transactionRoot}${path.sep}`)) {
    throw new Error(`Ai-translate transaction artifact escapes ${transactionRoot}.`);
  }
  return resolved;
}

async function applyDocument(filePath: string, contents: Buffer | null, mode?: number): Promise<void> {
  if (contents === null) {
    await removeFileDurable(filePath);
    return;
  }
  await writeFileDurable(filePath, contents, mode);
}

async function cleanupTransaction(
  journalPath: string,
  transactionsDir: string,
  journal: Pick<TransactionJournalV1, "id">,
): Promise<void> {
  // The journal must be durably gone before its recovery artifacts are removed.
  await removeFileDurable(journalPath);
  // Once the journal deletion is durable, the transaction is complete. A
  // leftover artifact directory is harmless and is removed by the next run.
  await fs
    .rm(path.join(transactionsDir, journal.id), { force: true, recursive: true })
    .catch(() => undefined);
}

export function createDurableTransactionCoordinator(
  options: DurableTransactionCoordinatorOptions,
): DurableTransactionStateStore[typeof DURABLE_TRANSACTION_STATE_STORE] & {
  recover(): Promise<void>;
} {
  async function recover(): Promise<void> {
    const journal = await readJournal(options.journalPath);
    if (journal === null) {
      await fs.rm(options.transactionsDir, { force: true, recursive: true }).catch(() => undefined);
      return;
    }

    const useNext = journal.phase === "rollforward";
    for (const document of journal.documents) {
      const relativeArtifact = useNext ? document.next : document.original;
      await applyDocument(
        document.path,
        relativeArtifact === null
          ? null
          : await readFileRequired(artifactPath(options.transactionsDir, journal, relativeArtifact)),
        document.mode,
      );
    }
    const stateRelativePath = useNext ? journal.nextState : journal.initialState;
    const statePath = artifactPath(options.transactionsDir, journal, stateRelativePath);
    await options.saveState(
      parseState(await readFileRequired(statePath), statePath),
      journal.scope,
    );
    await cleanupTransaction(options.journalPath, options.transactionsDir, journal);
  }

  async function injectFault(point: DurableTransactionFaultPoint): Promise<void> {
    if ((await options.faultInjector?.(point)) === "simulate-crash") {
      throw new SimulatedProcessCrash(point);
    }
  }

  return {
    async commit(transaction) {
      await recover();
      const uniquePaths = new Set(transaction.documents.map((document) => document.path));
      if (uniquePaths.size !== transaction.documents.length) {
        throw new Error("Ai-translate durable transaction contains duplicate document paths.");
      }
      if (transaction.documents.some((document) => !path.isAbsolute(document.path))) {
        throw new Error("Ai-translate durable transaction document paths must be absolute.");
      }

      const id = randomUUID();
      const transactionRoot = path.join(options.transactionsDir, id);
      await ensureDirectory(options.transactionsDir);
      await ensureDirectory(transactionRoot);

      const documents: JournalDocument[] = [];
      for (const [index, document] of transaction.documents.entries()) {
        const original = document.original === null ? null : `document-${String(index)}.old`;
        const next = document.next === null ? null : `document-${String(index)}.new`;
        if (original !== null) {
          await writeFileDurable(path.join(transactionRoot, original), document.original as Uint8Array);
        }
        if (next !== null) {
          await writeFileDurable(path.join(transactionRoot, next), document.next as Uint8Array);
        }
        documents.push({
          ...(document.mode === undefined ? {} : { mode: document.mode }),
          next,
          original,
          path: document.path,
        });
      }

      const initialState = "state.old.json";
      const nextState = "state.new.json";
      await writeFileDurable(
        path.join(transactionRoot, initialState),
        Buffer.from(`${JSON.stringify(transaction.initialState)}\n`),
      );
      await writeFileDurable(
        path.join(transactionRoot, nextState),
        Buffer.from(`${JSON.stringify(transaction.nextState)}\n`),
      );

      const scopeLocales = transaction.scope?.locales;
      const journal: TransactionJournal =
        scopeLocales === undefined || scopeLocales.length === 0
          ? { documents, id, initialState, nextState, phase: "rollback", version: 1 }
          : {
              documents,
              id,
              initialState,
              nextState,
              phase: "rollback",
              scope: { locales: [...scopeLocales] },
              version: 2,
            };
      await writeFileDurable(
        options.journalPath,
        Buffer.from(`${JSON.stringify(journal, null, 2)}\n`),
      );

      try {
        await injectFault("after-journal-prepared");
        for (const document of documents) {
          await applyDocument(
            document.path,
            document.next === null
              ? null
              : await readFileRequired(artifactPath(options.transactionsDir, journal, document.next)),
            document.mode,
          );
          await injectFault("after-document-write");
        }
        await options.saveState(transaction.nextState, journal.scope);
        await injectFault("after-state-write");

        const committedJournal: TransactionJournal = { ...journal, phase: "rollforward" };
        await writeFileDurable(
          options.journalPath,
          Buffer.from(`${JSON.stringify(committedJournal, null, 2)}\n`),
        );
        await injectFault("after-rollforward-marker");
        await cleanupTransaction(options.journalPath, options.transactionsDir, committedJournal);
      } catch (error) {
        if (error instanceof SimulatedProcessCrash) {
          throw error;
        }
        try {
          await recover();
        } catch (recoveryError) {
          const failure = new Error(
            "Ai-translate transaction failed and could not be completely recovered.",
            { cause: recoveryError },
          );
          Object.assign(failure, { errors: [error, recoveryError] });
          throw failure;
        }
        throw error;
      }
    },
    recover,
  };
}
