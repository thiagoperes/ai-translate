import { describe, expect, it } from "vitest";

import { validateTranslationConstraints } from "../src/constraints";

describe("validateTranslationConstraints", () => {
  it("matches required SEO phrases across capitalization, punctuation, and whitespace", () => {
    expect(
      validateTranslationConstraints({
        constraints: [
          {
            kind: "required-term",
            requirement: "required-one-of",
            targetValues: ["Fleet card", "Fuel card"],
            value: "fuel card",
          },
        ],
        targetText: "Choose the best FLEET-card for your team.",
      }),
    ).toEqual([]);

    expect(
      validateTranslationConstraints({
        constraints: [
          {
            kind: "literal",
            match: "normalized-phrase",
            requirement: "preserve",
            value: "Acme",
          },
        ],
        targetText: "Usa <a href='/'>Acme</a> para tu flota.",
      }),
    ).toEqual([]);
  });

  it("preserves accents and does not match partial words", () => {
    const constraint = {
      kind: "forbidden-term" as const,
      requirement: "forbid-any" as const,
      targetValues: ["carte carburant"],
      value: "fuel card",
    };

    expect(
      validateTranslationConstraints({
        constraints: [constraint],
        targetText: "Une carte carburante moderne.",
      }),
    ).toEqual([]);
    expect(
      validateTranslationConstraints({
        constraints: [{ ...constraint, targetValues: ["passe"] }],
        targetText: "Utilisez le passé composé.",
      }),
    ).toEqual([]);
  });

  it("keeps preserve constraints exact unless matching is explicitly relaxed", () => {
    const constraint = {
      kind: "literal" as const,
      requirement: "preserve" as const,
      value: "Acme",
    };

    expect(
      validateTranslationConstraints({
        constraints: [constraint],
        targetText: "Use Acme for your fleet.",
      }),
    ).toEqual([]);
    expect(
      validateTranslationConstraints({
        constraints: [constraint],
        targetText: "Acmet kasutatakse autopargi jaoks.",
      }),
    ).toEqual([expect.objectContaining({ code: "constraint-preserve", severity: "error" })]);
    expect(
      validateTranslationConstraints({
        constraints: [constraint],
        targetText: "acme for fleets",
      }),
    ).toEqual([expect.objectContaining({ code: "constraint-preserve", severity: "error" })]);

    expect(
      validateTranslationConstraints({
        constraints: [
          {
            kind: "literal",
            requirement: "preserve",
            value: "Acme®",
          },
        ],
        targetText: "Use Acme® for your fleet.",
      }),
    ).toEqual([]);
  });
});
