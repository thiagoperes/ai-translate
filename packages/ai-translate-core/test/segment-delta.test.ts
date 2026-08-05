import { describe, expect, it } from "vitest";

import { splitTranslationDeltaSegments } from "../src/segment-delta";

describe("sentence delta segmentation", () => {
  const config = {
    enabled: true,
    maxSegments: 6,
    minSegmentLength: 20,
    minSourceLength: 1,
    semanticAuditCoverage: "exhaustive",
  } as const;

  it("keeps complete sentences and their exact separators", () => {
    expect(
      splitTranslationDeltaSegments(
        "Fleet managers compare total operating costs.  Drivers use compatible cards across supported networks. Finance receives consolidated invoices with transaction data.",
        config,
      ),
    ).toEqual([
      {
        separator: "  ",
        sourceText: "Fleet managers compare total operating costs.",
      },
      {
        separator: " ",
        sourceText: "Drivers use compatible cards across supported networks.",
      },
      {
        separator: "",
        sourceText: "Finance receives consolidated invoices with transaction data.",
      },
    ]);
  });

  it("does not split common abbreviations as sentences", () => {
    expect(
      splitTranslationDeltaSegments(
        "Fleet costs include fees, e.g. network charges and card fees. Finance teams compare monthly charges before approving the invoice.",
        config,
      ),
    ).toEqual([
      {
        separator: " ",
        sourceText: "Fleet costs include fees, e.g. network charges and card fees.",
      },
      {
        separator: "",
        sourceText: "Finance teams compare monthly charges before approving the invoice.",
      },
    ]);
  });

  it("falls back to whole-field translation for short fragments or structural newlines", () => {
    expect(
      splitTranslationDeltaSegments(
        "This is a sufficiently long opening sentence. Too short.",
        config,
      ),
    ).toBeUndefined();
    expect(
      splitTranslationDeltaSegments(
        "This is a sufficiently long opening sentence.\nThis is another sufficiently long sentence.",
        config,
      ),
    ).toBeUndefined();
  });

  it.each([
    "This gives finance teams a simpler reconciliation workflow.",
    "However, finance teams still review transactions before approval.",
    "Drivers never pay fees at supported locations.",
    "Finance teams save 20% across the supported network.",
  ])("rejects context-dependent or claim-sensitive sentences: %s", (riskySentence) => {
    expect(
      splitTranslationDeltaSegments(
        `Fleet managers compare operating costs before selecting a suitable payment method. ${riskySentence}`,
        config,
      ),
    ).toBeUndefined();
  });
});
