import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { i18nextPluralKeys } from "@ai-translate/message-formats";
import { syncCatalogs, validateCatalogs } from "@ai-translate/core/sync";
import type { AiTranslateConfig, JsonValue } from "@ai-translate/core/types";
import { afterEach, describe, expect, it } from "vitest";

import { createNamespaceJsonCatalog } from "../src/namespace-json";
import {
  collapsePluralFamilies,
  expandPluralKeys,
  pluralStructureGroups,
  targetPluralCategories,
} from "../src/plurals";
import { createJsonStateStore } from "../src/state";
import { jsonStructureDigest } from "../src/shared";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function seed(files: Record<string, JsonValue>): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-plurals-"));
  workspaces.push(rootDir);
  for (const [relative, value] of Object.entries(files)) {
    const filePath = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  return rootDir;
}

const EN_NAMESPACE = {
  items_one: "{{count}} item",
  items_other: "{{count}} items",
  title: "Inventory",
};

describe("expandPluralKeys", () => {
  it("adds the forms the target locale requires, seeded from the closest source form", () => {
    expect(expandPluralKeys(EN_NAMESPACE, "pl", i18nextPluralKeys)).toEqual({
      items_one: "{{count}} item",
      items_few: "{{count}} items",
      items_many: "{{count}} items",
      items_other: "{{count}} items",
      title: "Inventory",
    });
  });

  it("keeps source forms the target locale does not need", () => {
    // Japanese only distinguishes `other`, but dropping `items_one` would be
    // reported as a missing target entry against the English source.
    expect(expandPluralKeys(EN_NAMESPACE, "ja", i18nextPluralKeys)).toEqual(EN_NAMESPACE);
  });

  it("keeps the i18next zero form, which sits outside CLDR", () => {
    const source = {
      automations_one: "{{count}} automation",
      automations_other: "{{count}} automations",
      automations_zero: "No automations",
    };

    expect(expandPluralKeys(source, "de", i18nextPluralKeys)).toEqual({
      automations_zero: "No automations",
      automations_one: "{{count}} automation",
      automations_other: "{{count}} automations",
    });
  });

  it("emits the family in canonical order at the position of its first member", () => {
    // Key order decides file diffs. An unstable order would rewrite every
    // localized file on every sync.
    const expanded = expandPluralKeys(
      { a: "A", items_other: "x", items_one: "y", z: "Z" },
      "pl",
      i18nextPluralKeys,
    ) as Record<string, unknown>;

    expect(Object.keys(expanded)).toEqual([
      "a",
      "items_one",
      "items_few",
      "items_many",
      "items_other",
      "z",
    ]);
  });

  it("leaves a lone category-suffixed key alone", () => {
    const merchants = { groceries: "Groceries", miscellaneous_other: "Miscellaneous" };

    expect(expandPluralKeys(merchants, "pl", i18nextPluralKeys)).toEqual(merchants);
  });

  it("does not treat suffixed nested objects as a family", () => {
    const nested = { card_one: { label: "Card" }, card_other: { label: "Cards" } };

    expect(expandPluralKeys(nested, "pl", i18nextPluralKeys)).toEqual(nested);
  });

  it("expands families nested inside objects and arrays", () => {
    expect(
      expandPluralKeys({ page: { rows: [{ ...EN_NAMESPACE }] } }, "pl", i18nextPluralKeys),
    ).toEqual({
      page: { rows: [expandPluralKeys(EN_NAMESPACE, "pl", i18nextPluralKeys)] },
    });
  });

  it("is idempotent, so re-syncing a target does not keep reshaping it", () => {
    const once = expandPluralKeys(EN_NAMESPACE, "pl", i18nextPluralKeys);

    expect(expandPluralKeys(once, "pl", i18nextPluralKeys)).toEqual(once);
  });
});

