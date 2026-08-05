import { describe, expect, it, vi } from "vitest";

import {
  collectTranslationIssues,
  createAcceptedContractRevision,
  hasCompleteAcceptedSemanticAuditProvenance,
  resolveAcceptedContractRevision,
  type SemanticAuditAcceptanceIdentity,
  withTranslationIssueCache,
} from "../src/acceptance";
import { digestValue } from "../src/hash";
import type {
  AiTranslateConfig,
  Entry,
  SemanticAuditConsensusEvaluation,
  SemanticAuditEvaluation,
  SemanticAuditProvenance,
  SyncStateEntry,
} from "../src/types";

const deterministicContractRevision = `sha256:${"a".repeat(64)}`;
const entry: Entry = {
  address: [{ key: "claim", kind: "key" }],
  policy: "translate",
  storage: "string",
  value: "A qualified claim",
};

function config(overrides: Partial<AiTranslateConfig> = {}): AiTranslateConfig {
  return {
    catalogs: [],
    provider: { translate: () => Promise.resolve([]) },
    sourceLocale: "en",
    state: {
      load: () => Promise.resolve({ entries: {}, version: 2 }),
      save: () => Promise.resolve(),
      withLock: (operation) => operation(),
    },
    targetLocales: ["de"],
    validation: {
      deterministicContractRevision,
      enforceAcceptanceProvenance: true,
    },
    ...overrides,
  };
}

