import {
  createGeneratorSelfCheckDigest,
  digestTranslationInstructions,
  hasAcceptedSemanticAudits,
  isLegacyAcceptanceMigrationExempt,
  resolveAcceptedContractRevision,
  resolveRequestContext,
  type SemanticAuditAcceptanceIdentity,
  usesGeneratorSelfCheck,
} from "./acceptance";
import {
  addressToJsonPointer,
  makeLegacyStateKey,
  makeStateKey,
} from "./address";
import {
  createTranslationCandidateCacheKey,
  resolveCandidateCacheIdentity,
} from "./candidate-cache";
import { resolveDocumentConcurrency, runWithConcurrency } from "./concurrency";
import { digestValue } from "./hash";
import { mapEntriesByPointer } from "./json";
import { resolvePolicy, resolveTranslationContext } from "./policies";
import { LEGACY_UNVERIFIED_GENERATION_REVISION } from "./types";
import type {
  AiTranslateConfig,
  AuditCatalogsOptions,
  CatalogAdapter,
  DocumentRef,
  Entry,
  SemanticAuditAnalysis,
  SemanticAuditAnalysisArgs,
  SemanticAuditConsensusEvaluation,
  SemanticAuditDefinition,
  SemanticAuditEvidenceSpan,
  SemanticAuditEvaluation,
  SemanticAuditIssue,
  SemanticAuditProvenance,
  SemanticAuditRequest,
  SemanticAuditResponse,
  SemanticAuditResult,
  SemanticAuditStatus,
  SyncStateEntry,
  SyncStateSnapshot,
  TranslationContentRole,
  TranslationCandidateCacheKey,
  TranslationContext,
  TranslationRequest,
  TranslationSelfCheckAttestation,
  TranslationSelfCheckPlan,
  TranslationValidationIssue,
} from "./types";

interface AuditCandidate {
  analysis: SemanticAuditAnalysis;
  audit: SemanticAuditDefinition;
  catalog: CatalogAdapter;
  contentRole: TranslationContentRole | undefined;
  context: TranslationContext | undefined;
  contextDigest: string;
  existingState: SyncStateEntry | undefined;
  inputDigest: string;
  path: string;
  request: SemanticAuditRequest;
  skipProviderAudit: boolean;
  stateKey: string;
  sourceRef: DocumentRef;
  sourceEntry: Entry;
  storedStateKey: string;
  targetRef: DocumentRef;
}

interface CandidateCacheSemanticDecision {
  candidate: AuditCandidate;
  status: SemanticAuditStatus;
}

interface AuditRetirement {
  auditId: string;
  catalog: CatalogAdapter;
  catalogId: string;
  existingAudit: SemanticAuditProvenance;
  existingState: SyncStateEntry;
  locale: string;
  path: string;
  pointer: string;
  sourceRef: DocumentRef;
  sourceText: string;
  stateKey: string;
  storedStateKey: string;
  targetRef: DocumentRef;
  targetText: string;
  unitId: string;
}

interface AuditOutcome {
  candidate: AuditCandidate;
  provenance: SemanticAuditProvenance;
}

interface ProviderAuditBatch {
  candidates: readonly AuditCandidate[];
  requests: readonly SemanticAuditRequest[];
}

interface ProviderAuditResult {
  adversarial?: SemanticAuditResponse;
  candidate: AuditCandidate;
  consensusResult: ReturnType<typeof consensus>;
  forward: SemanticAuditResponse;
  order: number;
}

const SEMANTICALLY_TRIVIAL_EVIDENCE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "aux",
  "da",
  "de",
  "del",
  "dem",
  "den",
  "der",
  "des",
  "det",
  "die",
  "do",
  "een",
  "ein",
  "eine",
  "el",
  "en",
  "et",
  "for",
  "het",
  "in",
  "la",
  "le",
  "les",
  "na",
  "no",
  "of",
  "on",
  "or",
  "os",
  "the",
  "to",
  "um",
  "un",
  "uma",
  "une",
  "von",
  "zu",
]);

/**
 * Rejects evidence that is literal but cannot independently identify any
 * semantic atom. Compact quantities and conventional uppercase concepts remain
 * valid because claims such as `1%`, `€5`, and `EV` can be complete evidence.
 */
export function isSemanticallySubstantiveEvidenceSpan(
  span: SemanticAuditEvidenceSpan
): boolean {
  const quote = span.quote.normalize("NFKC").trim();
  if (quote.length === 0) {
    return false;
  }

  if (
    /^(?:(?:EUR|GBP|USD|[€£$])\s*\p{N}+(?:(?:[.,]\p{N}+)|[ '’]\p{N}{3})*|\p{N}+(?:(?:[.,]\p{N}+)|[ '’]\p{N}{3})*\s*(?:EUR|GBP|USD|[€£$]|%|\p{L}{1,8}))$/iu.test(
      quote
    )
  ) {
    return true;
  }

  if (/^[\p{Lu}\p{N}]{2,8}$/u.test(quote) && /\p{Lu}/u.test(quote)) {
    return true;
  }

  const words = quote.match(/\p{L}[\p{L}\p{M}\p{N}]*/gu) ?? [];
  if (words.length === 0) {
    return false;
  }
  return words.some((word) => {
    const normalizedWord = word.toLocaleLowerCase("und");
    return (
      word.length >= 3 &&
      !SEMANTICALLY_TRIVIAL_EVIDENCE_WORDS.has(normalizedWord)
    );
  });
}

function acceptanceIdentity(
  candidate: AuditCandidate,
  config?: AiTranslateConfig
): SemanticAuditAcceptanceIdentity {
  const request = pendingRequest(candidate);
  return {
    acceptanceMode:
      statusFromDeterministic(candidate) === "accepted"
        ? "deterministic"
        : usesGeneratorSelfCheck(config)
        ? "generator-self-check"
        : "provider",
    auditMode: candidate.audit.mode ?? "dual",
    adversarialModelId: candidate.audit.adversarialModelId,
    adversarialPromptRevision: candidate.audit.adversarialPromptRevision,
    auditId: candidate.audit.id,
    auditRevision: candidate.audit.revision,
    deterministicEvaluationsDigest: digestValue(
      stableStringify(candidate.analysis.deterministicEvaluations ?? [])
    ),
    forwardModelId: candidate.audit.forwardModelId,
    forwardPromptRevision: candidate.audit.forwardPromptRevision,
    inputDigest: candidate.inputDigest,
    providerRevision: candidate.audit.providerRevision,
    requestKey: request.key,
    requirementIds: request.requirements.map(({ id }) => id),
  };
}

interface CollectedAudits {
  candidates: AuditCandidate[];
  issues: SemanticAuditIssue[];
  retirements: AuditRetirement[];
}

const MATERIAL_FAILURES = new Set([
  "broadened",
  "contradicted",
  "narrowed",
  "omitted",
]);

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

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function resolveCatalogs(
  config: AiTranslateConfig,
  options: AuditCatalogsOptions
): readonly CatalogAdapter[] {
  if (!options.catalogIds || options.catalogIds.length === 0) {
    return config.catalogs;
  }

  const requested = new Set(options.catalogIds);
  const catalogs = config.catalogs.filter(({ id }) => requested.has(id));
  const matched = new Set(catalogs.map(({ id }) => id));
  const missing = [...requested].filter((id) => !matched.has(id));
  if (missing.length > 0) {
    throw new Error(
      `No catalog matched requested catalogId "${missing[0] ?? ""}".`
    );
  }

  return catalogs;
}

function resolveLocales(
  config: AiTranslateConfig,
  options: AuditCatalogsOptions
): readonly string[] {
  const locales = [...new Set(options.locales ?? config.targetLocales)];
  if (locales.includes(config.sourceLocale)) {
    throw new Error("targetLocales must not include sourceLocale.");
  }

  return locales;
}

function resolveCurrentContext(args: {
  catalogId: string;
  config: AiTranslateConfig;
  contentRole: TranslationContentRole | undefined;
  entry: Entry;
  locale: string;
  path: string;
  unitId: string;
}): { context: TranslationContext | undefined; contextDigest: string } {
  const baseContext = resolveTranslationContext({
    catalogId: args.catalogId,
    locale: args.locale,
    path: args.path,
    unitId: args.unitId,
    ...(args.config.context?.project === undefined
      ? {}
      : { baseContext: args.config.context.project }),
    ...(args.config.context?.overrides === undefined
      ? {}
      : { rules: args.config.context.overrides }),
  });
  const { context, revision: requestContextRevision } = resolveRequestContext({
    ...args,
    baseContext,
  });
  return {
    context,
    contextDigest: digestTranslationInstructions({
      contentRole: args.contentRole,
      context,
      requestContextRevision,
      revision:
        args.contentRole === undefined
          ? undefined
          : args.config.contentRoleRevisions?.[args.contentRole],
    }),
  };
}

