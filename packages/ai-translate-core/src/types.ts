import type { MessageFormat } from "./message-format";

export type Policy = "translate" | "copy" | "exclude";

export type EntryStorage = "string" | "scalar" | "html" | "markdoc";

export type DocumentFormat = "json" | "html" | "markdoc";

export type JsonPrimitive = boolean | number | string | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

export interface KeyAddressSegment {
  kind: "key";
  key: string;
}

export interface IndexAddressSegment {
  kind: "index";
  index: number;
  stableId?: string;
}

export interface NodeAddressSegment {
  kind: "node";
  id: string;
}

export type AddressSegment =
  | IndexAddressSegment
  | KeyAddressSegment
  | NodeAddressSegment;

export interface DocumentRef {
  catalogId: string;
  format: DocumentFormat;
  locale: string;
  path: string;
  unitId: string;
}

export interface TextToken {
  raw: string;
  type: "text";
}

export interface PlaceholderToken {
  name: string;
  raw: string;
  syntax: "double-brace" | "single-brace";
  type: "placeholder";
}

export interface TagToken {
  flavor: "component" | "html" | "slot";
  name: string;
  raw: string;
  tagKind: "close" | "open" | "self";
  type: "tag";
}

export interface MarkdownDestinationToken {
  raw: string;
  type: "markdown-destination";
}

export interface MarkdownOpenerToken {
  raw: "![" | "[";
  type: "markdown-opener";
}

export interface MarkdownFormattingToken {
  flavor: "emphasis" | "strong" | "strong-emphasis";
  raw: "*" | "**" | "***" | "_" | "__" | "___";
  type: "markdown-formatting";
}

export interface MarkdownInlineCodeToken {
  raw: string;
  type: "markdown-inline-code";
}

export type Token =
  | MarkdownDestinationToken
  | MarkdownFormattingToken
  | MarkdownInlineCodeToken
  | MarkdownOpenerToken
  | PlaceholderToken
  | TagToken
  | TextToken;

export interface Entry {
  address: readonly AddressSegment[];
  /** Names the {@link MessageFormat} that interprets `value`. Omitting it means
   * the plain format, so entries written before formats existed keep validating
   * exactly as before. An id rather than the object itself, because entries are
   * serialised into the validation cache key. */
  messageFormatId?: string;
  /**
   * Adapter-defined metadata. Two keys are reserved by the engine:
   *
   * - `structureSignature` distinguishes entries that share a pointer shape but
   *   differ structurally, such as Markdoc block kinds.
   * - `structureGroup` marks entries whose *count* is a property of the locale
   *   rather than of the content. Members of one group compare as a single
   *   unit during structural validation, which is what lets a plural family be
   *   two keys in English and four in Polish without reporting a mismatch.
   */
  meta?: Readonly<Record<string, JsonPrimitive>>;
  policy: Policy;
  storage: EntryStorage;
  tokens?: readonly Token[];
  value: boolean | number | string | null;
}

export interface LoadedDocument<State = unknown> {
  entries: Entry[];
  reconciliation?: DocumentReconciliation;
  ref: DocumentRef;
  state: State;
  structureDigest?: string;
}

export interface ReconcileHistoryEntry extends SyncStateEntry {
  stateKey: string;
}

export interface DocumentReconciliation {
  previousPointers?: Readonly<Record<string, string>>;
  retiredStateKeys?: readonly string[];
}

export interface ReconcileDocumentArgs {
  history?: readonly ReconcileHistoryEntry[];
  ref: DocumentRef;
  source: LoadedDocument;
  target: LoadedDocument | null;
}

export interface MergeStagedStateArgs {
  document: LoadedDocument;
  staged: LoadedDocument;
}

export type CatalogScaffoldStrategy =
  | "copy-locale"
  | "copy-locale-and-retranslate"
  | "copy-source"
  | "empty";

export interface ScaffoldLocaleOptions {
  fromLocale?: string;
  locale: string;
  strategy?: CatalogScaffoldStrategy;
}

