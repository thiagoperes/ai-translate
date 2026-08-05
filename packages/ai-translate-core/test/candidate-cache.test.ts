import { describe, expect, it } from "vitest";

import {
  createTranslationCandidateCacheKey,
  selectRelevantGlossaryTerms,
} from "../src/candidate-cache";
import type {
  TranslationCandidateCacheIdentity,
  TranslationContentRole,
  TranslationRequest,
} from "../src/types";

const identity: TranslationCandidateCacheIdentity = {
  modelId: "model-v1",
  providerId: "provider",
  providerRevision: "provider-v1",
};

function request(overrides: Partial<TranslationRequest> = {}): TranslationRequest {
  return {
    catalogId: "messages",
    contentRole: "body",
    key: "/body",
    locale: "de",
    path: "/body",
    provenance: {
      catalogId: "messages",
      jsonPointer: "/body",
      unitId: "messages",
    },
    sourceText: "Source",
    unitId: "messages",
    ...overrides,
  };
}

function key(
  overrides: {
    contentRoleRevision?: string;
    generationRevision?: string;
    glossary?: { source: string; target: string }[];
    identity?: TranslationCandidateCacheIdentity;
    instructionDigest?: string;
    request?: TranslationRequest;
  } = {},
) {
  return createTranslationCandidateCacheKey({
    contentRoleRevision: overrides.contentRoleRevision ?? "role-v1",
    generationRevision: overrides.generationRevision ?? "generation-v1",
    glossary: overrides.glossary ?? [],
    identity: overrides.identity ?? identity,
    instructionDigest: overrides.instructionDigest ?? "instructions-v1",
    request: overrides.request ?? request(),
  });
}

describe("translation candidate cache keys", () => {
  it("is stable for an identical generation request", () => {
    expect(key()).toEqual(key());
  });

  it("uses schemaVersion 2 generation-only identity", () => {
    expect(key().schemaVersion).toBe(2);
    expect(key()).not.toHaveProperty("deterministicContractRevision");
  });

  it.each([
    ["source", () => key({ request: request({ sourceText: "Changed" }) })],
    ["locale", () => key({ request: request({ locale: "fr" }) })],
    ["model", () => key({ identity: { ...identity, modelId: "model-v2" } })],
    ["provider", () => key({ identity: { ...identity, providerId: "other" } })],
    ["provider revision", () =>
      key({ identity: { ...identity, providerRevision: "provider-v2" } })],
    ["generation revision", () => key({ generationRevision: "generation-v2" })],
    ["instruction revision", () => key({ instructionDigest: "instructions-v2" })],
    ["role revision", () => key({ contentRoleRevision: "role-v2" })],
    ["relevant glossary", () =>
      key({
        glossary: [{ source: "Source", target: "Quelle" }],
        request: request({ sourceText: "Source text" }),
      })],
    ["catalog", () => key({ request: request({ catalogId: "pages" }) })],
    ["unit", () => key({ request: request({ unitId: "other" }) })],
    ["path", () => key({ request: request({ path: "/other" }) })],
    ["JSON pointer", () =>
      key({
        request: request({
          key: "/other",
          provenance: {
            catalogId: "messages",
            jsonPointer: "/other",
            unitId: "messages",
          },
        }),
      })],
    ["content role", () =>
      key({ request: request({ contentRole: "heading" as TranslationContentRole }) })],
    ["request context", () =>
      key({ request: request({ context: { notes: "Repair this candidate." } }) })],
  ])("changes when %s changes", (_name, changed) => {
    expect(changed().digest).not.toBe(key().digest);
  });

  it("ignores unrelated glossary terms for generation identity", () => {
    const base = key({
      glossary: [{ source: "card", target: "Karte" }],
      request: request({ sourceText: "Fleet spend platform" }),
    });
    const withUnrelated = key({
      glossary: [
        { source: "card", target: "Karte" },
        { source: "unrelated", target: "irrelevant" },
      ],
      request: request({ sourceText: "Fleet spend platform" }),
    });
    expect(withUnrelated.digest).toBe(base.digest);
  });

  it("selects only glossary terms present in the source", () => {
    expect(
      selectRelevantGlossaryTerms("Best fuel card for fleets", [
        { source: "fuel card", target: "Tankkarte" },
        { source: "invoice", target: "Rechnung" },
      ]),
    ).toEqual([{ source: "fuel card", target: "Tankkarte" }]);
  });
});
