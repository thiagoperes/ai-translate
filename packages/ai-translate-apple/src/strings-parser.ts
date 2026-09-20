export interface StringsRecord {
  comment: string;
  end: number;
  implicitValue?: true;
  key: string;
  start: number;
  value: string;
  valueEnd: number;
  valueStart: number;
}

export interface StringsTable {
  /** In wrapped tables, insert records before the closing brace and its trivia. */
  insertionPoint?: number;
  records: StringsRecord[];
  text: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "'": "'",
  "\\": "\\",
  "?": "?",
};

// OpenStep octal escapes encode a NEXTSTEP byte, not a Unicode code point.
// The last two byte values are undefined in this encoding.
const NEXTSTEP_HIGH =
  "\u00a0ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞµ×÷" +
  "©¡¢£⁄¥ƒ§¤’“«‹›ﬁﬂ®–†‡·¦¶•‚„”»…‰¬¿" +
  "¹ˋ´ˆ˜¯˘˙¨²˚¸³˝˛ˇ—±¼½¾àáâãäåçèéêë" +
  "ìÆíªîïðñŁØŒºòóôõöæùúûıüýłøœßþÿ";

/** Parse Apple's textual property-list syntax while retaining source spans. */
export function parseStrings(text: string, label = ".strings"): StringsTable {
  const records: StringsRecord[] = [];
  const keys = new Set<string>();
  let position = 0;

  function fail(message: string): never {
    const line = text.slice(0, position).split(/\r\n|[\r\n]/u).length;
    throw new Error(`${label}:${String(line)}: ${message}`);
  }

  function trivia(): string {
    const comments: string[] = [];
    while (position < text.length) {
      if (/[ \t\r\n\f\v\u2028\u2029]/u.test(text[position] ?? "")) {
        position += 1;
      } else if (text.startsWith("//", position)) {
        const end = /[\r\n\u2028\u2029]/u.exec(text.slice(position + 2));
        const next = end === null ? text.length : position + 2 + end.index;
        comments.push(text.slice(position + 2, next).trim());
        position = next;
      } else if (text.startsWith("/*", position)) {
        const end = text.indexOf("*/", position + 2);
        if (end < 0) {
          fail("Unterminated comment.");
        }
        comments.push(text.slice(position + 2, end).trim());
        position = end + 2;
      } else {
        break;
      }
    }
    return comments.filter(Boolean).join("\n");
  }

  function string(): string {
    const quote = text[position];
    if (quote !== '"' && quote !== "'") {
      const bare = /^[A-Za-z0-9_.$/:-]+/u.exec(text.slice(position));
      if (bare === null) {
        fail("Expected a quoted string or property-list identifier.");
      }
      position += bare[0].length;
      return bare[0];
    }
    position += 1;
    let value = "";
    while (position < text.length) {
      const character = text[position++];
      if (character === quote) {
        return value;
      }
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escaped = text[position++];
      if (escaped === undefined) {
        fail("Unterminated escape sequence.");
      }
      if (escaped === "U") {
        const hexadecimal = /^[\da-fA-F]{1,4}/u.exec(text.slice(position))?.[0];
        if (hexadecimal === undefined) {
          fail("Expected hexadecimal digits after a Unicode escape.");
        }
        value += String.fromCharCode(Number.parseInt(hexadecimal, 16));
        position += hexadecimal.length;
      } else if (/[0-7]/u.test(escaped)) {
        const suffix = /^[0-7]{0,2}/u.exec(text.slice(position))?.[0] ?? "";
        const byte = Number.parseInt(escaped + suffix, 8) % 256;
        if (byte >= 254) {
          fail("Undefined NEXTSTEP octal escape.");
        }
        value += byte < 128 ? String.fromCharCode(byte) : NEXTSTEP_HIGH[byte - 128];
        position += suffix.length;
      } else {
        // Foundation drops the backslash on other escapes, including lowercase
        // \\u and escaped line endings. Do not apply JSON or C continuation rules.
        value += ESCAPES[escaped] ?? escaped;
      }
    }
    return fail("Unterminated quoted string.");
  }

  const heading = trivia();
  const wrapped = text[position] === "{";
  if (wrapped) {
    position += 1;
  } else {
    position = 0;
  }
  let insertionPoint: number | undefined;
  while (position < text.length) {
    const start = position;
    const comment = [wrapped && records.length === 0 ? heading : "", trivia()]
      .filter(Boolean).join("\n");
    if (wrapped && text[position] === "}") {
      insertionPoint = start;
      position += 1;
      trivia();
      if (position !== text.length) {
        fail("Unexpected content after the closing dictionary brace.");
      }
      break;
    }
    if (position === text.length) {
      break;
    }
    const key = string();
    if (keys.has(key)) {
      fail(`Duplicate key ${JSON.stringify(key)}.`);
    }
    keys.add(key);
    const keyEnd = position;
    trivia();
    const implicitValue = text[position] === ";";
    let valueStart = keyEnd;
    let valueEnd = keyEnd;
    let value = key;
    if (!implicitValue) {
      if (text[position++] !== "=") {
        fail("Expected '=' or ';' after key.");
      }
      trivia();
      valueStart = position;
      value = string();
      valueEnd = position;
      trivia();
    }
    if (text[position++] !== ";") {
      fail("Expected ';' after value.");
    }
    records.push({
      comment,
      end: position,
      ...(implicitValue ? { implicitValue: true } : {}),
      key,
      start,
      value,
      valueEnd,
      valueStart,
    });
  }
  if (wrapped && insertionPoint === undefined) {
    fail("Expected '}' after dictionary entries.");
  }
  return { ...(insertionPoint === undefined ? {} : { insertionPoint }), records, text };
}

