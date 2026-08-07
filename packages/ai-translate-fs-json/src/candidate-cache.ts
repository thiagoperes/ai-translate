import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";

import {
  createLegacyTranslationCandidateCacheProbeKey,
  digestTranslationCandidateCacheKey,
  generationCacheKeyMaterialMatches,
  isReadableTranslationCandidateCacheKey,
  isValidTranslationCandidateCacheKey,
} from "@ai-translate/core";
import { digestValue } from "@ai-translate/core/hash";
import type {
  TranslationCandidateCache,
  TranslationCandidateCacheKey,
  TranslationAttestedCandidate,
} from "@ai-translate/core/types";

export interface FileTranslationCandidateCacheOptions {
  compatibleProviderRevisions?: readonly string[];
  /**
   * Historical generation cohorts that remain eligible under the current
   * generation identity. Validator/deterministic revisions are ignored —
   * cache hits are always revalidated by the host.
   */
  compatibleGenerationRevisions?: readonly string[];
  /**
   * @deprecated Validator revisions no longer participate in generation-cache
   * identity. Kept only to locate pre-redesign on-disk digests during migration.
   */
  compatibleRevisionPairs?: readonly {
    deterministicContractRevision: string;
    generationRevision: string;
  }[];
  /** @deprecated Use compatibleGenerationRevisions / compatibleRevisionPairs. */
  compatibleDeterministicContractRevisions?: readonly string[];
  /**
   * Pre-redesign cache keys hashed the full glossary into every entry. Pass
   * those historical digests here so schema-v2 relevant-glossary keys can
   * still locate the on-disk records.
   */
  legacyGlossaryDigests?: readonly string[];
  /**
   * Current and historical deterministic-contract revisions used only to
   * locate schema-v1 digests that still embedded validator identity.
   */
  legacyDeterministicContractRevisions?: readonly string[];
  directory?: string;
  rootDir: string;
}

interface CandidateCacheRecord {
  key: TranslationCandidateCacheKey;
  keyDigest: string;
  schemaVersion: 1;
  translation: string;
  translationDigest: string;
  writtenAt: string;
}

interface CandidateCacheRejectionRecord {
  keyDigest: string;
  schemaVersion: 1;
  translationDigest: string;
  writtenAt: string;
}

interface AttestedCandidateCacheRecord {
  candidate: TranslationAttestedCandidate;
  candidateDigest: string;
  key: TranslationCandidateCacheKey;
  keyDigest: string;
  schemaVersion: 2;
  writtenAt: string;
}

function isAttestedCandidate(
  value: unknown
): value is TranslationAttestedCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TranslationAttestedCandidate>;
  return (
    typeof candidate.translation === "string" &&
    typeof candidate.selfCheck === "object" &&
    // Compared against `true` rather than tested for truthiness because this
    // value came from a cache file on disk. The declared type says `boolean`,
    // but nothing has checked that yet, and this guard is what does it.
    // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare
    candidate.selfCheck?.verified === true &&
    typeof candidate.selfCheck.modelId === "string" &&
    candidate.selfCheck.modelId.length > 0 &&
    Array.isArray(candidate.selfCheck.planDigests) &&
    candidate.selfCheck.planDigests.every(
      (digest) => typeof digest === "string"
    )
  );
}

function asGenerationKey(key: {
  catalogId: string;
  contentRole?: TranslationCandidateCacheKey["contentRole"];
  contentRoleRevision: string;
  generationRevision: string;
  glossaryDigest: string;
  instructionDigest: string;
  jsonPointer: string;
  locale: string;
  modelId: string;
  path: string;
  providerId: string;
  providerRevision: string;
  requestContextDigest: string;
  sourceDigest: string;
  sourceText: string;
  unitId: string;
}): TranslationCandidateCacheKey {
  const material = {
    catalogId: key.catalogId,
    ...(key.contentRole === undefined ? {} : { contentRole: key.contentRole }),
    contentRoleRevision: key.contentRoleRevision,
    generationRevision: key.generationRevision,
    glossaryDigest: key.glossaryDigest,
    instructionDigest: key.instructionDigest,
    jsonPointer: key.jsonPointer,
    locale: key.locale,
    modelId: key.modelId,
    path: key.path,
    providerId: key.providerId,
    providerRevision: key.providerRevision,
    requestContextDigest: key.requestContextDigest,
    schemaVersion: 2 as const,
    sourceDigest: key.sourceDigest,
    sourceText: key.sourceText,
    unitId: key.unitId,
  };
  return {
    ...material,
    digest: digestTranslationCandidateCacheKey(material),
  };
}

