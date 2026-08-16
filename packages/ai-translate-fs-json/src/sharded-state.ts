import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";

import { makeLegacyStateKey, makeStateKey } from "@ai-translate/core/address";
import { hasCompleteAcceptedSemanticAuditProvenance } from "@ai-translate/core/acceptance";
import { SCOPED_SAVE_STATE_STORE } from "@ai-translate/core/types";
import type {
  SemanticAuditConsensusEvaluation,
  SemanticAuditEvaluation,
  SemanticAuditProvenance,
  SyncStateEntry,
  SyncStateLoadScope,
  SyncStateOrigin,
  SyncStateSnapshot,
  SyncStateStatus,
  SyncStateStore,
} from "@ai-translate/core/types";

import {
  createDurableTransactionCoordinator,
  DURABLE_TRANSACTION_STATE_STORE,
  type DurableTransactionFaultPoint,
  type DurableTransactionStateStore,
} from "./durable-transaction";
import { fileExists, readJsonFile } from "./shared";

interface ShardedJsonStateStoreOptions {
  legacyStateFileName?: string;
  lockFileName?: string;
  retryDelayMs?: number;
  rootDir: string;
  shardsDir?: string;
  staleLockMs?: number;
  stateDir?: string;
  timeoutMs?: number;
  transactionFaultInjector?: (
    point: DurableTransactionFaultPoint,
  ) => Promise<"simulate-crash" | void> | "simulate-crash" | void;
}

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const CURRENT_STATE_VERSION = 2;
const SHARD_VERSION_V1 = 1;
const SHARD_VERSION = 2;
const LEGACY_BUCKET_ID = "__legacy__";
const SHARD_FILE_EXTENSION = ".json";
const ENCODED_PATH_PREFIX = "%";
const SAFE_PATH_SEGMENT_PATTERN = /^[a-z0-9._-]+$/u;
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const STATE_ORIGIN_VALUES = ["generated", "legacy-unknown", "manual"] as const;
const STATE_STATUS_VALUES = ["synced", "failed", "pending", "stale-manual"] as const;
const ORIGIN_MASK = 0b11;
const STATUS_SHIFT = 2;
const REQUIRES_ACCEPTANCE_AUDIT_FLAG = 0b1_0000;
const KNOWN_RECORD_FLAGS = 0b1_1111;

const AUDIT_CONFIDENCES = new Set(["high", "low", "medium"]);
const AUDIT_STATUSES = new Set(["accepted", "retranslate", "unresolved"]);
const AUDIT_VERDICTS = new Set([
  "ambiguous",
  "broadened",
  "contradicted",
  "narrowed",
  "omitted",
  "preserved",
]);
const STATE_ORIGINS = new Set<SyncStateOrigin>(["generated", "legacy-unknown", "manual"]);
const STATE_STATUSES = new Set<SyncStateStatus>(["failed", "pending", "stale-manual", "synced"]);

interface ShardLocaleRecord {
  acceptedContractRevision?: string;
  generationRevision?: string;
  origin: SyncStateOrigin;
  requiresAcceptanceAudit?: true;
  sourceDigest: string;
  status: SyncStateStatus;
  targetDigest: string;
  translationContextDigest?: string;
  updatedAt: string;
  validationAudits?: Readonly<Record<string, SemanticAuditProvenance>>;
}

interface ShardFileV1 {
  catalogId: string | null;
  entries: Record<string, Record<string, ShardLocaleRecord>>;
  unitId: string;
  version: typeof SHARD_VERSION_V1;
}

type PackedTimestamp = number | string;
type PackedContextOverride = false | string | null;
type PackedLocaleRecord =
  | readonly [
      locale: string,
      targetDigest: string,
      updatedAt: PackedTimestamp,
      acceptedContractRevision: string | null,
      generationRevision: string | null,
      flags: number,
    ]
  | readonly [
      locale: string,
      targetDigest: string,
      updatedAt: PackedTimestamp,
      acceptedContractRevision: string | null,
      generationRevision: string | null,
      flags: number,
      sourceDigestOverride: string | null,
      translationContextDigestOverride: PackedContextOverride,
      validationAudits: Readonly<Record<string, SemanticAuditProvenance>> | null,
    ];
type PackedPointerRecord = readonly [
  jsonPointer: string,
  sourceDigest: string,
  translationContextDigest: string | null,
  locales: readonly PackedLocaleRecord[],
];

interface ShardFileV2 {
  c: string | null;
  e: readonly PackedPointerRecord[];
  u: string;
  v: typeof SHARD_VERSION;
}

type ShardFile = ShardFileV1 | ShardFileV2;

interface ObservedLockRecord {
  acquiredAt: string;
  pid: number;
  token?: string;
}

function forceEncodePathSegment(segment: string): string {
  return `${ENCODED_PATH_PREFIX}${Buffer.from(segment, "utf8").toString("hex")}`;
}

function encodePathSegment(segment: string): string {
  if (
    segment !== "." &&
    segment !== ".." &&
    SAFE_PATH_SEGMENT_PATTERN.test(segment) &&
    !segment.startsWith(ENCODED_PATH_PREFIX)
  ) {
    return segment;
  }

  return forceEncodePathSegment(segment);
}

function bucketIdFor(catalogId: string | undefined): string {
  return catalogId ?? LEGACY_BUCKET_ID;
}

