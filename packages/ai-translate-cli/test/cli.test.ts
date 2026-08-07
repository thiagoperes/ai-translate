import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defineConfig } from "@ai-translate/core";
import type {
  AiTranslateConfig,
  SemanticAuditDefinition,
  SemanticAuditProvider,
  SemanticAuditVerdict,
} from "@ai-translate/core/types";
import { createJsonStateStore, createNamespaceJsonCatalog } from "@ai-translate/fs-json";

import * as configModule from "../src/config";
import { runCli } from "../src/index";

async function createWorkspace(sourceContent: Record<string, unknown> = { cta: "Get started" }) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-cli-"));
  const localesDir = path.join(cwd, "locales");
  await fs.mkdir(path.join(localesDir, "en"), { recursive: true });
  await fs.writeFile(
    path.join(localesDir, "en", "common.json"),
    JSON.stringify(sourceContent),
    "utf8",
  );

  return {
    cwd,
    localesDir,
  };
}

function createConfig(
  cwd: string,
  provider: AiTranslateConfig["provider"] = {
    translate({ locale, requests }) {
      return Promise.resolve(
        requests.map((request) => ({
          key: request.key,
          translation: `${locale}:${request.sourceText}`,
        })),
      );
    },
  },
  overrides: Partial<AiTranslateConfig> = {},
): AiTranslateConfig {
  return defineConfig({
    catalogs: [
      createNamespaceJsonCatalog({
        rootDir: path.join(cwd, "locales"),
        sourceLocale: "en",
      }),
    ],
    provider,
    sourceLocale: "en",
    state: createJsonStateStore({
      rootDir: cwd,
    }),
    targetLocales: ["fr"],
    ...overrides,
  });
}

function semanticAudit(provider: SemanticAuditProvider): SemanticAuditDefinition {
  return {
    adversarialModelId: "audit-adversarial-v1",
    adversarialPromptRevision: "adversarial-prompt-v1",
    analyze: () => ({
      deterministicEvaluations: [{ requirementId: "claim", verdict: "ambiguous" }],
      keyMaterial: { claim: "preserve" },
      requirements: [{ description: "Preserve the source claim.", id: "claim" }],
    }),
    forwardModelId: "audit-forward-v1",
    forwardPromptRevision: "forward-prompt-v1",
    id: "claim-integrity",
    provider,
    providerRevision: "provider-v1",
    revision: "audit-v1",
  };
}

function semanticProvider(verdict: SemanticAuditVerdict): SemanticAuditProvider {
  return {
    audit: ({ modelId, requests }) =>
      Promise.resolve(
        requests.map((request) => ({
          evaluations: request.requirements.map(({ id }) => ({
            confidence: "high" as const,
            evidence: [
              {
                end: request.sourceText.length,
                field: "source" as const,
                quote: request.sourceText,
                start: 0,
              },
              {
                end: request.targetText.length,
                field: "target" as const,
                quote: request.targetText,
                start: 0,
              },
            ],
            reason: "The cited source and target spans establish the semantic result.",
            requirementId: id,
            verdict,
          })),
          key: request.key,
          modelId,
        })),
      ),
  };
}

function mockConsole() {
  return {
    stderrSpy: vi.spyOn(console, "error").mockImplementation((): void => {
      return;
    }),
    stdoutSpy: vi.spyOn(console, "log").mockImplementation((): void => {
      return;
    }),
  };
}