function findStateEntry(args: {
  catalogId: string;
  locale: string;
  pointer: string;
  state: SyncStateSnapshot;
  unitId: string;
}): { entry: SyncStateEntry | undefined; key: string; storedKey: string } {
  const key = makeStateKey(
    args.locale,
    args.catalogId,
    args.unitId,
    args.pointer
  );
  const legacyKey = makeLegacyStateKey(args.locale, args.unitId, args.pointer);
  const modernEntry = args.state.entries[key];
  if (modernEntry !== undefined) {
    return { entry: modernEntry, key, storedKey: key };
  }

  return {
    entry: args.state.entries[legacyKey],
    key,
    storedKey: args.state.entries[legacyKey] === undefined ? key : legacyKey,
  };
}

function validateAnalysis(
  auditId: string,
  analysis: SemanticAuditAnalysis
): void {
  const requirementIds = new Set<string>();
  for (const requirement of analysis.requirements) {
    if (requirement.id.length === 0 || requirementIds.has(requirement.id)) {
      throw new Error(
        `Semantic audit "${auditId}" returned an empty or duplicate requirement id.`
      );
    }
    requirementIds.add(requirement.id);
  }

  const evaluationIds = new Set<string>();
  for (const evaluation of analysis.deterministicEvaluations ?? []) {
    if (!requirementIds.has(evaluation.requirementId)) {
      throw new Error(
        `Semantic audit "${auditId}" evaluated unknown requirement "${evaluation.requirementId}".`
      );
    }
    if (evaluationIds.has(evaluation.requirementId)) {
      throw new Error(
        `Semantic audit "${auditId}" evaluated requirement "${evaluation.requirementId}" twice.`
      );
    }
    evaluationIds.add(evaluation.requirementId);
  }
}

function createInputDigest(args: {
  analysis: SemanticAuditAnalysis;
  audit: SemanticAuditDefinition;
  catalogId: string;
  contextDigest: string;
  locale: string;
  path: string;
  sourceText: string;
  targetText: string;
  unitId: string;
}): string {
  return digestValue(
    stableStringify({
      adversarialPromptRevision: args.audit.adversarialPromptRevision,
      adversarialModelId: args.audit.adversarialModelId,
      analysis: args.analysis,
      auditMode: args.audit.mode ?? "dual",
      auditId: args.audit.id,
      auditRevision: args.audit.revision,
      catalogId: args.catalogId,
      contextDigest: args.contextDigest,
      forwardPromptRevision: args.audit.forwardPromptRevision,
      forwardModelId: args.audit.forwardModelId,
      locale: args.locale,
      path: args.path,
      providerRevision: args.audit.providerRevision,
      sourceDigest: digestValue(args.sourceText),
      targetDigest: digestValue(args.targetText),
      unitId: args.unitId,
    })
  );
}

function createRequestDigest(args: {
  analysis: SemanticAuditAnalysis;
  audit: SemanticAuditDefinition;
  catalogId: string;
  contextDigest: string;
  locale: string;
  path: string;
  sourceText: string;
  targetText: string;
  unitId: string;
}): string {
  return digestValue(
    stableStringify({
      analysis: args.analysis,
      auditMode: args.audit.mode ?? "dual",
      auditId: args.audit.id,
      catalogId: args.catalogId,
      contextDigest: args.contextDigest,
      locale: args.locale,
      path: args.path,
      providerRevision: args.audit.providerRevision,
      sourceDigest: digestValue(args.sourceText),
      targetDigest: digestValue(args.targetText),
      unitId: args.unitId,
    })
  );
}

interface ResolvedSemanticAuditArtifact {
  analysis: SemanticAuditAnalysis;
  audit: SemanticAuditDefinition;
  identity: SemanticAuditAcceptanceIdentity;
}

function acceptanceIdentityForArtifact(args: {
  analysis: SemanticAuditAnalysis;
  audit: SemanticAuditDefinition;
  config: AiTranslateConfig;
  contextDigest: string;
  request: SemanticAuditAnalysisArgs;
}): SemanticAuditAcceptanceIdentity {
  const { analysis, audit, config, contextDigest, request } = args;
  const inputDigest = createInputDigest({
    analysis,
    audit,
    catalogId: request.catalogId,
    contextDigest,
    locale: request.locale,
    path: request.path,
    sourceText: request.sourceText,
    targetText: request.targetText,
    unitId: request.unitId,
  });
  const requestDigest = createRequestDigest({
    analysis,
    audit,
    catalogId: request.catalogId,
    contextDigest,
    locale: request.locale,
    path: request.path,
    sourceText: request.sourceText,
    targetText: request.targetText,
    unitId: request.unitId,
  });
  const trustedDeterministicIds = new Set(
    (analysis.deterministicEvaluations ?? [])
      .filter((evaluation) =>
        isTrustedDeterministicEvaluation(
          request.sourceText,
          request.targetText,
          evaluation
        )
      )
      .map(({ requirementId }) => requirementId)
  );
  const deterministicAccepted =
    (analysis.deterministicEvaluations?.length ?? 0) > 0 &&
    analysis.requirements.every(({ id }) => trustedDeterministicIds.has(id)) &&
    trustedDeterministicIds.size ===
      (analysis.deterministicEvaluations?.length ?? 0);
  const requirementIds = deterministicAccepted
    ? []
    : analysis.requirements
        .filter(({ id }) => !trustedDeterministicIds.has(id))
        .map(({ id }) => id);
  const stateKey = makeStateKey(
    request.locale,
    request.catalogId,
    request.unitId,
    request.path
  );
  return {
    acceptanceMode: deterministicAccepted
      ? "deterministic"
      : usesGeneratorSelfCheck(config)
      ? "generator-self-check"
      : "provider",
    adversarialModelId: audit.adversarialModelId,
    adversarialPromptRevision: audit.adversarialPromptRevision,
    auditMode: audit.mode ?? "dual",
    auditId: audit.id,
    auditRevision: audit.revision,
    deterministicEvaluationsDigest: digestValue(
      stableStringify(analysis.deterministicEvaluations ?? [])
    ),
    forwardModelId: audit.forwardModelId,
    forwardPromptRevision: audit.forwardPromptRevision,
    inputDigest,
    providerRevision: audit.providerRevision,
    requestKey: `${audit.id}:${stateKey}:${requestDigest}`,
    requirementIds,
  };
}

async function resolveApplicableSemanticAuditArtifacts(
  config: AiTranslateConfig,
  args: SemanticAuditAnalysisArgs
): Promise<readonly ResolvedSemanticAuditArtifact[]> {
  const artifacts: ResolvedSemanticAuditArtifact[] = [];
  for (const audit of config.semanticAudits ?? []) {
    const analysis = await audit.analyze(args);
    if (!analysis || analysis.requirements.length === 0) {
      continue;
    }
    validateAnalysis(audit.id, analysis);
    const contextDigest =
      args.contextDigest ?? digestValue(stableStringify(args.context ?? null));
    const identity = acceptanceIdentityForArtifact({
      analysis,
      audit,
      config,
      contextDigest,
      request: args,
    });
    artifacts.push({ analysis, audit, identity });
  }
  return artifacts.toSorted((left, right) =>
    left.identity.auditId.localeCompare(right.identity.auditId)
  );
}

export async function resolveApplicableSemanticAuditIdentities(
  config: AiTranslateConfig,
  args: SemanticAuditAnalysisArgs
): Promise<readonly SemanticAuditAcceptanceIdentity[]> {
  return (await resolveApplicableSemanticAuditArtifacts(config, args)).map(
    ({ identity }) => identity
  );
}

export async function resolveContextRebindSemanticAuditIdentities(
  config: AiTranslateConfig,
  args: SemanticAuditAnalysisArgs,
  previousContextDigest: string
): Promise<{
  current: readonly SemanticAuditAcceptanceIdentity[];
  previous: readonly SemanticAuditAcceptanceIdentity[];
}> {
  const artifacts = await resolveApplicableSemanticAuditArtifacts(config, args);
  return {
    current: artifacts.map(({ identity }) => identity),
    previous: artifacts.map(({ analysis, audit }) =>
      acceptanceIdentityForArtifact({
        analysis,
        audit,
        config,
        contextDigest: previousContextDigest,
        request: args,
      })
    ),
  };
}