function shardRelativePath(catalogId: string | undefined, unitId: string): string {
  const catalogPathSegment =
    catalogId === LEGACY_BUCKET_ID
      ? forceEncodePathSegment(catalogId)
      : encodePathSegment(bucketIdFor(catalogId));
  return path.join(catalogPathSegment, `${encodePathSegment(unitId)}${SHARD_FILE_EXTENSION}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeCompactString(value: string): string {
  if (HEX_DIGEST_PATTERN.test(value)) {
    return `h${Buffer.from(value, "hex").toString("base64url")}`;
  }
  if (value.startsWith("sha256:") && HEX_DIGEST_PATTERN.test(value.slice(7))) {
    return `s${Buffer.from(value.slice(7), "hex").toString("base64url")}`;
  }
  return `r${value}`;
}

function decodeCompactString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const tag = value[0];
  const payload = value.slice(1);
  if (tag === "r") {
    return payload;
  }
  if ((tag === "h" || tag === "s") && BASE64URL_DIGEST_PATTERN.test(payload)) {
    const digest = Buffer.from(payload, "base64url").toString("hex");
    return tag === "s" ? `sha256:${digest}` : digest;
  }
  return null;
}

function packTimestamp(value: string): PackedTimestamp {
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : value;
}

function unpackTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  try {
    return new Date(value as number).toISOString();
  } catch {
    return null;
  }
}

/**
 * Per-load scratch space.
 *
 * Decoding is memoised only for fields whose cardinality is known to sit far
 * below the record count. On a real 246k-record corpus there are 18 distinct
 * generation revisions, 170 context digests and 12k source digests, but 173k
 * distinct target digests and 198k distinct accepted contract revisions.
 * Pooling those unique-per-record fields would pay map overhead for no dedup,
 * so they deliberately keep using the uncached decoder.
 */
interface ShardLoadContext {
  readonly compactStrings: Map<string, string>;
  /** `undefined` means "no narrowing"; an empty scope must not hide entries. */
  readonly locales: ReadonlySet<string> | undefined;
  readonly timestamps: Map<number, string>;
}

function createShardLoadContext(scope: SyncStateLoadScope | undefined): ShardLoadContext {
  const locales = scope?.locales;
  return {
    compactStrings: new Map(),
    locales: locales === undefined || locales.length === 0 ? undefined : new Set(locales),
    timestamps: new Map(),
  };
}

function includesLocale(context: ShardLoadContext, locale: string): boolean {
  return context.locales === undefined || context.locales.has(locale);
}

function decodePooledCompactString(context: ShardLoadContext, value: unknown): string | null {
  if (typeof value !== "string") {
    return decodeCompactString(value);
  }
  const pooled = context.compactStrings.get(value);
  if (pooled !== undefined) {
    return pooled;
  }
  const decoded = decodeCompactString(value);
  if (decoded !== null) {
    context.compactStrings.set(value, decoded);
  }
  return decoded;
}

/**
 * Also avoids re-running `new Date(...).toISOString()` per record: the real
 * corpus repeats 246k timestamps across 89k distinct values.
 */
function unpackPooledTimestamp(context: ShardLoadContext, value: unknown): string | null {
  if (typeof value !== "number") {
    return unpackTimestamp(value);
  }
  const pooled = context.timestamps.get(value);
  if (pooled !== undefined) {
    return pooled;
  }
  const unpacked = unpackTimestamp(value);
  if (unpacked !== null) {
    context.timestamps.set(value, unpacked);
  }
  return unpacked;
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => [key, canonicalizeJsonValue(item)]),
  );
}

function mostCommonRecordValue<T extends string | undefined>(
  records: readonly (readonly [string, ShardLocaleRecord])[],
  select: (record: ShardLocaleRecord) => T,
): T {
  const first = records[0];
  if (first === undefined) {
    throw new Error("Cannot pack an empty ai-translate state pointer bucket.");
  }
  const counts = new Map<T, number>();
  for (const [, record] of records) {
    const value = select(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let selected = select(first[1]);
  let selectedCount = counts.get(selected) ?? 0;
  for (const [, record] of records) {
    const value = select(record);
    const count = counts.get(value) ?? 0;
    if (count > selectedCount) {
      selected = value;
      selectedCount = count;
    }
  }
  return selected;
}

function packRecordFlags(record: ShardLocaleRecord): number {
  const origin = STATE_ORIGIN_VALUES.indexOf(record.origin);
  const status = STATE_STATUS_VALUES.indexOf(record.status);
  return (
    origin |
    (status << STATUS_SHIFT) |
    (record.requiresAcceptanceAudit === true ? REQUIRES_ACCEPTANCE_AUDIT_FLAG : 0)
  );
}

function isSemanticAuditEvaluation(value: unknown): value is SemanticAuditEvaluation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.requirementId) ||
    typeof candidate.verdict !== "string" ||
    !AUDIT_VERDICTS.has(candidate.verdict)
  ) {
    return false;
  }
  if (
    candidate.confidence !== undefined &&
    (typeof candidate.confidence !== "string" || !AUDIT_CONFIDENCES.has(candidate.confidence))
  ) {
    return false;
  }
  if (candidate.reason !== undefined && !isNonEmptyString(candidate.reason)) {
    return false;
  }
  if (candidate.evidence === undefined) {
    return true;
  }
  if (!Array.isArray(candidate.evidence)) {
    return false;
  }

  return candidate.evidence.every((span) => {
    if (typeof span !== "object" || span === null || Array.isArray(span)) {
      return false;
    }
    const evidence = span as Record<string, unknown>;
    return (
      (evidence.field === "source" || evidence.field === "target") &&
      Number.isInteger(evidence.start) &&
      Number.isInteger(evidence.end) &&
      (evidence.start as number) >= 0 &&
      (evidence.end as number) > (evidence.start as number) &&
      isNonEmptyString(evidence.quote)
    );
  });
}

function isSemanticAuditConsensusEvaluation(
  value: unknown,
): value is SemanticAuditConsensusEvaluation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.requirementId) &&
    typeof candidate.status === "string" &&
    AUDIT_STATUSES.has(candidate.status) &&
    (candidate.adversarial === undefined || isSemanticAuditEvaluation(candidate.adversarial)) &&
    (candidate.forward === undefined || isSemanticAuditEvaluation(candidate.forward))
  );
}

function isProviderBackedAuditProvenance(
  candidate: Record<string, unknown>,
  consensus: readonly SemanticAuditConsensusEvaluation[],
): boolean {
  return (
    isNonEmptyString(candidate.adversarialModelId) &&
    isNonEmptyString(candidate.adversarialResponseDigest) &&
    isNonEmptyString(candidate.forwardModelId) &&
    isNonEmptyString(candidate.forwardResponseDigest) &&
    consensus.length > 0
  );
}

function hasProviderEvidence(
  evaluation: SemanticAuditEvaluation | undefined,
): evaluation is SemanticAuditEvaluation {
  return (
    evaluation !== undefined &&
    isNonEmptyString(evaluation.reason) &&
    evaluation.evidence !== undefined &&
    evaluation.evidence.length > 0
  );
}

function isMaterialFailureConsensus(evaluation: SemanticAuditConsensusEvaluation): boolean {
  return (
    evaluation.status === "retranslate" &&
    [evaluation.adversarial, evaluation.forward].some(
      (item) =>
        hasProviderEvidence(item) &&
        ["broadened", "contradicted", "narrowed", "omitted"].includes(item.verdict),
    )
  );
}

function isUnresolvedConsensus(evaluation: SemanticAuditConsensusEvaluation): boolean {
  return (
    evaluation.status === "unresolved" &&
    hasProviderEvidence(evaluation.adversarial) &&
    hasProviderEvidence(evaluation.forward)
  );
}

function isSemanticAuditProvenance(value: unknown): value is SemanticAuditProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !isNonEmptyString(candidate.auditedAt) ||
    !Number.isFinite(Date.parse(candidate.auditedAt)) ||
    !isNonEmptyString(candidate.auditRevision) ||
    !isNonEmptyString(candidate.inputDigest) ||
    !isNonEmptyString(candidate.providerRevision) ||
    typeof candidate.status !== "string" ||
    !AUDIT_STATUSES.has(candidate.status)
  ) {
    return false;
  }

  const deterministic = candidate.deterministicEvaluations;
  if (
    deterministic !== undefined &&
    (!Array.isArray(deterministic) || !deterministic.every(isSemanticAuditEvaluation))
  ) {
    return false;
  }
  const consensus = candidate.consensusEvaluations;
  if (
    consensus !== undefined &&
    (!Array.isArray(consensus) || !consensus.every(isSemanticAuditConsensusEvaluation))
  ) {
    return false;
  }

  const deterministicEvaluations = (deterministic ?? []) as readonly SemanticAuditEvaluation[];
  const consensusEvaluations = (consensus ?? []) as readonly SemanticAuditConsensusEvaluation[];
  const providerBacked = isProviderBackedAuditProvenance(candidate, consensusEvaluations);
  if (candidate.status === "accepted") {
    return hasCompleteAcceptedSemanticAuditProvenance(
      candidate as unknown as SemanticAuditProvenance,
    );
  }
  if (candidate.status === "retranslate") {
    return (
      (providerBacked && consensusEvaluations.some(isMaterialFailureConsensus)) ||
      deterministicEvaluations.some(({ verdict }) =>
        ["broadened", "contradicted", "narrowed", "omitted"].includes(verdict),
      )
    );
  }

  return providerBacked && consensusEvaluations.some(isUnresolvedConsensus);
}

function isValidationAudits(
  value: unknown,
): value is Readonly<Record<string, SemanticAuditProvenance>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value as Record<string, unknown>).every(
    ([auditId, provenance]) => isNonEmptyString(auditId) && isSemanticAuditProvenance(provenance),
  );
}

function isShardFileV1(value: unknown): value is ShardFileV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === SHARD_VERSION_V1 &&
    typeof candidate.unitId === "string" &&
    (candidate.catalogId === null || typeof candidate.catalogId === "string") &&
    typeof candidate.entries === "object" &&
    candidate.entries !== null &&
    !Array.isArray(candidate.entries)
  );
}

function isShardLocaleRecord(value: unknown): value is ShardLocaleRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.acceptedContractRevision === undefined ||
      typeof candidate.acceptedContractRevision === "string") &&
    (candidate.generationRevision === undefined ||
      typeof candidate.generationRevision === "string") &&
    (candidate.requiresAcceptanceAudit === undefined ||
      candidate.requiresAcceptanceAudit === true) &&
    typeof candidate.sourceDigest === "string" &&
    typeof candidate.targetDigest === "string" &&
    typeof candidate.status === "string" &&
    STATE_STATUSES.has(candidate.status as SyncStateStatus) &&
    typeof candidate.origin === "string" &&
    STATE_ORIGINS.has(candidate.origin as SyncStateOrigin) &&
    typeof candidate.updatedAt === "string" &&
    (candidate.translationContextDigest === undefined ||
      typeof candidate.translationContextDigest === "string") &&
    (candidate.validationAudits === undefined || isValidationAudits(candidate.validationAudits))
  );
}

function buildEntryFromShardRecord(args: {
  catalogId: string | undefined;
  jsonPointer: string;
  locale: string;
  record: ShardLocaleRecord;
  unitId: string;
}): SyncStateEntry {
  const entry: SyncStateEntry = {
    jsonPointer: args.jsonPointer,
    locale: args.locale,
    origin: args.record.origin,
    sourceDigest: args.record.sourceDigest,
    status: args.record.status,
    targetDigest: args.record.targetDigest,
    unitId: args.unitId,
    updatedAt: args.record.updatedAt,
  };

  if (args.record.acceptedContractRevision !== undefined) {
    entry.acceptedContractRevision = args.record.acceptedContractRevision;
  }

  if (args.catalogId !== undefined) {
    entry.catalogId = args.catalogId;
  }

  if (args.record.generationRevision !== undefined) {
    entry.generationRevision = args.record.generationRevision;
  }

  if (args.record.requiresAcceptanceAudit === true) {
    entry.requiresAcceptanceAudit = true;
  }

  if (args.record.translationContextDigest !== undefined) {
    entry.translationContextDigest = args.record.translationContextDigest;
  }

  if (args.record.validationAudits !== undefined) {
    entry.validationAudits = args.record.validationAudits;
  }

  return entry;
}

function buildShardRecordFromEntry(entry: SyncStateEntry): ShardLocaleRecord {
  const record: ShardLocaleRecord = {
    origin: entry.origin,
    sourceDigest: entry.sourceDigest,
    status: entry.status,
    targetDigest: entry.targetDigest,
    updatedAt: entry.updatedAt,
  };

  if (entry.acceptedContractRevision !== undefined) {
    record.acceptedContractRevision = entry.acceptedContractRevision;
  }

  if (entry.generationRevision !== undefined) {
    record.generationRevision = entry.generationRevision;
  }

  if (entry.requiresAcceptanceAudit === true) {
    record.requiresAcceptanceAudit = true;
  }

  if (entry.translationContextDigest !== undefined) {
    record.translationContextDigest = entry.translationContextDigest;
  }

  if (entry.validationAudits !== undefined) {
    record.validationAudits = entry.validationAudits;
  }

  return record;
}

function shardEntryStateKey(args: {
  catalogId: string | undefined;
  jsonPointer: string;
  locale: string;
  unitId: string;
}): string {
  return args.catalogId === undefined
    ? makeLegacyStateKey(args.locale, args.unitId, args.jsonPointer)
    : makeStateKey(args.locale, args.catalogId, args.unitId, args.jsonPointer);
}

interface ShardGroup {
  catalogId: string | undefined;
  entries: Record<string, Record<string, ShardLocaleRecord>>;
  unitId: string;
}

function groupEntriesByShard(snapshot: SyncStateSnapshot): Map<string, ShardGroup> {
  const shards = new Map<string, ShardGroup>();
  for (const entry of Object.values(snapshot.entries)) {
    const shardPath = shardRelativePath(entry.catalogId, entry.unitId);
    let shard = shards.get(shardPath);
    if (!shard) {
      shard = {
        catalogId: entry.catalogId,
        entries: {},
        unitId: entry.unitId,
      };
      shards.set(shardPath, shard);
    } else if (shard.catalogId !== entry.catalogId || shard.unitId !== entry.unitId) {
      throw new Error(
        `Ai-translate shard path collision between ${String(shard.catalogId)}:${shard.unitId} and ${String(entry.catalogId)}:${entry.unitId}.`,
      );
    }

    const record = buildShardRecordFromEntry(entry);
    if (!isShardLocaleRecord(record)) {
      throw new Error(
        `Invalid ai-translate state entry for ${String(entry.catalogId)}:${entry.unitId}:${entry.jsonPointer}:${entry.locale}.`,
      );
    }
    const pointerBucket = (shard.entries[entry.jsonPointer] ??= {});
    if (pointerBucket[entry.locale] !== undefined) {
      throw new Error(
        `Duplicate ai-translate state entry for ${String(entry.catalogId)}:${entry.unitId}:${entry.jsonPointer}:${entry.locale}.`,
      );
    }
    pointerBucket[entry.locale] = record;
  }

  return shards;
}

function packShard(shard: ShardGroup): ShardFileV2 {
  const entries = Object.entries(shard.entries)
    .toSorted(([left], [right]) => compareStrings(left, right))
    .map(([pointer, localeRecords]): PackedPointerRecord => {
      const records = Object.entries(localeRecords).toSorted(([left], [right]) =>
        compareStrings(left, right),
      );
      const sourceDigest = mostCommonRecordValue(records, (record) => record.sourceDigest);
      const contextDigest = mostCommonRecordValue(
        records,
        (record) => record.translationContextDigest,
      );
      const packedRecords = records.map(([locale, record]): PackedLocaleRecord => {
        const base = [
          locale,
          encodeCompactString(record.targetDigest),
          packTimestamp(record.updatedAt),
          record.acceptedContractRevision === undefined
            ? null
            : encodeCompactString(record.acceptedContractRevision),
          record.generationRevision === undefined
            ? null
            : encodeCompactString(record.generationRevision),
          packRecordFlags(record),
        ] as const;
        if (
          record.sourceDigest === sourceDigest &&
          record.translationContextDigest === contextDigest &&
          record.validationAudits === undefined
        ) {
          return base;
        }
        return [
          ...base,
          record.sourceDigest === sourceDigest ? null : encodeCompactString(record.sourceDigest),
          record.translationContextDigest === contextDigest
            ? null
            : record.translationContextDigest === undefined
              ? false
              : encodeCompactString(record.translationContextDigest),
          record.validationAudits === undefined
            ? null
            : (canonicalizeJsonValue(record.validationAudits) as Readonly<
                Record<string, SemanticAuditProvenance>
              >),
        ];
      });
      return [
        pointer,
        encodeCompactString(sourceDigest),
        contextDigest === undefined ? null : encodeCompactString(contextDigest),
        packedRecords,
      ];
    });
  return {
    c: shard.catalogId ?? null,
    e: entries,
    u: shard.unitId,
    v: SHARD_VERSION,
  };
}

function isShardFileV2(value: unknown): value is ShardFileV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === SHARD_VERSION &&
    (candidate.c === null || typeof candidate.c === "string") &&
    typeof candidate.u === "string" &&
    Array.isArray(candidate.e)
  );
}

function unpackRecordFlags(flags: unknown): {
  origin: SyncStateOrigin;
  requiresAcceptanceAudit: boolean;
  status: SyncStateStatus;
} | null {
  if (
    !Number.isSafeInteger(flags) ||
    (flags as number) < 0 ||
    ((flags as number) & ~KNOWN_RECORD_FLAGS) !== 0
  ) {
    return null;
  }
  const numericFlags = flags as number;
  const origin = STATE_ORIGIN_VALUES[numericFlags & ORIGIN_MASK];
  const status = STATE_STATUS_VALUES[(numericFlags >> STATUS_SHIFT) & 0b11];
  return origin === undefined || status === undefined
    ? null
    : {
        origin,
        requiresAcceptanceAudit: (numericFlags & REQUIRES_ACCEPTANCE_AUDIT_FLAG) !== 0,
        status,
      };
}

async function listShardFiles(rootShardsDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string, relative: string): Promise<void> {
    let dirEntries: {
      isDirectory(): boolean;
      isFile(): boolean;
      name: string;
    }[];
    try {
      dirEntries = await fs.readdir(directory, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const dirEntry of dirEntries) {
      const name = dirEntry.name;
      const childRelative = relative ? path.join(relative, name) : name;
      const childAbsolute = path.join(directory, name);
      if (dirEntry.isDirectory()) {
        await walk(childAbsolute, childRelative);
        continue;
      }

      if (dirEntry.isFile() && name.endsWith(SHARD_FILE_EXTENSION)) {
        found.push(childRelative);
      }
    }
  }

  await walk(rootShardsDir, "");
  return found.toSorted();
}

async function readShard(shardPath: string): Promise<ShardFile | null> {
  const value = await readJsonFile(shardPath);
  if (value === null) {
    return null;
  }

  if (!isShardFileV1(value) && !isShardFileV2(value)) {
    throw new Error(`Invalid ai-translate shard file at ${shardPath}.`);
  }

  return value;
}

function loadEntriesFromShardV1(
  shard: ShardFileV1,
  shardPath: string,
  context: ShardLoadContext,
): Record<string, SyncStateEntry> {
  const entries: Record<string, SyncStateEntry> = {};
  const catalogId = shard.catalogId ?? undefined;

  for (const [pointer, localeRecords] of Object.entries(shard.entries)) {
    if (
      typeof localeRecords !== "object" ||
      localeRecords === null ||
      Array.isArray(localeRecords)
    ) {
      throw new Error(`Invalid ai-translate shard entry bucket at ${shardPath}:${pointer}.`);
    }

    for (const [locale, record] of Object.entries(localeRecords)) {
      if (!isShardLocaleRecord(record)) {
        throw new Error(
          `Invalid ai-translate shard locale record at ${shardPath}:${pointer}:${locale}.`,
        );
      }
      if (!includesLocale(context, locale)) {
        continue;
      }

      const entry = buildEntryFromShardRecord({
        catalogId,
        jsonPointer: pointer,
        locale,
        record,
        unitId: shard.unitId,
      });
      const key = shardEntryStateKey({
        catalogId,
        jsonPointer: pointer,
        locale,
        unitId: shard.unitId,
      });
      entries[key] = entry;
    }
  }

  return entries;
}

function invalidPackedRecord(shardPath: string, pointer: unknown, locale: unknown): Error {
  return new Error(
    `Invalid ai-translate shard locale record at ${shardPath}:${String(pointer)}:${String(locale)}.`,
  );
}

function loadEntriesFromShardV2(
  shard: ShardFileV2,
  shardPath: string,
  context: ShardLoadContext,
): Record<string, SyncStateEntry> {
  const entries: Record<string, SyncStateEntry> = {};
  const catalogId = shard.c ?? undefined;
  const pointers = new Set<string>();
  for (const pointerRecord of shard.e as readonly unknown[]) {
    if (!Array.isArray(pointerRecord) || pointerRecord.length !== 4) {
      throw new Error(`Invalid ai-translate shard entry bucket at ${shardPath}.`);
    }
    const [pointer, packedSourceDigest, packedContextDigest, localeRecords] = pointerRecord;
    if (typeof pointer !== "string" || pointers.has(pointer) || !Array.isArray(localeRecords)) {
      throw new Error(
        `Invalid ai-translate shard entry bucket at ${shardPath}:${String(pointer)}.`,
      );
    }
    pointers.add(pointer);
    const sourceDigest = decodePooledCompactString(context, packedSourceDigest);
    const contextDigest =
      packedContextDigest === null
        ? undefined
        : decodePooledCompactString(context, packedContextDigest);
    if (sourceDigest === null || contextDigest === null) {
      throw new Error(`Invalid ai-translate shard entry bucket at ${shardPath}:${pointer}.`);
    }

    const locales = new Set<string>();
    for (const packedRecord of localeRecords as readonly unknown[]) {
      if (
        !Array.isArray(packedRecord) ||
        (packedRecord.length !== 6 && packedRecord.length !== 9)
      ) {
        throw invalidPackedRecord(shardPath, pointer, "unknown");
      }
      const [
        locale,
        packedTargetDigest,
        packedUpdatedAt,
        packedAcceptedRevision,
        packedGenerationRevision,
        packedFlags,
      ] = packedRecord;
      if (typeof locale !== "string" || locales.has(locale)) {
        throw invalidPackedRecord(shardPath, pointer, locale);
      }
      locales.add(locale);
      // Structural checks above still run for every record so a scoped load
      // cannot mask shard corruption. Only the expensive decode and entry
      // allocation below are skipped.
      if (!includesLocale(context, locale)) {
        continue;
      }
      const targetDigest = decodeCompactString(packedTargetDigest);
      const updatedAt = unpackPooledTimestamp(context, packedUpdatedAt);
      const acceptedContractRevision =
        packedAcceptedRevision === null ? undefined : decodeCompactString(packedAcceptedRevision);
      const generationRevision =
        packedGenerationRevision === null
          ? undefined
          : decodePooledCompactString(context, packedGenerationRevision);
      const flags = unpackRecordFlags(packedFlags);
      if (
        targetDigest === null ||
        updatedAt === null ||
        acceptedContractRevision === null ||
        generationRevision === null ||
        flags === null
      ) {
        throw invalidPackedRecord(shardPath, pointer, locale);
      }

      let recordSourceDigest = sourceDigest;
      let recordContextDigest = contextDigest;
      let validationAudits: Readonly<Record<string, SemanticAuditProvenance>> | undefined;
      if (packedRecord.length === 9) {
        const packedSourceOverride = packedRecord[6];
        const packedContextOverride = packedRecord[7];
        const packedValidationAudits = packedRecord[8];
        if (packedSourceOverride !== null) {
          const decoded = decodePooledCompactString(context, packedSourceOverride);
          if (decoded === null) {
            throw invalidPackedRecord(shardPath, pointer, locale);
          }
          recordSourceDigest = decoded;
        }
        if (packedContextOverride === false) {
          recordContextDigest = undefined;
        } else if (packedContextOverride !== null) {
          const decoded = decodePooledCompactString(context, packedContextOverride);
          if (decoded === null) {
            throw invalidPackedRecord(shardPath, pointer, locale);
          }
          recordContextDigest = decoded;
        }
        if (packedValidationAudits !== null) {
          if (!isValidationAudits(packedValidationAudits)) {
            throw invalidPackedRecord(shardPath, pointer, locale);
          }
          validationAudits = packedValidationAudits;
        }
      }

      const record: ShardLocaleRecord = {
        origin: flags.origin,
        sourceDigest: recordSourceDigest,
        status: flags.status,
        targetDigest,
        updatedAt,
        ...(acceptedContractRevision === undefined ? {} : { acceptedContractRevision }),
        ...(generationRevision === undefined ? {} : { generationRevision }),
        ...(flags.requiresAcceptanceAudit ? { requiresAcceptanceAudit: true as const } : {}),
        ...(recordContextDigest === undefined
          ? {}
          : { translationContextDigest: recordContextDigest }),
        ...(validationAudits === undefined ? {} : { validationAudits }),
      };
      if (!isShardLocaleRecord(record)) {
        throw invalidPackedRecord(shardPath, pointer, locale);
      }
      const entry = buildEntryFromShardRecord({
        catalogId,
        jsonPointer: pointer,
        locale,
        record,
        unitId: shard.u,
      });
      entries[shardEntryStateKey({ catalogId, jsonPointer: pointer, locale, unitId: shard.u })] =
        entry;
    }
  }
  return entries;
}

function loadEntriesFromShard(
  shard: ShardFile,
  shardPath: string,
  context: ShardLoadContext,
): Record<string, SyncStateEntry> {
  return isShardFileV1(shard)
    ? loadEntriesFromShardV1(shard, shardPath, context)
    : loadEntriesFromShardV2(shard, shardPath, context);
}

async function migrateLegacyMonolithicState(args: {
  legacyPath: string;
  shardsDir: string;
}): Promise<SyncStateSnapshot | null> {
  if (!(await fileExists(args.legacyPath))) {
    return null;
  }

  const raw = await readJsonFile(args.legacyPath);
  if (raw === null) {
    return null;
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid ai-translate legacy state file at ${args.legacyPath}.`);
  }

  const candidateEntries = (raw as Record<string, unknown>).entries;
  if (
    typeof candidateEntries !== "object" ||
    candidateEntries === null ||
    Array.isArray(candidateEntries)
  ) {
    throw new Error(`Invalid ai-translate legacy state file at ${args.legacyPath}.`);
  }

  const snapshot = raw as unknown as SyncStateSnapshot;
  if (snapshot.version !== 1 && snapshot.version !== CURRENT_STATE_VERSION) {
    throw new Error(`Unsupported ai-translate legacy state version "${String(snapshot.version)}".`);
  }

  await writeShardFiles(args.shardsDir, snapshot);
  await fs.rm(args.legacyPath, { force: true });
  return { entries: snapshot.entries, version: CURRENT_STATE_VERSION };
}

