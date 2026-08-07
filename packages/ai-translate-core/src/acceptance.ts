import { AsyncLocalStorage } from "node:async_hooks";

import { validateTranslationConstraints } from "./constraints";
import { digestValue } from "./hash";
import { resolveConfigMessageFormat } from "./message-format";
import { normalizeTranslationContext } from "./policies";
import { tokenizeText } from "./tokens";
import { LEGACY_UNVERIFIED_GENERATION_REVISION } from "./types";
import type {
  AiTranslateConfig,
  Entry,
  SemanticAuditConsensusEvaluation,
  SemanticAuditEvaluation,
  SemanticAuditProvenance,
  SourceValidationArgs,
  SourceValidator,
  SyncStateEntry,
  TranslationContentRole,
  TranslationContext,
  TranslationValidationIssue,
} from "./types";

const ACCEPTANCE_PROVENANCE_SCHEMA_VERSION = 1;
const MATERIAL_FAILURE_VERDICTS = new Set<SemanticAuditEvaluation["verdict"]>([
  "broadened",
  "contradicted",
  "narrowed",
  "omitted",
]);

type TranslationIssueCache = WeakMap<
  AiTranslateConfig,
  Map<string, Promise<TranslationValidationIssue[]>>
>;

const translationIssueCacheStorage =
  new AsyncLocalStorage<TranslationIssueCache>();

export function withTranslationIssueCache<Result>(
  operation: () => Promise<Result>
): Promise<Result> {
  return translationIssueCacheStorage.run(new WeakMap(), operation);
}

/**
 * Semantic preservation defaults to riding along with the translation request
 * rather than a separate replay, because the self-check costs no extra provider
 * calls and catches the same class of drift. Opting in to `provider` buys a
 * second model's opinion at one or two calls per audit batch.
 *
 * Every caller must go through here: the mode is read in a dozen places, and an
 * inverted comparison at any one of them would silently split the pipeline
 * between the two strategies.
 */
export function usesGeneratorSelfCheck(
  config: Pick<AiTranslateConfig, "validation"> | undefined
): boolean {
  return config?.validation?.semanticAuditExecution !== "provider";
}

/**
 * Self-check mode caches candidates through `getAttested`/`putAttested` so a
 * cache hit carries the model's attestation with it. Those methods are
 * optional, and a store without them silently caches nothing.
 *
 * With no semantic audits configured there are no facets to attest, so nothing
 * ever demands an attestation and the plain `get`/`put` path is both correct
 * and the only one an ordinary store implements. Keying off the mode alone
 * would switch every such store onto a road it cannot drive down — no error,
 * just a cache that quietly stops working and a model bill that doubles.
 */
export function usesAttestedCandidateCache(
  config: Pick<AiTranslateConfig, "semanticAudits" | "validation"> | undefined
): boolean {
  return (
    usesGeneratorSelfCheck(config) &&
    (config?.semanticAudits?.length ?? 0) > 0
  );
}

export function isLegacyAcceptanceMigrationExempt(args: {
  config: AiTranslateConfig;
  sourceText: string;
  stateEntry: SyncStateEntry | undefined;
  targetText: string;
}): boolean {
  const { config, sourceText, stateEntry, targetText } = args;
  return (
    config.validation?.enforceAcceptanceProvenance === true &&
    config.validation.legacyUnverifiedSemanticPolicy === "skip-provider" &&
    stateEntry?.origin === "generated" &&
    (stateEntry.generationRevision === undefined ||
      stateEntry.generationRevision ===
        LEGACY_UNVERIFIED_GENERATION_REVISION) &&
    stateEntry.status === "synced" &&
    stateEntry.sourceDigest === digestValue(sourceText) &&
    stateEntry.targetDigest === digestValue(targetText) &&
    stateEntry.requiresAcceptanceAudit !== true &&
    stateEntry.acceptedContractRevision === undefined &&
    !Object.values(stateEntry.validationAudits ?? {}).some(
      (audit) => audit.status !== "accepted"
    )
  );
}

