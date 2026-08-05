import type {
  AddressSegment,
  Entry,
  JsonObject,
  JsonValue,
  LoadedDocument,
} from "./types";

type MutableContainer = JsonObject | JsonValue[];

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getJsonValueAtAddress(
  root: JsonValue,
  address: readonly AddressSegment[],
): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of address) {
    if (segment.kind === "node") {
      return undefined;
    }

    if (current === undefined) {
      return undefined;
    }

    if (segment.kind === "index") {
      if (!Array.isArray(current)) {
        return undefined;
      }

      current = current[segment.index];
      continue;
    }

    if (!isJsonObject(current)) {
      return undefined;
    }

    current = current[segment.key];
  }

  return current;
}

export function setJsonValueAtAddress(
  root: JsonValue,
  address: readonly AddressSegment[],
  value: JsonValue,
): void {
  if (address.length === 0) {
    throw new Error("Cannot replace the document root by address.");
  }

  let current: MutableContainer = root as MutableContainer;
  for (let index = 0; index < address.length - 1; index += 1) {
    const segment = address[index];
    const next = address[index + 1];
    if (!segment) {
      throw new Error("Encountered an undefined JSON address segment.");
    }

    if (segment.kind === "node") {
      throw new Error("Node segments are not supported for JSON values.");
    }

    if (segment.kind === "index") {
      if (!Array.isArray(current)) {
        throw new Error("Expected an array while traversing a JSON address.");
      }

      const existingValue = current[segment.index];
      if (existingValue === undefined) {
        current[segment.index] =
          next?.kind === "index" ? [] : {};
      }

      const nextValue = current[segment.index];
      if (
        nextValue === undefined ||
        (typeof nextValue !== "object" || nextValue === null)
      ) {
        current[segment.index] =
          next?.kind === "index" ? [] : {};
      }

      current = current[segment.index] as MutableContainer;
      continue;
    }

    if (Array.isArray(current)) {
      throw new Error("Expected an object while traversing a JSON address.");
    }

    const existingValue = current[segment.key];
    if (existingValue === undefined) {
      current[segment.key] =
        next?.kind === "index" ? [] : {};
    }

    const nextValue = current[segment.key];
    if (
      nextValue === undefined ||
      (typeof nextValue !== "object" || nextValue === null)
    ) {
      current[segment.key] =
        next?.kind === "index" ? [] : {};
    }

    current = current[segment.key] as MutableContainer;
  }

  const last = address[address.length - 1];
  if (!last || last.kind === "node") {
    throw new Error("Node segments are not supported for JSON values.");
  }

  if (last.kind === "index") {
    if (!Array.isArray(current)) {
      throw new Error("Expected an array at the final JSON address segment.");
    }

    current[last.index] = value;
    return;
  }

  if (Array.isArray(current)) {
    throw new Error("Expected an object at the final JSON address segment.");
  }

  current[last.key] = value;
}

export function visitJsonLeaves(
  value: JsonValue,
  visitor: (args: {
    address: readonly AddressSegment[];
    value: boolean | number | string | null;
  }) => void,
  address: readonly AddressSegment[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const stableId =
        isJsonObject(item) &&
        [item.id, item.key, item.slug].find(
          (candidate): candidate is number | string =>
            typeof candidate === "string" || typeof candidate === "number",
        );
      visitJsonLeaves(item, visitor, [
        ...address,
        {
          index,
          kind: "index",
          ...(stableId === false || stableId === undefined
            ? {}
            : { stableId: String(stableId) }),
        },
      ]);
    });
    return;
  }

  if (isJsonObject(value)) {
    for (const [key, nextValue] of Object.entries(value)) {
      visitJsonLeaves(nextValue, visitor, [...address, { key, kind: "key" }]);
    }
    return;
  }

  visitor({
    address,
    value,
  });
}

export function mapEntriesByPointer(
  document: LoadedDocument,
  toPointer: (address: readonly AddressSegment[]) => string,
): Map<string, Entry> {
  return new Map(
    document.entries.map((entry) => [toPointer(entry.address), entry] as const),
  );
}