function isStoredCacheKey(
  value: unknown
): value is {
  catalogId: string;
  contentRole?: TranslationCandidateCacheKey["contentRole"];
  contentRoleRevision: string;
  digest: string;
  generationRevision: string;
  glossaryDigest: string;
  instructionDigest: string;
  jsonPointer: string;
  locale: string;
  modelId: string;
  path: string;
  providerId: string;
  providerRevision: string;
  requestContextDigest: string;
  sourceDigest: string;
  sourceText: string;
  unitId: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const key = value as Record<string, unknown>;
  return (
    typeof key.catalogId === "string" &&
    typeof key.contentRoleRevision === "string" &&
    typeof key.digest === "string" &&
    typeof key.generationRevision === "string" &&
    typeof key.glossaryDigest === "string" &&
    typeof key.instructionDigest === "string" &&
    typeof key.jsonPointer === "string" &&
    typeof key.locale === "string" &&
    typeof key.modelId === "string" &&
    typeof key.path === "string" &&
    typeof key.providerId === "string" &&
    typeof key.providerRevision === "string" &&
    typeof key.requestContextDigest === "string" &&
    typeof key.sourceDigest === "string" &&
    typeof key.sourceText === "string" &&
    typeof key.unitId === "string"
  );
}

function storedKeyMatchesLookup(
  stored: unknown,
  lookup: TranslationCandidateCacheKey
): boolean {
  if (!isStoredCacheKey(stored)) {
    return false;
  }
  // Exact current identity, or generation-material match across schema
  // migrations (legacy records may still carry validator fields on disk).
  return (
    JSON.stringify(stored) === JSON.stringify(lookup) ||
    generationCacheKeyMaterialMatches(
      asGenerationKey(stored),
      asGenerationKey(lookup)
    )
  );
}

function attestedRecordMatchesKey(
  value: unknown,
  key: TranslationCandidateCacheKey
): value is AttestedCandidateCacheRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<AttestedCandidateCacheRecord>;
  return (
    record.schemaVersion === 2 &&
    record.keyDigest === key.digest &&
    isAttestedCandidate(record.candidate) &&
    record.candidateDigest === digestValue(JSON.stringify(record.candidate)) &&
    typeof record.writtenAt === "string" &&
    storedKeyMatchesLookup(record.key, key)
  );
}

function recordMatchesKey(
  value: unknown,
  key: TranslationCandidateCacheKey
): value is CandidateCacheRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<CandidateCacheRecord>;
  return (
    record.schemaVersion === 1 &&
    record.keyDigest === key.digest &&
    typeof record.translation === "string" &&
    record.translationDigest === digestValue(record.translation) &&
    typeof record.writtenAt === "string" &&
    storedKeyMatchesLookup(record.key, key)
  );
}