export function digestTranslationContext(
  context: TranslationContext | undefined
): string {
  const normalized = normalizeTranslationContext(context);
  return digestValue(
    normalized === undefined ? "" : JSON.stringify(normalized)
  );
}

export function digestTranslationInstructions(args: {
  contentRole: TranslationContentRole | undefined;
  context: TranslationContext | undefined;
  /** Digest of glossary terms relevant to this source request only. */
  glossaryDigest?: string;
  requestContextRevision?: string | undefined;
  revision: string | undefined;
}): string {
  const contextDigest = digestTranslationContext(args.context);
  if (
    args.contentRole === undefined &&
    args.revision === undefined &&
    args.requestContextRevision === undefined &&
    (args.glossaryDigest === undefined || args.glossaryDigest.length === 0)
  ) {
    return contextDigest;
  }
  return digestValue(
    JSON.stringify({
      contentRole: args.contentRole ?? "",
      contextDigest,
      ...(args.glossaryDigest === undefined || args.glossaryDigest.length === 0
        ? {}
        : { glossaryDigest: args.glossaryDigest }),
      revision: args.revision ?? "",
      ...(args.requestContextRevision === undefined
        ? {}
        : { requestContextRevision: args.requestContextRevision }),
    })
  );
}

export function resolveRequestContext(args: {
  baseContext: TranslationContext | undefined;
  catalogId: string;
  config: AiTranslateConfig;
  contentRole: TranslationContentRole | undefined;
  entry: Entry;
  locale: string;
  path: string;
  unitId: string;
}): { context: TranslationContext | undefined; revision: string | undefined } {
  const resolverArgs = {
    catalogId: args.catalogId,
    ...(args.contentRole === undefined
      ? {}
      : { contentRole: args.contentRole }),
    ...(args.baseContext === undefined ? {} : { context: args.baseContext }),
    entry: args.entry,
    locale: args.locale,
    path: args.path,
    unitId: args.unitId,
  };
  return {
    context: args.config.requestContext
      ? args.config.requestContext(resolverArgs)
      : args.baseContext,
    revision: args.config.requestContextRevision?.(resolverArgs),
  };
}

export interface SemanticAuditAcceptanceIdentity {
  acceptanceMode: "deterministic" | "generator-self-check" | "provider";
  auditMode?: "dual" | "single";
  adversarialModelId: string;
  adversarialPromptRevision: string;
  auditId: string;
  auditRevision: string;
  deterministicEvaluationsDigest: string;
  forwardModelId: string;
  forwardPromptRevision: string;
  inputDigest: string;
  providerRevision: string;
  requestKey: string;
  requirementIds: readonly string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)])
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

interface TranslationIssueCollectionArgs {
  catalogId: string;
  config: AiTranslateConfig;
  contentRole?: TranslationContentRole;
  context?: TranslationContext;
  entry: Entry;
  existingState?: SyncStateEntry;
  locale: string;
  sourceText: string;
  targetText: string;
  unitId: string;
  validationPhase: "candidate" | "existing";
}

function containsUnescapedTablePipe(value: string): boolean {
  return tokenizeText(value).some((token) => {
    if (token.type === "markdown-inline-code") {
      return false;
    }
    let precedingBackslashes = 0;
    for (const character of token.raw) {
      if (character === "|" && precedingBackslashes % 2 === 0) {
        return true;
      }
      precedingBackslashes = character === "\\" ? precedingBackslashes + 1 : 0;
    }
    return false;
  });
}