export async function resolveTranslationSelfCheckPlans(
  config: AiTranslateConfig,
  args: SemanticAuditAnalysisArgs
): Promise<readonly TranslationSelfCheckPlan[]> {
  if (!usesGeneratorSelfCheck(config)) {
    return [];
  }

  const plans: TranslationSelfCheckPlan[] = [];
  for (const audit of config.semanticAudits ?? []) {
    const analysis = await audit.analyze({ ...args, targetText: "" });
    if (!analysis || analysis.requirements.length === 0) {
      continue;
    }
    validateAnalysis(audit.id, analysis);
    const material = {
      auditId: audit.id,
      auditRevision: audit.revision,
      promptRevision: audit.forwardPromptRevision,
      providerRevision: audit.providerRevision,
      requirements: analysis.requirements,
    };
    plans.push({
      ...material,
      digest: digestValue(stableStringify(material)),
    });
  }
  return plans.toSorted((left, right) =>
    left.auditId.localeCompare(right.auditId)
  );
}

export interface GeneratorSelfCheckValidationResult {
  issues: readonly TranslationValidationIssue[];
  validationAudits: Readonly<Record<string, SemanticAuditProvenance>>;
}

export async function createGeneratorSelfCheckValidation(
  config: AiTranslateConfig,
  args: SemanticAuditAnalysisArgs & {
    attestation: TranslationSelfCheckAttestation | undefined;
    plans: readonly TranslationSelfCheckPlan[];
  }
): Promise<GeneratorSelfCheckValidationResult> {
  if (!usesGeneratorSelfCheck(config)) {
    return { issues: [], validationAudits: {} };
  }

  /*
   * An attestation proves the model checked the facets it was given. With no
   * applicable audits there are no facets, so demanding one only forces every
   * request to carry an empty self-check payload and every response to echo it
   * back — and turns a missing echo into a hard failure over nothing.
   */
  if (args.plans.length === 0) {
    return { issues: [], validationAudits: {} };
  }

  const expectedPlanDigests = args.plans.map(({ digest }) => digest).toSorted();
  const actualPlanDigests = args.attestation?.planDigests.toSorted() ?? [];
  if (
    args.attestation?.verified !== true ||
    args.attestation.modelId.trim().length === 0 ||
    stableStringify(actualPlanDigests) !== stableStringify(expectedPlanDigests)
  ) {
    return {
      issues: [
        {
          code: "generator-self-check-missing",
          message:
            "The translation response did not attest the exact source-derived semantic self-check plan.",
          severity: "error",
        },
      ],
      validationAudits: {},
    };
  }

  const planByAuditId = new Map(
    args.plans.map((plan) => [plan.auditId, plan] as const)
  );
  const artifacts = await resolveApplicableSemanticAuditArtifacts(config, args);
  const issues: TranslationValidationIssue[] = [];
  const validationAudits: Record<string, SemanticAuditProvenance> = {};

  for (const { analysis, audit, identity } of artifacts) {
    const materialFailure = (analysis.deterministicEvaluations ?? []).find(
      (evaluation) => MATERIAL_FAILURES.has(evaluation.verdict)
    );
    if (materialFailure !== undefined) {
      issues.push({
        code: "generator-self-check-deterministic-failure",
        message: `Semantic facet ${materialFailure.requirementId} failed deterministic verification (${materialFailure.verdict}).`,
        severity: "error",
      });
      continue;
    }

    if (identity.acceptanceMode === "deterministic") {
      validationAudits[audit.id] = {
        auditedAt: new Date().toISOString(),
        auditMode: audit.mode ?? "dual",
        auditRevision: audit.revision,
        ...(analysis.deterministicEvaluations === undefined
          ? {}
          : { deterministicEvaluations: analysis.deterministicEvaluations }),
        inputDigest: identity.inputDigest,
        provenanceOrigin: "deterministic",
        providerRevision: audit.providerRevision,
        schemaVersion: 1,
        status: "accepted",
      };
      continue;
    }

    const plan = planByAuditId.get(audit.id);
    if (plan === undefined) {
      issues.push({
        code: "generator-self-check-plan-mismatch",
        message: `No source-derived self-check plan covered semantic audit ${audit.id}.`,
        severity: "error",
      });
      continue;
    }

    const consensusEvaluations: SemanticAuditConsensusEvaluation[] =
      identity.requirementIds.map((requirementId) => {
        const forward: SemanticAuditEvaluation = {
          confidence: "high",
          evidence: [
            {
              end: args.sourceText.length,
              field: "source",
              quote: args.sourceText,
              start: 0,
            },
            {
              end: args.targetText.length,
              field: "target",
              quote: args.targetText,
              start: 0,
            },
          ],
          reason:
            "The generation response verified this source-derived facet after revising the final translation.",
          requirementId,
          verdict: "preserved",
        };
        return { forward, requirementId, status: "accepted" };
      });
    validationAudits[audit.id] = {
      auditedAt: new Date().toISOString(),
      auditMode: audit.mode ?? "dual",
      auditRevision: audit.revision,
      consensusEvaluations,
      ...((analysis.deterministicEvaluations?.length ?? 0) === 0
        ? {}
        : { deterministicEvaluations: analysis.deterministicEvaluations }),
      generatorModelId: args.attestation.modelId,
      generatorSelfCheckDigest: createGeneratorSelfCheckDigest({
        identity,
        modelId: args.attestation.modelId,
        sourceText: args.sourceText,
        targetText: args.targetText,
      }),
      inputDigest: identity.inputDigest,
      provenanceOrigin: "generator-self-check",
      providerRevision: audit.providerRevision,
      schemaVersion: 1,
      status: "accepted",
    };
  }

  return { issues, validationAudits };
}

