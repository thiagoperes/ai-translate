import { describe, expect, it } from "vitest";

import { resolveDocumentConcurrency, runWithConcurrency } from "../src/concurrency";
import { syncCatalogs, validateCatalogs } from "../src/sync";
import type {
  AiTranslateConfig,
  CatalogAdapter,
  DocumentRef,
  Entry,
  LoadedDocument,
  SyncStateSnapshot,
  SyncStateStore,
  TranslationProvider,
} from "../src/types";

interface DocumentState {
  locale: string;
  unitId: string;
}

/**
 * Records how many catalog reads and writes overlap, which is the only way to
 * distinguish a phase that fans out from one that merely looks like it does:
 * both produce identical documents and identical state.
 */
function createOverlapProbe() {
  const peak = { loads: 0, writes: 0 };
  const active = { loads: 0, writes: 0 };

  const track = async <T>(
    kind: "loads" | "writes",
    operation: () => Promise<T>
  ): Promise<T> => {
    active[kind] += 1;
    peak[kind] = Math.max(peak[kind], active[kind]);
    try {
      // Yields long enough for every sibling to start before the first
      // finishes, so a serial caller can never reach an overlap above one.
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      return await operation();
    } finally {
      active[kind] -= 1;
    }
  };

  return { peak, track };
}

function entriesFor(unitId: string): Entry[] {
  return [
    {
      address: [{ key: "title", kind: "key" }],
      policy: "translate",
      storage: "string",
      value: `Title of ${unitId}`,
    },
  ];
}

function createProbedCatalog(unitIds: readonly string[]) {
  const probe = createOverlapProbe();
  const documents = new Map<string, LoadedDocument<DocumentState>>();
  const keyFor = (locale: string, unitId: string): string => `${locale}:${unitId}`;

  for (const unitId of unitIds) {
    documents.set(keyFor("en", unitId), {
      entries: entriesFor(unitId),
      ref: {
        catalogId: "probed",
        format: "json",
        locale: "en",
        path: `/probed/en/${unitId}.json`,
        unitId,
      },
      state: { locale: "en", unitId },
    });
  }

  const catalog: CatalogAdapter = {
    createDocumentRef(sourceRef, locale) {
      return {
        ...sourceRef,
        locale,
        path: `/probed/${locale}/${sourceRef.unitId}.json`,
      };
    },
    id: "probed",
    listDocumentRefs(sourceLocale) {
      return Promise.resolve(
        unitIds.map(
          (unitId): DocumentRef => ({
            catalogId: "probed",
            format: "json",
            locale: sourceLocale,
            path: `/probed/${sourceLocale}/${unitId}.json`,
            unitId,
          })
        )
      );
    },
    loadDocument(ref) {
      return probe.track("loads", () => {
        const document = documents.get(keyFor(ref.locale, ref.unitId));
        return Promise.resolve(
          document === undefined
            ? null
            : {
                entries: document.entries.map((entry) => ({
                  ...entry,
                  address: [...entry.address],
                })),
                ref: document.ref,
                state: { ...document.state },
              }
        );
      });
    },
    reconcileDocument({ ref, source }) {
      return Promise.resolve({
        entries: source.entries.map((entry) => ({
          ...entry,
          address: [...entry.address],
        })),
        ref,
        state: { locale: ref.locale, unitId: ref.unitId },
      });
    },
    writeDocument(document) {
      return probe.track("writes", () => {
        documents.set(keyFor(document.ref.locale, document.ref.unitId), {
          entries: document.entries.map((entry) => ({
            ...entry,
            address: [...entry.address],
          })),
          ref: document.ref,
          state: document.state as DocumentState,
        });
        return Promise.resolve();
      });
    },
  };

  return { catalog, documents, peak: probe.peak };
}

function createStateStore(): SyncStateStore {
  let snapshot: SyncStateSnapshot = { entries: {}, version: 2 };
  return {
    load() {
      return Promise.resolve({
        entries: { ...snapshot.entries },
        version: snapshot.version,
      });
    },
    save(nextState) {
      snapshot = { entries: { ...nextState.entries }, version: nextState.version };
      return Promise.resolve();
    },
    withLock(operation) {
      return operation();
    },
  };
}

const echoProvider: TranslationProvider = {
  translate({ locale, requests }) {
    return Promise.resolve(
      requests.map((request) => ({
        key: request.key,
        translation: `${request.sourceText} (${locale})`,
      }))
    );
  },
};

const UNIT_IDS = ["alpha", "beta", "delta", "epsilon", "gamma", "omega"];

function withoutTimestamps(
  entries: SyncStateSnapshot["entries"]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, { updatedAt: _updatedAt, ...rest }]) => [key, rest])
  );
}