async function waitForStateMutations(
  mutations: readonly Promise<void>[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(mutations);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

/**
 * Rewrites a shard only when its bytes would change.
 *
 * Most runs change a handful of units and leave the rest of the corpus exactly
 * as it was, but a save repacks and rewrites every shard regardless. That costs
 * two fsyncs and a rename per untouched file, and it touches the mtime of files
 * a reviewer can see are unchanged. Comparing against what is already on disk is
 * one read against that, and it is what makes a no-op run genuinely a no-op.
 */
async function writeCompactJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value)}\n`;
  if (await fileContentMatches(filePath, contents)) {
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.tmp-${String(process.pid)}-${randomUUID()}`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(contents, "utf8");
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

async function fileContentMatches(filePath: string, contents: string): Promise<boolean> {
  try {
    return (await fs.readFile(filePath, "utf8")) === contents;
  } catch {
    // Missing, unreadable, or racing with another writer: fall through and write,
    // which is the outcome that cannot lose data.
    return false;
  }
}

function scopeLocaleSet(scope: SyncStateLoadScope | undefined): ReadonlySet<string> | undefined {
  const locales = scope?.locales;
  // An empty locale list is "no narrowing", matching the load path. Treating it
  // as "nothing is in scope" would turn a save into a corpus-wide deletion.
  return locales === undefined || locales.length === 0 ? undefined : new Set(locales);
}

