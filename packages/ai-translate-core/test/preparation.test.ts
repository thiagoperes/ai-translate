import { describe, expect, it } from "vitest";

import { resolveContentRole } from "../src/policies";
import { syncCatalogs } from "../src/sync";
import type { CatalogAdapter, Entry } from "../src/types";

describe("bounded catalog preparation", () => {
  it("overlaps independent reads, retains ordering, and honors document concurrency", async () => {
    let active = 0;
    let peak = 0;
    const writes: string[] = [];
    const refs = Array.from({ length: 7 }, (_, index) => ({
      catalogId: "test",
      format: "json" as const,
      locale: "en",
      path: `/memory/en/${index}`,
      unitId: String(index),
    }));
    const catalog: CatalogAdapter = {
      id: "test",
      listDocumentRefs: async () => refs,
      createDocumentRef: (ref, locale) => ({
        ...ref,
        locale,
        path: `/memory/${locale}/${ref.unitId}`,
      }),
      async loadDocument(ref) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
        active -= 1;
        return ref.locale === "en"
          ? {
              ref,
              entries: [{ address: [], storage: "scalar", policy: "copy", value: 1 }],
              state: {},
            }
          : null;
      },
      reconcileDocument: async ({ source, ref }) => ({ ...structuredClone(source), ref }),
      writeDocument: async ({ ref }) => {
        writes.push(ref.path);
      },
    };
    const result = await syncCatalogs({
      sourceLocale: "en",
      targetLocales: ["de", "fr"],
      catalogs: [catalog],
      concurrency: { documents: 3 },
      provider: {
        translate: async () => {
          throw new Error("No model needed.");
        },
      },
      state: {
        load: async () => ({ version: 2, entries: {} }),
        save: async () => {},
        withLock: (f) => f(),
      },
    });
    expect(peak).toBe(3);
    expect(result.documents.map(({ unitId, locale }) => `${unitId}:${locale}`)).toEqual(
      refs.flatMap(({ unitId }) => [`${unitId}:de`, `${unitId}:fr`]),
    );
    expect(writes).toHaveLength(14);
  });

  it("uses adapter roles by default and honors an explicit resolver including opt-out", () => {
    const entry: Entry = {
      address: [],
      policy: "translate",
      storage: "markdoc",
      value: "Title",
      meta: { contentRole: "heading" },
    };
    const args = { catalogId: "test", entry, locale: "de", path: "/title", unitId: "unit" };
    expect(resolveContentRole(args)).toBe("heading");
    expect(resolveContentRole({ ...args, resolver: () => "body" })).toBe("body");
    expect(resolveContentRole({ ...args, resolver: () => undefined })).toBeUndefined();
    expect(
      resolveContentRole({ ...args, entry: { ...entry, meta: { contentRole: "unsupported" } } }),
    ).toBeUndefined();
  });
});