async function collectCandidates(
  config: AiTranslateConfig,
  options: AuditCatalogsOptions,
  state: SyncStateSnapshot
): Promise<CollectedAudits> {
  const audits = config.semanticAudits ?? [];
  const duplicateAuditIds = audits.filter(
    ({ id }, index) =>
      audits.findIndex((candidate) => candidate.id === id) !== index
  );
  if (duplicateAuditIds.length > 0) {
    throw new Error(
      `Duplicate semantic audit id "${duplicateAuditIds[0]?.id ?? ""}".`
    );
  }
  for (const audit of audits) {
    const requiredFields = [
      ["id", audit.id],
      ["revision", audit.revision],
      ["providerRevision", audit.providerRevision],
      ["forwardModelId", audit.forwardModelId],
      ["forwardPromptRevision", audit.forwardPromptRevision],
      ["adversarialModelId", audit.adversarialModelId],
      ["adversarialPromptRevision", audit.adversarialPromptRevision],
    ] as const;
    const missing = requiredFields.find(
      ([, value]) => value.trim().length === 0
    );
    if (missing) {
      throw new Error(
        `Semantic audit "${audit.id}" requires a non-empty ${missing[0]}.`
      );
    }
    if (
      audit.batchSize !== undefined &&
      (!Number.isInteger(audit.batchSize) || audit.batchSize < 1)
    ) {
      throw new Error(
        `Semantic audit "${audit.id}" batchSize must be a positive integer.`
      );
    }
  }

  const candidates: AuditCandidate[] = [];
  const issues: SemanticAuditIssue[] = [];
  const retirements: AuditRetirement[] = [];
  const configuredAuditIds = new Set(audits.map(({ id }) => id));
  const requestedUnits = options.unitIds ? new Set(options.unitIds) : undefined;
  const locales = resolveLocales(config, options);

  /*
   * Every document an audit inspects is read before any of them is analyzed.
   * Reading them one at a time makes an audit cost a round trip per document
   * per locale, which on a large corpus dwarfs the analysis it exists to run;
   * the reads are independent, so they share the run's document budget. The
   * analysis below still walks documents in ref order, so which read landed
   * first cannot change the candidates or issues an audit produces.
   */
  const concurrency = resolveDocumentConcurrency(config, options);
  const sourceRequests = (
    await Promise.all(
      resolveCatalogs(config, options).map(async (catalog) => {
        const refs = await catalog.listDocumentRefs(config.sourceLocale);
        return refs
          .filter(
            (sourceRef) =>
              requestedUnits === undefined ||
              requestedUnits.has(sourceRef.unitId)
          )
          .map((sourceRef) => ({ catalog, sourceRef }));
      })
    )
  ).flat();
  const matchedUnits = new Set(
    sourceRequests.map(({ sourceRef }) => sourceRef.unitId)
  );

  const loadedSources = await runWithConcurrency(
    sourceRequests,
    concurrency,
    async ({ catalog, sourceRef }) => {
      const sourceDocument = await catalog.loadDocument(sourceRef);
      if (!sourceDocument) {
        throw new Error(`Missing source document at ${sourceRef.path}.`);
      }
      return { catalog, sourceDocument, sourceRef };
    }
  );

  const loadedTargets = await runWithConcurrency(
    loadedSources.flatMap((source) =>
      locales.map((locale) => ({ locale, source }))
    ),
    concurrency,
    async ({ locale, source }) => {
      const targetRef = source.catalog.createDocumentRef(
        source.sourceRef,
        locale
      );
      return {
        locale,
        source,
        targetDocument: await source.catalog.loadDocument(targetRef),
        targetRef,
      };
    }
  );

  for (const {
    locale,
    source: { catalog, sourceDocument, sourceRef },
    targetDocument,
    targetRef,
  } of loadedTargets) {
    const sourceEntries = mapEntriesByPointer(
      sourceDocument,
      addressToJsonPointer
    );

    if (!targetDocument) {
      for (const audit of audits) {
        issues.push({
          auditId: audit.id,
          catalogId: catalog.id,
          code: "semantic-audit-missing-target-document",
          inputDigest: digestValue(
            stableStringify({ auditId: audit.id, locale, targetRef })
          ),
          jsonPointer: "",
          locale,
          message: `Semantic audit "${audit.id}" cannot inspect missing target document ${targetRef.path}.`,
          path: targetRef.path,
          severity: "error",
          status: "missing",
          unitId: targetRef.unitId,
        });
      }
      continue;
    }
    const targetEntries = mapEntriesByPointer(
      targetDocument,
      addressToJsonPointer
    );

    for (const [pointer, sourceEntry] of sourceEntries) {
      if (
        options.includePaths !== undefined &&
        !options.includePaths.includes(pointer)
      ) {
        continue;
      }
      const targetEntry = targetEntries.get(pointer);
      const isTranslated =
        resolvePolicy({
          catalogId: catalog.id,
          entry: sourceEntry,
          locale,
          unitId: sourceRef.unitId,
          ...(config.policies === undefined ? {} : { rules: config.policies }),
        }) === "translate";
      if (!isTranslated || typeof sourceEntry.value !== "string") {
        continue;
      }
      if (!targetEntry || typeof targetEntry.value !== "string") {
        for (const audit of audits) {
          issues.push({
            auditId: audit.id,
            catalogId: catalog.id,
            code: targetEntry
              ? "semantic-audit-incompatible-target-entry"
              : "semantic-audit-missing-target-entry",
            inputDigest: digestValue(
              stableStringify({
                auditId: audit.id,
                locale,
                pointer,
                sourceDigest: digestValue(sourceEntry.value),
                unitId: targetRef.unitId,
              })
            ),
            jsonPointer: pointer,
            locale,
            message: targetEntry
              ? `Semantic audit "${audit.id}" requires a string target at ${pointer}.`
              : `Semantic audit "${audit.id}" cannot inspect missing target entry ${pointer}.`,
            path: targetRef.path,
            severity: "error",
            status: "missing",
            unitId: targetRef.unitId,
          });
        }
        continue;
      }

      const stateRecord = findStateEntry({
        catalogId: catalog.id,
        locale,
        pointer,
        state,
        unitId: sourceRef.unitId,
      });
      const sourceText = sourceEntry.value;
      const targetText = targetEntry.value;
      if (
        isLegacyAcceptanceMigrationExempt({
          config,
          sourceText,
          stateEntry: stateRecord.entry,
          targetText,
        })
      ) {
        continue;
      }
      const hasRejectedLegacyAudit = Object.values(
        stateRecord.entry?.validationAudits ?? {}
      ).some((audit) => audit.status !== "accepted");

      const skipLegacyProviderAudit =
        config.validation?.legacyUnverifiedSemanticPolicy ===
          "skip-provider" &&
        stateRecord.entry?.origin === "generated" &&
        stateRecord.entry.status === "synced" &&
        stateRecord.entry.sourceDigest === digestValue(sourceText) &&
        stateRecord.entry.targetDigest === digestValue(targetText) &&
        !hasRejectedLegacyAudit &&
        stateRecord.entry.generationRevision ===
          LEGACY_UNVERIFIED_GENERATION_REVISION;

      const contentRole = config.contentRole?.({
        catalogId: catalog.id,
        entry: sourceEntry,
        locale,
        path: pointer,
        unitId: sourceRef.unitId,
      });
      const { context, contextDigest } = resolveCurrentContext({
        catalogId: catalog.id,
        config,
        contentRole,
        entry: sourceEntry,
        locale,
        path: pointer,
        unitId: sourceRef.unitId,
      });
      const queueRetirement = (
        auditId: string,
        existingAudit: SemanticAuditProvenance
      ) => {
        if (!stateRecord.entry) {
          return;
        }
        retirements.push({
          auditId,
          catalog,
          catalogId: catalog.id,
          existingAudit,
          existingState: stateRecord.entry,
          locale,
          path: targetRef.path,
          pointer,
          sourceRef,
          sourceText,
          stateKey: stateRecord.key,
          storedStateKey: stateRecord.storedKey,
          targetRef,
          targetText,
          unitId: sourceRef.unitId,
        });
      };

      for (const [auditId, existingAudit] of Object.entries(
        stateRecord.entry?.validationAudits ?? {}
      )) {
        if (!configuredAuditIds.has(auditId)) {
          queueRetirement(auditId, existingAudit);
        }
      }

      for (const audit of audits) {
        const analyzerArgs = {
          catalogId: catalog.id,
          ...(contentRole === undefined ? {} : { contentRole }),
          ...(context === undefined ? {} : { context }),
          entry: sourceEntry,
          ...(stateRecord.entry === undefined
            ? {}
            : { existingState: stateRecord.entry }),
          locale,
          path: pointer,
          sourceText: sourceEntry.value,
          targetText: targetEntry.value,
          unitId: sourceRef.unitId,
        };
        const analysis = await audit.analyze(analyzerArgs);
        if (!analysis || analysis.requirements.length === 0) {
          const existingAudit =
            stateRecord.entry?.validationAudits?.[audit.id];
          if (existingAudit) {
            queueRetirement(audit.id, existingAudit);
          }
          continue;
        }
        validateAnalysis(audit.id, analysis);
        const inputDigest = createInputDigest({
          analysis,
          audit,
          catalogId: catalog.id,
          contextDigest,
          locale,
          path: pointer,
          sourceText: sourceEntry.value,
          targetText: targetEntry.value,
          unitId: sourceRef.unitId,
        });
        const requestDigest = createRequestDigest({
          analysis,
          audit,
          catalogId: catalog.id,
          contextDigest,
          locale,
          path: pointer,
          sourceText: sourceEntry.value,
          targetText: targetEntry.value,
          unitId: sourceRef.unitId,
        });
        const key = `${audit.id}:${stateRecord.key}:${requestDigest}`;
        candidates.push({
          analysis,
          audit,
          catalog,
          contentRole,
          context,
          contextDigest,
          existingState: stateRecord.entry,
          inputDigest,
          path: targetRef.path,
          request: {
            auditId: audit.id,
            catalogId: catalog.id,
            deterministicEvaluations: analysis.deterministicEvaluations ?? [],
            inputDigest,
            key,
            locale,
            path: pointer,
            requestDigest,
            requirements: analysis.requirements,
            sourceText,
            targetText,
            unitId: sourceRef.unitId,
          },
          skipProviderAudit: skipLegacyProviderAudit,
          stateKey: stateRecord.key,
          storedStateKey: stateRecord.storedKey,
          sourceRef,
          sourceEntry,
          targetRef,
        });
      }
    }
  }
  if (requestedUnits) {
    const missing = [...requestedUnits].filter(
      (unitId) => !matchedUnits.has(unitId)
    );
    if (missing.length > 0) {
      throw new Error(
        `No source document matched requested unitId "${missing[0] ?? ""}".`
      );
    }
  }
  return { candidates, issues, retirements };
}