function shardIdentity(shard: ShardFile): { catalogId: string | undefined; unitId: string } {
  return isShardFileV2(shard)
    ? { catalogId: shard.c ?? undefined, unitId: shard.u }
    : { catalogId: shard.catalogId ?? undefined, unitId: shard.unitId };
}

/**
 * Folds a shard's out-of-scope records back in, so a scoped write preserves the
 * locales it was never authoritative for.
 *
 * Shards are keyed by unit, not by locale, so one file holds every locale of a
 * unit. Repacking it from a snapshot that only carries some of them would drop
 * the rest even though the file itself was rewritten rather than deleted.
 *
 * Returns `null` when nothing survives, which is the only case where a scoped
 * save may delete a shard.
 */
async function mergeShardWithinScope(
  absolutePath: string,
  group: ShardGroup | undefined,
  scopedLocales: ReadonlySet<string>,
): Promise<ShardGroup | null> {
  const shard = await readShard(absolutePath);
  if (shard === null) {
    return group ?? null;
  }

  const identity = shardIdentity(shard);
  const merged: ShardGroup = {
    catalogId: group?.catalogId ?? identity.catalogId,
    entries: {},
    unitId: group?.unitId ?? identity.unitId,
  };

  // One shard at a time, and discarded once written: the point of a scoped save
  // is that peak memory tracks the largest unit rather than the whole corpus.
  const existing = loadEntriesFromShard(shard, absolutePath, createShardLoadContext(undefined));
  for (const entry of Object.values(existing)) {
    if (scopedLocales.has(entry.locale)) {
      continue;
    }
    (merged.entries[entry.jsonPointer] ??= {})[entry.locale] = buildShardRecordFromEntry(entry);
  }

  for (const [pointer, byLocale] of Object.entries(group?.entries ?? {})) {
    const bucket = (merged.entries[pointer] ??= {});
    for (const [locale, record] of Object.entries(byLocale)) {
      bucket[locale] = record;
    }
  }

  return Object.keys(merged.entries).length === 0 ? null : merged;
}