describe("targetPluralCategories", () => {
  it("unions the locale's grammar with the source's declared forms", () => {
    expect(
      targetPluralCategories({
        locale: "pl",
        sourceCategories: ["one", "other", "zero"],
        strategy: i18nextPluralKeys,
      }),
    ).toEqual(["zero", "one", "few", "many", "other"]);
  });
});

describe("structure normalisation", () => {
  it("gives every member of a family the same group id", () => {
    const groups = pluralStructureGroups(EN_NAMESPACE, i18nextPluralKeys);

    expect(groups.get("/items_one")).toBe("/items#plural");
    expect(groups.get("/items_other")).toBe("/items#plural");
    expect(groups.has("/title")).toBe(false);
  });

  it("digests an English file and its Polish translation identically", () => {
    // The raw structure digest is compared directly during validation, so a
    // per-locale difference here reports every plural file as mismatched.
    expect(jsonStructureDigest(EN_NAMESPACE, i18nextPluralKeys)).toBe(
      jsonStructureDigest(expandPluralKeys(EN_NAMESPACE, "pl", i18nextPluralKeys), i18nextPluralKeys),
    );
  });

  it("still distinguishes a genuine structural change", () => {
    expect(jsonStructureDigest(EN_NAMESPACE, i18nextPluralKeys)).not.toBe(
      jsonStructureDigest({ ...EN_NAMESPACE, subtitle: "New" }, i18nextPluralKeys),
    );
  });

  it("collapses a family to its base", () => {
    expect(collapsePluralFamilies(EN_NAMESPACE, i18nextPluralKeys)).toEqual({
      "items#plural": "",
      title: "Inventory",
    });
  });
});

