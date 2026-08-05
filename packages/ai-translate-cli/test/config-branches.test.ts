import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const mockJitiImport = vi.hoisted(() => vi.fn());
const mockCreateJiti = vi.hoisted(() =>
  vi.fn(() => ({
    import: mockJitiImport,
  })),
);
const mockDefineConfig = vi.hoisted(() => vi.fn((config: unknown) => config));

vi.mock("jiti", () => ({
  createJiti: mockCreateJiti,
}));

vi.mock("@ai-translate/core", () => ({
  defineConfig: mockDefineConfig,
}));

import { findConfigPath, loadConfig, loadEnvFiles } from "../src/config";

function createValidConfig() {
  return {
    catalogs: [],
    provider: {},
    sourceLocale: "en",
    state: {},
    targetLocales: ["fr"],
  };
}

describe("config branch coverage", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalBaseOnly = process.env.BASE_ONLY;
  const originalLocalOnly = process.env.LOCAL_ONLY;

  afterEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = originalNodeEnv;

    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }

    if (originalBaseOnly === undefined) {
      delete process.env.BASE_ONLY;
    } else {
      process.env.BASE_ONLY = originalBaseOnly;
    }

    if (originalLocalOnly === undefined) {
      delete process.env.LOCAL_ONLY;
    } else {
      process.env.LOCAL_ONLY = originalLocalOnly;
    }
  });

  it("resolves an explicit config path", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-config-explicit-"));

    expect(findConfigPath(cwd, "./nested/custom.config.ts")).toBe(
      path.resolve(cwd, "./nested/custom.config.ts"),
    );
  });

  it("throws when no config file exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-config-missing-"));

    expect(() => findConfigPath(cwd)).toThrow(
      `Unable to find ai-translate config in ${cwd}. Expected one of: ai-translate.config.ts, ai-translate.config.mts, ai-translate.config.js, ai-translate.config.mjs`,
    );
  });

  it("loads base env files when NODE_ENV is unset", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-env-base-"));
    delete process.env.NODE_ENV;
    await fs.writeFile(path.join(cwd, ".env"), "BASE_ONLY=1\nOPENAI_API_KEY=base\n", "utf8");
    await fs.writeFile(path.join(cwd, ".env.local"), "LOCAL_ONLY=1\nOPENAI_API_KEY=local\n", "utf8");

    const loaded = await loadEnvFiles(cwd);

    expect(loaded).toEqual({
      BASE_ONLY: "1",
      LOCAL_ONLY: "1",
      OPENAI_API_KEY: "local",
    });
  });

  it("rethrows env file read errors other than ENOENT", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-env-error-"));
    delete process.env.NODE_ENV;
    await fs.writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=base\n", "utf8");
    await fs.mkdir(path.join(cwd, ".env.local"));

    await expect(loadEnvFiles(cwd)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("loads config from a wrapped default export", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-load-config-default-"));
    const configPath = path.join(cwd, "ai-translate.config.ts");
    const validConfig = createValidConfig();
    await fs.writeFile(configPath, "export default {}\n", "utf8");
    mockJitiImport.mockResolvedValue({
      default: validConfig,
    });

    const result = await loadConfig(cwd);

    expect(mockCreateJiti).toHaveBeenCalledTimes(1);
    expect(mockCreateJiti).toHaveBeenCalledWith(
      expect.stringContaining("/packages/ai-translate-cli/src/config.ts"),
      {
        interopDefault: true,
        moduleCache: false,
      },
    );
    expect(mockJitiImport).toHaveBeenCalledWith(configPath);
    expect(mockDefineConfig).toHaveBeenCalledWith(validConfig);
    expect(result).toEqual({
      config: validConfig,
      configPath,
    });
  });

  it("falls back to the module object when default is undefined", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-load-config-fallback-"));
    const configPath = path.join(cwd, "ai-translate.config.ts");
    const validConfig = createValidConfig();
    await fs.writeFile(configPath, "export default {}\n", "utf8");
    mockJitiImport.mockResolvedValue({
      ...validConfig,
      default: undefined,
    });

    const result = await loadConfig(cwd);

    expect(mockDefineConfig).toHaveBeenCalledWith({
      ...validConfig,
      default: undefined,
    });
    expect(result).toEqual({
      config: {
        ...validConfig,
        default: undefined,
      },
      configPath,
    });
  });

  it("accepts a direct config export", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-load-config-direct-"));
    const configPath = path.join(cwd, "custom.config.ts");
    const validConfig = createValidConfig();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "export default {}\n", "utf8");
    mockJitiImport.mockResolvedValue(validConfig);

    const result = await loadConfig(cwd, "./custom.config.ts");

    expect(mockJitiImport).toHaveBeenCalledWith(configPath);
    expect(result).toEqual({
      config: validConfig,
      configPath,
    });
  });

  it("rejects invalid config exports", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-load-config-invalid-"));
    const configPath = path.join(cwd, "ai-translate.config.ts");
    await fs.writeFile(configPath, "export default {}\n", "utf8");
    mockJitiImport.mockResolvedValue({
      default: {
        sourceLocale: "en",
      },
    });

    await expect(loadConfig(cwd)).rejects.toThrow(
      `Config file ${configPath} did not export an ai-translate config object.`,
    );
  });
});
