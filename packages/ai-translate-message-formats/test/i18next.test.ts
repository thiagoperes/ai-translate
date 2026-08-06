import { describe, expect, it } from "vitest";

import { i18nextMessageFormat, i18nextPluralKeys } from "../src/i18next";
import { pluralCategoriesFor, seedPluralCategory } from "../src/plural";

function codes(sourceText: string, targetText: string): string[] {
  return i18nextMessageFormat
    .validateParity({ locale: "de", sourceLocale: "en", sourceText, targetText })
    .map((issue) => issue.code);
}

describe("i18nextMessageFormat", () => {
  it("keeps the plain double-brace interpolation contract", () => {
    expect(codes("Page {{page}} of {{total}}", "Seite {{page}} von {{total}}")).toEqual([]);
    expect(codes("Page {{page}}", "Seite")).toEqual(["token-count-mismatch"]);
  });

  it("rejects a translated nesting key", () => {
    // `$t(common:cancel)` resolves another key at runtime. Translating the key
    // itself produces a message that renders the raw string in production.
    expect(codes("Press $t(common:cancel)", "Drücken Sie $t(common:abbrechen)")).toEqual([
      "i18next-nesting-mismatch",
    ]);
  });

  it("accepts a nesting call that moves within the sentence", () => {
    expect(codes("Press $t(common:cancel) now", "Jetzt $t(common:cancel) drücken")).toEqual([]);
  });

  it("rejects a dropped nesting call", () => {
    expect(codes("Press $t(common:cancel)", "Drücken Sie Abbrechen")).toEqual([
      "i18next-nesting-mismatch",
    ]);
  });

  it("accepts several nesting calls whose order the translation changes", () => {
    // German puts the verb last, so a faithful translation reorders the two
    // calls. Comparing them as a sorted set keeps that from reading as a loss.
    expect(
      codes(
        "$t(common:save) or $t(common:cancel)",
        "$t(common:cancel) oder $t(common:save)",
      ),
    ).toEqual([]);
  });

  it("rejects one substituted call among several", () => {
    expect(
      codes(
        "$t(common:save) or $t(common:cancel)",
        "$t(common:speichern) oder $t(common:cancel)",
      ),
    ).toEqual(["i18next-nesting-mismatch"]);
  });
});

describe("i18nextPluralKeys", () => {
  it("names keys with the suffix i18next resolves at runtime", () => {
    expect(i18nextPluralKeys.formatKey("items", "one")).toBe("items_one");
    expect(i18nextPluralKeys.formatKey("items", "other")).toBe("items_other");
  });

  it("asks the locale, not the source, which categories a file needs", () => {
    expect(i18nextPluralKeys.categoriesFor("pl")).toEqual(["one", "few", "many", "other"]);
    expect(i18nextPluralKeys.categoriesFor("ja")).toEqual(["other"]);
  });

  it("orders groups by base so expansion writes files deterministically", () => {
    expect(
      i18nextPluralKeys
        .groupKeys(["zebras_one", "zebras_other", "apples_one", "apples_other"])
        .map((group) => group.base),
    ).toEqual(["apples", "zebras"]);
  });
});

describe("i18nextPluralKeys.groupKeys", () => {
  it("groups sibling keys that share a base under different categories", () => {
    expect(i18nextPluralKeys.groupKeys(["items_one", "items_other", "title"])).toEqual([
      { base: "items", members: new Map([["one", "items_one"], ["other", "items_other"]]) },
    ]);
  });

  it("does not treat a lone category-suffixed key as a plural", () => {
    // `miscellaneous_other` is a real merchant-category slug. Grouping it would
    // rewrite an enum value into grammar on the next sync.
    expect(
      i18nextPluralKeys.groupKeys(["miscellaneous_other", "groceries", "fuel"]),
    ).toEqual([]);
  });

  it("does not group a base key with a single suffixed sibling", () => {
    // `items` + `items_other` alone is ambiguous, and i18next itself needs at
    // least two forms before plural resolution kicks in.
    expect(i18nextPluralKeys.groupKeys(["items", "items_other"])).toEqual([]);
  });

  it("groups the legacy zero form alongside modern categories", () => {
    const groups = i18nextPluralKeys.groupKeys([
      "automationsCount_zero",
      "automationsCount_one",
      "automationsCount_other",
    ]);

    expect(groups).toHaveLength(1);
    expect([...(groups[0]?.members.keys() ?? [])]).toEqual(["zero", "one", "other"]);
  });

  it("ignores keys whose suffix is not a plural category", () => {
    expect(i18nextPluralKeys.groupKeys(["card_male", "card_female"])).toEqual([]);
  });
});

describe("pluralCategoriesFor", () => {
  it("returns the categories each locale actually distinguishes", () => {
    expect(pluralCategoriesFor("en")).toEqual(["one", "other"]);
    expect(pluralCategoriesFor("pl")).toEqual(["one", "few", "many", "other"]);
    expect(pluralCategoriesFor("ja")).toEqual(["other"]);
    expect(pluralCategoriesFor("ar")).toEqual(["zero", "one", "two", "few", "many", "other"]);
  });

  it("resolves regional tags through their base language", () => {
    expect(pluralCategoriesFor("pt-BR")).toEqual(pluralCategoriesFor("pt"));
  });

  it("falls back to the mandatory other form for an unusable tag", () => {
    expect(pluralCategoriesFor("not a locale")).toEqual(["other"]);
  });

  it("orders categories canonically regardless of locale", () => {
    // Expansion writes keys in this order, so an unstable order would rewrite
    // every localized file on every sync.
    expect(pluralCategoriesFor("cy")).toEqual(["zero", "one", "two", "few", "many", "other"]);
  });
});

describe("seedPluralCategory", () => {
  it("seeds a matching category from itself", () => {
    expect(seedPluralCategory("one", ["one", "other"])).toBe("one");
  });

  it("seeds a category the source lacks from the other form", () => {
    expect(seedPluralCategory("many", ["one", "other"])).toBe("other");
  });
});
