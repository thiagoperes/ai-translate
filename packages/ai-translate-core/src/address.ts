import type { AddressSegment } from "./types";

const NODE_PREFIX = "@node:";

/*
 * The two characters JSON Pointer reserves are both rare in catalog keys, and
 * this runs for every segment of every entry in every locale. An unconditional
 * pair of replaceAll calls scans and reallocates each segment twice to almost
 * always produce the identical string, so both escape helpers check first and
 * return the input untouched when there is nothing to rewrite.
 */
function escapePointerSegment(value: string): string {
  return value.includes("~")
    ? value.replaceAll("~", "~0").replaceAll("/", "~1")
    : value.includes("/")
      ? value.replaceAll("/", "~1")
      : value;
}

function unescapePointerSegment(value: string): string {
  return value.includes("~")
    ? value.replaceAll("~1", "/").replaceAll("~0", "~")
    : value;
}

export function addressToJsonPointer(address: readonly AddressSegment[]): string {
  if (address.length === 0) {
    return "";
  }

  let pointer = "";
  for (const segment of address) {
    if (segment.kind === "index") {
      pointer += `/${String(segment.index)}`;
    } else if (segment.kind === "node") {
      pointer += `/${escapePointerSegment(`${NODE_PREFIX}${segment.id}`)}`;
    } else {
      pointer += `/${escapePointerSegment(segment.key)}`;
    }
  }
  return pointer;
}

export function jsonPointerToAddress(pointer: string): AddressSegment[] {
  if (pointer === "") {
    return [];
  }

  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer "${pointer}"`);
  }

  return pointer
    .split("/")
    .slice(1)
    .map((segment): AddressSegment => {
      const decoded = unescapePointerSegment(segment);
      if (decoded.startsWith(NODE_PREFIX)) {
        return {
          id: decoded.slice(NODE_PREFIX.length),
          kind: "node",
        };
      }

      if (/^\d+$/.test(decoded)) {
        return {
          index: Number(decoded),
          kind: "index",
        };
      }

      return {
        key: decoded,
        kind: "key",
      };
    });
}

export function addressToDisplayPath(address: readonly AddressSegment[]): string {
  if (address.length === 0) {
    return "$";
  }

  let path = "$";
  for (const segment of address) {
    if (segment.kind === "key") {
      path += `.${segment.key}`;
      continue;
    }

    if (segment.kind === "index") {
      path += `[${String(segment.index)}]`;
      continue;
    }

    path += `.<${segment.id}>`;
  }

  return path;
}

export function makeStateKey(
  locale: string,
  catalogId: string,
  unitId: string,
  jsonPointer: string,
): string {
  return `${locale}::${catalogId}::${unitId}::${jsonPointer}`;
}

export function makeLegacyStateKey(
  locale: string,
  unitId: string,
  jsonPointer: string,
): string {
  return `${locale}::${unitId}::${jsonPointer}`;
}