export function quoteStrings(value: string): string {
  // Property-list strings require control characters to be escaped.
  // eslint-disable-next-line no-control-regex
  return `"${value.replace(/["\\\x00-\x1f\x7f]/gu, (character) => {
    if (character === '"' || character === "\\") {
      return `\\${character}`;
    }
    const named: Readonly<Record<string, string>> = { "\n": "n", "\r": "r", "\t": "t" };
    const escape = named[character];
    return escape === undefined
      ? `\\U${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      : `\\${escape}`;
  })}"`;
}

/** Replace only value spans, preserving comments, whitespace, and unknown keys. */
export function renderStrings(
  table: StringsTable,
  values: ReadonlyMap<string, string>,
  templates: StringsTable,
): string {
  const insertionPoint = table.insertionPoint ?? table.text.length;
  let text = table.text.slice(0, insertionPoint);
  const suffix = table.text.slice(insertionPoint);
  const replacement = (record: StringsRecord, value: string): string =>
    record.implicitValue === true
      ? value === record.value ? "" : ` = ${quoteStrings(value)}`
      : quoteStrings(value);
  const known = new Set(table.records.map((record) => record.key));
  for (const record of table.records.toReversed()) {
    const value = values.get(record.key);
    if (value !== undefined && value !== record.value) {
      text = text.slice(0, record.valueStart) + replacement(record, value) + text.slice(record.valueEnd);
    }
  }
  const source = new Map(templates.records.map((record) => [record.key, record]));
  for (const [key, value] of values) {
    if (known.has(key)) {
      continue;
    }
    const record = source.get(key);
    const addition =
      record === undefined
        ? `${quoteStrings(key)} = ${quoteStrings(value)};`
        : templates.text.slice(record.start, record.valueStart) +
          replacement(record, value) +
          templates.text.slice(record.valueEnd, record.end);
    text += `${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${addition.startsWith("\n") || text.length === 0 ? "" : "\n"}${addition}\n`;
  }
  return text + suffix;
}

export type StringsEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";

export function decodeStrings(buffer: Uint8Array): { encoding: StringsEncoding; text: string } {
  const encoding: StringsEncoding =
    buffer[0] === 0xff && buffer[1] === 0xfe
      ? "utf16le"
      : buffer[0] === 0xfe && buffer[1] === 0xff
        ? "utf16be"
        : buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
          ? "utf8-bom"
          : "utf8";
  const label = encoding === "utf16le" ? "utf-16le" : encoding === "utf16be" ? "utf-16be" : "utf-8";
  return { encoding, text: new TextDecoder(label, { fatal: true }).decode(buffer) };
}

export function encodeStrings(text: string, encoding: StringsEncoding): Uint8Array {
  if (encoding === "utf8") {
    return Buffer.from(text, "utf8");
  }
  if (encoding === "utf8-bom") {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  }
  const body = Buffer.from(text, "utf16le");
  if (encoding === "utf16be") {
    body.swap16();
  }
  return Buffer.concat([Buffer.from(encoding === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff]), body]);
}
