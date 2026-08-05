import { describe, expect, it } from "vitest";

import {
  normalizeTranslationContext,
  resolvePolicy,
  resolveTranslationContext,
} from "../src/policies";
import type { Entry } from "../src/types";

const translateEntry: Entry = {
  address: [
    { key: "teams", kind: "key" },
    { key: "tabs", kind: "key" },
    { index: 0, kind: "index" },
    { key: "key", kind: "key" },
  ],
  policy: "translate",
  storage: "string",
  value: "bo",
};

describe("policy resolution", () => {
  it("applies the last matching wildcard rule", () => {
    const resolved = resolvePolicy({
      catalogId: "home-content",
      entry: translateEntry,
      rules: [
        {
          catalogId: "home-content",
          locale: "fr",
          path: "/teams/tabs/*/key",
          policy: "copy",
          unitId: "home-content",
        },
        {
          catalogId: "home-content",
          locale: "fr",
          path: "/teams/**",
          policy: "exclude",
          unitId: "home-content",
        },
        {
          catalogId: "home-content",
          locale: "fr",
          path: "/teams/tabs/*/key",
          policy: "copy",
          unitId: "home-content",
        },
      ],
      locale: "fr",
      unitId: "home-content",
    });

    expect(resolved).toBe("copy");
  });

  it("composes project context with scoped overrides", () => {
    const resolved = resolveTranslationContext({
      baseContext: {
        notes: "Project voice: concise and direct.",
      },
      catalogId: "marketing",
      locale: "fr",
      rules: [
        {
          catalogId: "marketing",
          context: {
            notes: "Keep the brand slogan in English.",
          },
          unitId: "home",
        },
        {
          context: {
            notes: "Ignore me for other locales.",
          },
          locale: "de",
        },
      ],
      unitId: "home",
    });

    expect(resolved).toEqual({
      notes: "Project voice: concise and direct.\nKeep the brand slogan in English.",
    });
  });

  it("allows scoped context rules to replace the project context", () => {
    const resolved = resolveTranslationContext({
      baseContext: {
        notes: "Default project context.",
      },
      catalogId: "legal",
      locale: "fr",
      rules: [
        {
          catalogId: "legal",
          context: {
            tone: "Use formal legal register.",
          },
          mode: "replace",
          unitId: /terms/u,
        },
      ],
      unitId: "terms-of-use",
    });

    expect(resolved).toEqual({
      tone: "Use formal legal register.",
    });
  });

  it("normalizes, deduplicates, and sorts structured constraints", () => {
    expect(
      normalizeTranslationContext({
        constraints: [
          {
            kind: "required-term",
            match: "normalized-phrase",
            requirement: "required-one-of",
            sourceValues: [" fuel card ", "fuel card"],
            targetValues: [" Tankkarte ", "Tankkarte", "Flottenkarte"],
            value: " fuel card ",
          },
          {
            kind: "required-term",
            match: "normalized-phrase",
            requirement: "required-one-of",
            sourceValues: ["fuel card"],
            targetValue: "Tankkarte",
            targetValues: ["Flottenkarte"],
            value: "fuel card",
          },
        ],
      }),
    ).toEqual({
      constraints: [
        {
          kind: "required-term",
          match: "normalized-phrase",
          requirement: "required-one-of",
          sourceValues: ["fuel card"],
          targetValues: ["Flottenkarte", "Tankkarte"],
          value: "fuel card",
        },
      ],
    });
  });
});
