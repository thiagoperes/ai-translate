import { describe, expect, it } from "vitest";

import { tokenizeText, validateTokenParity } from "../src/tokens";

describe("tokenization", () => {
  it("returns a text token for strings without placeholders or tags", () => {
    expect(tokenizeText("Plain copy")).toEqual([
      {
        raw: "Plain copy",
        type: "text",
      },
    ]);
  });

  it("detects placeholders and tags", () => {
    expect(
      tokenizeText(
        "Get started with {{plan}} and <TermsOfServiceLink /> in {minutes} minutes.",
      ).filter((token) => token.type !== "text"),
    ).toEqual([
      {
        name: "plan",
        raw: "{{plan}}",
        syntax: "double-brace",
        type: "placeholder",
      },
      {
        flavor: "component",
        name: "TermsOfServiceLink",
        raw: "<TermsOfServiceLink />",
        tagKind: "self",
        type: "tag",
      },
      {
        name: "minutes",
        raw: "{minutes}",
        syntax: "single-brace",
        type: "placeholder",
      },
    ]);
  });

  it("classifies html tags, component tags, and numbered slots", () => {
    expect(tokenizeText("<strong>Save</strong> <0>today</0> <Icon />")).toEqual([
      {
        flavor: "html",
        name: "strong",
        raw: "<strong>",
        tagKind: "open",
        type: "tag",
      },
      {
        raw: "Save",
        type: "text",
      },
      {
        flavor: "html",
        name: "strong",
        raw: "</strong>",
        tagKind: "close",
        type: "tag",
      },
      {
        raw: " ",
        type: "text",
      },
      {
        flavor: "slot",
        name: "0",
        raw: "<0>",
        tagKind: "open",
        type: "tag",
      },
      {
        raw: "today",
        type: "text",
      },
      {
        flavor: "slot",
        name: "0",
        raw: "</0>",
        tagKind: "close",
        type: "tag",
      },
      {
        raw: " ",
        type: "text",
      },
      {
        flavor: "component",
        name: "Icon",
        raw: "<Icon />",
        tagKind: "self",
        type: "tag",
      },
    ]);
  });

  it("protects Markdown link and image destinations while leaving labels translatable", () => {
    expect(
      tokenizeText("Read [the fleet guide](/blog/fleet-guide) or ![chart](/images/chart.webp)."),
    ).toEqual([
      { raw: "Read ", type: "text" },
      { raw: "[", type: "markdown-opener" },
      { raw: "the fleet guide", type: "text" },
      { raw: "](/blog/fleet-guide)", type: "markdown-destination" },
      { raw: " or ", type: "text" },
      { raw: "![", type: "markdown-opener" },
      { raw: "chart", type: "text" },
      { raw: "](/images/chart.webp)", type: "markdown-destination" },
      { raw: ".", type: "text" },
    ]);
  });

  it("does not protect brackets that are ordinary prose rather than inline links", () => {
    expect(tokenizeText("Costs [estimated] vary.")).toEqual([
      { raw: "Costs [estimated] vary.", type: "text" },
    ]);
  });

  it("finds link openers around nested and escaped label brackets", () => {
    expect(tokenizeText("Read [a [nested] and \\[literal\\] label](/guide).")).toEqual([
      { raw: "Read ", type: "text" },
      { raw: "[", type: "markdown-opener" },
      { raw: "a [nested] and \\[literal\\] label", type: "text" },
      { raw: "](/guide)", type: "markdown-destination" },
      { raw: ".", type: "text" },
    ]);
  });

  it("protects emphasis structure and complete inline code spans", () => {
    expect(tokenizeText("Use **Acme** with _care_ and `pnpm test | tee results.txt`.")).toEqual([
      { raw: "Use ", type: "text" },
      { flavor: "strong", raw: "**", type: "markdown-formatting" },
      { raw: "Acme", type: "text" },
      { flavor: "strong", raw: "**", type: "markdown-formatting" },
      { raw: " with ", type: "text" },
      { flavor: "emphasis", raw: "_", type: "markdown-formatting" },
      { raw: "care", type: "text" },
      { flavor: "emphasis", raw: "_", type: "markdown-formatting" },
      { raw: " and ", type: "text" },
      { raw: "`pnpm test | tee results.txt`", type: "markdown-inline-code" },
      { raw: ".", type: "text" },
    ]);
  });

  it("supports strong-emphasis and multi-backtick code without protecting prose punctuation", () => {
    expect(tokenizeText("Keep ***this*** and ``a ` b | c``; 5 * 3 stays prose.")).toEqual([
      { raw: "Keep ", type: "text" },
      { flavor: "strong-emphasis", raw: "***", type: "markdown-formatting" },
      { raw: "this", type: "text" },
      { flavor: "strong-emphasis", raw: "***", type: "markdown-formatting" },
      { raw: " and ", type: "text" },
      { raw: "``a ` b | c``", type: "markdown-inline-code" },
      { raw: "; 5 * 3 stays prose.", type: "text" },
    ]);
  });

  it("protects nested emphasis whose closing delimiters share one run", () => {
    expect(tokenizeText("Keep **bold and *italic*** text.")).toEqual([
      { raw: "Keep ", type: "text" },
      { flavor: "strong", raw: "**", type: "markdown-formatting" },
      { raw: "bold and ", type: "text" },
      { flavor: "emphasis", raw: "*", type: "markdown-formatting" },
      { raw: "italic", type: "text" },
      { flavor: "strong-emphasis", raw: "***", type: "markdown-formatting" },
      { raw: " text.", type: "text" },
    ]);
  });

  it("leaves escaped, unmatched, and overlong delimiters as prose", () => {
    expect(
      tokenizeText(
        "Escaped \\`code\\` and \\*stars\\*, unmatched `` and ****runs**** stay prose.",
      ),
    ).toEqual([
      {
        raw: "Escaped \\`code\\` and \\*stars\\*, unmatched `` and ****runs**** stay prose.",
        type: "text",
      },
    ]);
  });

  it("ignores different-length backtick runs and protected syntax inside inline code", () => {
    expect(tokenizeText("Run ``a ``` b {{value}} | c`` now.")).toEqual([
      { raw: "Run ", type: "text" },
      { raw: "``a ``` b {{value}} | c``", type: "markdown-inline-code" },
      { raw: " now.", type: "text" },
    ]);
  });

  it("does not interpret intraword underscores as emphasis", () => {
    expect(tokenizeText("keep_snake_case_intact")).toEqual([
      { raw: "keep_snake_case_intact", type: "text" },
    ]);
  });

  it("accepts matching token parity", () => {
    expect(validateTokenParity("Hello {name}", "Bonjour {name}")).toEqual([]);
  });

  it("reports token count mismatches", () => {
    expect(validateTokenParity("Hello {name}", "Bonjour")).toEqual([
      {
        code: "token-count-mismatch",
        message: "Expected 1 non-text token(s) but received 0.",
        severity: "error",
      },
    ]);
  });

  it("reports mismatched token order", () => {
    expect(
      validateTokenParity(
        "Save <highlight>{{amount}}</highlight> now",
        "Sparen Sie {{amount}} <highlight>jetzt</highlight>",
      ),
    ).toEqual([
      {
        code: "token-order-mismatch",
        message: 'Token "<highlight>" does not match "{{amount}}" at position 1.',
        severity: "error",
      },
      {
        code: "token-order-mismatch",
        message: 'Token "{{amount}}" does not match "<highlight>" at position 2.',
        severity: "error",
      },
    ]);
  });

  it("rejects changed Markdown destinations", () => {
    expect(
      validateTokenParity(
        "Read [the guide](/blog/fleet-guide)",
        "Lesen Sie [den Leitfaden](/blog/anderer-leitfaden)",
      ),
    ).toEqual([
      {
        code: "token-order-mismatch",
        message:
          'Token "](/blog/fleet-guide)" does not match "](/blog/anderer-leitfaden)" at position 2.',
        severity: "error",
      },
    ]);
  });

  it("rejects removed link openers and links changed into images", () => {
    expect(
      validateTokenParity(
        "Read [the guide](/guide) and ![the chart](/chart.webp).",
        "Lisez le guide](/guide) et [le graphique](/chart.webp).",
      ),
    ).toEqual([
      {
        code: "token-count-mismatch",
        message: "Expected 4 non-text token(s) but received 3.",
        severity: "error",
      },
    ]);

    expect(
      validateTokenParity("See [the chart](/chart.webp).", "Voir ![le graphique](/chart.webp)."),
    ).toEqual([
      {
        code: "token-order-mismatch",
        message: 'Token "[" does not match "![" at position 1.',
        severity: "error",
      },
    ]);
  });

  it("rejects removed emphasis and modified inline code while allowing translated prose", () => {
    expect(
      validateTokenParity(
        "Use **Acme** with _care_ and `pnpm test | tee results.txt`.",
        "Utilisez **Acme** avec _soin_ et `pnpm test | tee results.txt`.",
      ),
    ).toEqual([]);

    expect(validateTokenParity("Keep **this** safe.", "Gardez this en sécurité.")).toEqual([
      {
        code: "token-count-mismatch",
        message: "Expected 2 non-text token(s) but received 0.",
        severity: "error",
      },
    ]);

    expect(
      validateTokenParity(
        "Run `pnpm test | tee results.txt`.",
        "Exécutez `npm test | tee results.txt`.",
      ),
    ).toEqual([
      {
        code: "token-order-mismatch",
        message:
          'Token "`pnpm test | tee results.txt`" does not match "`npm test | tee results.txt`" at position 1.',
        severity: "error",
      },
    ]);
  });

  it("rejects catastrophic Markdown formatting-scope expansion", () => {
    const source =
      "This gives you **99% acceptance** across the UK and EU. Read [the guide](/guide).";
    const target =
      "Cela vous offre un taux d’acceptation de **99 % au Royaume-Uni et dans l’UE. " +
      "Cette liberté permet aux conducteurs de choisir des stations pratiques et économiques. " +
      "Elle regroupe aussi les péages, le stationnement, la recharge et les autres dépenses " +
      "professionnelles dans un système clair. Pour en savoir plus, consultez**[le guide](/guide).";

    expect(validateTokenParity(source, target)).toEqual([
      {
        code: "token-formatting-scope-expansion",
        message: "Markdown formatting scope 1 expanded from 14 to 276 visible character(s).",
        severity: "error",
      },
    ]);
  });

  it("allows normal Markdown formatting-scope expansion in translated prose", () => {
    expect(
      validateTokenParity(
        "Use **automatic receipt capture** for every driver.",
        "Utilisez la **capture automatique des reçus** pour chaque conducteur.",
      ),
    ).toEqual([]);
  });
});
