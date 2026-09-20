import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  decodeStrings,
  encodeStrings,
  parseStrings,
  quoteStrings,
  renderStrings,
} from "../src/strings-parser";

describe("Apple strings parser", () => {
  it("reads quoted and bare identifiers, comments and escaped values losslessly", () => {
    const text =
      '// File heading\r\n/* Button comment */\r\n"save" /* key */ = "Save \\"now\\"";\r\nCFBundleName = Beauty; // tail\n';
    const parsed = parseStrings(text);
    expect(parsed.records.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "save", value: 'Save "now"' },
      { key: "CFBundleName", value: "Beauty" },
    ]);
    expect(parsed.records[0]?.comment).toBe("File heading\nButton comment");
    expect(renderStrings(parsed, new Map(), parsed)).toBe(text);
  });

  it("decodes Unicode pairs, octal, controls and Foundation's escaped line endings", () => {
    const text = String.raw`"escapes" = "\UD83D\UDE80\U00e9\141\n\r\t\b\f\v\a\?\'\\";`;
    expect(parseStrings(text).records[0]?.value).toBe("🚀éa\n\r\t\b\f\v\x07?'\\");
    expect(parseStrings('"a" = "one\\\ntwo\\\r\nthree";').records[0]?.value).toBe("one\ntwo\r\nthree");
    expect(parseStrings(String.raw`"a" = "\u00e9 \z \x";`).records[0]?.value).toBe("u00e9 z x");
    expect(parseStrings(String.raw`"a" = "\U1 \U123g \U12345";`).records[0]?.value).toBe("\x01 ģg ሴ5");
  });

  it("reads single-quoted strings, colon identifiers and CR comments as Foundation does", () => {
    const text = "// heading\r'key' = 'Value';\r// Unicode line end\u2028name:part = foo/bar;";
    expect(parseStrings(text).records.map(({ key, value }) => [key, value])).toEqual([
      ["key", "Value"],
      ["name:part", "foo/bar"],
    ]);
  });

  it("decodes legacy octal escapes as NEXTSTEP bytes rather than Unicode", () => {
    const text = String.raw`"a" = "\200\201\255\300\335\375\400";`;
    expect(parseStrings(text).records[0]?.value).toBe("\u00a0À›¹éÿ\0");
  });

  it("round trips arbitrary control characters and quoted prose", () => {
    const value = `${Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join("")}é 🚀`;
    expect(parseStrings(`"key" = ${quoteStrings(value)};`).records[0]?.value).toBe(value);
  });

  it("reads mixed implicit and explicit values without changing key spelling or trivia", () => {
    const text = String.raw`/* First */
"\U0068ello" /* Keep this comment */;
'unchanged';
bare;
"explicit" = "Original";
`;
    const parsed = parseStrings(text);
    expect(parsed.records.map(({ key, value }) => [key, value])).toEqual([
      ["hello", "hello"],
      ["unchanged", "unchanged"],
      ["bare", "bare"],
      ["explicit", "Original"],
    ]);
    expect(renderStrings(parsed, new Map(), parsed)).toBe(text);
    expect(renderStrings(parsed, new Map([["unchanged", "unchanged"]]), parsed)).toBe(text);
    const rendered = renderStrings(parsed, new Map([
      ["hello", 'Hallo "there"'],
      ["bare", "Translated"],
      ["explicit", "New"],
    ]), parsed);
    expect(rendered).toBe(text
      .replace(String.raw`"\U0068ello"`, String.raw`"\U0068ello" = "Hallo \"there\""`)
      .replace("bare;", 'bare = "Translated";')
      .replace('"Original"', '"New"'));
  });

  it("preserves optional wrapping and adds records before closing-brace comments", () => {
    const text = '/* Header */\r\n{\r\n  /* Greeting */\r\n  "hello";\r\n  "keep"="Human";\r\n  // End of table\r\n}\r\n/* Footer */';
    const target = parseStrings(text);
    const source = parseStrings('{\n/* New key */\n"new";\n/* Same value */\n"same";\n}');
    expect(target.records[0]?.comment).toBe("Header\nGreeting");
    expect(renderStrings(target, new Map(), source)).toBe(text);
    const rendered = renderStrings(target, new Map([
      ["hello", "Hallo"],
      ["new", "Neu"],
      ["same", "same"],
      ["unknown", "Additional"],
    ]), source);
    expect(rendered).toContain('/* Header */\r\n{\r\n  /* Greeting */\r\n  "hello" = "Hallo";');
    expect(rendered).toContain('"keep"="Human";');
    expect(rendered).toContain('/* New key */\n"new" = "Neu";');
    expect(rendered).toContain('/* Same value */\n"same";');
    expect(rendered).toContain('"unknown" = "Additional";');
    expect(rendered.endsWith('\r\n  // End of table\r\n}\r\n/* Footer */')).toBe(true);
    expect(parseStrings(rendered).records.map(({ key, value }) => [key, value])).toEqual([
      ["hello", "Hallo"],
      ["keep", "Human"],
      ["new", "Neu"],
      ["same", "same"],
      ["unknown", "Additional"],
    ]);
  });

  it("supports empty dictionaries and keeps template braces out of unwrapped output", () => {
    const source = parseStrings('{ /* Greeting */ "hello"; }');
    for (const text of ["", "{}", "/* Header */ {\n/* Closing */\n} /* Footer */"]) {
      const parsed = parseStrings(text);
      expect(renderStrings(parsed, new Map(), source)).toBe(text);
      const result = renderStrings(parsed, new Map([["hello", "Hallo"]]), source);
      expect(parseStrings(result).records.map(({ key, value }) => [key, value]))
        .toEqual([["hello", "Hallo"]]);
      expect(result.includes("{")).toBe(text.includes("{"));
    }
  });

  it.skipIf(process.platform !== "darwin").each([
    '"hello";',
    '"hello" /* note */; bare; \'single\'; explicit="value";',
    '/* Header */ { /* First */ "hello"; explicit="value"; /* Closing */ } // Footer',
    '{}',
  ])("matches Foundation for implicit values and wrapping in %s", (text) => {
    const source = parseStrings(text);
    const values = new Map(source.records.map((record) => [record.key, `Translated ${record.value}`]));
    values.set("appended", "Added value");
    const rendered = renderStrings(source, values, parseStrings('{ "appended"; }'));
    for (const contents of [text, rendered]) {
      const native = execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
        input: contents,
        encoding: "utf8",
      });
      expect(JSON.parse(native)).toEqual(Object.fromEntries(
        parseStrings(contents).records.map(({ key, value }) => [key, value]),
      ));
    }
  });

  it.each([
    ['"a"="one"; "a"="two";', "Duplicate key"],
    ['"a"; "a"="two";', "Duplicate key"],
    ['{ "a"; "a"; }', "Duplicate key"],
    [String.raw`"\U0061"="one"; a="two";`, "Duplicate key"],
    ["/* no end", "Unterminated comment"],
    ['"a"="oops', "Unterminated quoted"],
    ['"a"="oops\\', "Unterminated escape"],
    ['"a" "value";', "Expected '='"],
    ['"a"="value"', "Expected ';'"],
    [String.raw`"a"="\Uxyz";`, "hexadecimal digits"],
    [String.raw`"a"="\377";`, "Undefined NEXTSTEP"],
    ["a=foo+bar;", "Expected ';'"],
    ['a="A";\u00a0b="B";', "Expected a quoted string"],
    ['"a" = { no: "object" };', "Expected a quoted string"],
    ['{ "a"="value"; ', "Expected '}'"],
    ['{', "Expected '}'"],
    ['{ "a"="value" }', "Expected ';'"],
    ['{} "a";', "Unexpected content"],
    ['{};', "Unexpected content"],
    ['{ nested={"a"="value";}; }', "Expected a quoted string"],
  ])("rejects malformed or ambiguous tables", (text, message) => {
    expect(() => parseStrings(text, "Localizable.strings")).toThrow(message);
  });

  it("changes only translated spans and appends new keys with their source comment", () => {
    const target = parseStrings('/* Human */\r\n"old" = "Alt";\r\n"extra" = "Keep me";\r\n');
    const source = parseStrings('"old"="Old";\n/* Explain new */\n"new" = "New";\n');
    const result = renderStrings(
      target,
      new Map([
        ["old", 'Neu "now"'],
        ["new", "Neu"],
        ["brand-new", "Brand"],
      ]),
      source,
    );
    expect(result).toContain('/* Human */\r\n"old" = "Neu \\"now\\"";');
    expect(result).toContain('"extra" = "Keep me";\r\n');
    expect(result).toContain('/* Explain new */\n"new" = "Neu";');
    expect(parseStrings(result).records.map(({ key }) => key)).toEqual([
      "old",
      "extra",
      "new",
      "brand-new",
    ]);
  });

  it.each(["utf8", "utf8-bom", "utf16le", "utf16be"] as const)(
    "preserves %s encoding and Unicode",
    (encoding) => {
      const text = '"greeting" = "你好, café 🚀";\n';
      const bytes = encodeStrings(text, encoding);
      expect(decodeStrings(bytes)).toEqual({ encoding, text });
      expect(encodeStrings(decodeStrings(bytes).text, encoding)).toEqual(bytes);
    },
  );

  it("refuses invalid byte encodings instead of silently replacing characters", () => {
    expect(() => decodeStrings(Buffer.from([0xff, 0x20]))).toThrow();
    expect(() => decodeStrings(Buffer.from([0xff, 0xfe, 0x00]))).toThrow();
  });
});
