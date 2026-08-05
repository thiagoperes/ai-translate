import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { findConfigPath, loadConfig, loadEnvFiles } from "../src/config";

const originalNodeEnv = process.env.NODE_ENV;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

describe("cli config helpers", () => {
  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
  });

  it("finds ai-translate.config.ts automatically", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-config-"));
    const configPath = path.join(cwd, "ai-translate.config.ts");
    await fs.writeFile(configPath, "export default {};\n", "utf8");

    expect(findConfigPath(cwd)).toBe(configPath);
  });

  it("resolves an explicit config path", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-config-explicit-"));

    expect(findConfigPath(cwd, "./config/custom.ts")).toBe(
      path.join(cwd, "config", "custom.ts"),
    );
  });

  it("throws when no config file is present", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-config-missing-"));

    expect(() => findConfigPath(cwd)).toThrow(
      `Unable to find ai-translate config in ${cwd}. Expected one of: ai-translate.config.ts, ai-translate.config.mts, ai-translate.config.js, ai-translate.config.mjs`,
    );
  });

  it("loads .env files in predictable precedence order", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-env-"));
    await fs.writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=base\n", "utf8");
    await fs.writeFile(path.join(cwd, ".env.local"), "OPENAI_API_KEY=local\n", "utf8");
    process.env.NODE_ENV = "test";
    await fs.writeFile(path.join(cwd, ".env.test"), "OPENAI_API_KEY=test\n", "utf8");

    const loaded = await loadEnvFiles(cwd);

    expect(loaded.OPENAI_API_KEY).toBe("test");
    expect(process.env.OPENAI_API_KEY).toBeDefined();
  });

  it("rethrows non-ENOENT errors while loading env files", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-env-error-"));
    await fs.mkdir(path.join(cwd, ".env"));

    await expect(loadEnvFiles(cwd)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("loads a valid config module from disk", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-load-config-"));
    const configPath = path.join(cwd, "ai-translate.config.mjs");
    await fs.writeFile(
      configPath,
      `
        export default {
          catalogs: [],
          provider: {
            translate: async () => [],
          },
          sourceLocale: "en",
          state: {
            async load() {
              return { version: 1, entries: {} };
            },
            async save() {
              return;
            },
            async withLock(callback) {
              return callback();
            },
          },
          targetLocales: ["fr"],
        };
      `,
      "utf8",
    );

    const loaded = await loadConfig(cwd, "./ai-translate.config.mjs");

    expect(loaded.configPath).toBe(configPath);
    expect(loaded.config.sourceLocale).toBe("en");
    expect(loaded.config.targetLocales).toEqual(["fr"]);
  });

  it("rejects config modules that do not export an ai-translate config", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-load-config-invalid-"));
    await fs.writeFile(
      path.join(cwd, "ai-translate.config.mjs"),
      "export default { nope: true };\n",
      "utf8",
    );

    await expect(loadConfig(cwd)).rejects.toThrow(
      `Config file ${path.join(cwd, "ai-translate.config.mjs")} did not export an ai-translate config object.`,
    );
  });
});