function statusFromDeterministic(
  candidate: AuditCandidate
): SemanticAuditStatus | undefined {
  const evaluations = candidate.analysis.deterministicEvaluations ?? [];
  if (evaluations.some(({ verdict }) => MATERIAL_FAILURES.has(verdict))) {
    return "retranslate";
  }
  const trustedPreserved = evaluations.filter((evaluation) =>
    isTrustedDeterministicPreservation(candidate, evaluation)
  );
  const evaluated = new Set(
    trustedPreserved.map(({ requirementId }) => requirementId)
  );
  if (
    candidate.analysis.requirements.every(({ id }) => evaluated.has(id)) &&
    trustedPreserved.length === evaluations.length
  ) {
    return "accepted";
  }
  return undefined;
}

function isTrustedDeterministicPreservation(
  candidate: AuditCandidate,
  evaluation: SemanticAuditEvaluation
): boolean {
  return isTrustedDeterministicEvaluation(
    candidate.request.sourceText,
    candidate.request.targetText,
    evaluation
  );
}

export function isTrustedDeterministicEvaluation(
  sourceText: string,
  targetText: string,
  evaluation: SemanticAuditEvaluation
): boolean {
  if (
    evaluation.verdict !== "preserved" ||
    evaluation.confidence !== "high" ||
    evaluation.reason?.trim().length === 0
  ) {
    return false;
  }

  const evidence = evaluation.evidence ?? [];
  return (["source", "target"] as const).every((field) =>
    evidence.some((span) => {
      if (
        span.field !== field ||
        span.start < 0 ||
        span.end <= span.start ||
        span.quote.length === 0
      ) {
        return false;
      }
      const text = field === "source" ? sourceText : targetText;
      return (
        span.end <= text.length &&
        text.slice(span.start, span.end) === span.quote &&
        isSemanticallySubstantiveEvidenceSpan(span)
      );
    })
  );
}

function pendingRequest(candidate: AuditCandidate): SemanticAuditRequest {
  const deterministic = new Map(
    (candidate.analysis.deterministicEvaluations ?? []).map((item) => [
      item.requirementId,
      item,
    ])
  );
  return {
    ...candidate.request,
    requirements: candidate.request.requirements.filter(({ id }) => {
      const evaluation = deterministic.get(id);
      return (
        evaluation === undefined ||
        !isTrustedDeterministicPreservation(candidate, evaluation)
      );
    }),
  };
}

function responseMap(
  pass: "adversarial" | "forward",
  expectedModelId: string,
  requests: readonly SemanticAuditRequest[],
  responses: readonly SemanticAuditResponse[]
): Map<string, SemanticAuditResponse> {
  const requestKeys = new Set(requests.map(({ key }) => key));
  const map = new Map<string, SemanticAuditResponse>();
  for (const response of responses) {
    if (!requestKeys.has(response.key)) {
      throw new Error(
        `Semantic audit ${pass} pass returned unknown key "${response.key}".`
      );
    }
    if (map.has(response.key)) {
      throw new Error(
        `Semantic audit ${pass} pass returned duplicate key "${response.key}".`
      );
    }
    map.set(response.key, response);
  }
  for (const request of requests) {
    const response = map.get(request.key);
    if (!response) {
      throw new Error(
        `Semantic audit ${pass} pass omitted key "${request.key}".`
      );
    }
    if (response.modelId !== expectedModelId) {
      throw new Error(
        `Semantic audit ${pass} pass returned modelId "${response.modelId}" instead of "${expectedModelId}".`
      );
    }
    const requirementIds = new Set(request.requirements.map(({ id }) => id));
    const evaluations = new Map<
      string,
      (typeof response.evaluations)[number]
    >();
    for (const evaluation of response.evaluations) {
      if (
        ![
          "ambiguous",
          "broadened",
          "contradicted",
          "narrowed",
          "omitted",
          "preserved",
        ].includes(evaluation.verdict) ||
        !["high", "low", "medium"].includes(evaluation.confidence ?? "")
      ) {
        throw new Error(
          `Semantic audit ${pass} pass returned an invalid verdict or confidence for "${evaluation.requirementId}".`
        );
      }
      if (!requirementIds.has(evaluation.requirementId)) {
        throw new Error(
          `Semantic audit ${pass} pass evaluated unknown requirement "${evaluation.requirementId}".`
        );
      }
      if (evaluations.has(evaluation.requirementId)) {
        throw new Error(
          `Semantic audit ${pass} pass evaluated requirement "${evaluation.requirementId}" twice.`
        );
      }
      if (
        typeof evaluation.reason !== "string" ||
        evaluation.reason.trim().length === 0
      ) {
        throw new Error(
          `Semantic audit ${pass} pass omitted a reason for "${evaluation.requirementId}".`
        );
      }
      if (
        !Array.isArray(evaluation.evidence) ||
        evaluation.evidence.length === 0
      ) {
        throw new Error(
          `Semantic audit ${pass} pass omitted evidence for "${evaluation.requirementId}".`
        );
      }
      const evidenceFields = new Set<"source" | "target">();
      const substantiveEvidenceFields = new Set<"source" | "target">();
      for (const span of evaluation.evidence) {
        if (span.field !== "source" && span.field !== "target") {
          throw new Error(
            `Semantic audit ${pass} pass returned an invalid evidence field for "${evaluation.requirementId}".`
          );
        }
        const text =
          span.field === "source" ? request.sourceText : request.targetText;
        if (
          !Number.isInteger(span.start) ||
          !Number.isInteger(span.end) ||
          span.start < 0 ||
          span.end <= span.start ||
          span.end > text.length ||
          text.slice(span.start, span.end) !== span.quote
        ) {
          throw new Error(
            `Semantic audit ${pass} pass returned a non-literal evidence span for "${evaluation.requirementId}".`
          );
        }
        if (
          (evaluation.verdict === "preserved" ||
            evaluation.verdict === "ambiguous") &&
          isSemanticallySubstantiveEvidenceSpan(span)
        ) {
          substantiveEvidenceFields.add(span.field);
        }
        evidenceFields.add(span.field);
      }
      const requiresBilateralEvidence =
        evaluation.verdict === "preserved" ||
        evaluation.verdict === "ambiguous";
      if (
        requiresBilateralEvidence &&
        (!evidenceFields.has("source") || !evidenceFields.has("target"))
      ) {
        throw new Error(
          `Semantic audit ${pass} pass must cite source and target evidence for ${evaluation.verdict} requirement "${evaluation.requirementId}".`
        );
      }
      if (
        requiresBilateralEvidence &&
        (!substantiveEvidenceFields.has("source") ||
          !substantiveEvidenceFields.has("target"))
      ) {
        throw new Error(
          `Semantic audit ${pass} pass returned semantically trivial ${evaluation.verdict} evidence for "${evaluation.requirementId}".`
        );
      }
      evaluations.set(evaluation.requirementId, evaluation);
    }
    for (const requirement of request.requirements) {
      if (!evaluations.has(requirement.id)) {
        throw new Error(
          `Semantic audit ${pass} pass omitted requirement "${requirement.id}" for "${request.key}".`
        );
      }
    }
  }
  return map;
}

function consensus(
  request: SemanticAuditRequest,
  forward: SemanticAuditResponse,
  adversarial: SemanticAuditResponse | undefined,
  auditMode: "dual" | "single"
): {
  evaluations: SemanticAuditConsensusEvaluation[];
  status: SemanticAuditStatus;
} {
  const forwardMap = new Map(
    forward.evaluations.map((evaluation) => [
      evaluation.requirementId,
      evaluation,
    ])
  );
  const adversarialMap = new Map(
    (adversarial?.evaluations ?? []).map((evaluation) => [
      evaluation.requirementId,
      evaluation,
    ])
  );
  const evaluations = request.requirements.map(
    ({ id }): SemanticAuditConsensusEvaluation => {
      const forwardEvaluation = forwardMap.get(id);
      const adversarialEvaluation = adversarialMap.get(id);
      let status: SemanticAuditStatus = "unresolved";
      if (
        [
          forwardEvaluation,
          ...(auditMode === "dual" ? [adversarialEvaluation] : []),
        ].some(
          (evaluation) =>
            evaluation && MATERIAL_FAILURES.has(evaluation.verdict)
        )
      ) {
        status = "retranslate";
      } else if (
        auditMode === "single" &&
        forwardEvaluation?.verdict === "preserved" &&
        forwardEvaluation.confidence !== "low"
      ) {
        status = "accepted";
      } else if (
        auditMode === "dual" &&
        forwardEvaluation?.verdict === "preserved" &&
        forwardEvaluation.confidence === "high" &&
        adversarialEvaluation?.verdict === "preserved" &&
        adversarialEvaluation.confidence === "high"
      ) {
        status = "accepted";
      }
      return {
        ...(adversarialEvaluation === undefined
          ? {}
          : { adversarial: adversarialEvaluation }),
        ...(forwardEvaluation === undefined
          ? {}
          : { forward: forwardEvaluation }),
        requirementId: id,
        status,
      };
    }
  );
  return {
    evaluations,
    status: evaluations.some(({ status }) => status === "retranslate")
      ? "retranslate"
      : evaluations.every(({ status }) => status === "accepted")
      ? "accepted"
      : "unresolved",
  };
}

