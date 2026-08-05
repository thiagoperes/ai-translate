import { describe, expect, it } from "vitest";

import {
  buildStateHistoryIndex,
  getStateHistory,
  removeStateEntriesInPlace,
} from "../src/state-operations";
import type { SyncStateEntry } from "../src/types";

function stateEntry(args: { catalogId?: string; locale: string; unitId: string }): SyncStateEntry {
  return {
    ...(args.catalogId === undefined ? {} : { catalogId: args.catalogId }),
    jsonPointer: "/title",
    locale: args.locale,
    origin: "generated",
    sourceDigest: "source",
    status: "synced",
    targetDigest: "target",
    unitId: args.unitId,
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

describe("state operation complexity", () => {
  it("indexes every state record once and only visits the requested history bucket", () => {
    let localeReads = 0;
    let unitReads = 0;
    const entries: Record<string, SyncStateEntry> = {};

    for (let index = 0; index < 200; index += 1) {
      const entry = stateEntry({
        catalogId: "posts",
        locale: "fr",
        unitId: `unrelated-${String(index)}`,
      });
      Object.defineProperties(entry, {
        locale: {
          configurable: true,
          enumerable: true,
          get: () => {
            localeReads += 1;
            return "fr";
          },
        },
        unitId: {
          configurable: true,
          enumerable: true,
          get: () => {
            unitReads += 1;
            return `unrelated-${String(index)}`;
          },
        },
      });
      entries[`state-${String(index)}`] = entry;
    }

    entries.canonical = stateEntry({ catalogId: "posts", locale: "de", unitId: "welcome.mdoc" });
    entries.legacy = stateEntry({ locale: "de", unitId: "welcome.mdoc" });
    entries.otherCatalog = stateEntry({
      catalogId: "pages",
      locale: "de",
      unitId: "welcome.mdoc",
    });

    const index = buildStateHistoryIndex({ entries, version: 2 });
    expect(localeReads).toBe(200);
    expect(unitReads).toBe(200);

    expect(
      getStateHistory({
        catalogId: "posts",
        index,
        locale: "de",
        unitId: "welcome.mdoc",
      }).map(({ stateKey }) => stateKey),
    ).toEqual(["canonical", "legacy"]);

    expect(localeReads).toBe(200);
    expect(unitReads).toBe(200);
  });

  it("deletes unique keys without enumerating or copying the state record", () => {
    let deleteCalls = 0;
    let enumerations = 0;
    const rawEntries: Record<string, SyncStateEntry> = {
      keep: stateEntry({ catalogId: "posts", locale: "de", unitId: "keep.mdoc" }),
      retire: stateEntry({ catalogId: "posts", locale: "de", unitId: "retire.mdoc" }),
    };
    const entries = new Proxy(rawEntries, {
      deleteProperty(target, property) {
        deleteCalls += 1;
        return Reflect.deleteProperty(target, property);
      },
      ownKeys(target) {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
    });

    removeStateEntriesInPlace(entries, ["retire", "retire", "missing"]);

    expect(deleteCalls).toBe(2);
    expect(enumerations).toBe(0);
    expect(rawEntries).toEqual({
      keep: expect.objectContaining({ unitId: "keep.mdoc" }),
    });
  });
});