function configFor(
  catalog: CatalogAdapter,
  documentConcurrency: number | undefined
): AiTranslateConfig {
  return {
    catalogs: [catalog],
    ...(documentConcurrency === undefined
      ? {}
      : { concurrency: { documents: documentConcurrency } }),
    provider: echoProvider,
    sourceLocale: "en",
    state: createStateStore(),
    targetLocales: ["de", "fr"],
  };
}

describe("resolveDocumentConcurrency", () => {
  it("prefers the run option over the configured default", () => {
    expect(
      resolveDocumentConcurrency({ concurrency: { documents: 3 } }, { documentConcurrency: 32 })
    ).toBe(32);
    expect(resolveDocumentConcurrency({ concurrency: { documents: 3 } })).toBe(3);
    expect(resolveDocumentConcurrency({})).toBe(4);
  });

  it("rejects a concurrency that cannot run any work", () => {
    expect(() => resolveDocumentConcurrency({ concurrency: { documents: 0 } })).toThrow(
      "Document concurrency must be a positive integer."
    );
    expect(() => resolveDocumentConcurrency({}, { documentConcurrency: 1.5 })).toThrow(
      "Document concurrency must be a positive integer."
    );
  });
});

describe("runWithConcurrency", () => {
  it("keeps results in input order however they complete", async () => {
    const results = await runWithConcurrency([30, 20, 10, 0], 4, async (delay, index) => {
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("stops handing out work after the first failure", async () => {
    const started: number[] = [];
    await expect(
      runWithConcurrency([0, 1, 2, 3, 4, 5], 1, (value) => {
        started.push(value);
        return value === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(value);
      })
    ).rejects.toThrow("boom");
    expect(started).toEqual([0, 1]);
  });
});

describe("syncCatalogs concurrency", () => {
  it("reads and writes documents concurrently up to the configured budget", async () => {
    const { catalog, peak } = createProbedCatalog(UNIT_IDS);
    const result = await syncCatalogs(configFor(catalog, 6));

    expect(result.metrics.scannedDocuments).toBe(UNIT_IDS.length * 2);
    expect(peak.loads).toBeGreaterThan(1);
    expect(peak.writes).toBeGreaterThan(1);
    expect(peak.loads).toBeLessThanOrEqual(6);
    expect(peak.writes).toBeLessThanOrEqual(6);
  });

  it("serializes every document phase at a concurrency of one", async () => {
    const { catalog, peak } = createProbedCatalog(UNIT_IDS);
    await syncCatalogs(configFor(catalog, 1));

    expect(peak.loads).toBe(1);
    expect(peak.writes).toBe(1);
  });

  it("produces the same documents and state whatever the concurrency", async () => {
    const serial = createProbedCatalog(UNIT_IDS);
    const parallel = createProbedCatalog(UNIT_IDS);

    const serialResult = await syncCatalogs(configFor(serial.catalog, 1));
    const parallelResult = await syncCatalogs(configFor(parallel.catalog, 16));

    expect(parallelResult.documents).toEqual(serialResult.documents);
    // `updatedAt` records when each run happened, so it is the one field two
    // runs are meant to disagree on.
    expect(withoutTimestamps(parallelResult.state.entries)).toEqual(
      withoutTimestamps(serialResult.state.entries)
    );
    expect([...parallel.documents.keys()].toSorted()).toEqual(
      [...serial.documents.keys()].toSorted()
    );
  });

  it("lets a run override the configured concurrency", async () => {
    const { catalog, peak } = createProbedCatalog(UNIT_IDS);
    await syncCatalogs(configFor(catalog, 1), { documentConcurrency: 12 });

    expect(peak.loads).toBeGreaterThan(1);
  });

  it("reports the time spent writing documents", async () => {
    const { catalog } = createProbedCatalog(UNIT_IDS);
    const result = await syncCatalogs(configFor(catalog, 6));

    expect(result.metrics.phases?.documentWriteMs).toBeGreaterThan(0);
  });
});

describe("validateCatalogs concurrency", () => {
  it("reads documents concurrently without changing the issue list", async () => {
    const serial = createProbedCatalog(UNIT_IDS);
    const parallel = createProbedCatalog(UNIT_IDS);

    const serialResult = await validateCatalogs(configFor(serial.catalog, 1));
    const parallelResult = await validateCatalogs(configFor(parallel.catalog, 16));

    expect(serial.peak.loads).toBe(1);
    expect(parallel.peak.loads).toBeGreaterThan(1);
    expect(parallelResult.issues).toEqual(serialResult.issues);
    expect(parallelResult.sourceDocuments).toBe(UNIT_IDS.length);
  });
});