function assertSnapshotWithinScope(
  snapshot: SyncStateSnapshot,
  scopedLocales: ReadonlySet<string>,
): void {
  for (const entry of Object.values(snapshot.entries)) {
    if (!scopedLocales.has(entry.locale)) {
      throw new Error(
        `Scoped ai-translate save received an entry for locale "${entry.locale}", which is outside the declared scope. ` +
          `Saving it would be silently dropped for every unit the snapshot does not mention.`,
      );
    }
  }
}

async function writeShardFiles(
  shardsDir: string,
  snapshot: SyncStateSnapshot,
  scope?: SyncStateLoadScope,
): Promise<void> {
  const groups = groupEntriesByShard(snapshot);
  const existingShards = new Set(await listShardFiles(shardsDir));

  await fs.mkdir(shardsDir, { recursive: true });

  const scopedLocales = scopeLocaleSet(scope);
  if (scopedLocales !== undefined) {
    assertSnapshotWithinScope(snapshot, scopedLocales);
    // Every existing shard has to be visited even when the snapshot says
    // nothing about it: the snapshot is authoritative for its locales, so
    // silence means those records are gone, while the others must survive.
    await waitForStateMutations(
      [...new Set([...groups.keys(), ...existingShards])].map(async (shardPath) => {
        const absolute = path.join(shardsDir, shardPath);
        const merged = existingShards.has(shardPath)
          ? await mergeShardWithinScope(absolute, groups.get(shardPath), scopedLocales)
          : (groups.get(shardPath) ?? null);
        await (merged === null
          ? fs.rm(absolute, { force: true })
          : writeCompactJsonFileAtomic(absolute, packShard(merged)));
      }),
      "Failed to write ai-translate state shards.",
    );
    await syncDirectoryTree(shardsDir);
    return;
  }

  // Do not let the durable coordinator begin rollback while a sibling shard
  // mutation is still running. A fail-fast Promise.all can otherwise allow a
  // late next-state rename to land after the rollback restored old state.
  await waitForStateMutations(
    [...groups.entries()].map(async ([shardPath, shard]) => {
      const absolute = path.join(shardsDir, shardPath);
      await writeCompactJsonFileAtomic(absolute, packShard(shard));
      existingShards.delete(shardPath);
    }),
    "Failed to write ai-translate state shards.",
  );

  await waitForStateMutations(
    [...existingShards].map(async (shardPath) => {
      await fs.rm(path.join(shardsDir, shardPath), { force: true });
    }),
    "Failed to remove stale ai-translate state shards.",
  );

  await syncDirectoryTree(shardsDir);
}

