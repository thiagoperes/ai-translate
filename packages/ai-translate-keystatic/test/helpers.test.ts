import { describe, expect, it } from "vitest";

import {
  buildLocalizedSeedMap,
  createLocalizedSingletonPaths,
  scaffoldLocaleSeed,
} from "../src/index";

describe("keystatic helpers", () => {
  it("creates locale file paths", () => {
    expect(
      createLocalizedSingletonPaths({
        locales: ["en", "fr"],
        rootDir: "content/messages",
      }),
    ).toEqual({
      en: "content/messages/en.json",
      fr: "content/messages/fr.json",
    });
  });

  it("normalizes custom locale file extensions", () => {
    expect(
      createLocalizedSingletonPaths({
        extension: "mdoc",
        locales: ["en"],
        rootDir: "content/pages",
      }),
    ).toEqual({
      en: "content/pages/en.mdoc",
    });
  });

  it("builds locale-specific seed maps and overrides", () => {
    const seedMap = buildLocalizedSeedMap(["en", "fr"], {
      overrides: {
        fr: {
          title: "Bonjour",
        },
      },
      seed: {
        title: "Hello",
      },
    });

    expect(seedMap.en?.title).toBe("Hello");
    expect(seedMap.fr?.title).toBe("Bonjour");
    expect(scaffoldLocaleSeed({ title: "Hello" }, { title: "Hoi" })).toEqual({
      title: "Hoi",
    });
  });

  it("scaffolds a clone when no override is provided", () => {
    const seed = { nested: { title: "Hello" } };
    const scaffolded = scaffoldLocaleSeed(seed);

    expect(scaffolded).toEqual(seed);
    expect(scaffolded).not.toBe(seed);
    expect(scaffolded.nested).not.toBe(seed.nested);
  });
});
