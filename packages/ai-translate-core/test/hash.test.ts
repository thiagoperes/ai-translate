import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { digestValue } from "../src/hash";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

describe("digestValue", () => {
  it("matches a plain sha256 of the stringified value", () => {
    for (const value of ["", "Save changes", "üñïçødé 🎉", "a".repeat(5000)]) {
      expect(digestValue(value)).toBe(sha256(value));
    }
    for (const value of [true, false, null, 0, -1, 42.5]) {
      expect(digestValue(value)).toBe(sha256(String(value)));
    }
  });

  it("returns the same digest whether or not the value was seen before", () => {
    const first = digestValue("Repeated source string.");
    expect(digestValue("Repeated source string.")).toBe(first);
    expect(first).toBe(sha256("Repeated source string."));
  });

  it("does not confuse a value with its string form", () => {
    // Caching keys on the stringified value, so these must agree with String()
    // rather than accidentally collide across types.
    expect(digestValue("true")).toBe(digestValue(true));
    expect(digestValue("null")).toBe(digestValue(null));
    expect(digestValue("42")).toBe(digestValue(42));
  });

  it("stays correct past the cache bound", () => {
    // More distinct values than the cache holds, so the eviction path runs and
    // every answer still has to be the real digest.
    const values = Array.from({ length: 250_001 }, (_unused, index) => `value-${String(index)}`);
    for (const value of values) {
      digestValue(value);
    }
    expect(digestValue("value-0")).toBe(sha256("value-0"));
    expect(digestValue("value-250000")).toBe(sha256("value-250000"));
  });
});