async function syncDirectoryTree(root: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await syncDirectoryTree(path.join(root, entry.name));
    }
  }
  const handle = await fs.open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function projectSnapshotLocales(
  snapshot: SyncStateSnapshot,
  scope: SyncStateLoadScope | undefined,
): SyncStateSnapshot {
  const locales = scope?.locales;
  if (locales === undefined || locales.length === 0) {
    return snapshot;
  }
  const included = new Set(locales);
  const entries: Record<string, SyncStateEntry> = {};
  for (const [key, entry] of Object.entries(snapshot.entries)) {
    if (included.has(entry.locale)) {
      entries[key] = entry;
    }
  }
  return { entries, version: snapshot.version };
}

/**
 * Shards read at once while loading state. Loading is the first thing a run
 * does and nothing can start until it finishes, so a shard at a time would put
 * a full read latency between the run and its first translation for every unit
 * in the corpus. Bounded because a large corpus has thousands of shards and
 * opening them all at once would exhaust the process's file descriptors.
 */
const SHARD_READ_CONCURRENCY = 32;

async function loadFromShards(
  shardsDir: string,
  scope?: SyncStateLoadScope,
): Promise<SyncStateSnapshot> {
  const shardFiles = await listShardFiles(shardsDir);
  const entries: Record<string, SyncStateEntry> = {};
  const context = createShardLoadContext(scope);

  // Read in file order so a conflicting-record error names the same shard on
  // every run, however the reads interleave.
  for (let index = 0; index < shardFiles.length; index += SHARD_READ_CONCURRENCY) {
    const batch = await Promise.all(
      shardFiles.slice(index, index + SHARD_READ_CONCURRENCY).map(async (relativePath) => {
        const absolutePath = path.join(shardsDir, relativePath);
        return { absolutePath, shard: await readShard(absolutePath) };
      }),
    );

    for (const { absolutePath, shard } of batch) {
      if (!shard) {
        continue;
      }

      for (const [key, entry] of Object.entries(
        loadEntriesFromShard(shard, absolutePath, context),
      )) {
        const existing = entries[key];
        if (existing === undefined) {
          entries[key] = entry;
          continue;
        }
        if (JSON.stringify(existing) !== JSON.stringify(entry)) {
          throw new Error(
            `Conflicting ai-translate shard records for ${key}; remove or reconcile duplicate legacy and canonical shards.`,
          );
        }
      }
    }
  }

  return { entries, version: CURRENT_STATE_VERSION };
}