describe("syncCatalogs with plural expansion", () => {
  /** Echoes the source with a locale marker, so the written file shows which
   * entries actually reached the provider. */
  const echoProvider = {
    translate: ({ locale, requests }: { locale: string; requests: readonly { key: string; sourceText: string }[] }) =>
      Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          translation: `[${locale}] ${request.sourceText}`,
        })),
      ),
  };

  async function syncProject(rootDir: string, targetLocales: readonly string[]) {
    const config = {
      catalogs: [
        createNamespaceJsonCatalog({
          plurals: i18nextPluralKeys,
          rootDir: path.join(rootDir, "locales"),
          sourceLocale: "en",
        }),
      ],
      provider: echoProvider,
      sourceLocale: "en",
      state: createJsonStateStore({ rootDir }),
      targetLocales,
    } as unknown as AiTranslateConfig;

    return syncCatalogs(config);
  }

  it("translates every plural form the target locale needs", async () => {
    // The regression this guards: expanding only inside reconcileDocument
    // reshapes the written file but never routes the new forms through the
    // provider, so Polish ships two seeded English strings and no error.
    const rootDir = await seed({ "locales/en/inventory.json": EN_NAMESPACE });

    const result = await syncProject(rootDir, ["pl"]);
    const written = JSON.parse(
      await fs.readFile(path.join(rootDir, "locales/pl/inventory.json"), "utf8"),
    ) as Record<string, string>;

    expect(Object.keys(written).toSorted()).toEqual([
      "items_few",
      "items_many",
      "items_one",
      "items_other",
      "title",
    ]);
    for (const value of Object.values(written)) {
      expect(value).toMatch(/^\[pl\] /u);
    }
    expect(result.metrics.translatedEntries).toBe(5);
  });

  it("gives each locale only the forms it needs", async () => {
    const rootDir = await seed({ "locales/en/inventory.json": EN_NAMESPACE });

    await syncProject(rootDir, ["de", "pl"]);

    const german = JSON.parse(
      await fs.readFile(path.join(rootDir, "locales/de/inventory.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(german).toSorted()).toEqual(["items_one", "items_other", "title"]);
  });

  it("leaves catalogs without a plural strategy untouched", async () => {
    // No plurals option means no localizeSourceDocument hook at all, so this
    // path must stay byte-identical to how it behaved before expansion existed.
    const rootDir = await seed({ "locales/en/inventory.json": EN_NAMESPACE });
    const config = {
      catalogs: [
        createNamespaceJsonCatalog({
          rootDir: path.join(rootDir, "locales"),
          sourceLocale: "en",
        }),
      ],
      provider: echoProvider,
      sourceLocale: "en",
      state: createJsonStateStore({ rootDir }),
      targetLocales: ["pl"],
    } as unknown as AiTranslateConfig;

    await syncCatalogs(config);

    const written = JSON.parse(
      await fs.readFile(path.join(rootDir, "locales/pl/inventory.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(written).toSorted()).toEqual(["items_one", "items_other", "title"]);
  });

  it("is stable across a second sync", async () => {
    const rootDir = await seed({ "locales/en/inventory.json": EN_NAMESPACE });
    await syncProject(rootDir, ["pl"]);
    const first = await fs.readFile(path.join(rootDir, "locales/pl/inventory.json"), "utf8");

    const second = await syncProject(rootDir, ["pl"]);

    expect(await fs.readFile(path.join(rootDir, "locales/pl/inventory.json"), "utf8")).toBe(first);
    expect(second.metrics.translatedEntries).toBe(0);
  });
});

describe("validateCatalogs with plural expansion", () => {
  /**
   * Only the shape-related codes. Seeded plural forms still read as English,
   * so `untranslated-entry` is expected here and says nothing about structure.
   */
  const STRUCTURAL_CODES = new Set(["document-structure-mismatch", "missing-target-entry"]);

  async function structuralCodes(
    rootDir: string,
    targetLocales: readonly string[],
  ): Promise<string[]> {
    const config = {
      catalogs: [
        createNamespaceJsonCatalog({
          plurals: i18nextPluralKeys,
          rootDir: path.join(rootDir, "locales"),
          sourceLocale: "en",
        }),
      ],
      provider: { translate: () => Promise.resolve([]) },
      sourceLocale: "en",
      state: createJsonStateStore({ rootDir }),
      targetLocales,
    } satisfies AiTranslateConfig;

    const report = await validateCatalogs(config);
    return report.issues.map((issue) => issue.code).filter((code) => STRUCTURAL_CODES.has(code));
  }

  it("accepts a locale carrying more plural forms than the source", async () => {
    // This is the invariant the whole design turns on: without it, every file
    // with a plural reports document-structure-mismatch in any locale whose
    // plural rules are richer than English's.
    const rootDir = await seed({
      "locales/en/inventory.json": EN_NAMESPACE,
      "locales/pl/inventory.json": expandPluralKeys(EN_NAMESPACE, "pl", i18nextPluralKeys),
    });

    expect(await structuralCodes(rootDir, ["pl"])).toEqual([]);
  });

  it("accepts a locale carrying fewer plural forms than it grammatically needs", async () => {
    // A project adopting the toolkit has files that predate expansion. They
    // must validate as structurally sound before the first sync reshapes them.
    const rootDir = await seed({
      "locales/en/inventory.json": EN_NAMESPACE,
      "locales/pl/inventory.json": { items_one: "x", items_other: "y", title: "Inwentarz" },
    });

    expect(await structuralCodes(rootDir, ["pl"])).toEqual([]);
  });

  it("still reports a target that is genuinely missing a key", async () => {
    const rootDir = await seed({
      "locales/en/inventory.json": EN_NAMESPACE,
      "locales/pl/inventory.json": {
        items_few: "y",
        items_many: "z",
        items_one: "x",
        items_other: "w",
      },
    });

    expect(await structuralCodes(rootDir, ["pl"])).toContain("missing-target-entry");
  });

  it("still reports a target that dropped an entire plural family", async () => {
    const rootDir = await seed({
      "locales/en/inventory.json": EN_NAMESPACE,
      "locales/pl/inventory.json": { title: "Inwentarz" },
    });

    expect(await structuralCodes(rootDir, ["pl"])).toContain("document-structure-mismatch");
  });
});