export function createFileTranslationCandidateCache({
  compatibleDeterministicContractRevisions = [],
  compatibleGenerationRevisions = [],
  compatibleProviderRevisions = [],
  compatibleRevisionPairs = [],
  legacyDeterministicContractRevisions = [],
  legacyGlossaryDigests = [],
  directory = ".ai-translate/candidate-cache",
  rootDir,
}: FileTranslationCandidateCacheOptions): TranslationCandidateCache {
  const cacheRoot = path.resolve(rootDir, directory, "v1");
  const attestedCacheRoot = path.resolve(rootDir, directory, "v2");
  const candidatePath = (key: TranslationCandidateCacheKey) =>
    path.join(cacheRoot, key.digest.slice(0, 2), `${key.digest}.json`);
  const promotionPath = (key: TranslationCandidateCacheKey) =>
    path.join(cacheRoot, key.digest.slice(0, 2), `${key.digest}.accepted.json`);
  const rejectionPath = (
    key: TranslationCandidateCacheKey,
    translation: string
  ) =>
    path.join(
      cacheRoot,
      key.digest.slice(0, 2),
      `${key.digest}.rejected.${digestValue(translation)}.json`
    );
  const attestedCandidatePath = (key: TranslationCandidateCacheKey) =>
    path.join(attestedCacheRoot, key.digest.slice(0, 2), `${key.digest}.json`);
  const attestedPromotionPath = (key: TranslationCandidateCacheKey) =>
    path.join(
      attestedCacheRoot,
      key.digest.slice(0, 2),
      `${key.digest}.accepted.json`
    );
  const publishedPaths = new Set<string>();
  let cachePathIndexPromise: Promise<Set<string>> | undefined;

  const indexCacheRoot = async (
    root: string,
    indexedPaths: Set<string>
  ): Promise<void> => {
    let shards: Dirent[];
    try {
      shards = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    const directories = shards.filter((entry) => entry.isDirectory());
    for (let index = 0; index < directories.length; index += 32) {
      await Promise.all(
        directories.slice(index, index + 32).map(async (shard) => {
          const directoryPath = path.join(root, shard.name);
          let files: Dirent[];
          try {
            files = await fs.readdir(directoryPath, { withFileTypes: true });
          } catch {
            return;
          }
          for (const file of files) {
            if (file.isFile() && file.name.endsWith(".json")) {
              indexedPaths.add(path.join(directoryPath, file.name));
            }
          }
        })
      );
    }
  };

  const cachePathIndex = (): Promise<Set<string>> => {
    cachePathIndexPromise ??= (async () => {
      const indexedPaths = new Set<string>();
      await Promise.all([
        indexCacheRoot(cacheRoot, indexedPaths),
        indexCacheRoot(attestedCacheRoot, indexedPaths),
      ]);
      return indexedPaths;
    })();
    return cachePathIndexPromise;
  };

  const recordMayExist = async (recordPath: string): Promise<boolean> =>
    publishedPaths.has(recordPath) || (await cachePathIndex()).has(recordPath);

  const forgetRecordPath = async (recordPath: string): Promise<void> => {
    publishedPaths.delete(recordPath);
    if (cachePathIndexPromise !== undefined) {
      (await cachePathIndexPromise).delete(recordPath);
    }
  };

  const readRecord = async (
    key: TranslationCandidateCacheKey,
    recordPath: string,
    useIndex = false
  ): Promise<string | undefined> => {
    if (useIndex && !(await recordMayExist(recordPath))) {
      return undefined;
    }
    let raw: string;
    try {
      raw = await fs.readFile(recordPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (recordMatchesKey(parsed, key)) {
        return parsed.translation;
      }
      await fs.rm(recordPath, { force: true });
      await forgetRecordPath(recordPath);
    } catch {
      try {
        await fs.rm(recordPath, { force: true });
        await forgetRecordPath(recordPath);
      } catch {
        // Best-effort removal permits a future immutable publication when the
        // cache is writable. A corrupt cache record must never fail the sync.
      }
    }
    return undefined;
  };

  const isRejected = async (
    key: TranslationCandidateCacheKey,
    translation: string
  ): Promise<boolean> => {
    const markerPath = rejectionPath(key, translation);
    let raw: string;
    try {
      raw = await fs.readFile(markerPath, "utf8");
    } catch {
      return false;
    }
    try {
      const record = JSON.parse(raw) as Partial<CandidateCacheRejectionRecord>;
      if (
        record.schemaVersion === 1 &&
        record.keyDigest === key.digest &&
        record.translationDigest === digestValue(translation) &&
        typeof record.writtenAt === "string"
      ) {
        return true;
      }
      await fs.rm(markerPath, { force: true });
      await forgetRecordPath(markerPath);
    } catch {
      try {
        await fs.rm(markerPath, { force: true });
        await forgetRecordPath(markerPath);
      } catch {
        // A corrupt rejection marker is a cache miss, never a sync failure.
      }
    }
    return false;
  };

  const readExact = async (
    key: TranslationCandidateCacheKey,
    useIndex = false
  ): Promise<string | undefined> => {
    if (!isReadableTranslationCandidateCacheKey(key)) {
      return undefined;
    }
    const promoted = await readRecord(key, promotionPath(key), useIndex);
    if (promoted !== undefined && !(await isRejected(key, promoted))) {
      return promoted;
    }
    const candidate = await readRecord(key, candidatePath(key), useIndex);
    return candidate !== undefined && !(await isRejected(key, candidate))
      ? candidate
      : undefined;
  };

  // Candidate caches are disposable optimizations, not translation
  // provenance. Close each complete, digested record before atomic
  // publication, but do not fsync every file: a power loss can only turn a
  // cache entry into a validated miss and must not serialize large releases.
  const writeRecord = async (
    key: TranslationCandidateCacheKey,
    translation: string,
    recordPath: string,
    replace: boolean
  ): Promise<void> => {
    const directoryPath = path.dirname(recordPath);
    await fs.mkdir(directoryPath, { recursive: true });
    const temporaryPath = path.join(
      directoryPath,
      `.${key.digest}.${randomUUID()}.tmp`
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      const record: CandidateCacheRecord = {
        key,
        keyDigest: key.digest,
        schemaVersion: 1,
        translation,
        translationDigest: digestValue(translation),
        writtenAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.close();
      handle = undefined;
      if (replace) {
        await fs.rename(temporaryPath, recordPath);
        publishedPaths.add(recordPath);
      } else {
        try {
          await fs.link(temporaryPath, recordPath);
          publishedPaths.add(recordPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
          publishedPaths.add(recordPath);
        }
      }
    } finally {
      await handle?.close();
      await fs.rm(temporaryPath, { force: true });
    }
  };

  const readAttestedRecord = async (
    key: TranslationCandidateCacheKey,
    recordPath: string,
    useIndex = false
  ): Promise<TranslationAttestedCandidate | undefined> => {
    if (useIndex && !(await recordMayExist(recordPath))) {
      return undefined;
    }
    let raw: string;
    try {
      raw = await fs.readFile(recordPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (attestedRecordMatchesKey(parsed, key)) {
        return parsed.candidate;
      }
      await fs.rm(recordPath, { force: true });
      await forgetRecordPath(recordPath);
    } catch {
      try {
        await fs.rm(recordPath, { force: true });
        await forgetRecordPath(recordPath);
      } catch {
        // A corrupt optimization record is always treated as a cache miss.
      }
    }
    return undefined;
  };

  const readAttestedExact = async (
    key: TranslationCandidateCacheKey,
    useIndex = false
  ): Promise<TranslationAttestedCandidate | undefined> => {
    if (!isReadableTranslationCandidateCacheKey(key)) {
      return undefined;
    }
    const promoted = await readAttestedRecord(
      key,
      attestedPromotionPath(key),
      useIndex
    );
    if (
      promoted !== undefined &&
      !(await isRejected(key, promoted.translation))
    ) {
      return promoted;
    }
    const candidate = await readAttestedRecord(
      key,
      attestedCandidatePath(key),
      useIndex
    );
    return candidate !== undefined &&
      !(await isRejected(key, candidate.translation))
      ? candidate
      : undefined;
  };

  const writeAttestedRecord = async (
    key: TranslationCandidateCacheKey,
    candidate: TranslationAttestedCandidate,
    recordPath: string,
    replace: boolean
  ): Promise<void> => {
    const directoryPath = path.dirname(recordPath);
    await fs.mkdir(directoryPath, { recursive: true });
    const temporaryPath = path.join(
      directoryPath,
      `.${key.digest}.${randomUUID()}.tmp`
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      const record: AttestedCandidateCacheRecord = {
        candidate,
        candidateDigest: digestValue(JSON.stringify(candidate)),
        key,
        keyDigest: key.digest,
        schemaVersion: 2,
        writtenAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.close();
      handle = undefined;
      if (replace) {
        await fs.rename(temporaryPath, recordPath);
        publishedPaths.add(recordPath);
      } else {
        try {
          await fs.link(temporaryPath, recordPath);
          publishedPaths.add(recordPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
          publishedPaths.add(recordPath);
        }
      }
    } finally {
      await handle?.close();
      await fs.rm(temporaryPath, { force: true });
    }
  };

  const dedupe = (values: readonly string[]): string[] => [
    ...new Set(values.filter((value) => value.length > 0)),
  ];

  const compatibleKeys = (
    key: TranslationCandidateCacheKey
  ): TranslationCandidateCacheKey[] => {
    const generationRevisions = dedupe([
      key.generationRevision,
      ...compatibleGenerationRevisions,
      ...compatibleRevisionPairs.map((pair) => pair.generationRevision),
    ]);
    const providerRevisions = dedupe([
      key.providerRevision,
      ...compatibleProviderRevisions,
    ]);
    const glossaryDigests = dedupe([key.glossaryDigest, ...legacyGlossaryDigests]);
    const { digest: _digest, ...currentMaterial } = key;
    const probes: TranslationCandidateCacheKey[] = [];
    const seenDigests = new Set<string>([key.digest]);
    const pushProbe = (probe: TranslationCandidateCacheKey): void => {
      if (!seenDigests.has(probe.digest)) {
        seenDigests.add(probe.digest);
        probes.push(probe);
      }
    };

    for (const glossaryDigest of glossaryDigests) {
      for (const generationRevision of generationRevisions) {
        for (const providerRevision of providerRevisions) {
          if (
            glossaryDigest === key.glossaryDigest &&
            generationRevision === key.generationRevision &&
            providerRevision === key.providerRevision
          ) {
            continue;
          }
          const material = {
            ...currentMaterial,
            generationRevision,
            glossaryDigest,
            providerRevision,
          };
          pushProbe({
            ...material,
            digest: digestTranslationCandidateCacheKey(material),
          });
        }
      }
    }

    // Locate pre-redesign digests that still hashed validator revisions.
    // Deterministic and generation revisions are only probed as the exact
    // historical pairs (or standalone legacy contracts against the current
    // cohorts); crossing every contract with every generation revision would
    // grow the probe space quadratically for no on-disk record that could
    // ever have been written that way.
    const legacyProbePairs: {
      deterministicContractRevision: string;
      generationRevision: string;
    }[] = [
      ...compatibleRevisionPairs,
      ...dedupe([
        ...legacyDeterministicContractRevisions,
        ...compatibleDeterministicContractRevisions,
      ]).flatMap((deterministicContractRevision) =>
        dedupe([
          key.generationRevision,
          ...compatibleGenerationRevisions,
        ]).map((generationRevision) => ({
          deterministicContractRevision,
          generationRevision,
        }))
      ),
    ];
    for (const pair of legacyProbePairs) {
      if (
        pair.deterministicContractRevision.length === 0 ||
        pair.generationRevision.length === 0
      ) {
        continue;
      }
      for (const glossaryDigest of glossaryDigests) {
        for (const providerRevision of providerRevisions) {
          const base = {
            ...currentMaterial,
            generationRevision: pair.generationRevision,
            glossaryDigest,
            providerRevision,
            digest: digestTranslationCandidateCacheKey({
              ...currentMaterial,
              generationRevision: pair.generationRevision,
              glossaryDigest,
              providerRevision,
            }),
          };
          pushProbe(
            createLegacyTranslationCandidateCacheProbeKey({
              deterministicContractRevision:
                pair.deterministicContractRevision,
              key: base,
            })
          );
        }
      }
    }

    return probes;
  };

  const read = async (
    key: TranslationCandidateCacheKey
  ): Promise<string | undefined> => {
    const exact = await readExact(key);
    if (exact !== undefined || !isReadableTranslationCandidateCacheKey(key)) {
      return exact;
    }
    for (const compatibleKey of compatibleKeys(key)) {
      const compatible = await readExact(compatibleKey, true);
      if (compatible === undefined || (await isRejected(key, compatible))) {
        continue;
      }
      return compatible;
    }
    return undefined;
  };

  const readAttested = async (
    key: TranslationCandidateCacheKey
  ): Promise<TranslationAttestedCandidate | undefined> => {
    const exact = await readAttestedExact(key);
    if (exact !== undefined || !isReadableTranslationCandidateCacheKey(key)) {
      return exact;
    }
    for (const compatibleKey of compatibleKeys(key)) {
      const compatible = await readAttestedExact(compatibleKey, true);
      if (
        compatible === undefined ||
        (await isRejected(key, compatible.translation))
      ) {
        continue;
      }
      return compatible;
    }
    return undefined;
  };

  return {
    get: read,
    getAttested: readAttested,
    async promote(key, translation) {
      try {
        if (!isValidTranslationCandidateCacheKey(key)) {
          return;
        }
        await writeRecord(key, translation, promotionPath(key), true);
      } catch {
        // Best-effort semantic promotion cannot fail the surrounding audit.
      }
    },
    async promoteAttested(key, candidate) {
      try {
        if (
          !isValidTranslationCandidateCacheKey(key) ||
          !isAttestedCandidate(candidate)
        ) {
          return;
        }
        await writeAttestedRecord(
          key,
          candidate,
          attestedPromotionPath(key),
          true
        );
      } catch {
        // Best-effort promotion cannot fail the surrounding transaction.
      }
    },
    async put(key, translation) {
      try {
        if (
          !isValidTranslationCandidateCacheKey(key) ||
          (await readExact(key)) !== undefined
        ) {
          return;
        }
        await writeRecord(key, translation, candidatePath(key), false);
      } catch {
        // Best-effort cache persistence can only reduce provider calls. It is
        // deliberately unable to fail or commit the surrounding transaction.
      }
    },
    async putAttested(key, candidate) {
      try {
        if (
          !isValidTranslationCandidateCacheKey(key) ||
          !isAttestedCandidate(candidate) ||
          (await readAttestedExact(key)) !== undefined
        ) {
          return;
        }
        await writeAttestedRecord(
          key,
          candidate,
          attestedCandidatePath(key),
          false
        );
      } catch {
        // Best-effort persistence can only reduce future provider calls.
      }
    },
    async reject(key, translation) {
      try {
        if (!isValidTranslationCandidateCacheKey(key)) {
          return;
        }
        const markerPath = rejectionPath(key, translation);
        const directoryPath = path.dirname(markerPath);
        await fs.mkdir(directoryPath, { recursive: true });
        const temporaryPath = path.join(
          directoryPath,
          `.${key.digest}.${randomUUID()}.tmp`
        );
        let handle: fs.FileHandle | undefined;
        try {
          const record: CandidateCacheRejectionRecord = {
            keyDigest: key.digest,
            schemaVersion: 1,
            translationDigest: digestValue(translation),
            writtenAt: new Date().toISOString(),
          };
          handle = await fs.open(temporaryPath, "wx", 0o600);
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.close();
          handle = undefined;
          try {
            await fs.link(temporaryPath, markerPath);
            publishedPaths.add(markerPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
              throw error;
            }
            publishedPaths.add(markerPath);
          }
        } finally {
          await handle?.close();
          await fs.rm(temporaryPath, { force: true });
        }
      } catch {
        // Best-effort semantic quarantine cannot fail the surrounding audit.
      }
    },
  };
}
