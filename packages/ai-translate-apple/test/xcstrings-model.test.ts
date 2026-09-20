import { addressToJsonPointer } from "@ai-translate/core/address";
import type { JsonObject } from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import {
  alignNode, buildCatalogEntries, expandNode, localeRoots, parseCatalog, setUnit, structureDigest,
} from "../src/xcstrings-model";

const unit = (value: string, state = "translated"): JsonObject => ({ stringUnit: { state, value } });
const catalog = (strings: JsonObject) => parseCatalog(JSON.stringify({ sourceLanguage: "en", strings, version: "1.0" }), "Localizable.xcstrings", "en");

describe("String Catalog model", () => {
  it.each(["1.0", "1.1", "1.2", "1.3"])("reads version %s without changing its native metadata", (version) => {
    const input = { sourceLanguage: "en", version, strings: {
      "Hello %@": { comment: "Account greeting", localizations: { de: unit("Hallo %@") } },
    }, metadata: { preserved: true } };
    const model = parseCatalog(JSON.stringify(input), "Localizable.xcstrings", "en");
    expect(model).toEqual(input);
    expect(buildCatalogEntries(model, localeRoots(model, "en"), true)[0]?.value).toBe("Hello %@");
    expect(buildCatalogEntries(model, localeRoots(model, "de"), false)[0]?.value).toBe("Hallo %@");
  });

  it.each([undefined, null, 1.3, "1", "1.4", "2.0"])("rejects unsupported catalog version %s", (version) => {
    expect(() => parseCatalog(JSON.stringify({ sourceLanguage: "en", version, strings: {} }), "Future.xcstrings", "en"))
      .toThrow('Unsupported String Catalog version in Future.xcstrings');
  });

  it("loads implicit source text and preserves explicit source text, comments, and native placeholders", () => {
    const model = catalog({
      "Hello %@": { comment: "Greeting for the account holder" },
      semantic_key: { localizations: { en: unit("%lld files") } },
      "": {},
      skipped: { shouldTranslate: false },
      old: { extractionState: "stale" },
    });
    const entries = buildCatalogEntries(model, localeRoots(model, "en"), true);
    expect(entries.map(({ value }) => value)).toEqual(["Hello %@", "%lld files"]);
    expect(entries[0]).toMatchObject({
      context: { notes: 'Apple string key: "Hello %@"\nGreeting for the account holder' },
      messageFormatId: "apple-printf", policy: "translate", storage: "string",
      tokens: [{ raw: "Hello ", type: "text" }, { raw: "%@", syntax: "printf", type: "placeholder" }],
    });
  });

  it("treats only translated targets as accepted while retaining source text in every state", () => {
    const states = ["translated", "new", "needs_review", "stale", "future_state"];
    const model = catalog(Object.fromEntries(states.map((state) => [state, { localizations: { en: unit("Source", state), de: unit("Ziel", state) } }])));
    expect(buildCatalogEntries(model, localeRoots(model, "en"), true).map(({ value }) => value)).toEqual(states.map(() => "Source"));
    expect(buildCatalogEntries(model, localeRoots(model, "de"), false).map(({ value }) => value)).toEqual(["Ziel", null, null, null, null]);
  });

  it("expands target CLDR categories without mutating or dropping authored source arms", () => {
    const source = { variations: { plural: { one: unit("%lld file"), other: unit("%lld files") } } };
    const before = structuredClone(source);
    const arabic = expandNode(source, "ar");
    expect(Object.keys((arabic.variations as JsonObject).plural as JsonObject)).toEqual(["zero", "one", "two", "few", "many", "other"]);
    expect(((arabic.variations as JsonObject).plural as JsonObject).few).toEqual(unit("%lld files"));
    expect(Object.keys((expandNode(source, "ja").variations as JsonObject).plural as JsonObject)).toEqual(["one", "other"]);
    expect(source).toEqual(before);
    const model = catalog({ files: { localizations: { en: source } } });
    expect(structureDigest(buildCatalogEntries(model, { files: source }, true))).toBe(structureDigest(buildCatalogEntries(model, { files: arabic }, true)));
  });

  it("uses canonical source text for target-only device and plural branches", () => {
    const source = unit("%lld saved items");
    const target = { variations: { device: { applewatch: unit("Short foreign text"), other: unit("Foreign text") } } };
    expect(expandNode(source, "pt", target)).toEqual({ variations: { device: { applewatch: source, other: source } } });
    const plural = expandNode(source, "pl", { variations: { plural: { one: unit("Obcy tekst") } } });
    expect(Object.keys((plural.variations as JsonObject).plural as JsonObject)).toEqual(["one", "few", "many", "other"]);
    expect(((plural.variations as JsonObject).plural as JsonObject).few).toEqual(source);
  });

  it("adds target-only device arms to authored variants using the source fallback", () => {
    const source = { variations: { device: { iphone: unit("Phone"), other: unit("Device") } } };
    const target = { variations: { device: { applewatch: unit("Watch translation"), other: unit("Target") } } };
    expect((expandNode(source, "de", target).variations as JsonObject).device).toEqual({ iphone: unit("Phone"), other: unit("Device"), applewatch: unit("Device") });
  });

  it("rejects target-only substitution fragments before shaping or aligning native text", () => {
    const source = unit("Found %lld birds");
    const target = { ...unit("%#@birds@ entdeckt"), substitutions: { birds: { argNum: 1, formatSpecifier: "lld", variations: { plural: { one: unit("%arg Vogel"), other: unit("%arg Vögel") } } } } };
    const before = structuredClone(target);
    expect(() => expandNode(source, "de", target, 'key "Found %lld birds"')).toThrow('Unsupported target-only String Catalog substitution "birds" at key "Found %lld birds" (de)');
    expect(() => { alignNode(target, source, structuredClone(target)); }).toThrow("Define the corresponding substitution in the source localization");
    expect(target).toEqual(before);
    expect(() => expandNode({ ...source, substitutions: { unrelated: { argNum: 1, formatSpecifier: "lld", ...unit("%arg") } } }, "de", target)).toThrow('substitution "birds"');
  });

  it("preserves substitution bindings, plural context, and unusual key names safely", () => {
    const key = "a/b~c";
    const node = {
      ...unit("%#@variations@"),
      substitutions: { variations: { argNum: 2, formatSpecifier: "lld", variations: { plural: { one: unit("%arg item"), other: unit("%arg items") } } } },
    };
    const model = catalog(Object.fromEntries([[key, { comment: "Count description", localizations: { en: node } }], ["__proto__", {}], ["constructor", {}]]));
    const entries = buildCatalogEntries(model, { [key]: expandNode(node, "pl") }, true);
    expect(entries.map(({ address }) => addressToJsonPointer(address))).toContain("/a~1b~0c/substitutions/variations/variations/plural/few/stringUnit/value");
    const few = entries.find(({ context }) => context?.notes?.includes("Plural category: few."));
    expect(few?.context?.notes).toContain("Substitution: variations.");
    expect(few?.context?.notes).toContain('Apple substitution arguments: {"variations":[2,"lld"]}.');
    expect(few?.meta).toMatchObject({ structureGroup: "/a~1b~0c/substitutions/variations/variations/plural/*/stringUnit/value", structureSignature: '{"variations":[2,"lld"]}' });
    const roots = localeRoots(model, "en");
    expect(Object.hasOwn(roots, "__proto__")).toBe(true);
    expect((roots.__proto__ as JsonObject).stringUnit).toEqual({ state: "translated", value: "__proto__" });
    expect({}).not.toHaveProperty("polluted");
  });

  it("accepts partially translated target plurals and unknown native metadata", () => {
    const model = catalog({ key: { extractionState: "manual", future: { preserved: true }, localizations: { en: { variations: { plural: { other: unit("%lld values") } } }, de: { variations: { plural: { one: unit("%lld Wert") } } } } } });
    expect(buildCatalogEntries(model, localeRoots(model, "de"), false).map(({ value }) => value)).toEqual(["%lld Wert"]);
  });

  it.each([
    ["{", "Invalid JSON"],
    ["[]", "expected an object"],
    [JSON.stringify({ version: "2.0", sourceLanguage: "en", strings: {} }), "version"],
    [JSON.stringify({ version: "1.0", sourceLanguage: "fr", strings: {} }), "sourceLanguage"],
    [JSON.stringify({ version: "1.0", sourceLanguage: "en", strings: [] }), "expected an object"],
  ])("rejects malformed catalog %s", (text, message) => {
    expect(() => parseCatalog(text, "file.xcstrings", "en")).toThrow(message);
  });

  it.each([
    [{ shouldTranslate: "false" }, "shouldTranslate"],
    [{ comment: 1 }, "comment"],
    [{ localizations: [] }, "expected an object"],
    [{ localizations: { en: {} } }, "expected stringUnit or variations"],
    [{ localizations: { en: { stringUnit: { value: 1, state: "translated" } } } }, "value and state"],
    [{ localizations: { en: { variations: {} } } }, "Empty"],
    [{ localizations: { en: { variations: { gender: { other: unit("Other") } } } } }, "Unsupported"],
    [{ localizations: { en: { variations: { plural: { one: unit("One") } } } } }, "requires an other arm"],
    [{ localizations: { en: { variations: { plural: { manyish: unit("Some"), other: unit("Other") } } } } }, "plural category"],
    [{ localizations: { en: { ...unit("Count"), substitutions: { count: { argNum: 0, formatSpecifier: "lld", ...unit("Count") } } } } }, "argNum"],
    [{ localizations: { en: { ...unit("Count"), substitutions: { count: { argNum: 1, formatSpecifier: "", ...unit("Count") } } } } }, "formatSpecifier"],
  ])("rejects malformed string metadata or structure %#", (string, message) => {
    expect(() => catalog({ key: string })).toThrow(message);
  });

  it("bounds recursive native variations", () => {
    let node = unit("Deep");
    for (let index = 0; index < 66; index += 1) {
      node = { variations: { device: { other: node } } };
    }
    expect(() => catalog({ key: { localizations: { en: node } } })).toThrow("exceeds 64 levels");
  });

  it("rejects malformed and unknown entry addresses before setting a unit", () => {
    const roots = { key: unit("Value") };
    expect(() => { setUnit({}, roots, ["key", "stringUnit", "wrong"], "New", "translated"); }).toThrow("entry address");
    expect(() => { setUnit({}, roots, ["unknown", "stringUnit", "value"], "New", "translated"); }).toThrow("unknown String Catalog entry");
    expect(() => { setUnit({}, { key: {} }, ["key", "stringUnit", "value"], "New", "translated"); }).toThrow("unknown String Catalog stringUnit");
  });
});
