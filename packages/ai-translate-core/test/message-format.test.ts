import { describe, expect, it } from "vitest";

import {
  createMessageFormatRegistry,
  plainMessageFormat,
  resolveConfigMessageFormat,
} from "../src/message-format";
import type { MessageFormat } from "../src/message-format";
import { tokenizeText, validateTokenParity } from "../src/tokens";
import type { AiTranslateConfig, CatalogAdapter } from "../src/types";

function stubFormat(id: string): MessageFormat {
  return { id, tokenize: () => [], validateParity: () => [] };
}

function stubCatalog(id: string, messageFormats?: readonly MessageFormat[]): CatalogAdapter {
  return {
    createDocumentRef: (ref) => ref,
    id,
    listDocumentRefs: () => Promise.resolve([]),
    loadDocument: () => Promise.resolve(null),
    reconcileDocument: ({ source }) => Promise.resolve(source),
    writeDocument: () => Promise.resolve(),
    ...(messageFormats === undefined ? {} : { messageFormats }),
  };
}

describe("plainMessageFormat", () => {
  it("is the historical tokenizer and parity check, unchanged", () => {
    // Entries written before formats existed carry no id and resolve here, so
    // any divergence would silently re-validate the whole corpus.
    const source = "Read the [guide](/guide) with {{count}} <b>tips</b>";
    const target = "Lisez le [guide](/guide) avec {{count}} <b>astuces</b>";

    expect(plainMessageFormat.tokenize(source)).toEqual(tokenizeText(source));
    expect(
      plainMessageFormat.validateParity({
        locale: "fr",
        sourceLocale: "en",
        sourceText: source,
        targetText: target,
      }),
    ).toEqual(validateTokenParity(source, target));
  });
});

describe("createMessageFormatRegistry", () => {
  it("resolves an unnamed format to plain", () => {
    expect(createMessageFormatRegistry({}).resolve(undefined)).toBe(plainMessageFormat);
  });

  it("collects formats advertised by catalogs", () => {
    const icu = stubFormat("icu");
    const registry = createMessageFormatRegistry({ catalogs: [stubCatalog("messages", [icu])] });

    expect(registry.resolve("icu")).toBe(icu);
  });

  it("collects formats registered directly on the config", () => {
    const custom = stubFormat("custom");

    expect(createMessageFormatRegistry({ formats: [custom] }).resolve("custom")).toBe(custom);
  });

  it("throws on an unknown id rather than falling back to plain", () => {
    // Falling back would validate ICU plurals with the flat tokenizer and
    // accept output that breaks at runtime.
    expect(() => createMessageFormatRegistry({}).resolve("icu")).toThrow(
      /Unknown message format "icu"/,
    );
  });

  it("names the registered ids so a typo is self-correcting", () => {
    const registry = createMessageFormatRegistry({ formats: [stubFormat("icu")] });

    expect(() => registry.resolve("ICU")).toThrow(/Registered formats: icu, plain/);
  });

  it("accepts the same format object advertised by several catalogs", () => {
    const icu = stubFormat("icu");
    const registry = createMessageFormatRegistry({
      catalogs: [stubCatalog("a", [icu]), stubCatalog("b", [icu])],
    });

    expect(registry.resolve("icu")).toBe(icu);
  });

  it("throws when two different formats claim one id", () => {
    // Otherwise which one wins would depend on catalog ordering.
    expect(() =>
      createMessageFormatRegistry({
        catalogs: [stubCatalog("a", [stubFormat("icu")]), stubCatalog("b", [stubFormat("icu")])],
      }),
    ).toThrow(/Two different message formats are registered as "icu"/);
  });
});

describe("resolveConfigMessageFormat", () => {
  const config = (catalogs: readonly CatalogAdapter[], formats?: readonly MessageFormat[]) =>
    ({
      catalogs,
      sourceLocale: "en",
      targetLocales: ["fr"],
      ...(formats === undefined ? {} : { messageFormats: formats }),
    }) as unknown as AiTranslateConfig;

  it("resolves through the config's catalogs", () => {
    const icu = stubFormat("icu");

    expect(resolveConfigMessageFormat(config([stubCatalog("m", [icu])]), "icu")).toBe(icu);
  });

  it("short-circuits an unnamed format without touching the registry", () => {
    expect(resolveConfigMessageFormat(config([]), undefined)).toBe(plainMessageFormat);
  });

  it("returns the same registry for repeated lookups on one config", () => {
    const icu = stubFormat("icu");
    const resolved = config([stubCatalog("m", [icu])]);

    expect(resolveConfigMessageFormat(resolved, "icu")).toBe(
      resolveConfigMessageFormat(resolved, "icu"),
    );
  });
});