export interface ScaffoldLocaleResult {
  catalogId: string;
  createdDocuments: number;
  locale: string;
  skippedDocuments: number;
  strategy: CatalogScaffoldStrategy;
}

export interface CatalogAdapter {
  readonly id: string;
  /** Every format this catalog stamps onto its entries. Core builds the
   * validation registry from these, so a catalog constructed with a format is
   * self-registering and the user never lists it twice. */
  readonly messageFormats?: readonly MessageFormat[];
  createDocumentRef(sourceRef: DocumentRef, locale: string): DocumentRef;
  listDocumentRefs(sourceLocale: string): Promise<readonly DocumentRef[]>;
  loadDocument(ref: DocumentRef): Promise<LoadedDocument | null>;
  /**
   * Reshapes the source document for one target locale before it drives a
   * sync.
   *
   * A source document is loaded once and reused for every locale, which is
   * correct only while the set of translatable units is locale-independent.
   * Suffix-keyed plurals break that: English states two forms and Polish needs
   * four, and the two extra units have to exist on the source side or they
   * will never be translated. Implementations must be pure and must keep every
   * pointer the authored source already had.
   */
  localizeSourceDocument?(args: LocalizeSourceDocumentArgs): Promise<LoadedDocument>;
  /** Combine a reconciled document with the partially written state of a
   * staged file. Only formats that pack several logical documents into one
   * file need this: without it a write would either drop sibling documents
   * written earlier in the same transaction or keep source keys that the
   * reconciled document no longer has. */
  mergeStagedState?(args: MergeStagedStateArgs): unknown;
  reconcileDocument(args: ReconcileDocumentArgs): Promise<LoadedDocument>;
  scaffoldLocale?(
    options: ScaffoldLocaleOptions
  ): Promise<ScaffoldLocaleResult>;
  writeDocument(document: LoadedDocument): Promise<void>;
}

export interface LocalizeSourceDocumentArgs {
  locale: string;
  source: LoadedDocument;
}

export interface GlossaryTerm {
  note?: string;
  source: string;
  target: string;
}

export interface TranslationRequestProvenance {
  catalogId: string;
  jsonPointer: string;
  unitId: string;
}

export type TranslationConstraintKind =
  | "attribution"
  | "citation"
  | "currency"
  | "date"
  | "link"
  | "literal"
  | "number"
  | "percentage"
  | "qualifier"
  | "range"
  | "required-term"
  | "forbidden-term"
  | "unit"
  | "validator-feedback";

export type TranslationConstraintRequirement =
  | "forbid-any"
  | "preserve"
  | "required-one-of";

export interface TranslationConstraint {
  kind: TranslationConstraintKind;
  match?: "exact" | "normalized-phrase";
  note?: string;
  requirement?: TranslationConstraintRequirement;
  sourceValues?: readonly string[];
  targetValue?: string;
  targetValues?: readonly string[];
  value: string;
}

export interface TranslationContext {
  audience?: string;
  constraints?: readonly TranslationConstraint[];
  notes?: string;
  product?: string;
  purpose?: string;
  tone?: string;
}

export type TranslationContentRole =
  | "body"
  | "cta"
  | "heading"
  | "link-anchor"
  | "metadata-description"
  | "metadata-title"
  | "table-cell"
  | "ui-label";

export interface TranslationContentRoleArgs {
  catalogId: string;
  entry: Entry;
  locale: string;
  path: string;
  unitId: string;
}

export type TranslationContentRoleResolver = (
  args: TranslationContentRoleArgs
) => TranslationContentRole | undefined;

export interface TranslationRequestContextArgs
  extends TranslationContentRoleArgs {
  contentRole?: TranslationContentRole;
  context?: TranslationContext;
}

export type TranslationRequestContextResolver = (
  args: TranslationRequestContextArgs
) => TranslationContext | undefined;

export type TranslationRequestContextRevisionResolver = (
  args: TranslationRequestContextArgs
) => string | undefined;