describe("runCli", { concurrent: false }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints help when no command is provided", async () => {
    const { cwd } = await createWorkspace();
    const { stdoutSpy, stderrSpy } = mockConsole();

    const exitCode = await runCli([], cwd);

    expect(exitCode).toBe(0);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain("Usage:");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("prints the version for the version flag", async () => {
    const { cwd } = await createWorkspace();
    const { stdoutSpy } = mockConsole();

    const exitCode = await runCli(["-v"], cwd);

    expect(exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith("0.0.0");
  });

  it("validates the configured source catalogs", async () => {
    const { cwd } = await createWorkspace();
    const { stdoutSpy, stderrSpy } = mockConsole();
    const config = createConfig(cwd, undefined, {
      targetLocales: [],
    });

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    const loadConfigSpy = vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["validate", "--config=./custom-config.ts"], cwd);

    expect(exitCode).toBe(0);
    expect(loadConfigSpy).toHaveBeenCalledWith(cwd, "./custom-config.ts");
    expect(JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]))).toEqual({
      configPath: path.join(cwd, "ai-translate.config.ts"),
      issues: [],
      legacyUnverifiedGeneratedEntries: 0,
      sourceDocuments: 1,
      targetLocales: 0,
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("fails validate on a source-validator error even when no target locale is selected", async () => {
    const { cwd } = await createWorkspace({ unsafe: "Unsafe English source" });
    const { stdoutSpy, stderrSpy } = mockConsole();
    const config = createConfig(cwd, undefined, {
      sourceValidators: [
        ({ path: sourcePath }) =>
          sourcePath === "/unsafe"
            ? {
                code: "unsafe-source",
                message: "The canonical English source is unsafe.",
                severity: "error",
              }
            : null,
      ],
      targetLocales: [],
    });

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["validate"], cwd);

    expect(exitCode).toBe(1);
    expect(JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]))).toMatchObject({
      issues: [
        {
          catalogId: "namespace-json",
          code: "unsafe-source",
          jsonPointer: "/unsafe",
          locale: "en",
          message: "The canonical English source is unsafe.",
          severity: "error",
          unitId: "common",
        },
      ],
      sourceDocuments: 1,
      targetLocales: 0,
    });
    expect(stderrSpy).toHaveBeenCalledWith("Validation failed.");
  });

  it("runs sync in dry-run mode without writing locale files", async () => {
    const { cwd } = await createWorkspace();
    const config = createConfig(cwd, {
      translate() {
        throw new Error("Provider should not be called for dry-run syncs.");
      },
    });
    const { stdoutSpy, stderrSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["sync", "--dry-run"], cwd);

    expect(exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    await expect(fs.access(path.join(cwd, "locales", "fr", "common.json"))).rejects.toThrow();
  });

  it("syncs only the requested locale targets", async () => {
    const { cwd } = await createWorkspace();
    const config = createConfig(
      cwd,
      {
        translate({ locale, requests }) {
          return Promise.resolve(
            requests.map((request) => ({
              key: request.key,
              translation: `${locale}:${request.sourceText}`,
            })),
          );
        },
      },
      {
        targetLocales: ["fr", "de"],
      },
    );
    const { stdoutSpy, stderrSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["sync", "--locale", "de"], cwd);

    expect(exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(cwd, "locales", "de", "common.json"), "utf8"),
    ).resolves.toContain("de:Get started");
    await expect(fs.access(path.join(cwd, "locales", "fr", "common.json"))).rejects.toThrow();
  });

  it("leaves documents and state untouched when the semantic audit provider throws", async () => {
    const { cwd } = await createWorkspace({ claim: "No refundable deposit" });
    const config = createConfig(cwd, undefined, {
      semanticAudits: [
        semanticAudit({
          audit: () => Promise.reject(new Error("semantic audit unavailable")),
        }),
      ],
      validation: { semanticAuditExecution: "provider" as const },
    });
    const { stderrSpy } = mockConsole();
    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    expect(await runCli(["sync"], cwd)).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("semantic audit unavailable");
    await expect(fs.access(path.join(cwd, "locales", "fr", "common.json"))).rejects.toThrow();
    await expect(config.state.load()).resolves.toEqual({ entries: {}, version: 2 });
  });

  it("skips the semantic phase when translation returns a generator self-check", async () => {
    const { cwd } = await createWorkspace({ claim: "No refundable deposit" });
    const audit = vi.fn<SemanticAuditProvider["audit"]>(() =>
      Promise.reject(new Error("semantic provider must not run")),
    );
    const config = createConfig(
      cwd,
      {
        translate: ({ locale, requests }) =>
          Promise.resolve(
            requests.map((request) => ({
              key: request.key,
              selfCheck: {
                modelId: "translation-model",
                planDigests: (request.selfCheckPlans ?? []).map(({ digest }) => digest),
                verified: true as const,
              },
              translation: `${locale}:${request.sourceText}`,
            })),
          ),
      },
      {
        semanticAudits: [semanticAudit({ audit })],
        validation: { semanticAuditExecution: "generator-self-check" },
      },
    );
    const { stderrSpy } = mockConsole();
    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    expect(await runCli(["sync"], cwd)).toBe(0);
    expect(audit).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    const state = await config.state.load();
    expect(Object.values(state.entries)[0]?.validationAudits?.["claim-integrity"]).toMatchObject({
      provenanceOrigin: "generator-self-check",
      status: "accepted",
    });
  });

  it("does not publish unresolved semantic audit output", async () => {
    const { cwd } = await createWorkspace({ claim: "No refundable deposit" });
    const config = createConfig(cwd, undefined, {
      semanticAudits: [semanticAudit(semanticProvider("ambiguous"))],
      validation: { semanticAuditExecution: "provider" as const },
    });
    const { stderrSpy } = mockConsole();
    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    expect(await runCli(["sync"], cwd)).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Sync completed with unresolved semantic audits. Review or refresh the audit findings.",
    );
    await expect(fs.access(path.join(cwd, "locales", "fr", "common.json"))).rejects.toThrow();
    await expect(config.state.load()).resolves.toEqual({ entries: {}, version: 2 });
  });

  it("publishes normalized documents and audit provenance after convergence", async () => {
    const { cwd } = await createWorkspace({ claim: "No refundable deposit" });
    const config = createConfig(cwd, undefined, {
      semanticAudits: [semanticAudit(semanticProvider("preserved"))],
      validation: { semanticAuditExecution: "provider" as const },
    });
    const { stderrSpy } = mockConsole();
    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    expect(await runCli(["sync"], cwd)).toBe(0);
    await expect(
      fs.readFile(path.join(cwd, "locales", "fr", "common.json"), "utf8"),
    ).resolves.toContain("fr:No refundable deposit");
    const state = await config.state.load();
    expect(Object.values(state.entries)[0]?.validationAudits?.["claim-integrity"]).toMatchObject({
      status: "accepted",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not publish after the bounded semantic repair loop fails to converge", async () => {
    const { cwd } = await createWorkspace({ claim: "No refundable deposit" });
    let translationRound = 0;
    const config = createConfig(
      cwd,
      {
        translate: ({ locale, requests }) => {
          translationRound += 1;
          return Promise.resolve(
            requests.map((request) => ({
              key: request.key,
              translation: `${locale}:${request.sourceText}:${String(translationRound)}`,
            })),
          );
        },
      },
      {
        semanticAudits: [semanticAudit(semanticProvider("contradicted"))],
        validation: { semanticAuditExecution: "provider" as const, semanticRepairAttempts: 3 },
      },
    );
    const { stderrSpy } = mockConsole();
    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    expect(await runCli(["sync"], cwd)).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Semantic audit rejected translations after 3 configured repair round(s).",
    );
    await expect(fs.access(path.join(cwd, "locales", "fr", "common.json"))).rejects.toThrow();
    await expect(config.state.load()).resolves.toEqual({ entries: {}, version: 2 });
  });

  it("returns a failing exit code when sync finishes with failed entries", async () => {
    const { cwd } = await createWorkspace({
      cta: "Get started {{team}}",
    });
    const config = createConfig(cwd, {
      translate({ requests }) {
        return Promise.resolve(
          requests.map((request) => ({
            key: request.key,
            translation: "Commencez",
          })),
        );
      },
    });
    const { stderrSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["sync"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("Sync completed with failed translation entries.");
  });

  it("scaffolds a locale from an existing source locale", async () => {
    const { cwd } = await createWorkspace();
    const config = createConfig(cwd);
    const { stdoutSpy, stderrSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["scaffold-locale", "fr", "--from", "en"], cwd);

    expect(exitCode).toBe(0);
    expect(JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]))).toEqual({
      fromLocale: "en",
      locale: "fr",
      scaffoldResults: [
        {
          catalogId: "namespace-json",
          createdDocuments: 1,
          locale: "fr",
          skippedDocuments: 0,
          strategy: "copy-locale",
        },
      ],
      strategy: "copy-locale",
      status: "ok",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
    const scaffolded = JSON.parse(
      await fs.readFile(path.join(cwd, "locales", "fr", "common.json"), "utf8"),
    ) as { cta: string };
    expect(scaffolded.cta).toBe("Get started");
  });

  it("creates and syncs a new locale without touching other configured locales", async () => {
    const { cwd } = await createWorkspace();
    const config = createConfig(
      cwd,
      {
        translate({ locale, requests }) {
          return Promise.resolve(
            requests.map((request) => ({
              key: request.key,
              translation: `${locale}:${request.sourceText}`,
            })),
          );
        },
      },
      {
        targetLocales: ["fr"],
      },
    );
    const { stdoutSpy, stderrSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["new-locale", "de"], cwd);

    expect(exitCode).toBe(0);
    expect(JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]))).toMatchObject({
      dryRun: false,
      fromLocale: "en",
      locale: "de",
      scaffoldResults: [
        {
          catalogId: "namespace-json",
          createdDocuments: 1,
          locale: "de",
          skippedDocuments: 0,
          strategy: "copy-source",
        },
      ],
      strategy: "copy-source",
      status: "ok",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(cwd, "locales", "de", "common.json"), "utf8"),
    ).resolves.toContain("de:Get started");
    await expect(fs.access(path.join(cwd, "locales", "fr", "common.json"))).rejects.toThrow();
  });

  it("requires a locale argument for scaffold-locale", async () => {
    const { cwd } = await createWorkspace();
    const { stderrSpy } = mockConsole();

    const exitCode = await runCli(["scaffold-locale"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      'The "scaffold-locale" command requires a <locale> argument.',
    );
  });

  it("fails validation when translated files drift from the committed state", async () => {
    const { cwd } = await createWorkspace();
    const config = createConfig(cwd);
    await fs.mkdir(path.join(cwd, "locales", "fr"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "locales", "fr", "common.json"),
      JSON.stringify({ cta: "Commencer" }),
      "utf8",
    );
    await config.state.save({
      entries: {
        "fr::namespace-json::common::/cta": {
          catalogId: "namespace-json",
          jsonPointer: "/cta",
          locale: "fr",
          origin: "generated",
          sourceDigest: "wrong-source",
          status: "synced",
          targetDigest: "wrong-target",
          translationContextDigest: "",
          unitId: "common",
          updatedAt: "2026-03-17T00:00:00.000Z",
        },
      },
      version: 2,
    });
    const { stderrSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["validate"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("Validation failed.");
  });

  it("requires --from for scaffold-locale", async () => {
    const { cwd } = await createWorkspace();
    const { stderrSpy } = mockConsole();

    const exitCode = await runCli(["scaffold-locale", "fr"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      'The "scaffold-locale" command requires --from <locale>.',
    );
  });

  it("seeds state from existing translations through the adopt command", async () => {
    const { cwd, localesDir } = await createWorkspace();
    await fs.mkdir(path.join(localesDir, "fr"), { recursive: true });
    await fs.writeFile(
      path.join(localesDir, "fr", "common.json"),
      JSON.stringify({ cta: "Commencer" }),
      "utf8",
    );
    const config = createConfig(cwd, {
      translate({ requests }) {
        return Promise.resolve(
          requests.map((request) => ({
            key: request.key,
            translation: request.sourceText,
          })),
        );
      },
    });
    const { stdoutSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["adopt"], cwd);

    expect(exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    const stateFile = JSON.parse(
      await fs.readFile(path.join(cwd, ".ai-translate", "translation-state.json"), "utf8"),
    ) as { entries: Record<string, { origin: string }> };
    expect(stateFile.entries["fr::namespace-json::common::/cta"]?.origin).toBe("legacy-unknown");
  });

  it("writes no state when adopt runs as a dry run", async () => {
    const { cwd } = await createWorkspace();
    const config = createConfig(cwd, {
      translate({ requests }) {
        return Promise.resolve(
          requests.map((request) => ({
            key: request.key,
            translation: request.sourceText,
          })),
        );
      },
    });
    const { stdoutSpy } = mockConsole();

    vi.spyOn(configModule, "loadEnvFiles").mockResolvedValue({});
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      config,
      configPath: path.join(cwd, "ai-translate.config.ts"),
    });

    const exitCode = await runCli(["adopt", "--dry-run"], cwd);

    expect(exitCode).toBe(0);
    expect(stdoutSpy.mock.calls[0]?.[0]).toContain('"dryRun": true');
    await expect(
      fs.readFile(path.join(cwd, ".ai-translate", "translation-state.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects an unsupported --identical-to-source value", async () => {
    const { cwd } = await createWorkspace();
    const { stderrSpy } = mockConsole();

    const exitCode = await runCli(["adopt", "--identical-to-source", "maybe"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      'Option "--identical-to-source" accepts "adopt" or "skip", not "maybe".',
    );
  });

  it("rejects unknown commands", async () => {
    const { cwd } = await createWorkspace();
    const { stderrSpy } = mockConsole();

    const exitCode = await runCli(["deploy"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith('Unknown command "deploy".');
  });

  it("rejects unknown options", async () => {
    const { cwd } = await createWorkspace();
    const { stderrSpy } = mockConsole();

    const exitCode = await runCli(["sync", "--bogus"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith('Unknown option "--bogus".');
  });

  it("rejects empty option flags", async () => {
    const { cwd } = await createWorkspace();
    const { stderrSpy } = mockConsole();

    const exitCode = await runCli(["sync", "--"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith("Encountered an empty option flag.");
  });

  it("rejects missing option values", async () => {
    const { cwd } = await createWorkspace();
    const { stderrSpy } = mockConsole();

    const exitCode = await runCli(["validate", "--config"], cwd);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith('Option "--config" requires a value.');
  });
});
