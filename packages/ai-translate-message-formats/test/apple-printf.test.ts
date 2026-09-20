import type { Entry } from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import { applePrintfMessageFormat, createApplePrintfMessageFormat } from "../src/apple-printf";

function codes(sourceText: string, targetText: string): string[] {
  return applePrintfMessageFormat
    .validateParity({ locale: "de", sourceLocale: "en", sourceText, targetText })
    .map((issue) => issue.code);
}

function boundCodes(sourceText: string, targetText: string, bindings: string): string[] {
  const sourceEntry: Entry = {
    address: [], meta: { appleSubstitutionBindings: bindings }, policy: "translate", storage: "string", value: sourceText,
  };
  return applePrintfMessageFormat.validateParity({ sourceEntry, sourceText, targetText, locale: "de", sourceLocale: "en" }).map(({ code }) => code);
}

describe("applePrintfMessageFormat", () => {
  it("protects complete conversions while leaving prose translatable", () => {
    expect(applePrintfMessageFormat.tokenize("Hello %@: %04lld, %+.2f%%")).toEqual([
      { raw: "Hello ", type: "text" },
      expect.objectContaining({ raw: "%@", syntax: "printf", type: "placeholder" }),
      { raw: ": ", type: "text" },
      expect.objectContaining({ raw: "%04lld", syntax: "printf", type: "placeholder" }),
      { raw: ", ", type: "text" },
      expect.objectContaining({ raw: "%+.2f", syntax: "printf", type: "placeholder" }),
      expect.objectContaining({ raw: "%%", syntax: "printf", type: "placeholder" }),
    ]);
  });

  it.each([
    "%@",
    "%d",
    "%lld",
    "%lu",
    "%zu",
    "%08x",
    "%#X",
    "%+-8.3f",
    "%Lf",
    "%lc",
    "%S",
    "%p",
    "%g",
    "%a",
    "%D",
    "%qX",
    "%hhd",
    "%.f",
  ])("preserves %s", (specifier) => {
    expect(codes(`Value ${specifier}`, `Wert ${specifier}`)).toEqual([]);
  });

  it("allows positional reordering with original argument types", () => {
    expect(codes("%@ has %lld items", "%2$lld Einträge für %1$@")).toEqual([]);
    expect(codes("%1$@ %2$d", "%2$d %1$@")).toEqual([]);
    expect(codes("%@ %d", "%d %@")).toEqual(["apple-printf-argument-mismatch"]);
  });

  it("tracks dynamic width and precision independently of value arguments", () => {
    expect(codes("%*.*f for %@", "%4$@: %3$*1$.*2$f")).toEqual([]);
    expect(codes("%*d", "%2$*1$d")).toEqual([]);
    expect(codes("%*.*f", "%3$*2$.*1$f")).toEqual(["apple-printf-argument-mismatch"]);
    expect(codes("%*.*f", "%f")).toEqual(["apple-printf-argument-mismatch"]);
  });

  it("preserves named substitutions and permits explicit positional references", () => {
    expect(codes("%#@count@ by %@", "%2$@: %1$#@count@")).toEqual([]);
    expect(codes("%#@count@", "%#@anzahl@")).toEqual(["apple-printf-argument-mismatch"]);
    expect(codes("%#@count@", "%d")).toEqual(["apple-printf-argument-mismatch"]);
  });

  it("resolves native catalog names through source bindings while preserving standalone printf order", () => {
    const source = "%#@animals@ and %#@birds@";
    const reordered = "%#@birds@ und %#@animals@";
    const bindings = '{"animals":[1,"lld"],"birds":[2,"lld"]}';
    expect(boundCodes(source, reordered, bindings)).toEqual([]);
    expect(boundCodes(source, "%2$#@birds@ und %1$#@animals@", bindings)).toEqual([]);
    expect(boundCodes(source, "%1$#@birds@ und %2$#@animals@", bindings)).toEqual(["apple-printf-argument-mismatch"]);
    expect(boundCodes(source, "%#@animals@ und %#@animals@", bindings)).toEqual(["apple-printf-argument-mismatch"]);
    expect(boundCodes(source, "%#@birds@", bindings)).toEqual(["apple-printf-argument-mismatch"]);
    expect(boundCodes(source, "%#@renamed@ und %#@animals@", bindings)).toContain("apple-printf-target-invalid");
    expect(codes(source, reordered)).toEqual(["apple-printf-argument-mismatch"]);
    expect(applePrintfMessageFormat.tokenize(source).map(({ raw }) => raw).join("")).toBe(source);
  });

  it("keeps ordinary argument positions and types safe alongside bound catalog names", () => {
    const bindings = '{"animals":[2,"lld"],"birds":[3,"lld"]}';
    expect(boundCodes("%@: %#@animals@ and %#@birds@", "%#@birds@, %@: %#@animals@", bindings)).toEqual([]);
    expect(boundCodes("%@: %#@animals@ and %#@birds@", "%3$#@birds@, %1$@: %2$#@animals@", bindings)).toEqual([]);
    expect(boundCodes("%@ %#@animals@", "%d %#@animals@", bindings)).toEqual(["apple-printf-argument-mismatch"]);
    expect(boundCodes("%@ %#@animals@", "%2$@ %#@animals@", bindings)).toContain("apple-printf-target-invalid");
    expect(boundCodes("%1$@ %d %#@animals@", "%1$@ %d %#@animals@", bindings)).toContain("apple-printf-source-invalid");
    expect(boundCodes("%#@animals@ %2$lld", "%2$lld %#@animals@", bindings)).toEqual([]);
    expect(boundCodes("%#@animals@ %2$@", "%#@animals@ %2$@", bindings)).toContain("apple-printf-source-invalid");
  });

  it.each([
    "{", "[]", "null", '{"birds":[0,"lld"]}', '{"birds":[1,"n"]}',
    '{"birds":[1,"1$lld"]}', '{"birds":[1,"*d"]}', '{"birds":[1,".*f"]}',
    '{"birds":[1,"ll@"]}', '{"birds":[1,"lld trailing"]}', '{"birds":[1]}',
  ])("rejects unsafe native binding metadata: %s", (bindings) => {
    expect(boundCodes("%#@birds@", "%#@birds@", bindings)).toContain("apple-printf-source-invalid");
  });

  it("rejects undefined catalog names and accepts safely formatted binding conversions", () => {
    expect(boundCodes("%#@missing@", "%#@missing@", "{}")).toContain("apple-printf-source-invalid");
    expect(boundCodes("%#@birds@", "%#@birds@", '{"birds":[1,"02lld"]}')).toEqual([]);
    expect(boundCodes("%#@birds@", "%#@birds@", '{"birds":[1,".2f"]}')).toEqual([]);
  });

  it.each(["bird-count", "bird count", "birds.count", "鳥", "2count", "bird\ncount", "bird\rcount", "bird\tcount"])(
    "preserves Apple-delimited substitution names such as %s",
    (name) => {
      expect(codes(`%#@${name}@ for %@`, `%2$@: %1$#@${name}@`)).toEqual([]);
      expect(applePrintfMessageFormat.tokenize(`%#@${name}@`)).toEqual([
        expect.objectContaining({ raw: `%#@${name}@`, syntax: "printf", type: "placeholder" }),
      ]);
    },
  );

  it("protects Xcode substitution branch argument markers without parsing them as hex floats", () => {
    expect(applePrintfMessageFormat.tokenize("%arg files")).toEqual([
      { name: "substitution-argument", raw: "%arg", syntax: "printf", type: "placeholder" },
      { raw: " files", type: "text" },
    ]);
    expect(codes("%arg files", "Dateien: %arg")).toEqual([]);
    expect(codes("%arg files", "%argument")).toEqual([]);
    expect(codes("%arg files", "%a files")).toEqual(["apple-printf-argument-mismatch"]);
    expect(codes("%arg files", "%lld files")).toEqual(["apple-printf-argument-mismatch"]);
    expect(codes("%arg files", "%arg %arg files")).toEqual(["apple-printf-argument-mismatch"]);
    expect(codes("%arg files", "files")).toEqual(["apple-printf-argument-mismatch"]);
    expect(codes("%arg files for %@", "%1$@: %arg Dateien")).toEqual([]);
  });

  it("permits repeated positional arguments with compatible C argument types", () => {
    for (const value of [
      "%1$f %1$g %1$E %1$A %1$lf",
      "%1$d %1$x %1$u %1$O %1$X",
      "%1$lld %1$qd",
      "%1$hhd %1$hd %1$d %1$hu %1$C",
      "%1$*1$d",
    ]) {
      expect(codes(value, value)).toEqual([]);
    }
    expect(codes("%1$Lf %1$f", "%1$Lf %1$f")).toContain("apple-printf-source-invalid");
  });

  it.each([
    ["%@", "%s"],
    ["%d", "%lld"],
    ["%f", "%Lf"],
    ["%.2f", "%.3f"],
    ["%08x", "%x"],
    ["%1$@ %1$@", "%1$@"],
    ["%d", "%d %d"],
    ["%%", "%"],
    ["%d%%", "%d"],
    ["no argument", "%@"],
  ])("rejects argument or formatting changes from %s to %s", (source, target) => {
    expect(codes(source, target)).toEqual(["apple-printf-argument-mismatch"]);
  });

  it.each([
    "%n",
    "%1$",
    "%0$d",
    "%#@missing",
    "%Q",
    "%ll@",
    "%1$@ %d",
    "%1$d %1$@",
    "%2$*d",
    "%99999999999999999999$d",
  ])("rejects invalid directives: %s", (value) => {
    expect(codes("Hello", value)).toContain("apple-printf-target-invalid");
    expect(codes(value, "Hallo")).toContain("apple-printf-source-invalid");
  });

  it("does not interpret ordinary punctuation as format directives", () => {
    expect(codes("100%", "100%")).toEqual([]);
    expect(codes("%", "%")).toEqual([]);
    expect(codes("", "")).toEqual([]);
    expect(applePrintfMessageFormat.tokenize("hello")).toEqual([{ raw: "hello", type: "text" }]);
  });

  it("supports custom ids without changing the contract", () => {
    expect(createApplePrintfMessageFormat({ id: "native" }).id).toBe("native");
  });
});