export interface TranslationRequest {
  catalogId: string;
  contentRole?: TranslationContentRole;
  context?: TranslationContext;
  key: string;
  locale: string;
  outputContract?: TranslationOutputContract;
  path: string;
  provenance: TranslationRequestProvenance;
  sourceText: string;
  /**
   * Source-derived semantic facets that the translation model must preserve and
   * verify before returning its final candidate. This is intentionally part of
   * the generation request, not a second provider-backed audit phase.
   */
  selfCheckPlans?: readonly TranslationSelfCheckPlan[];
  tokens?: readonly Token[];
  unitId: string;
}

export interface TranslationOutputContract {
  /** One response may include multiple independently verified candidates. */
  candidateCount?: number;
  /** Absolute visible Unicode-character budget enforced by downstream validation. */
  hardMaximumVisibleCharacters?: number;
  /** Human-readable preferred range supplied to the generator. */
  targetVisibleCharacterRange?: string;
}

export interface TranslationSelfCheckPlan {
  auditId: string;
  auditRevision: string;
  digest: string;
  promptRevision: string;
  providerRevision: string;
  requirements: readonly SemanticAuditRequirement[];
}

export interface TranslationSelfCheckAttestation {
  modelId: string;
  planDigests: readonly string[];
  verified: true;
}

export interface TranslationResponse {
  alternatives?: readonly string[];
  key: string;
  selfCheck?: TranslationSelfCheckAttestation;
  translation: string;
}

export interface TranslationProvider {
  translate(args: {
    batchContext?: TranslationContext;
    batchKey?: string;
    glossary?: readonly GlossaryTerm[];
    locale: string;
    requests: readonly TranslationRequest[];
  }): Promise<readonly TranslationResponse[]>;
}

export type CompactMetadataFallback = (
  request: TranslationRequest
) => string | undefined;

export interface TranslationCandidateCacheIdentity {
  modelId: string;
  providerId: string;
  providerRevision: string;
}

/**
 * Generation-cache identity. Includes only model-visible inputs that can
 * change the translation text. Validator/audit/transport revisions are
 * deliberately excluded — cache hits are always revalidated and rebound.
 */
export interface TranslationCandidateCacheKey {
  catalogId: string;
  contentRole?: TranslationContentRole;
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
  /** 2 = generation-only identity (no validator/provenance fields). */
  schemaVersion: 2;
  sourceDigest: string;
  sourceText: string;
  unitId: string;
}

export interface TranslationCandidateCache {
  get(key: TranslationCandidateCacheKey): Promise<string | undefined>;
  /** Returns only candidates whose generation-time self-check is persisted. */
  getAttested?(
    key: TranslationCandidateCacheKey
  ): Promise<TranslationAttestedCandidate | undefined>;
  /**
   * Publishes a candidate that passed the complete deterministic and semantic
   * acceptance contract. Unlike `put`, this may supersede an earlier
   * deterministic-only candidate for the same generation key.
   */
  promote(
    key: TranslationCandidateCacheKey,
    translation: string
  ): Promise<void>;
  promoteAttested?(
    key: TranslationCandidateCacheKey,
    candidate: TranslationAttestedCandidate
  ): Promise<void>;
  put(key: TranslationCandidateCacheKey, translation: string): Promise<void>;
  putAttested?(
    key: TranslationCandidateCacheKey,
    candidate: TranslationAttestedCandidate
  ): Promise<void>;
  /**
   * Quarantines this exact translation after a semantic rejection. Other
   * candidates for the same key remain eligible for later promotion.
   */
  reject(key: TranslationCandidateCacheKey, translation: string): Promise<void>;
}

export interface TranslationAttestedCandidate {
  selfCheck: TranslationSelfCheckAttestation;
  translation: string;
}