function collectMarkdocStructureIssues(
  entry: Entry,
  targetText: string
): TranslationValidationIssue[] {
  if (entry.storage !== "markdoc") {
    return [];
  }
  const structureSignature = entry.meta?.structureSignature;
  if (typeof structureSignature !== "string") {
    return [];
  }
  if (
    structureSignature.startsWith("table-cell:") &&
    containsUnescapedTablePipe(targetText)
  ) {
    return [
      {
        code: "markdoc-table-cell-pipe",
        message:
          "Markdoc table-cell translations cannot introduce an unescaped table pipe.",
        severity: "error",
      },
    ];
  }
  if (!structureSignature.startsWith("paragraph:")) {
    return [];
  }
  const trimmed = targetText.trim();
  const introducesBlockSyntax =
    /^(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+|```|~~~|\{%)/u.test(trimmed) ||
    /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(
      trimmed
    ) ||
    /^\|.*\|$/u.test(trimmed);
  return introducesBlockSyntax
    ? [
        {
          code: "markdoc-block-structure",
          message:
            "A Markdoc paragraph translation cannot introduce heading, list, fence, tag, table, or thematic-break syntax.",
          severity: "error",
        },
      ]
    : [];
}

async function collectUncachedRawTranslationIssues(
  args: TranslationIssueCollectionArgs
): Promise<TranslationValidationIssue[]> {
  const tokenIssues = resolveConfigMessageFormat(
    args.config,
    args.entry.messageFormatId
  ).validateParity({
    locale: args.locale,
    sourceLocale: args.config.sourceLocale,
    sourceText: args.sourceText,
    targetText: args.targetText,
  });
  const constraintIssues = validateTranslationConstraints({
    constraints: args.context?.constraints,
    targetText: args.targetText,
  });
  const structureIssues = [
    ...(args.validationPhase === "candidate" &&
    args.entry.storage === "markdoc" &&
    /[\r\n]/u.test(args.targetText)
      ? [
          {
            code: "markdoc-structural-newline",
            message: "Markdoc translations cannot contain structural newlines.",
            severity: "error" as const,
          },
        ]
      : []),
    ...collectMarkdocStructureIssues(args.entry, args.targetText),
  ];
  const validatorIssues = (
    await Promise.all(
      (args.config.validators ?? []).map((validator) =>
        Promise.resolve(
          validator({
            catalogId: args.catalogId,
            ...(args.contentRole === undefined
              ? {}
              : { contentRole: args.contentRole }),
            ...(args.context === undefined ? {} : { context: args.context }),
            entry: args.entry,
            ...(args.existingState === undefined
              ? {}
              : { existingState: args.existingState }),
            locale: args.locale,
            sourceText: args.sourceText,
            targetText: args.targetText,
            unitId: args.unitId,
            validationPhase: args.validationPhase,
          })
        ).then((result) =>
          result === null || result === undefined
            ? []
            : Array.isArray(result)
            ? result
            : [result]
        )
      )
    )
  ).flat();

  return [
    ...tokenIssues,
    ...constraintIssues,
    ...structureIssues,
    ...validatorIssues,
  ];
}

async function collectRawTranslationIssues(
  args: TranslationIssueCollectionArgs
): Promise<TranslationValidationIssue[]> {
  const cacheScope = translationIssueCacheStorage.getStore();
  if (cacheScope === undefined) {
    return collectUncachedRawTranslationIssues(args);
  }

  let configCache = cacheScope.get(args.config);
  if (configCache === undefined) {
    configCache = new Map();
    cacheScope.set(args.config, configCache);
  }
  const cacheKey = digestValue(
    stableStringify({
      catalogId: args.catalogId,
      contentRole: args.contentRole,
      context: args.context,
      entry: args.entry,
      existingState: args.existingState,
      locale: args.locale,
      sourceText: args.sourceText,
      targetText: args.targetText,
      unitId: args.unitId,
      validationPhase: args.validationPhase,
    })
  );
  const cached = configCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const pending = collectUncachedRawTranslationIssues(args);
  configCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    configCache.delete(cacheKey);
    throw error;
  }
}

export async function collectTranslationIssues(
  args: TranslationIssueCollectionArgs
): Promise<TranslationValidationIssue[]> {
  return (await collectRawTranslationIssues(args)).map((issue) =>
    args.validationPhase === "existing"
      ? {
          ...issue,
          severity:
            args.config.validation?.existingIssueSeverity?.[issue.code] ??
            (issue.code.startsWith("token-") ? "warning" : issue.severity),
        }
      : issue
  );
}

/**
 * Acceptance is stricter than existing-content diagnostics. It executes both
 * candidate and existing validator contracts and intentionally ignores display
 * severity overrides, so a downgraded structural/token error can never become
 * accepted provenance.
 */
export async function collectAcceptanceIssues(
  args: Omit<TranslationIssueCollectionArgs, "validationPhase">
): Promise<TranslationValidationIssue[]> {
  const issues = (
    await Promise.all(
      (["candidate", "existing"] as const).map((validationPhase) =>
        collectRawTranslationIssues({ ...args, validationPhase })
      )
    )
  ).flat();
  const unique = new Map(
    issues.map((issue) => [
      `${issue.code}\u0000${issue.severity}\u0000${issue.message}`,
      issue,
    ])
  );
  return [...unique.values()];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function collectSourceValidationIssues(
  args: SourceValidationArgs & { validators?: readonly SourceValidator[] }
): Promise<TranslationValidationIssue[]> {
  const { validators = [], ...validatorArgs } = args;
  return (
    await Promise.all(
      validators.map((validator) =>
        Promise.resolve(validator(validatorArgs)).then((result) =>
          result === null || result === undefined
            ? []
            : Array.isArray(result)
            ? result
            : [result]
        )
      )
    )
  ).flat();
}

function isCompleteEvidence(evaluation: SemanticAuditEvaluation): boolean {
  if (
    !isNonEmptyString(evaluation.reason) ||
    !Array.isArray(evaluation.evidence)
  ) {
    return false;
  }
  const fields = new Set<"source" | "target">();
  for (const span of evaluation.evidence) {
    if (
      (span.field !== "source" && span.field !== "target") ||
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      !isNonEmptyString(span.quote)
    ) {
      return false;
    }
    fields.add(span.field);
  }
  return fields.has("source") && fields.has("target");
}

function isCompletePreservedEvaluation(
  evaluation: SemanticAuditEvaluation | undefined
): evaluation is SemanticAuditEvaluation {
  return (
    evaluation?.verdict === "preserved" &&
    evaluation.confidence === "high" &&
    isCompleteEvidence(evaluation)
  );
}

function isCompleteSinglePassPreservedEvaluation(
  evaluation: SemanticAuditEvaluation | undefined
): evaluation is SemanticAuditEvaluation {
  return (
    evaluation?.verdict === "preserved" &&
    (evaluation.confidence === "high" || evaluation.confidence === "medium") &&
    isCompleteEvidence(evaluation)
  );
}

function isCompleteAcceptedConsensus(
  evaluation: SemanticAuditConsensusEvaluation,
  auditMode: "dual" | "single"
): boolean {
  if (auditMode === "single") {
    return (
      isNonEmptyString(evaluation.requirementId) &&
      evaluation.status === "accepted" &&
      evaluation.adversarial === undefined &&
      isCompleteSinglePassPreservedEvaluation(evaluation.forward) &&
      evaluation.forward.requirementId === evaluation.requirementId
    );
  }
  return (
    isNonEmptyString(evaluation.requirementId) &&
    evaluation.status === "accepted" &&
    isCompletePreservedEvaluation(evaluation.adversarial) &&
    evaluation.adversarial.requirementId === evaluation.requirementId &&
    isCompletePreservedEvaluation(evaluation.forward) &&
    evaluation.forward.requirementId === evaluation.requirementId
  );
}

export function createGeneratorSelfCheckDigest(args: {
  identity: SemanticAuditAcceptanceIdentity;
  modelId: string;
  sourceText: string;
  targetText: string;
}): string {
  return digestValue(
    stableStringify({
      auditId: args.identity.auditId,
      auditRevision: args.identity.auditRevision,
      inputDigest: args.identity.inputDigest,
      modelId: args.modelId,
      providerRevision: args.identity.providerRevision,
      requestKey: args.identity.requestKey,
      requirementIds: args.identity.requirementIds,
      sourceDigest: digestValue(args.sourceText),
      targetDigest: digestValue(args.targetText),
    })
  );
}

function hasLiteralEvidence(
  evaluation: SemanticAuditEvaluation,
  sourceText: string,
  targetText: string
): boolean {
  return (
    evaluation.evidence?.every((span) => {
      const text = span.field === "source" ? sourceText : targetText;
      return (
        span.end <= text.length &&
        text.slice(span.start, span.end) === span.quote
      );
    }) === true
  );
}

export function hasCompleteAcceptedSemanticAuditProvenance(
  provenance: SemanticAuditProvenance | undefined
): provenance is SemanticAuditProvenance {
  if (
    provenance?.schemaVersion !== 1 ||
    provenance.status !== "accepted" ||
    !isNonEmptyString(provenance.auditedAt) ||
    !Number.isFinite(Date.parse(provenance.auditedAt)) ||
    !isNonEmptyString(provenance.auditRevision) ||
    !isNonEmptyString(provenance.inputDigest) ||
    !isNonEmptyString(provenance.providerRevision)
  ) {
    return false;
  }

  const deterministicEvaluations = provenance.deterministicEvaluations ?? [];
  const consensusEvaluations = provenance.consensusEvaluations ?? [];
  const deterministicOnly =
    deterministicEvaluations.length > 0 &&
    deterministicEvaluations.every(isCompletePreservedEvaluation) &&
    consensusEvaluations.length === 0 &&
    provenance.forwardModelId === undefined &&
    provenance.forwardResponseDigest === undefined &&
    provenance.adversarialModelId === undefined &&
    provenance.adversarialResponseDigest === undefined;
  const auditMode = provenance.auditMode ?? "dual";
  const generatorSelfChecked =
    provenance.provenanceOrigin === "generator-self-check" &&
    isNonEmptyString(provenance.generatorModelId) &&
    isNonEmptyString(provenance.generatorSelfCheckDigest) &&
    provenance.forwardModelId === undefined &&
    provenance.forwardResponseDigest === undefined &&
    provenance.adversarialModelId === undefined &&
    provenance.adversarialResponseDigest === undefined &&
    deterministicEvaluations.every(
      ({ verdict }) => !MATERIAL_FAILURE_VERDICTS.has(verdict)
    ) &&
    consensusEvaluations.length > 0 &&
    consensusEvaluations.every((evaluation) =>
      isCompleteAcceptedConsensus(evaluation, "single")
    );
  const providerBacked =
    (provenance.provenanceOrigin === undefined ||
      provenance.provenanceOrigin === "provider") &&
    isNonEmptyString(provenance.forwardModelId) &&
    isNonEmptyString(provenance.forwardResponseDigest) &&
    (auditMode === "single" ||
      (isNonEmptyString(provenance.adversarialModelId) &&
        isNonEmptyString(provenance.adversarialResponseDigest))) &&
    (auditMode === "dual" ||
      (provenance.adversarialModelId === undefined &&
        provenance.adversarialResponseDigest === undefined)) &&
    deterministicEvaluations.every(
      ({ verdict }) => !MATERIAL_FAILURE_VERDICTS.has(verdict)
    ) &&
    consensusEvaluations.length > 0 &&
    consensusEvaluations.every((evaluation) =>
      isCompleteAcceptedConsensus(evaluation, auditMode)
    );

  return deterministicOnly || generatorSelfChecked || providerBacked;
}

function auditProvenanceMatches(
  identity: SemanticAuditAcceptanceIdentity,
  provenance: SemanticAuditProvenance | undefined,
  sourceText: string,
  targetText: string
): boolean {
  if (!hasCompleteAcceptedSemanticAuditProvenance(provenance)) {
    return false;
  }
  const auditMode = identity.auditMode ?? "dual";
  if (
    (provenance.auditMode ?? "dual") !== auditMode ||
    provenance.inputDigest !== identity.inputDigest ||
    provenance.auditRevision !== identity.auditRevision ||
    provenance.providerRevision !== identity.providerRevision
  ) {
    return false;
  }
  // Deterministic analyzer evaluations are host bookkeeping for provider-backed
  // audits. Generator-self-check acceptance is attested by requirement coverage
  // and literal evidence; validator/analyzer digest drift must not regenerate.
  if (
    identity.acceptanceMode !== "generator-self-check" &&
    digestValue(stableStringify(provenance.deterministicEvaluations ?? [])) !==
      identity.deterministicEvaluationsDigest
  ) {
    return false;
  }

  if (identity.acceptanceMode === "deterministic") {
    return (
      provenance.consensusEvaluations === undefined &&
      (provenance.deterministicEvaluations ?? []).every((evaluation) =>
        hasLiteralEvidence(evaluation, sourceText, targetText)
      )
    );
  }

  const consensus = provenance.consensusEvaluations;
  if (
    identity.acceptanceMode === "generator-self-check" &&
    provenance.provenanceOrigin === "generator-self-check"
  ) {
    return (
      provenance.provenanceOrigin === "generator-self-check" &&
      isNonEmptyString(provenance.generatorModelId) &&
      consensus !== undefined &&
      stableStringify(consensus.map(({ requirementId }) => requirementId)) ===
        stableStringify(identity.requirementIds) &&
      consensus.every(
        ({ adversarial, forward }) =>
          adversarial === undefined &&
          forward !== undefined &&
          hasLiteralEvidence(forward, sourceText, targetText)
      ) &&
      provenance.generatorSelfCheckDigest ===
        createGeneratorSelfCheckDigest({
          identity,
          modelId: provenance.generatorModelId,
          sourceText,
          targetText,
        })
    );
  }
  if (
    provenance.forwardModelId !== identity.forwardModelId ||
    (auditMode === "dual" &&
      provenance.adversarialModelId !== identity.adversarialModelId) ||
    consensus === undefined ||
    stableStringify(consensus.map(({ requirementId }) => requirementId)) !==
      stableStringify(identity.requirementIds) ||
    !consensus.every(
      ({ adversarial, forward }) =>
        (auditMode === "single" || adversarial !== undefined) &&
        forward !== undefined &&
        (adversarial === undefined ||
          hasLiteralEvidence(adversarial, sourceText, targetText)) &&
        hasLiteralEvidence(forward, sourceText, targetText)
    )
  ) {
    return false;
  }
  const forwardResponse = {
    evaluations: consensus.map(({ forward }) => forward),
    key: identity.requestKey,
    modelId: identity.forwardModelId,
  };
  if (
    forwardResponse.evaluations.includes(undefined) ||
    digestValue(stableStringify(forwardResponse)) !==
      provenance.forwardResponseDigest
  ) {
    return false;
  }
  if (auditMode === "single") {
    return true;
  }
  const adversarialResponse = {
    evaluations: consensus.map(({ adversarial }) => adversarial),
    key: identity.requestKey,
    modelId: identity.adversarialModelId,
  };
  return (
    !adversarialResponse.evaluations.includes(undefined) &&
    digestValue(stableStringify(adversarialResponse)) ===
      provenance.adversarialResponseDigest
  );
}

export function hasAcceptedSemanticAudits(
  identities: readonly SemanticAuditAcceptanceIdentity[],
  stateEntry: SyncStateEntry | undefined,
  sourceText: string,
  targetText: string
): boolean {
  return identities.every((identity) =>
    auditProvenanceMatches(
      identity,
      stateEntry?.validationAudits?.[identity.auditId],
      sourceText,
      targetText
    )
  );
}

function rebindSemanticAuditProvenance(
  identity: SemanticAuditAcceptanceIdentity,
  provenance: SemanticAuditProvenance | undefined,
  sourceText: string,
  targetText: string
): SemanticAuditProvenance | undefined {
  if (provenance === undefined) {
    return undefined;
  }
  const rebound: SemanticAuditProvenance = {
    ...provenance,
    inputDigest: identity.inputDigest,
  };
  if (identity.acceptanceMode === "deterministic") {
    return rebound;
  }
  if (identity.acceptanceMode === "generator-self-check") {
    if (
      provenance.provenanceOrigin !== "generator-self-check" ||
      !isNonEmptyString(provenance.generatorModelId)
    ) {
      return undefined;
    }
    const consensus = provenance.consensusEvaluations;
    if (
      consensus === undefined ||
      stableStringify(consensus.map(({ requirementId }) => requirementId)) !==
        stableStringify(identity.requirementIds) ||
      !consensus.every(
        ({ adversarial, forward }) =>
          adversarial === undefined &&
          forward !== undefined &&
          hasLiteralEvidence(forward, sourceText, targetText)
      )
    ) {
      return undefined;
    }
    // Rebind host provenance to the current audit/validator identity while
    // keeping the generator-attested evidence. Validator and audit-revision
    // drift must not force a provider call when the text still passes.
    const reboundAuditMode = identity.auditMode ?? provenance.auditMode;
    return {
      ...rebound,
      ...(reboundAuditMode === undefined ? {} : { auditMode: reboundAuditMode }),
      auditRevision: identity.auditRevision,
      ...(provenance.deterministicEvaluations === undefined
        ? {}
        : { deterministicEvaluations: provenance.deterministicEvaluations }),
      generatorSelfCheckDigest: createGeneratorSelfCheckDigest({
        identity,
        modelId: provenance.generatorModelId,
        sourceText,
        targetText,
      }),
      providerRevision: identity.providerRevision,
    };
  }

  const consensus = provenance.consensusEvaluations;
  if (consensus === undefined) {
    return undefined;
  }
  const forwardEvaluations = consensus.map(({ forward }) => forward);
  if (forwardEvaluations.includes(undefined)) {
    return undefined;
  }
  const next: SemanticAuditProvenance = {
    ...rebound,
    forwardModelId: identity.forwardModelId,
    forwardResponseDigest: digestValue(
      stableStringify({
        evaluations: forwardEvaluations,
        key: identity.requestKey,
        modelId: identity.forwardModelId,
      })
    ),
  };
  if ((identity.auditMode ?? "dual") === "single") {
    delete next.adversarialModelId;
    delete next.adversarialResponseDigest;
    return next;
  }
  const adversarialEvaluations = consensus.map(
    ({ adversarial }) => adversarial
  );
  if (adversarialEvaluations.includes(undefined)) {
    return undefined;
  }
  return {
    ...next,
    adversarialModelId: identity.adversarialModelId,
    adversarialResponseDigest: digestValue(
      stableStringify({
        evaluations: adversarialEvaluations,
        key: identity.requestKey,
        modelId: identity.adversarialModelId,
      })
    ),
  };
}

/**
 * Rebinds generator-self-check provenance onto the current audit identity when
 * the attested text and requirement coverage still hold. Used when validator or
 * audit revisions drift without model-visible generation input changes.
 */
export function rebindGeneratorSelfCheckAuditsForCurrentIdentity(args: {
  currentIdentities: readonly SemanticAuditAcceptanceIdentity[];
  existingState: SyncStateEntry;
  sourceText: string;
  targetText: string;
}): Readonly<Record<string, SemanticAuditProvenance>> | undefined {
  if (args.existingState.acceptedContractRevision === undefined) {
    return undefined;
  }
  const reboundAudits: Record<string, SemanticAuditProvenance> = {};
  for (const identity of args.currentIdentities) {
    if (identity.acceptanceMode !== "generator-self-check") {
      return undefined;
    }
    const rebound = rebindSemanticAuditProvenance(
      identity,
      args.existingState.validationAudits?.[identity.auditId],
      args.sourceText,
      args.targetText
    );
    if (rebound === undefined) {
      return undefined;
    }
    reboundAudits[identity.auditId] = rebound;
  }
  return Object.keys(reboundAudits).length === args.currentIdentities.length
    ? reboundAudits
    : undefined;
}

export function rebindAcceptedSemanticAudits(args: {
  catalogId: string;
  config: AiTranslateConfig;
  contentRole?: TranslationContentRole;
  currentContextDigest: string;
  currentIdentities: readonly SemanticAuditAcceptanceIdentity[];
  existingState: SyncStateEntry;
  locale: string;
  path: string;
  previousContextDigest: string;
  previousIdentities: readonly SemanticAuditAcceptanceIdentity[];
  sourceText: string;
  targetText: string;
  unitId: string;
}): Readonly<Record<string, SemanticAuditProvenance>> | undefined {
  const currentAuditIds = args.currentIdentities
    .map(({ auditId }) => auditId)
    .toSorted();
  const previousAuditIds = args.previousIdentities
    .map(({ auditId }) => auditId)
    .toSorted();
  const storedAuditIds = Object.keys(
    args.existingState.validationAudits ?? {}
  ).toSorted();
  if (
    stableStringify(currentAuditIds) !== stableStringify(previousAuditIds) ||
    stableStringify(previousAuditIds) !== stableStringify(storedAuditIds) ||
    args.existingState.acceptedContractRevision === undefined
  ) {
    return undefined;
  }
  const previousAcceptedContractRevision = createAcceptedContractRevision({
    catalogId: args.catalogId,
    config: args.config,
    ...(args.contentRole === undefined
      ? {}
      : { contentRole: args.contentRole }),
    contextDigest: args.previousContextDigest,
    locale: args.locale,
    path: args.path,
    semanticAudits: args.previousIdentities,
    sourceText: args.sourceText,
    targetText: args.targetText,
    unitId: args.unitId,
  });
  if (
    previousAcceptedContractRevision !==
      args.existingState.acceptedContractRevision ||
    !hasAcceptedSemanticAudits(
      args.previousIdentities,
      args.existingState,
      args.sourceText,
      args.targetText
    )
  ) {
    return undefined;
  }

  const reboundAudits: Record<string, SemanticAuditProvenance> = {};
  for (const identity of args.currentIdentities) {
    const rebound = rebindSemanticAuditProvenance(
      identity,
      args.existingState.validationAudits?.[identity.auditId],
      args.sourceText,
      args.targetText
    );
    if (rebound === undefined) {
      return undefined;
    }
    reboundAudits[identity.auditId] = rebound;
  }
  const {
    acceptedContractRevision: _acceptedContractRevision,
    ...existingState
  } = args.existingState;
  const reboundState = {
    ...existingState,
    translationContextDigest: args.currentContextDigest,
    validationAudits: reboundAudits,
  };
  return hasAcceptedSemanticAudits(
    args.currentIdentities,
    reboundState,
    args.sourceText,
    args.targetText
  )
    ? reboundAudits
    : undefined;
}

export function createAcceptedContractRevision(args: {
  catalogId: string;
  config: AiTranslateConfig;
  contentRole?: TranslationContentRole;
  contextDigest: string;
  locale: string;
  path: string;
  semanticAudits: readonly SemanticAuditAcceptanceIdentity[];
  sourceText: string;
  targetText: string;
  unitId: string;
}): string | undefined {
  const deterministicContractRevision =
    args.config.validation?.deterministicContractRevision;
  if (
    args.config.validation?.enforceAcceptanceProvenance !== true ||
    deterministicContractRevision === undefined
  ) {
    return undefined;
  }

  return `sha256:${digestValue(
    stableStringify({
      catalogId: args.catalogId,
      ...(args.contentRole === undefined
        ? {}
        : { contentRole: args.contentRole }),
      contextDigest: args.contextDigest,
      deterministicContractRevision,
      locale: args.locale,
      path: args.path,
      schemaVersion: ACCEPTANCE_PROVENANCE_SCHEMA_VERSION,
      semanticAudits: [...args.semanticAudits].toSorted((left, right) =>
        left.auditId.localeCompare(right.auditId)
      ),
      sourceDigest: digestValue(args.sourceText),
      targetDigest: digestValue(args.targetText),
      unitId: args.unitId,
    })
  )}`;
}

export async function resolveAcceptedContractRevision(args: {
  catalogId: string;
  config: AiTranslateConfig;
  contentRole?: TranslationContentRole;
  context?: TranslationContext;
  contextDigest: string;
  entry: Entry;
  existingState?: SyncStateEntry;
  locale: string;
  path: string;
  semanticAudits: readonly SemanticAuditAcceptanceIdentity[];
  sourceText: string;
  targetText: string;
  unitId: string;
}): Promise<string | undefined> {
  if (args.config.validation?.enforceAcceptanceProvenance !== true) {
    return undefined;
  }
  const issues = await collectAcceptanceIssues(args);
  if (
    issues.some(({ severity }) => severity === "error") ||
    !hasAcceptedSemanticAudits(
      args.semanticAudits,
      args.existingState,
      args.sourceText,
      args.targetText
    )
  ) {
    return undefined;
  }
  return createAcceptedContractRevision(args);
}
