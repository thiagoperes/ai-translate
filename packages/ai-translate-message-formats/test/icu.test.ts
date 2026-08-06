import { describe, expect, it } from "vitest";

import { icuMessageFormat } from "../src/icu";

const EN_PLURAL = "{count, plural, one {# follower} other {# followers}}";

function codes(args: { locale: string; sourceText: string; targetText: string }): string[] {
  return icuMessageFormat
    .validateParity({ sourceLocale: "en", ...args })
    .map((issue) => issue.code);
}

describe("icuMessageFormat parity", () => {
  it("accepts a target that adds the plural forms its locale requires", () => {
    // Polish needs one/few/many/other where English needs only one/other. A
    // flat token comparison would reject this correct translation.
    expect(
      codes({
        locale: "pl",
        sourceText: EN_PLURAL,
        targetText:
          "{count, plural, one {# obserwujący} few {# obserwujących} " +
          "many {# obserwujących} other {# obserwującego}}",
      }),
    ).toEqual([]);
  });

  it("accepts a target that collapses to the single form its locale requires", () => {
    expect(
      codes({
        locale: "ja",
        sourceText: EN_PLURAL,
        targetText: "{count, plural, other {#人のフォロワー}}",
      }),
    ).toEqual([]);
  });

  it("rejects a target missing a plural form its locale requires", () => {
    // The classic failure: the model mirrors English's two arms into Polish.
    expect(
      codes({
        locale: "pl",
        sourceText: EN_PLURAL,
        targetText: "{count, plural, one {# obserwujący} other {# obserwujących}}",
      }),
    ).toEqual(["icu-plural-category-missing"]);
  });

  it("rejects a plural form the target locale does not use", () => {
    expect(
      codes({
        locale: "en",
        sourceText: EN_PLURAL,
        targetText: "{count, plural, one {# follower} many {# followers} other {# followers}}",
      }),
    ).toEqual(["icu-plural-category-unexpected"]);
  });

  it("applies ordinal rather than cardinal categories to selectordinal", () => {
    // English ordinals distinguish one/two/few/other ("1st", "2nd", "3rd",
    // "4th") where English cardinals only distinguish one/other.
    expect(
      codes({
        locale: "en",
        sourceText: "{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
        targetText: "{place, selectordinal, one {#st} other {#th}}",
      }),
    ).toEqual(["icu-plural-category-missing"]);
  });

  it("reports a dropped exact selector as a warning, not an error", () => {
    const issues = icuMessageFormat.validateParity({
      locale: "de",
      sourceLocale: "en",
      sourceText: "{count, plural, =0 {No followers yet} one {# follower} other {# followers}}",
      targetText: "{count, plural, one {# Follower} other {# Follower}}",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "icu-plural-exact-dropped", severity: "warning" });
  });

  it("rejects an exact selector the source never had", () => {
    expect(
      codes({
        locale: "de",
        sourceText: EN_PLURAL,
        targetText: "{count, plural, =7 {Sieben} one {# Follower} other {# Follower}}",
      }),
    ).toEqual(["icu-plural-exact-unexpected"]);
  });

  it("rejects a dropped argument", () => {
    expect(
      codes({
        locale: "fr",
        sourceText: "Hello {firstName}, you have {unread} messages",
        targetText: "Bonjour {firstName}, vous avez des messages",
      }),
    ).toEqual(["icu-argument-missing"]);
  });

  it("rejects an invented argument", () => {
    expect(
      codes({
        locale: "fr",
        sourceText: "Hello {firstName}",
        targetText: "Bonjour {firstName} {lastName}",
      }),
    ).toEqual(["icu-argument-unexpected"]);
  });

  it("rejects an argument whose formatting type changed", () => {
    expect(
      codes({
        locale: "fr",
        sourceText: "Due {when, date, short}",
        targetText: "Échéance {when, time, short}",
      }),
    ).toEqual(["icu-argument-type-mismatch"]);
  });

  it("rejects a translation that is not valid ICU", () => {
    expect(
      codes({
        locale: "fr",
        sourceText: EN_PLURAL,
        targetText: "{count, plural, one {# abonné} other {# abonnés}",
      }),
    ).toEqual(["icu-parse-error"]);
  });

  it("stays silent when the source itself does not parse", () => {
    // The source is a separate authoring problem. Failing every locale on it
    // would bury the one issue that matters.
    expect(
      codes({ locale: "fr", sourceText: "{count, plural, one {#}", targetText: "Bonjour" }),
    ).toEqual([]);
  });

  it("compares rich-text tags as a multiset so word order can change", () => {
    expect(
      codes({
        locale: "de",
        sourceText: "Read the <link>guide</link> and the <bold>notes</bold>",
        targetText: "Lies die <bold>Notizen</bold> und den <link>Leitfaden</link>",
      }),
    ).toEqual([]);
  });

  it("rejects a dropped rich-text tag", () => {
    expect(
      codes({
        locale: "de",
        sourceText: "Read the <link>guide</link>",
        targetText: "Lies den Leitfaden",
      }),
    ).toEqual(["icu-tag-mismatch"]);
  });

  it("requires select options to match the source exactly", () => {
    // `select` keys are application values, not grammar, so unlike plurals they
    // must not vary by locale.
    expect(
      codes({
        locale: "de",
        sourceText: "{plan, select, free {Free} pro {Pro} other {Unknown}}",
        targetText: "{plan, select, free {Kostenlos} other {Unbekannt}}",
      }),
    ).toEqual(["icu-select-option-mismatch"]);
  });

  it("validates plurals nested inside a select", () => {
    expect(
      codes({
        locale: "pl",
        sourceText:
          "{plan, select, pro {{count, plural, one {# seat} other {# seats}}} other {None}}",
        targetText:
          "{plan, select, pro {{count, plural, one {# miejsce} other {# miejsc}}} other {Brak}}",
      }),
    ).toEqual(["icu-plural-category-missing"]);
  });
});

describe("icuMessageFormat tokenize", () => {
  it("emits placeholders for arguments and the pound sign", () => {
    expect(icuMessageFormat.tokenize("{count, plural, other {# of {total}}}")).toEqual([
      { name: "count", raw: "{count}", syntax: "single-brace", type: "placeholder" },
      { name: "#", raw: "#", syntax: "single-brace", type: "placeholder" },
      { raw: " of ", type: "text" },
      { name: "total", raw: "{total}", syntax: "single-brace", type: "placeholder" },
    ]);
  });

  it("falls back to a single text token when the message does not parse", () => {
    expect(icuMessageFormat.tokenize("{broken")).toEqual([{ raw: "{broken", type: "text" }]);
  });
});
