import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  AiTranslateConfig,
  CatalogAdapter,
  DocumentRef,
  Entry,
  LoadedDocument,
  ScaffoldLocaleOptions,
  ScaffoldLocaleResult,
  SyncStateSnapshot,
  SyncStateStore,
} from "@ai-translate/core/types";
import type {
  DurableDocumentChange,
} from "@ai-translate/fs-json";

const DURABLE_TRANSACTION_STATE_STORE = Symbol.for(
  "@ai-translate/fs-json/durable-transaction-state-store",
);

function cloneState(state: SyncStateSnapshot): SyncStateSnapshot {
  return structuredClone(state);
}

function cloneEntry(entry: Entry): Entry {
  return {
    ...entry,
    address: entry.address.map((segment) => ({ ...segment })),
    ...(entry.meta === undefined ? {} : { meta: { ...entry.meta } }),
    ...(entry.tokens === undefined ? {} : { tokens: entry.tokens.map((token) => ({ ...token })) }),
  };
}

/** Adapter state may contain parser-owned class instances, so retain it while
 * isolating the mutable translation entries. Staged writes are subsequently
 * serialized and reloaded by the real adapter to obtain isolated live state. */
function cloneDocument(document: LoadedDocument): LoadedDocument {
  return {
    entries: document.entries.map(cloneEntry),
    ...(document.reconciliation === undefined
      ? {}
      : {
          reconciliation: {
            ...(document.reconciliation.previousPointers === undefined
              ? {}
              : { previousPointers: { ...document.reconciliation.previousPointers } }),
            ...(document.reconciliation.retiredStateKeys === undefined
              ? {}
              : { retiredStateKeys: [...document.reconciliation.retiredStateKeys] }),
          },
        }),
    ref: { ...document.ref },
    state: document.state,
    ...(document.structureDigest === undefined
      ? {}
      : { structureDigest: document.structureDigest }),
  };
}

function restoreDocumentRef(document: LoadedDocument, ref: DocumentRef): LoadedDocument {
  return cloneDocument({ ...document, ref: { ...ref } });
}

function documentKey(ref: DocumentRef): string {
  return [ref.catalogId, ref.format, ref.locale, ref.path, ref.unitId].join("\u0000");
}

class StagedStateStore implements SyncStateStore {
  private dirty = false;
  private snapshot: SyncStateSnapshot;

  constructor(initial: SyncStateSnapshot) {
    this.snapshot = cloneState(initial);
  }

  hasChanges(): boolean {
    return this.dirty;
  }

  load(): Promise<SyncStateSnapshot> {
    return Promise.resolve(cloneState(this.snapshot));
  }

  save(state: SyncStateSnapshot): Promise<void> {
    this.snapshot = cloneState(state);
    this.dirty = true;
    return Promise.resolve();
  }

  stagedSnapshot(): SyncStateSnapshot {
    return cloneState(this.snapshot);
  }

  withLock<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

interface StagedFile {
  mode: number | undefined;
  original: Buffer | null;
  realPath: string;
  tempPath: string;
}

async function readOriginal(filePath: string): Promise<{
  mode: number | undefined;
  original: Buffer | null;
}> {
  try {
    const [original, stats] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return { mode: stats.mode, original };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { mode: undefined, original: null };
    }
    throw error;
  }
}

