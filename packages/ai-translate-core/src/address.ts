import type { AddressSegment } from "./types";

const NODE_PREFIX = "@node:";

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function addressToJsonPointer(address: readonly AddressSegment[]): string {
  if (address.length === 0) {
    return "";
  }

  return address
    .map((segment) => {
      if (segment.kind === "index") {
        return `/${String(segment.index)}`;
      }

      if (segment.kind === "node") {
        return `/${escapePointerSegment(`${NODE_PREFIX}${segment.id}`)}`;
      }

      return `/${escapePointerSegment(segment.key)}`;
    })
    .join("");
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