function isObservedLockRecord(value: unknown): value is ObservedLockRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Number.isInteger(candidate.pid) &&
    (candidate.pid as number) > 0 &&
    isNonEmptyString(candidate.acquiredAt) &&
    Number.isFinite(Date.parse(candidate.acquiredAt)) &&
    (candidate.token === undefined || isNonEmptyString(candidate.token))
  );
}

async function readLockRecord(lockPath: string): Promise<ObservedLockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value: unknown = JSON.parse(raw);
    return isObservedLockRecord(value) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function isStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const record = await readLockRecord(lockPath);
  if (record !== null) {
    return !isProcessAlive(record.pid);
  }

  return Date.now() - stats.mtimeMs >= staleLockMs;
}

async function tryReclaimStaleLock(
  lockPath: string,
  recoveryPath: string,
  staleLockMs: number,
): Promise<boolean> {
  let recoveryHandle: fs.FileHandle;
  try {
    recoveryHandle = await fs.open(recoveryPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    if (!(await isStaleLock(lockPath, staleLockMs))) {
      return false;
    }
    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await recoveryHandle.close();
    await fs.rm(recoveryPath, { force: true });
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const record = await readLockRecord(lockPath);
  if (record?.token === token) {
    await fs.rm(lockPath, { force: true });
  }
}

export function createShardedJsonStateStore(
  options: ShardedJsonStateStoreOptions,
): SyncStateStore & DurableTransactionStateStore {
  const stateDir = path.join(options.rootDir, options.stateDir ?? ".ai-translate");
  const shardsDir = path.join(stateDir, options.shardsDir ?? "state");
  const lockPath = path.join(stateDir, options.lockFileName ?? "translation-sync.lock");
  const recoveryPath = `${lockPath}.reclaim`;
  const legacyPath = path.join(stateDir, options.legacyStateFileName ?? "translation-state.json");
  const journalPath = path.join(stateDir, "translation-transaction.json");
  const transactionsDir = path.join(stateDir, "transactions");
  const durableTransaction = createDurableTransactionCoordinator({
    ...(options.transactionFaultInjector === undefined
      ? {}
      : { faultInjector: options.transactionFaultInjector }),
    journalPath,
    saveState: (state, scope) => writeShardFiles(shardsDir, state, scope),
    transactionsDir,
  });

  return {
    [DURABLE_TRANSACTION_STATE_STORE]: durableTransaction,
    [SCOPED_SAVE_STATE_STORE]: true,
    async load(scope) {
      const migrated = await migrateLegacyMonolithicState({ legacyPath, shardsDir });
      if (migrated !== null) {
        // Migration is a one-time full rewrite, so it always materialises the
        // whole corpus; narrow afterwards rather than complicate that path.
        return projectSnapshotLocales(migrated, scope);
      }

      return  loadFromShards(shardsDir, scope);
    },
    async save(state, scope) {
      await writeShardFiles(shardsDir, state, scope);
    },
    async withLock(operation) {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
      if (!Number.isFinite(staleLockMs) || staleLockMs <= 0) {
        throw new Error("staleLockMs must be a positive finite number.");
      }
      const startedAt = Date.now();
      let handle: fs.FileHandle | undefined;
      const token = randomUUID();

      while (!handle) {
        let acquiredHandle: fs.FileHandle | undefined;
        try {
          acquiredHandle = await fs.open(lockPath, "wx");
          await acquiredHandle.writeFile(
            JSON.stringify({
              acquiredAt: new Date().toISOString(),
              pid: process.pid,
              token,
            }),
            "utf8",
          );
          handle = acquiredHandle;
        } catch (error) {
          if (acquiredHandle !== undefined) {
            await acquiredHandle.close();
            await fs.rm(lockPath, { force: true });
          }
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }

          if (await tryReclaimStaleLock(lockPath, recoveryPath, staleLockMs)) {
            continue;
          }

          if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`Timed out waiting for ai-translate lock at ${lockPath}.`, {
              cause: error,
            });
          }

          await new Promise((resolve) => { setTimeout(resolve, retryDelayMs); });
        }
      }

      try {
        await durableTransaction.recover();
        return await operation();
      } finally {
        await handle.close();
        await releaseOwnedLock(lockPath, token);
      }
    },
  };
}