async function writeFileAtomic(filePath: string, contents: Buffer, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.ai-translate-${randomUUID()}`,
  );
  try {
    await fs.writeFile(temporaryPath, contents);
    if (mode !== undefined) {
      await fs.chmod(temporaryPath, mode);
    }
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

class StagedCatalogs {
  private readonly files = new Map<string, StagedFile>();
  private readonly pendingRefs = new Map<string, { catalog: CatalogAdapter; ref: DocumentRef }>();
  private tempRoot: string | undefined;

  constructor(
    private readonly catalogs: readonly CatalogAdapter[],
    private readonly sourceLocale: string,
  ) {}

  adapters(): readonly CatalogAdapter[] {
    return this.catalogs.map((catalog) => this.createAdapter(catalog));
  }

  async cleanup(): Promise<void> {
    if (this.tempRoot !== undefined) {
      await fs.rm(this.tempRoot, { force: true, recursive: true });
    }
  }

  async promote(): Promise<void> {
    for (const staged of this.files.values()) {
      await writeFileAtomic(staged.realPath, await fs.readFile(staged.tempPath), staged.mode);
    }
  }

  async durableChanges(): Promise<readonly DurableDocumentChange[]> {
    return await Promise.all(
      [...this.files.values()].map(async (staged) => ({
        ...(staged.mode === undefined ? {} : { mode: staged.mode }),
        next: await fs.readFile(staged.tempPath),
        original: staged.original,
        path: staged.realPath,
      })),
    );
  }

  async rollback(): Promise<void> {
    const failures: unknown[] = [];
    for (const staged of this.files.values()) {
      try {
        if (staged.original === null) {
          await fs.rm(staged.realPath, { force: true });
        } else {
          await writeFileAtomic(staged.realPath, staged.original, staged.mode);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to restore localized documents after commit.");
    }
  }

  private async stageFile(realPath: string): Promise<StagedFile> {
    const existing = this.files.get(realPath);
    if (existing) {
      return existing;
    }
    this.tempRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-stage-"));
    const { mode, original } = await readOriginal(realPath);
    const tempPath = path.join(
      this.tempRoot,
      `${String(this.files.size)}${path.extname(realPath) || ".document"}`,
    );
    if (original !== null) {
      await fs.writeFile(tempPath, original);
    }
    const staged = { mode, original, realPath, tempPath };
    this.files.set(realPath, staged);
    return staged;
  }

  private async loadStaged(
    catalog: CatalogAdapter,
    ref: DocumentRef,
  ): Promise<LoadedDocument | null> {
    const staged = this.files.get(ref.path);
    if (!staged) {
      const document = await catalog.loadDocument(ref);
      return document === null ? null : cloneDocument(document);
    }
    const tempRef = { ...ref, path: staged.tempPath };
    const document = await catalog.loadDocument(tempRef);
    return document === null ? null : restoreDocumentRef(document, ref);
  }

  private async writeStaged(catalog: CatalogAdapter, document: LoadedDocument): Promise<void> {
    const staged = await this.stageFile(document.ref.path);
    const tempRef = { ...document.ref, path: staged.tempPath };
    const stagedDocument = await catalog.loadDocument(tempRef);
    await catalog.writeDocument({
      ...cloneDocument(document),
      ref: tempRef,
      // The reconciled document is authoritative: it carries the source shape,
      // so keys dropped from the source do not survive in the target. Formats
      // that pack several logical documents into one file merge that shape
      // into the staged file themselves so sibling writes are not lost.
      state:
        stagedDocument === null || catalog.mergeStagedState === undefined
          ? document.state
          : catalog.mergeStagedState({ document, staged: stagedDocument }),
    });
    const persisted = await catalog.loadDocument(tempRef);
    if (persisted === null) {
      throw new Error(
        `Catalog "${catalog.id}" did not persist staged document ${document.ref.path}.`,
      );
    }
    this.pendingRefs.set(documentKey(document.ref), { catalog, ref: { ...document.ref } });

    // A bundle catalog can expose several logical documents backed by one file.
    // Re-read every staged ref for the path so later repair rounds see the
    // aggregate serialized state, not a pre-write per-unit snapshot.
    for (const pending of this.pendingRefs.values()) {
      if (pending.ref.path === document.ref.path) {
        const pendingTempRef = { ...pending.ref, path: staged.tempPath };
        if ((await pending.catalog.loadDocument(pendingTempRef)) === null) {
          throw new Error(
            `Catalog "${pending.catalog.id}" could not reload staged document ${pending.ref.path}.`,
          );
        }
      }
    }
  }

  private createAdapter(catalog: CatalogAdapter): CatalogAdapter {
    const mergeStagedState = catalog.mergeStagedState?.bind(catalog);
    return {
      createDocumentRef: (sourceRef, locale) => catalog.createDocumentRef(sourceRef, locale),
      id: catalog.id,
      listDocumentRefs: (sourceLocale) => catalog.listDocumentRefs(sourceLocale),
      loadDocument: (ref) => this.loadStaged(catalog, ref),
      ...(mergeStagedState === undefined ? {} : { mergeStagedState }),
      reconcileDocument: async (args) => {
        const document = await catalog.reconcileDocument({
          ...(args.history === undefined
            ? {}
            : { history: args.history.map((entry) => structuredClone(entry)) }),
          ref: { ...args.ref },
          source: cloneDocument(args.source),
          target: args.target === null ? null : cloneDocument(args.target),
        });
        return cloneDocument(document);
      },
      ...(catalog.scaffoldLocale === undefined
        ? {}
        : {
            scaffoldLocale: (options: ScaffoldLocaleOptions) =>
              this.scaffoldCatalog(catalog, options),
          }),
      writeDocument: (document) => this.writeStaged(catalog, document),
    };
  }

  private async scaffoldCatalog(
    catalog: CatalogAdapter,
    options: ScaffoldLocaleOptions,
  ): Promise<ScaffoldLocaleResult> {
    const strategy = options.strategy ?? "copy-source";
    const fromLocale =
      strategy === "copy-source" ? this.sourceLocale : (options.fromLocale ?? this.sourceLocale);
    const refs = await catalog.listDocumentRefs(fromLocale);
    if (strategy === "empty") {
      return {
        catalogId: catalog.id,
        createdDocuments: 0,
        locale: options.locale,
        skippedDocuments: refs.length,
        strategy,
      };
    }

    let createdDocuments = 0;
    let skippedDocuments = 0;
    const adapter = this.createAdapter(catalog);
    for (const sourceRef of refs) {
      const targetRef = adapter.createDocumentRef(sourceRef, options.locale);
      if ((await adapter.loadDocument(targetRef)) !== null) {
        skippedDocuments += 1;
        continue;
      }
      const source = await adapter.loadDocument(sourceRef);
      if (source === null) {
        skippedDocuments += 1;
        continue;
      }
      await adapter.writeDocument(
        await adapter.reconcileDocument({ ref: targetRef, source, target: null }),
      );
      createdDocuments += 1;
    }

    return {
      catalogId: catalog.id,
      createdDocuments,
      locale: options.locale,
      skippedDocuments,
      strategy,
    };
  }
}

function commitFailure(commitError: unknown, rollbackErrors: readonly unknown[]): Error {
  return rollbackErrors.length === 0
    ? commitError instanceof Error
      ? commitError
      : new Error(String(commitError))
    : new AggregateError(
        [commitError, ...rollbackErrors],
        "Translation commit failed and could not be completely rolled back.",
      );
}

interface DurableCommitCoordinator {
  commit(transaction: {
    documents: readonly DurableDocumentChange[];
    initialState: SyncStateSnapshot;
    nextState: SyncStateSnapshot;
  }): Promise<void>;
}

function durableStateStore(state: SyncStateStore): DurableCommitCoordinator | null {
  if (typeof state === "object" && state !== null) {
    const candidate = (state as unknown as Record<PropertyKey, unknown>)[
      DURABLE_TRANSACTION_STATE_STORE
    ];
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "commit" in candidate &&
      typeof candidate.commit === "function"
    ) {
      return candidate as DurableCommitCoordinator;
    }
  }
  return null;
}

export async function runStagedCatalogTransaction<T>(
  config: AiTranslateConfig,
  operation: (stagedConfig: AiTranslateConfig) => Promise<T>,
  shouldCommit: (result: T) => boolean = () => true,
): Promise<T> {
  return config.state.withLock(async () => {
    const initialState = await config.state.load();
    const stagedState = new StagedStateStore(initialState);
    const stagedCatalogs = new StagedCatalogs(config.catalogs, config.sourceLocale);
    const stagedConfig: AiTranslateConfig = {
      ...config,
      catalogs: stagedCatalogs.adapters(),
      state: stagedState,
    };
    try {
      const result = await operation(stagedConfig);
      if (!shouldCommit(result)) {
        return result;
      }

      const durableStore = durableStateStore(config.state);
      if (durableStore !== null) {
        const documents = await stagedCatalogs.durableChanges();
        if (documents.length > 0 || stagedState.hasChanges()) {
          await durableStore.commit({
            documents,
            initialState: cloneState(initialState),
            nextState: stagedState.stagedSnapshot(),
          });
        }
      } else {
        let stateSaveAttempted = false;
        try {
          await stagedCatalogs.promote();
          if (stagedState.hasChanges()) {
            stateSaveAttempted = true;
            await config.state.save(stagedState.stagedSnapshot());
          }
        } catch (error) {
          const rollbackErrors: unknown[] = [];
          try {
            await stagedCatalogs.rollback();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          if (stateSaveAttempted) {
            try {
              await config.state.save(cloneState(initialState));
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          throw commitFailure(error, rollbackErrors);
        }
      }
      return result;
    } finally {
      await stagedCatalogs.cleanup();
    }
  });
}
