import { describe, expect, it } from "vitest";

import { renderConfig } from "../src/index";

describe("mapped JSON document config rendering", () => {
  it("keeps explicit locale filenames as quoted data", () => {
    const files = { en: "metadata/English.json", fr: "metadata/French's.json" };
    expect(renderConfig({
      catalog: { kind: "document-json", localeFiles: files, rootDir: "." },
      messageFormat: "plain", sourceLocale: "en", targetLocales: ["fr"], warnings: [],
    })).toContain(`localeFiles: ${JSON.stringify(files)},`);
  });
});
