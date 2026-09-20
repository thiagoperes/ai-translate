import type { MessageFormat } from "@ai-translate/core/message-format";
import type { Entry, Token, TranslationValidationIssue } from "@ai-translate/core/types";

export const APPLE_PRINTF_MESSAGE_FORMAT_ID = "apple-printf";

interface ParsedFormat {
  errors: string[];
  signatures: string[];
  tokens: Token[];
}

// Keep the complete conversion protected, including presentation details. A
// translator may reorder numbered arguments, but cannot safely change the
// caller's argument types, precision, or dynamic width/precision arguments.
const CONVERSION =
  /^%(?:(\d+)\$)?([-+#0 ']*)(\*(?:\d+\$)?|\d+)?(?:\.(\*(?:\d+\$)?|\d*))?(hh|ll|[hlLqjzt])?([@diuoxXfFeEgGaAcCsSpDUO])/u;
const SUBSTITUTION = /^%(?:(\d+)\$)?#@([^@]+)@/u;

function argumentType(length: string, specifier: string): string {
  if ("diuoxXDUO".includes(specifier)) {
    // Promotions make short and char values int arguments. Signed/unsigned
    // presentations of the same integer are compatible; parity below still
    // protects the exact conversion used for every occurrence.
    return length === "" || length === "h" || length === "hh"
      ? "int"
      : `${length === "q" ? "ll" : length}:integer`;
  }
  if ("fFeEgGaA".includes(specifier)) {
    return length === "L" ? "long-double" : "double";
  }
  if ("cC".includes(specifier)) {
    return "int";
  }
  return `${length}:${specifier}`;
}

function validLength(length: string, specifier: string): boolean {
  return "diuoxXDUO".includes(specifier)
    ? ["", "hh", "h", "l", "ll", "q", "j", "z", "t"].includes(length)
    : "fFeEgGaA".includes(specifier)
      ? ["", "l", "L"].includes(length)
      : "cs".includes(specifier)
        ? ["", "l"].includes(length)
        : length === "";
}

interface SubstitutionBinding {
  position: number;
  type: string;
}

function catalogBindings(entry: Readonly<Entry> | undefined): {
  bindings?: ReadonlyMap<string, SubstitutionBinding>;
  errors: string[];
} {
  const raw = entry?.meta?.appleSubstitutionBindings;
  if (raw === undefined) {
    return { errors: [] };
  }
  const bindings = new Map<string, SubstitutionBinding>();
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { bindings, errors: ["Invalid Apple substitution binding metadata."] };
  }
  for (const [name, value] of Object.entries(parsed)) {
    const parts = Array.isArray(value) ? value as unknown[] : [];
    const position = parts[0];
    const format = typeof parts[1] === "string" ? CONVERSION.exec(`%${parts[1]}`) : null;
    if (parts.length !== 2 || typeof position !== "number" || !Number.isSafeInteger(position) || position < 1 ||
      format === null || format[0] !== `%${String(parts[1])}` || format[1] !== undefined ||
      format[3]?.startsWith("*") === true || format[4]?.startsWith("*") === true ||
      !validLength(format[5] ?? "", format[6] ?? "")) {
      errors.push(`Invalid Apple substitution binding ${JSON.stringify(name)}: expected a positive argNum and a supported formatSpecifier without positional or dynamic arguments.`);
      continue;
    }
    bindings.set(name, { position, type: argumentType(format[5] ?? "", format[6] ?? "") });
  }
  return { bindings, errors };
}

function parse(value: string, bindings?: ReadonlyMap<string, SubstitutionBinding>): ParsedFormat {
  const result: ParsedFormat = { errors: [], signatures: [], tokens: [] };
  let nextArgument = 1;
  let numbered = false;
  let sequential = false;
  let textStart = 0;
  const types = new Map<number, string>();

  function registerArgument(position: number, type: string): number {
    if (!Number.isSafeInteger(position) || position < 1) {
      result.errors.push("Argument positions must be positive safe integers.");
    }
    const previous = types.get(position);
    if (previous !== undefined && previous !== type) {
      result.errors.push(`Argument ${String(position)} is used with incompatible types.`);
    }
    types.set(position, type);
    return position;
  }

  function argument(explicit: string | undefined, type: string): number {
    if (explicit === undefined) {
      sequential = true;
    } else {
      numbered = true;
    }
    return registerArgument(explicit === undefined ? nextArgument++ : Number(explicit), type);
  }

  function dynamic(spec: string | undefined): string {
    if (spec?.startsWith("*") !== true) {
      return spec ?? "";
    }
    const explicit = spec.length === 1 ? undefined : spec.slice(1, -1);
    return `*${String(argument(explicit, "int"))}`;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") {
      continue;
    }
    const tail = value.slice(index);
    let raw: string;
    let signature: string;
    if (tail.startsWith("%%")) {
      raw = "%%";
      signature = "literal-percent";
    } else if (tail.startsWith("%arg")) {
      // Xcode substitutes this branch-local marker using the enclosing
      // substitution's argNum and formatSpecifier when compiling a catalog.
      raw = "%arg";
      signature = "substitution-argument";
    } else {
      const substitution = SUBSTITUTION.exec(tail);
      const conversion =
        substitution === null && !/^%(?:\d+\$)?#@/u.test(tail) ? CONVERSION.exec(tail) : null;
      if (substitution !== null) {
        raw = substitution[0];
        const name = substitution[2] ?? "";
        const binding = bindings?.get(name);
        if (bindings !== undefined && binding === undefined) {
          result.errors.push(`Undefined Apple substitution ${JSON.stringify(name)} in source binding metadata.`);
        }
        // Catalog names resolve through argNum, independently of textual
        // order. Explicit positions override that binding in Apple's compiler.
        // These resolved names do not change how ordinary printf arguments
        // consume the remaining unnumbered argument sequence.
        const position = binding === undefined
          ? argument(substitution[1], `substitution:${name}`)
          : registerArgument(substitution[1] === undefined ? binding.position : Number(substitution[1]), binding.type);
        signature = `${String(position)}:#@${name}@`;
      } else if (conversion !== null) {
        raw = conversion[0];
        const [, explicit, flags = "", width, precision, length = "", specifier = ""] = conversion;
        if (!validLength(length, specifier)) {
          result.errors.push(`Invalid length modifier in ${raw}.`);
        }
        const widthKey = dynamic(width);
        const precisionKey = dynamic(precision);
        const position = argument(explicit, argumentType(length, specifier));
        signature = JSON.stringify([
          position,
          flags,
          widthKey,
          precision === undefined ? null : precisionKey,
          length,
          specifier,
        ]);
      } else {
        // Bare percentages are ordinary text in string catalogs. A directive
        // prefix, unsupported conversion, or unfinished substitution is not.
        if (/^%(?:\d+\$|[-+#0.*]|[A-Za-z@])/u.test(tail)) {
          result.errors.push(
            `Malformed or unsupported printf conversion near ${JSON.stringify(tail.slice(0, 24))}.`,
          );
        }
        continue;
      }
    }
    if (index > textStart) {
      result.tokens.push({ raw: value.slice(textStart, index), type: "text" });
    }
    result.tokens.push({ name: signature, raw, syntax: "printf", type: "placeholder" });
    result.signatures.push(signature);
    index += raw.length - 1;
    textStart = index + 1;
  }
  if (textStart < value.length) {
    result.tokens.push({ raw: value.slice(textStart), type: "text" });
  }
  if (numbered && sequential) {
    result.errors.push("Numbered and unnumbered printf arguments cannot be mixed.");
  }
  result.signatures.sort();
  return result;
}

function issues(
  kind: "source" | "target",
  errors: readonly string[],
): TranslationValidationIssue[] {
  return errors.map((message) => ({
    code: `apple-printf-${kind}-invalid`,
    message,
    severity: "error",
  }));
}

/** Apple's NSString/Swift format arguments and string-catalog substitutions. */
export function createApplePrintfMessageFormat(options: { id?: string } = {}): MessageFormat {
  return {
    id: options.id ?? APPLE_PRINTF_MESSAGE_FORMAT_ID,
    tokenize: (value) => parse(value).tokens,
    validateParity({ sourceEntry, sourceText, targetText }) {
      const { bindings, errors } = catalogBindings(sourceEntry);
      const source = parse(sourceText, bindings);
      const target = parse(targetText, bindings);
      const invalid = [...issues("source", [...errors, ...source.errors]), ...issues("target", target.errors)];
      if (invalid.length > 0) {
        return invalid;
      }
      return JSON.stringify(source.signatures) === JSON.stringify(target.signatures)
        ? []
        : [
            {
              code: "apple-printf-argument-mismatch",
              message:
                "Preserve every printf argument, its type and formatting, named substitution, and escaped percent; use positional arguments when reordering.",
              severity: "error",
            },
          ];
    },
  };
}

export const applePrintfMessageFormat: MessageFormat = createApplePrintfMessageFormat();