const baseArgs = {
  catalogId: "messages",
  contextDigest: "context-v1",
  entry,
  locale: "de",
  path: "/claim",
  semanticAudits: [] as readonly SemanticAuditAcceptanceIdentity[],
  sourceText: "A qualified claim",
  targetText: "Eine qualifizierte Aussage",
  unitId: "messages",
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function responseDigest(value: unknown): string {
  return digestValue(JSON.stringify(stableValue(value)));
}

function providerIdentity(
  overrides: Partial<SemanticAuditAcceptanceIdentity> = {},
): SemanticAuditAcceptanceIdentity {
  return {
    acceptanceMode: "provider",
    adversarialModelId: "adversarial-v1",
    adversarialPromptRevision: "adversarial-prompt-v1",
    auditId: "claims",
    auditRevision: "claims-v1",
    deterministicEvaluationsDigest: digestValue("[]"),
    forwardModelId: "forward-v1",
    forwardPromptRevision: "forward-prompt-v1",
    inputDigest: "input-v1",
    providerRevision: "provider-v1",
    requestKey: "claims:de::messages::messages::/claim:input-v1",
    requirementIds: ["claim"],
    ...overrides,
  };
}

function preservedEvaluation(requirementId = "claim"): SemanticAuditEvaluation {
  return {
    confidence: "high",
    evidence: [
      { end: 17, field: "source", quote: "A qualified claim", start: 0 },
      {
        end: 26,
        field: "target",
        quote: "Eine qualifizierte Aussage",
        start: 0,
      },
    ],
    reason: "The qualified claim is preserved.",
    requirementId,
    verdict: "preserved",
  };
}

function acceptedProviderProvenance(args: {
  consensusEvaluations: readonly SemanticAuditConsensusEvaluation[];
  deterministicEvaluations?: readonly SemanticAuditEvaluation[];
  identity: SemanticAuditAcceptanceIdentity;
}): SemanticAuditProvenance {
  const forwardEvaluations = args.consensusEvaluations.flatMap(({ forward }) =>
    forward === undefined ? [] : [forward],
  );
  const adversarialEvaluations = args.consensusEvaluations.flatMap(({ adversarial }) =>
    adversarial === undefined ? [] : [adversarial],
  );
  return {
    adversarialModelId: args.identity.adversarialModelId,
    adversarialResponseDigest: responseDigest({
      evaluations: adversarialEvaluations,
      key: args.identity.requestKey,
      modelId: args.identity.adversarialModelId,
    }),
    auditedAt: "2026-07-21T00:00:00.000Z",
    auditRevision: args.identity.auditRevision,
    consensusEvaluations: args.consensusEvaluations,
    ...(args.deterministicEvaluations === undefined
      ? {}
      : { deterministicEvaluations: args.deterministicEvaluations }),
    forwardModelId: args.identity.forwardModelId,
    forwardResponseDigest: responseDigest({
      evaluations: forwardEvaluations,
      key: args.identity.requestKey,
      modelId: args.identity.forwardModelId,
    }),
    inputDigest: args.identity.inputDigest,
    providerRevision: args.identity.providerRevision,
    schemaVersion: 1,
    status: "accepted",
  };
}

describe("translation issue cache", () => {
  it("reuses identical validation within one explicit run scope only", async () => {
    const validator = vi.fn(() => null);
    const testConfig = config({ validators: [validator] });
    const args = {
      catalogId: "messages",
      config: testConfig,
      entry,
      locale: "de",
      sourceText: "A qualified claim",
      targetText: "Eine qualifizierte Aussage",
      unitId: "messages",
      validationPhase: "candidate" as const,
    };

    await withTranslationIssueCache(async () => {
      await collectTranslationIssues(args);
      await collectTranslationIssues(args);
    });
    expect(validator).toHaveBeenCalledTimes(1);

    await collectTranslationIssues(args);
    await collectTranslationIssues(args);
    expect(validator).toHaveBeenCalledTimes(3);
  });
});

function stateWithAcceptedProvenance(provenance: SemanticAuditProvenance): SyncStateEntry {
  return {
    generationRevision: "legacy-unverified",
    jsonPointer: "/claim",
    locale: "de",
    origin: "generated",
    sourceDigest: "source",
    status: "synced",
    targetDigest: "target",
    unitId: "messages",
    updatedAt: "2026-07-21T00:00:00.000Z",
    validationAudits: { claims: provenance },
  };
}

describe("acceptance provenance", () => {
  it("accepts a low-risk exact input only after the strict deterministic contract passes", async () => {
    const accepted = await resolveAcceptedContractRevision({
      ...baseArgs,
      config: config(),
    });

    expect(accepted).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      createAcceptedContractRevision({
        ...baseArgs,
        config: config(),
        targetText: `${baseArgs.targetText}.`,
      }),
    ).not.toBe(accepted);
  });

  it("does not let existingIssueSeverity downgrade a candidate-contract error into acceptance", async () => {
    const accepted = await resolveAcceptedContractRevision({
      ...baseArgs,
      config: config({
        validation: {
          deterministicContractRevision,
          enforceAcceptanceProvenance: true,
          existingIssueSeverity: { "claim-inverted": "warning" },
        },
        validators: [
          () => ({
            code: "claim-inverted",
            message: "The claim polarity changed.",
            severity: "error",
          }),
        ],
      }),
    });

    expect(accepted).toBeUndefined();
  });

  it("rejects migrated provider acceptance that contradicts a deterministic material failure", async () => {
    const deterministicEvaluations: readonly SemanticAuditEvaluation[] = [
      {
        confidence: "high",
        reason: "The target omitted the material claim.",
        requirementId: "claim",
        verdict: "omitted",
      },
    ];
    const identity = providerIdentity({
      deterministicEvaluationsDigest: responseDigest(deterministicEvaluations),
    });
    const evaluation = preservedEvaluation();
    const provenance = acceptedProviderProvenance({
      consensusEvaluations: [
        {
          adversarial: evaluation,
          forward: evaluation,
          requirementId: "claim",
          status: "accepted",
        },
      ],
      deterministicEvaluations,
      identity,
    });

    expect(hasCompleteAcceptedSemanticAuditProvenance(provenance)).toBe(false);
    expect(
      await resolveAcceptedContractRevision({
        ...baseArgs,
        config: config(),
        existingState: stateWithAcceptedProvenance(provenance),
        semanticAudits: [identity],
      }),
    ).toBeUndefined();
  });

  it.each(["adversarial", "forward"] as const)(
    "rejects corrupt consensus whose outer and %s requirement ids disagree",
    async (mismatchedPass) => {
      const identity = providerIdentity();
      const matchingEvaluation = preservedEvaluation();
      const mismatchedEvaluation = preservedEvaluation("different-claim");
      const provenance = acceptedProviderProvenance({
        consensusEvaluations: [
          {
            adversarial:
              mismatchedPass === "adversarial" ? mismatchedEvaluation : matchingEvaluation,
            forward: mismatchedPass === "forward" ? mismatchedEvaluation : matchingEvaluation,
            requirementId: "claim",
            status: "accepted",
          },
        ],
        identity,
      });

      expect(hasCompleteAcceptedSemanticAuditProvenance(provenance)).toBe(false);
      expect(
        await resolveAcceptedContractRevision({
          ...baseArgs,
          config: config(),
          existingState: stateWithAcceptedProvenance(provenance),
          semanticAudits: [identity],
        }),
      ).toBeUndefined();
    },
  );

  it("requires every applicable semantic audit at its exact current input", async () => {
    const requestKey = "claims:de::messages::messages::/claim:input-v1";
    const semanticAudit: SemanticAuditAcceptanceIdentity = {
      acceptanceMode: "provider",
      adversarialModelId: "adversarial-v1",
      adversarialPromptRevision: "adversarial-prompt-v1",
      auditId: "claims",
      auditRevision: "claims-v1",
      deterministicEvaluationsDigest: digestValue("[]"),
      forwardModelId: "forward-v1",
      forwardPromptRevision: "forward-prompt-v1",
      inputDigest: "input-v1",
      providerRevision: "provider-v1",
      requestKey,
      requirementIds: ["claim"],
    };
    const historicalState: SyncStateEntry = {
      generationRevision: "legacy-unverified",
      jsonPointer: "/claim",
      locale: "de",
      origin: "generated",
      sourceDigest: "source",
      status: "synced",
      targetDigest: "target",
      unitId: "messages",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };

    expect(
      await resolveAcceptedContractRevision({
        ...baseArgs,
        config: config(),
        existingState: historicalState,
        semanticAudits: [semanticAudit],
      }),
    ).toBeUndefined();

    const evaluation = {
      confidence: "high" as const,
      evidence: [
        { end: 17, field: "source" as const, quote: "A qualified claim", start: 0 },
        {
          end: 26,
          field: "target" as const,
          quote: "Eine qualifizierte Aussage",
          start: 0,
        },
      ],
      reason: "The qualified claim is preserved.",
      requirementId: "claim",
      verdict: "preserved" as const,
    };
    const consensusEvaluations = [
      {
        adversarial: evaluation,
        forward: evaluation,
        requirementId: "claim",
        status: "accepted" as const,
      },
    ];
    const acceptedProvenance = {
      adversarialModelId: semanticAudit.adversarialModelId,
      adversarialResponseDigest: responseDigest({
        evaluations: [evaluation],
        key: requestKey,
        modelId: semanticAudit.adversarialModelId,
      }),
      auditedAt: "2026-07-21T00:00:00.000Z",
      auditRevision: semanticAudit.auditRevision,
      consensusEvaluations,
      forwardModelId: semanticAudit.forwardModelId,
      forwardResponseDigest: responseDigest({
        evaluations: [evaluation],
        key: requestKey,
        modelId: semanticAudit.forwardModelId,
      }),
      inputDigest: semanticAudit.inputDigest,
      providerRevision: semanticAudit.providerRevision,
      schemaVersion: 1 as const,
      status: "accepted" as const,
    };
    const acceptedState: SyncStateEntry = {
      ...historicalState,
      validationAudits: {
        claims: acceptedProvenance,
      },
    };
    expect(
      await resolveAcceptedContractRevision({
        ...baseArgs,
        config: config(),
        existingState: acceptedState,
        semanticAudits: [semanticAudit],
      }),
    ).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      await resolveAcceptedContractRevision({
        ...baseArgs,
        config: config(),
        existingState: acceptedState,
        semanticAudits: [{ ...semanticAudit, inputDigest: "input-v2" }],
      }),
    ).toBeUndefined();

    const nonLiteralEvaluation = {
      ...evaluation,
      evidence: [
        { end: 11, field: "source" as const, quote: "not literal", start: 0 },
        evaluation.evidence[1],
      ],
    };
    const nonLiteralConsensus = [
      {
        adversarial: nonLiteralEvaluation,
        forward: nonLiteralEvaluation,
        requirementId: "claim",
        status: "accepted" as const,
      },
    ];
    for (const incomplete of [
      { ...acceptedProvenance, forwardModelId: undefined },
      { ...acceptedProvenance, adversarialResponseDigest: undefined },
      { ...acceptedProvenance, consensusEvaluations: undefined },
      {
        ...acceptedProvenance,
        consensusEvaluations: [
          {
            ...consensusEvaluations[0],
            forward: { ...evaluation, evidence: undefined },
          },
        ],
      },
      {
        ...acceptedProvenance,
        adversarialResponseDigest: responseDigest({
          evaluations: [nonLiteralEvaluation],
          key: requestKey,
          modelId: semanticAudit.adversarialModelId,
        }),
        consensusEvaluations: nonLiteralConsensus,
        forwardResponseDigest: responseDigest({
          evaluations: [nonLiteralEvaluation],
          key: requestKey,
          modelId: semanticAudit.forwardModelId,
        }),
      },
    ]) {
      expect(
        await resolveAcceptedContractRevision({
          ...baseArgs,
          config: config(),
          existingState: {
            ...acceptedState,
            validationAudits: { claims: incomplete as never },
          },
          semanticAudits: [semanticAudit],
        }),
      ).toBeUndefined();
    }
  });
});
