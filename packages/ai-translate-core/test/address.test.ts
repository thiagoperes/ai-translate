import { describe, expect, it } from "vitest";

import {
  addressToDisplayPath,
  addressToJsonPointer,
  jsonPointerToAddress,
  makeLegacyStateKey,
  makeStateKey,
} from "../src/address";

describe("address utilities", () => {
  it("round-trips JSON pointers for keys, indices, and node ids", () => {
    const address = [
      { key: "teams", kind: "key" },
      { key: "tabs", kind: "key" },
      { index: 0, kind: "index", stableId: "bo" },
      { id: "text.1", kind: "node" },
    ] as const;

    const pointer = addressToJsonPointer(address);
    expect(pointer).toBe("/teams/tabs/0/@node:text.1");
    expect(jsonPointerToAddress(pointer)).toEqual([
      { key: "teams", kind: "key" },
      { key: "tabs", kind: "key" },
      { index: 0, kind: "index" },
      { id: "text.1", kind: "node" },
    ]);
  });

  it("formats display paths and stable state keys", () => {
    expect(
      addressToDisplayPath([
        { key: "routes", kind: "key" },
        { key: "charge insights", kind: "key" },
      ]),
    ).toBe("$.routes.charge insights");
    expect(makeStateKey("fr", "messages", "common", "/routes/charge insights")).toBe(
      "fr::messages::common::/routes/charge insights",
    );
    expect(makeLegacyStateKey("fr", "common", "/routes/charge insights")).toBe(
      "fr::common::/routes/charge insights",
    );
  });
});