export interface TranslationCandidateSegmentDeltaConfig {
  /** Explicit opt-in: unchanged complete sentences may be reused from validated candidates. */
  enabled: boolean;
  /** Upper bound prevents long documents from being fragmented into excessive requests. */
  maxSegments?: number;
  /** Every sentence must meet this length or the complete field is translated normally. */
  minSegmentLength?: number;
  /** Fields shorter than this are translated normally. */
  minSourceLength?: number;
  /**
   * Explicit contract from the host: every reconstructed full field is covered by an
   * exhaustive semantic audit in addition to deterministic full-field validators.
   */
  semanticAuditCoverage: "exhaustive";
}

export interface TranslationCandidateCacheConfig {
  compatibleSelfCheckPlanDigests?: (
    plan: TranslationSelfCheckPlan
  ) => readonly string[];
  identity: TranslationCandidateCacheIdentity;
  segmentDeltaReuse?: TranslationCandidateSegmentDeltaConfig;
  store: TranslationCandidateCache;
}

export type SyncStateOrigin = "generated" | "legacy-unknown" | "manual";

export type SyncStateStatus = "failed" | "pending" | "stale-manual" | "synced";

export const LEGACY_UNVERIFIED_GENERATION_REVISION =
  "legacy-unverified" as const;

export interface SyncStateEntry {
  /**
   * Proves that this exact source/target/context pair passed the current
   * deterministic validation contract and every currently applicable semantic
   * audit. This is deliberately independent from generationRevision: accepting
   * preserved historical output must never pretend it was generated by a newer
   * provider contract.
   */
  acceptedContractRevision?: string;
  /**
   * Marks output created under the incremental acceptance rollout. These
   * entries must complete semantic audits before release; historical entries
   * without the marker remain observable migration debt instead of triggering
   * a corpus-wide provider replay.
   */
  requiresAcceptanceAudit?: true;
  catalogId?: string;
  generationRevision?: string;
  jsonPointer: string;
  locale: string;
  origin: SyncStateOrigin;
  sourceDigest: string;
  status: SyncStateStatus;
  targetDigest: string;
  translationContextDigest?: string;
  unitId: string;
  updatedAt: string;
  validationAudits?: Readonly<Record<string, SemanticAuditProvenance>>;
}

export interface SyncStateSnapshot {
  entries: Record<string, SyncStateEntry>;
  version: number;
}

/**
 * Narrows what a store must materialise. A store may ignore this and return a
 * superset, so callers that depend on the narrowing must still filter the
 * result; the scope is a memory optimisation, not an access control.
 */
export interface SyncStateLoadScope {
  /** When set and non-empty, only entries for these locales need be returned. */
  locales?: readonly string[];
}

