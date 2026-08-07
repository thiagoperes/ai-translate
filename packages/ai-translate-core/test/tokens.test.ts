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

  it("rejects a dropped placeholder as a data-losing error", () => {
    expect(validateTokenParity("Hello {name}", "Bonjour")).toEqual([
      {
        code: "token-missing",
        message: 'Source token "{name}" is absent from the translation.',
        severity: "error",
      },
    ]);
  });

  it("rejects a placeholder the source never contained", () => {
    expect(validateTokenParity("Hello {name}", "Bonjour {nom}")).toEqual([
      {
        code: "token-missing",
        message: 'Source token "{name}" is absent from the translation.',
        severity: "error",
      },
      {
        code: "token-unexpected",
        message: 'Translation adds token "{nom}", which the source does not contain.',
        severity: "error",
      },
    ]);
  });

  it("allows target grammar to reorder placeholders and tags", () => {
    expect(
      validateTokenParity(
        "Save <highlight>{{amount}}</highlight> now",
        "Sparen Sie {{amount}} <highlight>jetzt</highlight>",
      ),
    ).toEqual([]);

    // The real German case that a positional check used to reject outright.
    expect(
      validateTokenParity(
        "Language set to {{language}} for {{count}} number.",
        "Sprache für {{count}} Nummer auf {{language}} gesetzt.",
      ),
    ).toEqual([]);
  });

  it("warns rather than fails when a Markdown destination is localized", () => {
    expect(
      validateTokenParity(
        "Read [the guide](/blog/fleet-guide)",
        "Lesen Sie [den Leitfaden](/blog/anderer-leitfaden)",
      ),
    ).toEqual([
      {
        code: "token-missing",
        message: 'Source token "](/blog/fleet-guide)" is absent from the translation.',
        severity: "warning",
      },
      {
        code: "token-unexpected",
        message:
          'Translation adds token "](/blog/anderer-leitfaden)", which the source does not contain.',
        severity: "warning",
      },
    ]);
  });

  it("warns on removed link openers and links changed into images", () => {
    expect(
      validateTokenParity(
        "Read [the guide](/guide) and ![the chart](/chart.webp).",
        "Lisez le guide](/guide) et [le graphique](/chart.webp).",
      ),
    ).toEqual([
      {
        code: "token-missing",
        message: 'Source token "![" is absent from the translation.',
        severity: "warning",
      },
    ]);

    expect(
      validateTokenParity("See [the chart](/chart.webp).", "Voir ![le graphique](/chart.webp)."),
    ).toEqual([
      {
        code: "token-missing",
        message: 'Source token "[" is absent from the translation.',
        severity: "warning",
      },
      {
        code: "token-unexpected",
        message: 'Translation adds token "![", which the source does not contain.',
        severity: "warning",
      },
    ]);
  });

  it("warns on removed emphasis and modified inline code while allowing translated prose", () => {
    expect(
      validateTokenParity(
        "Use **Acme** with _care_ and `pnpm test | tee results.txt`.",
        "Utilisez **Acme** avec _soin_ et `pnpm test | tee results.txt`.",
      ),
    ).toEqual([]);

    expect(validateTokenParity("Keep **this** safe.", "Gardez this en sécurité.")).toEqual([
      {
        code: "token-missing",
        message: 'Source token "**" is absent from the translation.',
        severity: "warning",
      },
      {
        code: "token-missing",
        message: 'Source token "**" is absent from the translation.',
        severity: "warning",
      },
    ]);

    expect(
      validateTokenParity(
        "Run `pnpm test | tee results.txt`.",
        "Exécutez `npm test | tee results.txt`.",
      ),
    ).toEqual([
      {
        code: "token-missing",
        message: 'Source token "`pnpm test | tee results.txt`" is absent from the translation.',
        severity: "warning",
      },
      {
        code: "token-unexpected",
        message:
          'Translation adds token "`npm test | tee results.txt`", which the source does not contain.',
        severity: "warning",
      },
    ]);
  });

  it("warns on catastrophic Markdown formatting-scope expansion", () => {
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
        severity: "warning",
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