export interface SemanticAuditAcceptanceContractMaterial {
  readonly implementation: readonly string[];
  readonly schemaVersion: 1;
}

/**
 * Stable provenance material for semantic response validation and consensus.
 * Transport, batching, cache persistence, and unrelated sync code are omitted.
 */
export const SEMANTIC_AUDIT_ACCEPTANCE_CONTRACT_MATERIAL: SemanticAuditAcceptanceContractMaterial =
  {
    implementation: [
      isSemanticallySubstantiveEvidenceSpan,
      isTrustedDeterministicEvaluation,
      responseMap,
      consensus,
    ].map((value) => value.toString()),
    schemaVersion: 1,
  };

export function createSemanticAuditAcceptanceContractRevision(
  material: unknown = SEMANTIC_AUDIT_ACCEPTANCE_CONTRACT_MATERIAL
): string {
  return `sha256:${digestValue(JSON.stringify(material))}`;
}

export const SEMANTIC_AUDIT_ACCEPTANCE_CONTRACT_REVISION: string =
  createSemanticAuditAcceptanceContractRevision();

function provenance(
  candidate: AuditCandidate,
  status: SemanticAuditStatus,
  responses: {
    adversarial?: SemanticAuditResponse;
    consensusEvaluations?: readonly SemanticAuditConsensusEvaluation[];
    forward?: SemanticAuditResponse;
  } = {}
): SemanticAuditProvenance {
  return {
    ...(responses.adversarial === undefined
      ? {}
      : {
          adversarialModelId: responses.adversarial.modelId,
          adversarialResponseDigest: digestValue(
            stableStringify(responses.adversarial)
          ),
        }),
    auditedAt: new Date().toISOString(),
    auditMode: candidate.audit.mode ?? "dual",
    auditRevision: candidate.audit.revision,
    ...(responses.consensusEvaluations === undefined
      ? {}
      : { consensusEvaluations: responses.consensusEvaluations }),
    ...((candidate.analysis.deterministicEvaluations?.length ?? 0) === 0
      ? {}
      : {
          deterministicEvaluations: candidate.analysis.deterministicEvaluations,
        }),
    ...(responses.forward === undefined
      ? {}
      : {
          forwardModelId: responses.forward.modelId,
          forwardResponseDigest: digestValue(
            stableStringify(responses.forward)
          ),
        }),
    inputDigest: candidate.inputDigest,
    providerRevision: candidate.audit.providerRevision,
    schemaVersion: 1,
    status,
  };
}

function issue(
  candidate: AuditCandidate,
  status: SemanticAuditIssue["status"]
): SemanticAuditIssue {
  return {
    auditId: candidate.audit.id,
    catalogId: candidate.request.catalogId,
    code: `semantic-audit-${status}`,
    inputDigest: candidate.inputDigest,
    jsonPointer: candidate.request.path,
    locale: candidate.request.locale,
    message: `Semantic audit "${candidate.audit.id}" is ${status} for ${candidate.request.path}.`,
    path: candidate.path,
    severity: "error",
    status,
    unitId: candidate.request.unitId,
  };
}

function retirementIssue(retirement: AuditRetirement): SemanticAuditIssue {
  return {
    auditId: retirement.auditId,
    catalogId: retirement.catalogId,
    code: "semantic-audit-stale",
    inputDigest: retirement.existingAudit.inputDigest,
    jsonPointer: retirement.pointer,
    locale: retirement.locale,
    message: `Semantic audit "${retirement.auditId}" is no longer applicable at ${retirement.pointer}. Run the audit command to retire its cached finding.`,
    path: retirement.path,
    severity: "error",
    status: "stale",
    unitId: retirement.unitId,
  };
}

function hasValidCommonProvenance(
  candidate: AuditCandidate,
  cached: SemanticAuditProvenance
): boolean {
  return (
    cached.schemaVersion === 1 &&
    typeof cached.inputDigest === "string" &&
    cached.inputDigest === candidate.inputDigest &&
    (cached.auditMode ?? "dual") === (candidate.audit.mode ?? "dual") &&
    cached.auditRevision === candidate.audit.revision &&
    cached.providerRevision === candidate.audit.providerRevision &&
    typeof cached.auditedAt === "string" &&
    Number.isFinite(Date.parse(cached.auditedAt)) &&
    ["accepted", "retranslate", "unresolved"].includes(cached.status)
  );
}

function hasMatchingDeterministicEvaluations(
  candidate: AuditCandidate,
  cached: SemanticAuditProvenance
): boolean {
  return (
    stableStringify(cached.deterministicEvaluations ?? []) ===
    stableStringify(candidate.analysis.deterministicEvaluations ?? [])
  );
}

function hasValidProviderProvenance(
  candidate: AuditCandidate,
  cached: SemanticAuditProvenance
): boolean {
  const request = pendingRequest(candidate);
  const consensusEvaluations = cached.consensusEvaluations;
  const auditMode = candidate.audit.mode ?? "dual";
  if (
    cached.forwardModelId !== candidate.audit.forwardModelId ||
    !cached.forwardResponseDigest ||
    (auditMode === "dual" &&
      (cached.adversarialModelId !== candidate.audit.adversarialModelId ||
        !cached.adversarialResponseDigest)) ||
    (auditMode === "single" &&
      (cached.adversarialModelId !== undefined ||
        cached.adversarialResponseDigest !== undefined)) ||
    !Array.isArray(consensusEvaluations) ||
    consensusEvaluations.length !== request.requirements.length
  ) {
    return false;
  }

  const forwardResponse: SemanticAuditResponse = {
    evaluations: consensusEvaluations.flatMap(({ forward }) =>
      forward ? [forward] : []
    ),
    key: request.key,
    modelId: cached.forwardModelId,
  };
  const adversarialResponse: SemanticAuditResponse | undefined =
    auditMode === "dual" && cached.adversarialModelId !== undefined
      ? {
          evaluations: consensusEvaluations.flatMap(({ adversarial }) =>
            adversarial ? [adversarial] : []
          ),
          key: request.key,
          modelId: cached.adversarialModelId,
        }
      : undefined;

  try {
    responseMap(
      "forward",
      candidate.audit.forwardModelId,
      [request],
      [forwardResponse]
    );
    if (adversarialResponse !== undefined) {
      responseMap(
        "adversarial",
        candidate.audit.adversarialModelId,
        [request],
        [adversarialResponse]
      );
    }
  } catch {
    return false;
  }

  const recomputed = consensus(
    request,
    forwardResponse,
    adversarialResponse,
    auditMode
  );
  return (
    recomputed.status === cached.status &&
    stableStringify(recomputed.evaluations) ===
      stableStringify(consensusEvaluations) &&
    digestValue(stableStringify(forwardResponse)) ===
      cached.forwardResponseDigest &&
    (auditMode === "single" ||
      (adversarialResponse !== undefined &&
        digestValue(stableStringify(adversarialResponse)) ===
          cached.adversarialResponseDigest))
  );
}

