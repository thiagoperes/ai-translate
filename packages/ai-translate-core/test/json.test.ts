import { describe, expect, it } from "vitest";

import { addressToJsonPointer } from "../src/address";
import {
  cloneJsonValue,
  getJsonValueAtAddress,
  isJsonObject,
  mapEntriesByPointer,
  setJsonValueAtAddress,
  visitJsonLeaves,
} from "../src/json";
import type { Entry, JsonValue, LoadedDocument } from "../src/types";

describe("json helpers", () => {
  it("clones JSON values and identifies plain objects", () => {
    const source = {
      meta: {
        label: "Fleet",
      },
      tabs: ["overview", "drivers"],
    } satisfies JsonValue;

    const cloned = cloneJsonValue(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.meta).not.toBe(source.meta);
    expect(cloned.tabs).not.toBe(source.tabs);

    expect(isJsonObject(source)).toBe(true);
    expect(isJsonObject(["a", "b"])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("fleet")).toBe(false);
  });

  it("reads nested JSON values by address", () => {
    const root = {
      users: [
        {
          name: "Ada",
          roles: ["admin"],
        },
      ],
    } satisfies JsonValue;

    expect(
      getJsonValueAtAddress(root, [
        { key: "users", kind: "key" },
        { index: 0, kind: "index" },
        { key: "name", kind: "key" },
      ]),
    ).toBe("Ada");
    expect(
      getJsonValueAtAddress(root, [
        { key: "users", kind: "key" },
        { index: 1, kind: "index" },
      ]),
    ).toBeUndefined();
    expect(
      getJsonValueAtAddress(root, [
        { id: "html.text.0", kind: "node" },
      ]),
    ).toBeUndefined();
    expect(
      getJsonValueAtAddress(root, [
        { key: "users", kind: "key" },
        { key: "name", kind: "key" },
      ]),
    ).toBeUndefined();
  });

  it("sets nested JSON values and creates intermediate containers", () => {
    const root: JsonValue = {};

    setJsonValueAtAddress(
      root,
      [
        { key: "users", kind: "key" },
        { index: 0, kind: "index" },
        { key: "name", kind: "key" },
      ],
      "Ada",
    );
    setJsonValueAtAddress(
      root,
      [
        { key: "users", kind: "key" },
        { index: 0, kind: "index" },
        { key: "active", kind: "key" },
      ],
      true,
    );

    expect(root).toEqual({
      users: [
        {
          active: true,
          name: "Ada",
        },
      ],
    });

    expect(() => setJsonValueAtAddress(root, [], "bad")).toThrow(
      "Cannot replace the document root by address.",
    );
    expect(() =>
      setJsonValueAtAddress(root, [{ id: "node.1", kind: "node" }], "bad"),
    ).toThrow("Node segments are not supported for JSON values.");
    expect(() =>
      setJsonValueAtAddress([], [{ key: "name", kind: "key" }], "bad"),
    ).toThrow("Expected an object at the final JSON address segment.");
    expect(() =>
      setJsonValueAtAddress({}, [{ index: 0, kind: "index" }], "bad"),
    ).toThrow("Expected an array at the final JSON address segment.");
  });

  it("visits JSON leaves with stable addresses", () => {
    const visited: { pointer: string; value: boolean | number | string | null }[] = [];

    visitJsonLeaves(
      {
        enabled: true,
        header: {
          title: "Fleet OS",
        },
        tabs: ["Overview", null, 3],
      },
      ({ address, value }) => {
        visited.push({
          pointer: addressToJsonPointer(address),
          value,
        });
      },
    );

    expect(visited).toEqual([
      { pointer: "/enabled", value: true },
      { pointer: "/header/title", value: "Fleet OS" },
      { pointer: "/tabs/0", value: "Overview" },
      { pointer: "/tabs/1", value: null },
      { pointer: "/tabs/2", value: 3 },
    ]);
  });

  it("maps document entries by JSON pointer", () => {
    const entries: Entry[] = [
      {
        address: [{ key: "cta", kind: "key" }],
        policy: "translate",
        storage: "string",
        value: "Get started",
      },
      {
        address: [
          { key: "tabs", kind: "key" },
          { index: 0, kind: "index" },
          { key: "label", kind: "key" },
        ],
        policy: "translate",
        storage: "string",
        value: "Overview",
      },
    ];
    const document: LoadedDocument = {
      entries,
      ref: {
        catalogId: "memory",
        format: "json",
        locale: "en",
        path: "/memory/en/messages.json",
        unitId: "messages",
      },
      state: {},
    };

    const entryMap = mapEntriesByPointer(document, addressToJsonPointer);

    expect(entryMap.get("/cta")?.value).toBe("Get started");
    expect(entryMap.get("/tabs/0/label")?.value).toBe("Overview");
  });
});