export interface SyncStateStore {
  /**
   * A scoped snapshot is only safe to read. Passing one to {@link save} would
   * delete every entry the scope excluded, so scoped loads must never feed a
   * save.
   */
  load(scope?: SyncStateLoadScope): Promise<SyncStateSnapshot>;
  save(state: SyncStateSnapshot): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

export interface PathPolicyRule {
  catalogId?: string;
  locale?: RegExp | string;
  path: string;
  policy: Policy;
  unitId?: RegExp | string;
}

export interface TranslationContextRule {
  catalogId?: string;
  context: TranslationContext;
  locale?: RegExp | string;
  mode?: "append" | "replace";
  path?: string;
  unitId?: RegExp | string;
}

export interface TranslationValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface SourceValidationArgs {
  catalogId: string;
  contentRole?: TranslationContentRole;
  /** The canonical source locale, not a target locale. */
  locale: string;
  path: string;
  sourceText: string;
  unitId: string;
}

export type SourceValidator = (
  args: SourceValidationArgs
) =>
  | Promise<
      readonly TranslationValidationIssue[] | TranslationValidationIssue | null
    >
  | readonly TranslationValidationIssue[]
  | TranslationValidationIssue
  | null;

export type TranslationValidator = (args: {
  catalogId: string;
  contentRole?: TranslationContentRole;
  context?: TranslationContext;
  entry: Entry;
  existingState?: SyncStateEntry;
  locale: string;
  sourceText: string;
  targetText: string;
  unitId: string;
  validationPhase: "candidate" | "existing";
}) =>
  | Promise<
      readonly TranslationValidationIssue[] | TranslationValidationIssue | null
    >
  | readonly TranslationValidationIssue[]
  | TranslationValidationIssue
  | null;

export type SemanticAuditVerdict =
  | "ambiguous"
  | "broadened"
  | "contradicted"
  | "narrowed"
  | "omitted"
  | "preserved";

export type SemanticAuditConfidence = "high" | "low" | "medium";

export interface SemanticAuditRequirement {
  description: string;
  id: string;
  metadata?: JsonValue;
}

export interface SemanticAuditEvaluation {
  confidence?: SemanticAuditConfidence;
  evidence?: readonly SemanticAuditEvidenceSpan[];
  reason?: string;
  requirementId: string;
  verdict: SemanticAuditVerdict;
}

export interface SemanticAuditEvidenceSpan {
  end: number;
  field: "source" | "target";
  quote: string;
  start: number;
}

export interface SemanticAuditConsensusEvaluation {
  adversarial?: SemanticAuditEvaluation;
  forward?: SemanticAuditEvaluation;
  requirementId: string;
  status: SemanticAuditStatus;
}

export interface SemanticAuditAnalysis {
  deterministicEvaluations?: readonly SemanticAuditEvaluation[];
  keyMaterial?: JsonValue;
  requirements: readonly SemanticAuditRequirement[];
}

export interface SemanticAuditAnalysisArgs {
  catalogId: string;
  contentRole?: TranslationContentRole;
  context?: TranslationContext;
  contextDigest?: string;
  entry: Entry;
  existingState?: SyncStateEntry;
  locale: string;
  path: string;
  sourceText: string;
  targetText: string;
  unitId: string;
}

/** Minimal provider-facing audit payload. Analyzer-only context stays local. */
export interface SemanticAuditRequest {
  auditId: string;
  catalogId: string;
  deterministicEvaluations: readonly SemanticAuditEvaluation[];
  inputDigest: string;
  key: string;
  locale: string;
  path: string;
  /** Stable identity for provider-visible semantics, excluding analyzer bookkeeping revisions. */
  requestDigest: string;
  requirements: readonly SemanticAuditRequirement[];
  sourceText: string;
  targetText: string;
  unitId: string;
}

export interface SemanticAuditResponse {
  evaluations: readonly SemanticAuditEvaluation[];
  key: string;
  modelId: string;
}

export interface SemanticAuditProvider {
  audit(args: {
    auditId: string;
    locale: string;
    modelId: string;
    pass: "adversarial" | "forward";
    promptRevision: string;
    requests: readonly SemanticAuditRequest[];
  }): Promise<readonly SemanticAuditResponse[]>;
}

export type SemanticAuditStatus = "accepted" | "retranslate" | "unresolved";
export type SemanticAuditMode = "dual" | "single";

export interface SemanticAuditProvenance {
  adversarialModelId?: string;
  adversarialResponseDigest?: string;
  auditedAt: string;
  auditRevision: string;
  consensusEvaluations?: readonly SemanticAuditConsensusEvaluation[];
  deterministicEvaluations?: readonly SemanticAuditEvaluation[];
  forwardModelId?: string;
  forwardResponseDigest?: string;
  inputDigest: string;
  auditMode?: SemanticAuditMode;
  generatorModelId?: string;
  generatorSelfCheckDigest?: string;
  provenanceOrigin?: "deterministic" | "generator-self-check" | "provider";
  providerRevision: string;
  schemaVersion: 1;
  status: SemanticAuditStatus;
}

export interface SemanticAuditDefinition {
  adversarialModelId: string;
  adversarialPromptRevision: string;
  analyze(
    args: SemanticAuditAnalysisArgs
  ): Promise<SemanticAuditAnalysis | null> | SemanticAuditAnalysis | null;
  forwardPromptRevision: string;
  forwardModelId: string;
  id: string;
  /** Defaults to dual for backward compatibility with existing audit definitions. */
  mode?: SemanticAuditMode;
  batchSize?: number;
  provider: SemanticAuditProvider;
  providerRevision: string;
  revision: string;
}

export interface SemanticAuditIssue extends ValidationIssue {
  auditId: string;
  inputDigest: string;
  status: SemanticAuditStatus | "missing" | "stale";
}

export interface SemanticAuditResult {
  accepted: number;
  audited: number;
  cached: number;
  checked: number;
  issues: readonly SemanticAuditIssue[];
  retranslate: number;
  unresolved: number;
}

export interface AuditCatalogsOptions extends SyncCatalogsOptions {
  checkOnly?: boolean;
  refresh?: boolean;
}

export interface AiTranslateConfig {
  batching?: {
    /**
     * Maximum logical requests sent through one provider call for locale
     * batching. Providers may apply a smaller character-bounded split while
     * preserving every request's own context.
     */
    maxRequestsPerProviderCall?: number;
    scope?: "document" | "locale";
  };
  candidateCache?: TranslationCandidateCacheConfig;
  catalogs: readonly CatalogAdapter[];
  /**
   * Resolves narrowly scoped, deterministic compact metadata before the
   * translation provider is called. Returned candidates still pass the normal
   * validation, cache, audit, and provenance pipeline.
   */
  compactMetadataFallback?: CompactMetadataFallback;
  /**
   * Older generation contracts whose existing output remains valid under the
   * current contract. Request-context revisions and validators still select
   * entries affected by a narrowly scoped migration.
   */
  compatibleGenerationRevisions?: readonly string[];
  concurrency?: {
    documents?: number;
  };
  contentRole?: TranslationContentRoleResolver;
  contentRoleLegacyRevisions?: Partial<Record<TranslationContentRole, string>>;
  contentRoleRevisions?: Partial<Record<TranslationContentRole, string>>;
  context?: {
    overrides?: readonly TranslationContextRule[];
    project: TranslationContext;
  };
  glossary?: readonly GlossaryTerm[];
  /**
   * Identifies the complete translation-generation contract (provider, model,
   * system prompt, and deterministic post-processing). Generated entries with
   * an explicit different revision are automatically retranslated.
   */
  generationRevision?: string;
  legacyOriginPolicy?: "preserve" | "retranslate" | "validate-existing";
  manualOriginPolicy?: "preserve" | "retranslate" | "validate-existing";
  /** Message formats that no catalog advertises. Formats reachable through
   * {@link CatalogAdapter.messageFormats} are registered automatically; this is
   * only for entries stamped by something other than a catalog. */
  messageFormats?: readonly MessageFormat[];
  /** Declarative generation/selection contracts keyed by semantic content role. */
  outputContracts?: Partial<
    Record<TranslationContentRole, TranslationOutputContract>
  >;
  /**
   * Controls the one-time migration of historical generated entries that do
   * not have trustworthy generation provenance. Set to `retranslate` to run
   * them through the current generation contract instead of grandfathering
   * their existing target text.
   */
  unverifiedGeneratedPolicy?: "preserve" | "retranslate" | "validate-existing";
  policies?: readonly PathPolicyRule[];
  provider: TranslationProvider;
  requestContext?: TranslationRequestContextResolver;
  requestContextLegacyRevisions?: readonly string[];
  requestContextRevision?: TranslationRequestContextRevisionResolver;
  semanticAudits?: readonly SemanticAuditDefinition[];
  sourceLocale: string;
  /** Validates every canonical source string independently of translation policy. */
  sourceValidators?: readonly SourceValidator[];
  state: SyncStateStore;
  targetLocales: readonly string[];
  validation?: {
    /**
     * Machine-derived digest of the complete deterministic validation contract.
     * Required when acceptance provenance enforcement is enabled.
     */
    deterministicContractRevision?: string;
    /** Require acceptedContractRevision for generated translated strings. */
    enforceAcceptanceProvenance?: boolean;
    /**
     * Controls semantic-audit migration for historical generated strings with
     * no trustworthy generation revision. `skip-provider` still runs local
     * analyzers and deterministic semantic failures, but defers ambiguous
     * two-model replays; current and newly generated strings are audited fully.
     */
    legacyUnverifiedSemanticPolicy?: "audit" | "skip-provider";
    candidateRepairAttempts?: number;
    /** Number of provider-backed semantic repair cycles after the first audit. */
    semanticRepairAttempts?: number;
    /**
     * `generator-self-check` (the default) moves semantic preservation into the
     * translation response itself, so no semantic provider is called after
     * translation. `provider` replays every audited string through a separate
     * model — one or two extra calls per batch — and is worth it only when you
     * want a second opinion from a model that did not write the translation.
     */
    semanticAuditExecution?: "generator-self-check" | "provider";
    /**
     * Controls unchanged generated targets when only their resolved request
     * context changed. The default retranslates them; validate-existing runs
     * current validators first and rekeys valid state without provider churn.
     */
    contextChangePolicy?: "retranslate" | "validate-existing";
    /** Optional release-preflight limits enforced by CLI dry-run syncs. */
    dryRunBudget?: {
      forbiddenPendingTranslationReasons?: readonly string[];
      maxPendingTranslations?: number;
    };
    existingIssueSeverity?: Readonly<Record<string, "error" | "warning">>;
    retranslateInvalidExisting?: boolean;
  };
  validators?: readonly TranslationValidator[];
}

export interface SyncCatalogsOptions {
  /** Internal: skip validator diagnostics already bound by current acceptance provenance. */
  acceptedProvenanceFastPath?: boolean;
  /** Internal: the caller holds the state store's exclusive snapshot lock. */
  assumeStateLock?: boolean;
  catalogIds?: readonly string[];
  dryRun?: boolean;
  forceRetranslate?: boolean;
  forceRetranslatePaths?: readonly string[];
  /** Exact JSON pointers to reconcile; all other target values and state remain untouched. */
  includePaths?: readonly string[];
  locales?: readonly string[];
  /**
   * Abort before cache lookups or provider calls when the selected scope would
   * translate more entries than this limit. Release tooling can omit the limit
   * only when a deliberately large reconciliation is intended.
   */
  maxPendingTranslations?: number;
  unitIds?: readonly string[];
}

export interface DocumentSyncResult {
  catalogId: string;
  changed: boolean;
  copiedEntries: number;
  excludedEntries: number;
  failedEntries: number;
  issues: readonly TranslationValidationIssue[];
  locale: string;
  path: string;
  pendingTranslationReasons?: Readonly<Record<string, number>>;
  staleManualEntries: number;
  translatedEntries: number;
  unitId: string;
  wroteFile: boolean;
}

export interface SyncPhaseTimings {
  cacheLookupMs: number;
  catalogScanMs: number;
  providerMs: number;
  stateLoadMs: number;
  stateWriteMs: number;
  validationMs: number;
}

export interface SyncMetrics {
  candidateCacheHits?: number;
  candidateCacheMisses?: number;
  candidateCacheWrites?: number;
  changedDocuments: number;
  copiedEntries: number;
  durationMs: number;
  excludedEntries: number;
  failedEntries: number;
  /** Exact pending-translation / invalidation reasons → entry counts. */
  invalidationReasons?: Readonly<Record<string, number>>;
  phases?: SyncPhaseTimings;
  providerRequestCount?: number;
  scannedDocuments: number;
  staleManualEntries: number;
  translatedEntries: number;
}

export interface SyncResult {
  documents: readonly DocumentSyncResult[];
  dryRun: boolean;
  metrics: SyncMetrics;
  state: SyncStateSnapshot;
}

export interface ValidationIssue {
  catalogId: string;
  code: string;
  jsonPointer: string;
  locale: string;
  message: string;
  path: string;
  severity: "error" | "warning";
  unitId: string;
}

export interface ValidationResult {
  configPath?: string;
  issues: readonly ValidationIssue[];
  legacyUnverifiedGeneratedEntries: number;
  sourceDocuments: number;
  targetLocales: number;
}