function cachedProvenance(
  config: AiTranslateConfig,
  candidate: AuditCandidate
): SemanticAuditProvenance | undefined {
  const cached =
    candidate.existingState?.validationAudits?.[candidate.audit.id];
  if (
    !cached ||
    !hasValidCommonProvenance(candidate, cached) ||
    !hasMatchingDeterministicEvaluations(candidate, cached)
  ) {
    return undefined;
  }

  const deterministicStatus = statusFromDeterministic(candidate);
  if (deterministicStatus !== undefined) {
    return cached.status === deterministicStatus &&
      cached.consensusEvaluations === undefined &&
      cached.forwardModelId === undefined &&
      cached.forwardResponseDigest === undefined &&
      cached.adversarialModelId === undefined &&
      cached.adversarialResponseDigest === undefined
      ? cached
      : undefined;
  }

  if (cached.provenanceOrigin === "generator-self-check") {
    return hasAcceptedSemanticAudits(
      [acceptanceIdentity(candidate, config)],
      candidate.existingState,
      candidate.request.sourceText,
      candidate.request.targetText
    )
      ? cached
      : undefined;
  }

  return hasValidProviderProvenance(candidate, cached) ? cached : undefined;
}

function candidateCacheKey(
  config: AiTranslateConfig,
  candidate: AuditCandidate
): TranslationCandidateCacheKey | undefined {
  const identity = resolveCandidateCacheIdentity(config);
  if (
    config.candidateCache === undefined ||
    config.generationRevision === undefined ||
    identity === undefined
  ) {
    return undefined;
  }
  const request: TranslationRequest = {
    catalogId: candidate.request.catalogId,
    ...(candidate.contentRole === undefined
      ? {}
      : { contentRole: candidate.contentRole }),
    ...(candidate.context === undefined ? {} : { context: candidate.context }),
    key: candidate.request.path,
    locale: candidate.request.locale,
    path: candidate.targetRef.path,
    provenance: {
      catalogId: candidate.request.catalogId,
      jsonPointer: candidate.request.path,
      unitId: candidate.request.unitId,
    },
    sourceText: candidate.request.sourceText,
    unitId: candidate.request.unitId,
  };
  const contentRoleRevision =
    candidate.contentRole === undefined
      ? undefined
      : config.contentRoleRevisions?.[candidate.contentRole];
  return createTranslationCandidateCacheKey({
    ...(contentRoleRevision === undefined ? {} : { contentRoleRevision }),
    generationRevision: config.generationRevision,
    ...(config.glossary === undefined ? {} : { glossary: config.glossary }),
    identity,
    instructionDigest: candidate.contextDigest,
    request,
  });
}

async function applyCandidateCacheSemanticDecisions(
  config: AiTranslateConfig,
  decisions: readonly CandidateCacheSemanticDecision[]
): Promise<void> {
  if (
    config.candidateCache === undefined ||
    config.generationRevision === undefined
  ) {
    return;
  }
  await Promise.all(
    decisions.map(async ({ candidate, status }) => {
      const key = candidateCacheKey(config, candidate);
      if (key === undefined) {
        return;
      }
      try {
        if (status === "accepted") {
          await config.candidateCache?.store.promote(
            key,
            candidate.request.targetText
          );
        } else {
          await config.candidateCache?.store.reject(
            key,
            candidate.request.targetText
          );
        }
      } catch {
        // Candidate caching is an optimization. A cache decision must not
        // change semantic-audit correctness or the surrounding transaction.
      }
    })
  );
}

export async function auditCatalogs(
  config: AiTranslateConfig,
  options: AuditCatalogsOptions = {}
): Promise<SemanticAuditResult> {
  const state = await config.state.load();
  if (state.version !== 1 && state.version !== 2) {
    throw new Error(
      `Unsupported ai-translate state version "${String(state.version)}".`
    );
  }
  const collected = await collectCandidates(config, options, state);
  const { candidates, retirements } = collected;
  const issues: SemanticAuditIssue[] = [...collected.issues];
  const outcomes: AuditOutcome[] = [];
  const candidateCacheDecisions: CandidateCacheSemanticDecision[] = [];
  const providerCandidates: AuditCandidate[] = [];
  let accepted = 0;
  let cached = 0;
  let retranslate = 0;
  let unresolved = collected.issues.length;

  for (const candidate of candidates) {
    const existing = cachedProvenance(config, candidate);
    if (
      !options.refresh &&
      existing &&
      (options.checkOnly || existing.status !== "unresolved")
    ) {
      cached += 1;
      if (existing.status === "accepted") {
        accepted += 1;
      } else if (existing.status === "retranslate") {
        retranslate += 1;
      } else {
        unresolved += 1;
      }
      if (existing.status !== "accepted") {
        issues.push(issue(candidate, existing.status));
      }
      if (!options.checkOnly) {
        candidateCacheDecisions.push({ candidate, status: existing.status });
      }
      continue;
    }

    const deterministicStatus = statusFromDeterministic(candidate);
    if (candidate.skipProviderAudit && deterministicStatus === undefined) {
      continue;
    }

    if (
      options.checkOnly ||
      usesGeneratorSelfCheck(config)
    ) {
      issues.push(
        issue(
          candidate,
          candidate.existingState?.validationAudits?.[candidate.audit.id]
            ? "stale"
            : "missing"
        )
      );
      unresolved += 1;
      continue;
    }

    if (deterministicStatus !== undefined) {
      if (deterministicStatus === "accepted") {
        accepted += 1;
      } else {
        retranslate += 1;
        issues.push(issue(candidate, "retranslate"));
      }
      outcomes.push({
        candidate,
        provenance: provenance(candidate, deterministicStatus),
      });
      continue;
    }
    providerCandidates.push(candidate);
  }

  if (options.checkOnly) {
    for (const retirement of retirements) {
      issues.push(retirementIssue(retirement));
      unresolved += 1;
    }
  }

  const groups = new Map<string, AuditCandidate[]>();
  for (const candidate of providerCandidates) {
    const key = `${candidate.audit.id}\u0000${candidate.request.locale}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const candidateOrder = new Map(
    providerCandidates.map((candidate, index) => [candidate, index] as const)
  );
  const batchQueues = [...groups.values()].map((localeGroup) => {
    const batchSize = localeGroup[0]?.audit.batchSize ?? 50;
    const batches: ProviderAuditBatch[] = [];
    for (let offset = 0; offset < localeGroup.length; offset += batchSize) {
      const groupCandidates = localeGroup.slice(offset, offset + batchSize);
      batches.push({
        candidates: groupCandidates,
        requests: groupCandidates.map(pendingRequest),
      });
    }
    return batches;
  });
  const batches: ProviderAuditBatch[] = [];
  const largestQueue = Math.max(0, ...batchQueues.map(({ length }) => length));
  for (let batchIndex = 0; batchIndex < largestQueue; batchIndex += 1) {
    for (const queue of batchQueues) {
      const batch = queue[batchIndex];
      if (batch !== undefined) {
        batches.push(batch);
      }
    }
  }

  const batchResults = await runWithConcurrency(
    batches,
    resolveDocumentConcurrency(config, options),
    async ({
      candidates: batchCandidates,
      requests,
    }): Promise<ProviderAuditResult[]> => {
      const first = batchCandidates[0];
      if (!first) {
        return [];
      }
      const auditMode = first.audit.mode ?? "dual";
      const forwardCall = first.audit.provider.audit({
        auditId: first.audit.id,
        locale: first.request.locale,
        modelId: first.audit.forwardModelId,
        pass: "forward",
        promptRevision: first.audit.forwardPromptRevision,
        requests,
      });
      const [forwardResult, adversarialResult] = await Promise.allSettled([
        forwardCall,
        ...(auditMode === "single"
          ? []
          : [
              first.audit.provider.audit({
                auditId: first.audit.id,
                locale: first.request.locale,
                modelId: first.audit.adversarialModelId,
                pass: "adversarial",
                promptRevision: first.audit.adversarialPromptRevision,
                requests,
              }),
            ]),
      ]);
      if (forwardResult.status === "rejected") {
        throw forwardResult.reason;
      }
      if (adversarialResult?.status === "rejected") {
        throw adversarialResult.reason;
      }
      const forwardResponses = forwardResult.value;
      const forward = responseMap(
        "forward",
        first.audit.forwardModelId,
        requests,
        forwardResponses
      );
      const adversarial =
        adversarialResult?.status === "fulfilled"
          ? responseMap(
              "adversarial",
              first.audit.adversarialModelId,
              requests,
              adversarialResult.value
            )
          : undefined;
      return batchCandidates.flatMap(
        (candidate, index): ProviderAuditResult[] => {
          const request = requests[index];
          if (!request) {
            return [];
          }
          const forwardResponse = forward.get(request.key);
          const adversarialResponse = adversarial?.get(request.key);
          if (
            !forwardResponse ||
            (auditMode === "dual" && !adversarialResponse)
          ) {
            return [];
          }
          return [
            {
              ...(adversarialResponse === undefined
                ? {}
                : { adversarial: adversarialResponse }),
              candidate,
              consensusResult: consensus(
                request,
                forwardResponse,
                adversarialResponse,
                auditMode
              ),
              forward: forwardResponse,
              order: candidateOrder.get(candidate) ?? Number.MAX_SAFE_INTEGER,
            },
          ];
        }
      );
    }
  );
  const providerResults = batchResults
    .flat()
    .toSorted((left, right) => left.order - right.order);
  for (const {
    adversarial,
    candidate,
    consensusResult,
    forward,
  } of providerResults) {
    const { status } = consensusResult;
    if (status === "accepted") {
      accepted += 1;
    } else if (status === "retranslate") {
      retranslate += 1;
    } else {
      unresolved += 1;
    }
    if (status !== "accepted") {
      issues.push(issue(candidate, status));
    }
    outcomes.push({
      candidate,
      provenance: provenance(candidate, status, {
        ...(adversarial === undefined ? {} : { adversarial }),
        consensusEvaluations: consensusResult.evaluations,
        forward,
      }),
    });
  }

  if (
    !options.checkOnly &&
    (outcomes.length > 0 ||
      retirements.length > 0 ||
      (config.validation?.enforceAcceptanceProvenance === true &&
        candidates.length > 0))
  ) {
    await config.state.withLock(async () => {
      const current = await config.state.load();
      const next: SyncStateSnapshot = {
        entries: { ...current.entries },
        version: current.version,
      };
      const liveEntries = new Map<string, Promise<Map<string, Entry> | null>>();
      const loadLiveEntries = (
        catalog: CatalogAdapter,
        ref: DocumentRef
      ): Promise<Map<string, Entry> | null> => {
        const key = `${catalog.id}\u0000${ref.locale}\u0000${ref.path}`;
        const pending = liveEntries.get(key);
        if (pending) {
          return pending;
        }
        const loaded = catalog
          .loadDocument(ref)
          .then((document) =>
            document
              ? mapEntriesByPointer(document, addressToJsonPointer)
              : null
          );
        liveEntries.set(key, loaded);
        return loaded;
      };
      for (const retirement of retirements) {
        const currentEntry = next.entries[retirement.storedStateKey];
        const [sourceEntries, targetEntries] = await Promise.all([
          loadLiveEntries(retirement.catalog, retirement.sourceRef),
          loadLiveEntries(retirement.catalog, retirement.targetRef),
        ]);
        const liveSource = sourceEntries?.get(retirement.pointer)?.value;
        const liveTarget = targetEntries?.get(retirement.pointer)?.value;
        const currentAudit =
          currentEntry?.validationAudits?.[retirement.auditId];
        if (
          !currentEntry ||
          liveSource !== retirement.sourceText ||
          liveTarget !== retirement.targetText ||
          currentEntry.sourceDigest !== digestValue(retirement.sourceText) ||
          currentEntry.targetDigest !== digestValue(retirement.targetText) ||
          (currentEntry.translationContextDigest ?? "") !==
            (retirement.existingState.translationContextDigest ?? "") ||
          stableStringify(currentAudit) !==
            stableStringify(retirement.existingAudit)
        ) {
          issues.push(retirementIssue(retirement));
          unresolved += 1;
          continue;
        }

        const { [retirement.auditId]: _, ...remainingAudits } =
          currentEntry.validationAudits ?? {};
        const nextEntry: SyncStateEntry = { ...currentEntry };
        if (Object.keys(remainingAudits).length === 0) {
          delete nextEntry.validationAudits;
        } else {
          nextEntry.validationAudits = remainingAudits;
        }
        nextEntry.catalogId = retirement.catalogId;
        if (retirement.storedStateKey !== retirement.stateKey) {
          delete next.entries[retirement.storedStateKey];
        }
        next.entries[retirement.stateKey] = nextEntry;
      }
      for (const { candidate, provenance: auditProvenance } of outcomes) {
        const currentEntry =
          next.entries[candidate.storedStateKey] ??
          next.entries[candidate.stateKey];
        const [sourceEntries, targetEntries] = await Promise.all([
          loadLiveEntries(candidate.catalog, candidate.sourceRef),
          loadLiveEntries(candidate.catalog, candidate.targetRef),
        ]);
        const liveSource = sourceEntries?.get(candidate.request.path)?.value;
        const liveTarget = targetEntries?.get(candidate.request.path)?.value;
        if (
          !currentEntry ||
          liveSource !== candidate.request.sourceText ||
          liveTarget !== candidate.request.targetText ||
          currentEntry.sourceDigest !==
            digestValue(candidate.request.sourceText) ||
          currentEntry.targetDigest !==
            digestValue(candidate.request.targetText) ||
          (currentEntry.translationContextDigest ?? "") !==
            (candidate.existingState?.translationContextDigest ?? "")
        ) {
          if (auditProvenance.status === "accepted") {
            accepted -= 1;
          } else if (auditProvenance.status === "retranslate") {
            retranslate -= 1;
          } else {
            unresolved -= 1;
          }
          issues.push(issue(candidate, "stale"));
          unresolved += 1;
          continue;
        }
        next.entries[candidate.stateKey] = {
          ...currentEntry,
          catalogId: candidate.request.catalogId,
          validationAudits: {
            ...currentEntry.validationAudits,
            [candidate.audit.id]: auditProvenance,
          },
        };
        if (candidate.storedStateKey !== candidate.stateKey) {
          delete next.entries[candidate.storedStateKey];
        }
        candidateCacheDecisions.push({
          candidate,
          status: auditProvenance.status,
        });
      }

      if (config.validation?.enforceAcceptanceProvenance === true) {
        const candidatesByStateKey = new Map<string, AuditCandidate[]>();
        for (const candidate of candidates) {
          const bucket = candidatesByStateKey.get(candidate.stateKey) ?? [];
          bucket.push(candidate);
          candidatesByStateKey.set(candidate.stateKey, bucket);
        }
        for (const [stateKey, entryCandidates] of candidatesByStateKey) {
          const first = entryCandidates[0];
          if (!first) {
            continue;
          }
          const currentEntry =
            next.entries[stateKey] ?? next.entries[first.storedStateKey];
          const [sourceEntries, targetEntries] = await Promise.all([
            loadLiveEntries(first.catalog, first.sourceRef),
            loadLiveEntries(first.catalog, first.targetRef),
          ]);
          const liveSource = sourceEntries?.get(first.request.path)?.value;
          const liveTarget = targetEntries?.get(first.request.path)?.value;
          if (
            !currentEntry ||
            liveSource !== first.request.sourceText ||
            liveTarget !== first.request.targetText ||
            currentEntry.sourceDigest !==
              digestValue(first.request.sourceText) ||
            currentEntry.targetDigest !== digestValue(first.request.targetText)
          ) {
            continue;
          }

          const acceptedContractRevision =
            await resolveAcceptedContractRevision({
              catalogId: first.request.catalogId,
              config,
              ...(first.contentRole === undefined
                ? {}
                : { contentRole: first.contentRole }),
              ...(first.context === undefined
                ? {}
                : { context: first.context }),
              contextDigest: first.contextDigest,
              entry: first.sourceEntry,
              existingState: currentEntry,
              locale: first.request.locale,
              path: first.request.path,
              semanticAudits: entryCandidates.map((candidate) =>
                acceptanceIdentity(candidate, config)
              ),
              sourceText: first.request.sourceText,
              targetText: first.request.targetText,
              unitId: first.request.unitId,
            });
          const nextEntry: SyncStateEntry = { ...currentEntry };
          if (acceptedContractRevision === undefined) {
            delete nextEntry.acceptedContractRevision;
          } else {
            nextEntry.acceptedContractRevision = acceptedContractRevision;
          }
          next.entries[stateKey] = nextEntry;
          if (first.storedStateKey !== stateKey) {
            delete next.entries[first.storedStateKey];
          }
        }
      }
      await config.state.save(next);
    });
  }

  if (!options.checkOnly) {
    await applyCandidateCacheSemanticDecisions(config, candidateCacheDecisions);
  }

  return {
    accepted,
    audited: outcomes.length,
    cached,
    checked: candidates.length + collected.issues.length + retirements.length,
    issues,
    retranslate,
    unresolved,
  };
}
