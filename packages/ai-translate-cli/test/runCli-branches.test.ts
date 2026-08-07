import type { AiTranslateConfig, SyncResult } from "@ai-translate/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockDefineConfig = vi.hoisted(() => vi.fn((config: unknown) => config));
const mockAuditCatalogs = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    accepted: 0,
    audited: 0,
    cached: 0,
    checked: 0,
    issues: [],
    retranslate: 0,
    unresolved: 0,
  }),
);
const mockSyncCatalogs = vi.hoisted(() => vi.fn());
const mockValidateCatalogs = vi.hoisted(() => vi.fn());
const mockWithTranslationIssueCache = vi.hoisted(() =>
  vi.fn((operation: () => Promise<unknown>) => operation()),
);
const mockAdoptExistingTranslations = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockLoadEnvFiles = vi.hoisted(() => vi.fn());

vi.mock("@ai-translate/core", () => ({
  auditCatalogs: mockAuditCatalogs,
  defineConfig: mockDefineConfig,
  syncCatalogs: mockSyncCatalogs,
  validateCatalogs: mockValidateCatalogs,
  withTranslationIssueCache: mockWithTranslationIssueCache,
}));

vi.mock("@ai-translate/fs-json", () => ({
  adoptExistingTranslations: mockAdoptExistingTranslations,
}));

vi.mock("../src/config", () => ({
  findConfigPath: vi.fn(),
  loadConfig: mockLoadConfig,
  loadEnvFiles: mockLoadEnvFiles,
}));

import { runCli } from "../src/index";

function createConfig(overrides: Partial<AiTranslateConfig> = {}): AiTranslateConfig {
  return {
    catalogs: [],
    provider: {
      translate: vi.fn(),
    },
    sourceLocale: "en",
    state: {
      load: vi.fn().mockResolvedValue({
        entries: {},
        version: 2,
      }),
      save: vi.fn().mockResolvedValue(undefined),
      withLock(operation) {
        return operation();
      },
    },
    targetLocales: ["fr"],
    ...overrides,
  };
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    documents: [],
    dryRun: false,
    metrics: {
      changedDocuments: 0,
      copiedEntries: 0,
      durationMs: 0,
      excludedEntries: 0,
      failedEntries: 0,
      scannedDocuments: 0,
      staleManualEntries: 0,
      translatedEntries: 0,
      ...overrides.metrics,
    },
    state: {
      entries: {},
      version: 2,
    },
    ...overrides,
  };
}

function stagedConfig(config: AiTranslateConfig) {
  return expect.objectContaining({
    ...config,
    catalogs: expect.any(Array),
    state: expect.any(Object),
  });
}

function spyOnConsole() {
  const stdoutSpy = vi.spyOn(console, "log").mockImplementation((): void => {
    return;
  });
  const stderrSpy = vi.spyOn(console, "error").mockImplementation((): void => {
    return;
  });

  return { stderrSpy, stdoutSpy };
}

describe("runCli branch coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockAuditCatalogs.mockResolvedValue({
      accepted: 0,
      audited: 0,
      cached: 0,
      checked: 0,
      issues: [],
      retranslate: 0,
      unresolved: 0,
    });
  });

  it("prints help when no command or -h is provided", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();

    expect(await runCli([], "/repo")).toBe(0);
    expect(await runCli(["-h"], "/repo")).toBe(0);

    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockLoadEnvFiles).not.toHaveBeenCalled();
  });

  it("prints the version for both long and short flags", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();

    expect(await runCli(["--version"], "/repo")).toBe(0);
    expect(await runCli(["-v"], "/repo")).toBe(0);

    expect(stdoutSpy).toHaveBeenNthCalledWith(1, "0.0.0");
    expect(stdoutSpy).toHaveBeenNthCalledWith(2, "0.0.0");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("validates configs and counts source documents", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig({
      targetLocales: ["fr", "de"],
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/custom.config.ts",
    });
    mockValidateCatalogs.mockResolvedValue({
      issues: [],
      sourceDocuments: 3,
      targetLocales: 2,
    });

    expect(await runCli(["validate", "--config", "custom.config.ts"], "/repo")).toBe(0);

    expect(mockLoadEnvFiles).toHaveBeenCalledWith("/repo");
    expect(mockLoadConfig).toHaveBeenCalledWith("/repo", "custom.config.ts");
    expect(mockValidateCatalogs).toHaveBeenCalledWith(config, {});
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toEqual({
      configPath: "/repo/custom.config.ts",
      issues: [],
      sourceDocuments: 3,
      targetLocales: 2,
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("fails validation when a source document is missing", async () => {
    const { stderrSpy } = spyOnConsole();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config: createConfig(),
      configPath: "/repo/ai-translate.config.ts",
    });
    mockValidateCatalogs.mockRejectedValue(new Error("Missing source document at missing.json."));

    expect(await runCli(["validate", "--config=override.ts"], "/repo")).toBe(1);

    expect(mockLoadConfig).toHaveBeenCalledWith("/repo", "override.ts");
    expect(stderrSpy).toHaveBeenCalledWith("Missing source document at missing.json.");
  });

  it("syncs with default options when --dry-run is omitted", async () => {
    const argv = ["sync", undefined] as unknown as readonly string[];
    const { stderrSpy } = spyOnConsole();
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());

    expect(await runCli(argv, "/repo")).toBe(0);

    expect(mockSyncCatalogs).toHaveBeenCalledWith(stagedConfig(config), {});
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("syncs only explicit locale selections", async () => {
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());

    expect(await runCli(["sync", "--locale", "de", "--locale=fr"], "/repo")).toBe(0);

    expect(mockSyncCatalogs).toHaveBeenCalledWith(stagedConfig(config), {
      locales: ["de", "fr"],
    });
  });

  it("forwards the provider-call safety budget to sync", async () => {
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());

    expect(
      await runCli(
        ["sync", "--max-pending-translations", "200", "--locale", "de"],
        "/repo",
      ),
    ).toBe(0);

    expect(mockSyncCatalogs).toHaveBeenCalledWith(stagedConfig(config), {
      locales: ["de"],
      maxPendingTranslations: 200,
    });
  });

  it("reports sync failures after printing the summary", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(
      createSyncResult({
        dryRun: true,
        metrics: {
          failedEntries: 2,
        } as SyncResult["metrics"],
      }),
    );

    expect(await runCli(["sync", "--dry-run"], "/repo")).toBe(1);

    expect(mockSyncCatalogs).toHaveBeenCalledWith(config, {
      dryRun: true,
    });
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith("Sync completed with failed translation entries.");
  });

  it("fails a dry-run that exceeds its provider translation budget", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig({
      validation: { dryRunBudget: { maxPendingTranslations: 3 } },
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({ config, configPath: "/repo/ai-translate.config.ts" });
    mockSyncCatalogs.mockResolvedValue(
      createSyncResult({
        dryRun: true,
        metrics: { translatedEntries: 4 } as SyncResult["metrics"],
      }),
    );

    expect(await runCli(["sync", "--dry-run"], "/repo")).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Translation dry-run planned 4 provider translations, exceeding the configured budget of 3.",
    );
  });

  it("reports reason totals and rejects forbidden dry-run selection reasons", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig({
      validation: {
        dryRunBudget: {
          forbiddenPendingTranslationReasons: ["context-changed"],
          maxPendingTranslations: 10,
        },
      },
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({ config, configPath: "/repo/ai-translate.config.ts" });
    mockSyncCatalogs.mockResolvedValue(
      createSyncResult({
        documents: [
          {
            catalogId: "messages",
            changed: false,
            copiedEntries: 0,
            excludedEntries: 0,
            failedEntries: 0,
            issues: [],
            locale: "de",
            path: "/repo/de.json",
            pendingTranslationReasons: { "context-changed": 2, "missing-state": 1 },
            staleManualEntries: 0,
            translatedEntries: 3,
            unitId: "messages",
            wroteFile: false,
          },
        ],
        dryRun: true,
        metrics: { translatedEntries: 3 } as SyncResult["metrics"],
      }),
    );

    expect(await runCli(["sync", "--dry-run"], "/repo")).toBe(1);
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      pendingTranslationReasons: { "context-changed": 2, "missing-state": 1 },
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      "Translation dry-run included forbidden selection reasons: context-changed (2).",
    );
  });

  it("runs two-pass semantic audits and exposes an offline check mode", async () => {
    const { stderrSpy } = spyOnConsole();
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockAuditCatalogs.mockResolvedValueOnce({
      accepted: 0,
      audited: 0,
      cached: 0,
      checked: 1,
      issues: [
        {
          auditId: "claims",
          catalogId: "messages",
          code: "semantic-audit-missing",
          inputDigest: "digest",
          jsonPointer: "/claim",
          locale: "de",
          message: "missing",
          path: "/de/messages.json",
          severity: "error",
          status: "missing",
          unitId: "messages",
        },
      ],
      retranslate: 0,
      unresolved: 1,
    });

    expect(
      await runCli(
        ["audit", "--check", "--refresh", "--locale", "de", "--unit", "messages"],
        "/repo",
      ),
    ).toBe(1);
    expect(mockAuditCatalogs).toHaveBeenCalledWith(config, {
      checkOnly: true,
      locales: ["de"],
      refresh: true,
      unitIds: ["messages"],
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      "Semantic audit check failed. Run ai-translate audit --refresh.",
    );
  });

  it("automatically converges sync through bounded semantic repair rounds", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig({
      semanticAudits: [{} as never],
      validation: { semanticRepairAttempts: 1 },
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());
    mockAuditCatalogs
      .mockResolvedValueOnce({
        accepted: 0,
        audited: 1,
        cached: 0,
        checked: 1,
        issues: [
          {
            auditId: "claims",
            catalogId: "messages",
            code: "semantic-audit-retranslate",
            inputDigest: "digest",
            jsonPointer: "/claim",
            locale: "de",
            message: "retranslate",
            path: "/de/messages.json",
            severity: "error",
            status: "retranslate",
            unitId: "messages",
          },
        ],
        retranslate: 1,
        unresolved: 0,
      })
      .mockResolvedValueOnce({
        accepted: 1,
        audited: 1,
        cached: 0,
        checked: 1,
        issues: [],
        retranslate: 0,
        unresolved: 0,
      });

    expect(
      await runCli(
        ["sync", "--force-retranslate", "--force-retranslate-path", "/claim", "--locale", "de"],
        "/repo",
      ),
    ).toBe(0);
    expect(mockSyncCatalogs).toHaveBeenCalledTimes(2);
    expect(mockSyncCatalogs).toHaveBeenNthCalledWith(1, stagedConfig(config), {
      forceRetranslate: true,
      forceRetranslatePaths: ["/claim"],
      locales: ["de"],
    });
    expect(mockSyncCatalogs).toHaveBeenNthCalledWith(2, stagedConfig(config), {
      locales: ["de"],
    });
    expect(mockAuditCatalogs).toHaveBeenCalledTimes(2);
    expect(mockAuditCatalogs).toHaveBeenCalledWith(stagedConfig(config), {
      forceRetranslate: true,
      forceRetranslatePaths: ["/claim"],
      locales: ["de"],
    });
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      semanticAudit: { accepted: 1, issues: [] },
      semanticRepairRounds: 1,
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("uses one semantic pass by default and never starts a repair loop", async () => {
    const { stderrSpy } = spyOnConsole();
    const config = createConfig({ semanticAudits: [{} as never] });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());
    mockAuditCatalogs.mockResolvedValue({
      accepted: 0,
      audited: 1,
      cached: 0,
      checked: 1,
      issues: [],
      retranslate: 1,
      unresolved: 0,
    });

    expect(await runCli(["sync", "--locale", "de"], "/repo")).toBe(1);
    expect(mockSyncCatalogs).toHaveBeenCalledOnce();
    expect(mockAuditCatalogs).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith(
      "Semantic audit rejected translations after 0 configured repair round(s).",
    );
  });

  it("fails a converged sync on unresolved semantic audits", async () => {
    const { stderrSpy } = spyOnConsole();
    const config = { ...createConfig(), semanticAudits: [{} as never] };
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());
    mockAuditCatalogs.mockResolvedValue({
      accepted: 0,
      audited: 1,
      cached: 0,
      checked: 1,
      issues: [
        {
          auditId: "claims",
          catalogId: "messages",
          code: "semantic-audit-unresolved",
          inputDigest: "digest",
          jsonPointer: "/claim",
          locale: "de",
          message: "unresolved",
          path: "/de/messages.json",
          severity: "error",
          status: "unresolved",
          unitId: "messages",
        },
      ],
      retranslate: 0,
      unresolved: 1,
    });

    expect(await runCli(["sync"], "/repo")).toBe(1);
    expect(mockSyncCatalogs).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith(
      "Sync completed with unresolved semantic audits. Review or refresh the audit findings.",
    );
  });

  it("points audit-only check failures to an audit refresh", async () => {
    const { stderrSpy } = spyOnConsole();
    const config = createConfig({ semanticAudits: [{} as never] });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockValidateCatalogs.mockResolvedValue({ issues: [], sourceDocuments: 1, targetLocales: 1 });
    mockSyncCatalogs.mockResolvedValue(createSyncResult({ dryRun: true }));
    mockAuditCatalogs.mockResolvedValue({
      accepted: 0,
      audited: 0,
      cached: 0,
      checked: 1,
      issues: [
        {
          auditId: "claims",
          catalogId: "messages",
          code: "semantic-audit-stale",
          inputDigest: "digest",
          jsonPointer: "/claim",
          locale: "de",
          message: "stale",
          path: "/de/messages.json",
          severity: "error",
          status: "stale",
          unitId: "messages",
        },
      ],
      retranslate: 0,
      unresolved: 1,
    });

    expect(await runCli(["check"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Translation check failed because semantic audit provenance is missing, stale, or unresolved. Run ai-translate audit --refresh.",
    );
  });

  it("fails check when dry-run reports pending translations without document drift", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockValidateCatalogs.mockResolvedValue({
      issues: [],
      sourceDocuments: 3,
      targetLocales: 1,
    });
    mockSyncCatalogs.mockResolvedValue(
      createSyncResult({
        dryRun: true,
        metrics: {
          translatedEntries: 4,
        } as SyncResult["metrics"],
      }),
    );
    mockAuditCatalogs.mockResolvedValue({
      accepted: 0,
      audited: 0,
      cached: 0,
      checked: 0,
      issues: [],
      retranslate: 0,
      unresolved: 0,
    });

    expect(await runCli(["check"], "/repo")).toBe(1);

    const checkConfig = expect.objectContaining({
      ...config,
      state: expect.any(Object),
    });
    expect(mockValidateCatalogs).toHaveBeenCalledWith(checkConfig, {
      acceptedProvenanceFastPath: true,
    });
    expect(mockSyncCatalogs).toHaveBeenCalledWith(checkConfig, {
      dryRun: true,
    });
    expect(mockAuditCatalogs).not.toHaveBeenCalled();
    expect(config.state.load).toHaveBeenCalledOnce();
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      dryRun: {
        translatedEntries: 4,
      },
      validation: {
        configPath: "/repo/ai-translate.config.ts",
        issues: [],
        sourceDocuments: 3,
        targetLocales: 1,
      },
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      "Translation check failed. Run ai-translate sync to reconcile localized content.",
    );
  });

  it("fails check when dry-run detects pending document changes", async () => {
    const { stderrSpy } = spyOnConsole();
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockValidateCatalogs.mockResolvedValue({
      issues: [],
      sourceDocuments: 3,
      targetLocales: 1,
    });
    mockSyncCatalogs.mockResolvedValue(
      createSyncResult({
        dryRun: true,
        metrics: {
          changedDocuments: 1,
        } as SyncResult["metrics"],
      }),
    );
    mockAuditCatalogs.mockResolvedValue({
      accepted: 0,
      audited: 0,
      cached: 0,
      checked: 0,
      issues: [],
      retranslate: 0,
      unresolved: 0,
    });

    expect(await runCli(["check"], "/repo")).toBe(1);

    expect(stderrSpy).toHaveBeenCalledWith(
      "Translation check failed. Run ai-translate sync to reconcile localized content.",
    );
  });

  it("scaffolds locales and skips catalogs without scaffold support", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const scaffoldLocale = vi.fn().mockResolvedValue({
      catalogId: "memory",
      createdDocuments: 1,
      locale: "de",
      skippedDocuments: 0,
      strategy: "copy-locale",
    });
    const config = createConfig({
      catalogs: [
        {
          scaffoldLocale,
        } as unknown as AiTranslateConfig["catalogs"][number],
        {} as AiTranslateConfig["catalogs"][number],
      ],
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });

    expect(await runCli(["scaffold-locale", "de", "--from=en"], "/repo")).toBe(0);

    expect(scaffoldLocale).toHaveBeenCalledWith({
      fromLocale: "en",
      locale: "de",
      strategy: "copy-locale",
    });
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toEqual({
      fromLocale: "en",
      locale: "de",
      scaffoldResults: [
        {
          catalogId: "memory",
          createdDocuments: 1,
          locale: "de",
          skippedDocuments: 0,
          strategy: "copy-locale",
        },
        null,
      ],
      strategy: "copy-locale",
      status: "ok",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("creates a new locale and converges a rejected semantic audit through repair", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig({
      semanticAudits: [{} as never],
      sourceLocale: "en",
      targetLocales: ["fr"],
      validation: { semanticRepairAttempts: 1 },
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(
      createSyncResult({
        metrics: {
          translatedEntries: 4,
        } as SyncResult["metrics"],
      }),
    );
    mockAuditCatalogs
      .mockResolvedValueOnce({
        accepted: 0,
        audited: 1,
        cached: 0,
        checked: 1,
        issues: [
          {
            auditId: "claims",
            catalogId: "messages",
            code: "semantic-audit-retranslate",
            inputDigest: "digest",
            jsonPointer: "/claim",
            locale: "de",
            message: "retranslate",
            path: "/de/messages.json",
            severity: "error",
            status: "retranslate",
            unitId: "messages",
          },
        ],
        retranslate: 1,
        unresolved: 0,
      })
      .mockResolvedValueOnce({
        accepted: 1,
        audited: 1,
        cached: 0,
        checked: 1,
        issues: [],
        retranslate: 0,
        unresolved: 0,
      });

    expect(await runCli(["new-locale", "de"], "/repo")).toBe(0);

    expect(mockSyncCatalogs).toHaveBeenNthCalledWith(1, stagedConfig(config), {
      forceRetranslate: false,
      locales: ["de"],
    });
    expect(mockSyncCatalogs).toHaveBeenNthCalledWith(2, stagedConfig(config), {
      locales: ["de"],
    });
    expect(mockAuditCatalogs).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      dryRun: false,
      fromLocale: "en",
      locale: "de",
      scaffoldResults: [],
      semanticAudit: { accepted: 1, issues: [] },
      semanticRepairRounds: 1,
      strategy: "copy-source",
      status: "ok",
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("fails a new locale after three persistently rejected semantic repair rounds", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig({
      semanticAudits: [{} as never],
      validation: { semanticRepairAttempts: 3 },
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());
    mockAuditCatalogs.mockResolvedValue({
      accepted: 0,
      audited: 1,
      cached: 0,
      checked: 1,
      issues: [
        {
          auditId: "claims",
          catalogId: "messages",
          code: "semantic-audit-retranslate",
          inputDigest: "digest",
          jsonPointer: "/claim",
          locale: "de",
          message: "retranslate",
          path: "/de/messages.json",
          severity: "error",
          status: "retranslate",
          unitId: "messages",
        },
      ],
      retranslate: 1,
      unresolved: 0,
    });

    expect(await runCli(["new-locale", "de"], "/repo")).toBe(1);

    expect(mockSyncCatalogs).toHaveBeenCalledTimes(4);
    expect(mockAuditCatalogs).toHaveBeenCalledTimes(4);
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      semanticAudit: { retranslate: 1 },
      semanticRepairRounds: 3,
      status: "failed",
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      "Semantic audit rejected translations after 3 configured repair round(s).",
    );
  });

  it("forwards force-retranslate to sync", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });
    mockSyncCatalogs.mockResolvedValue(createSyncResult());

    expect(
      await runCli(
        [
          "sync",
          "--locale",
          "nl",
          "--catalog",
          "home-content",
          "--force-retranslate-path",
          "/hero/title",
          "--force-retranslate-path=/hero/subtitle",
          "--include-path",
          "/hero/title",
          "--include-path=/hero/subtitle",
        ],
        "/repo",
      ),
    ).toBe(0);

    expect(mockSyncCatalogs).toHaveBeenCalledWith(stagedConfig(config), {
      catalogIds: ["home-content"],
      forceRetranslate: true,
      forceRetranslatePaths: ["/hero/title", "/hero/subtitle"],
      includePaths: ["/hero/title", "/hero/subtitle"],
      locales: ["nl"],
    });
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toEqual({
      dryRun: false,
      metrics: createSyncResult().metrics,
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid new-locale usage", async () => {
    const { stderrSpy } = spyOnConsole();

    expect(await runCli(["new-locale"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(
      1,
      'The "new-locale" command requires a <locale> argument.',
    );

    const config = createConfig();
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });

    expect(await runCli(["new-locale", "de", "--from", "fr", "--dry-run"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(
      2,
      'The "new-locale" command only supports --from <sourceLocale> when used with --dry-run.',
    );
  });

  it("requires scaffold-locale arguments", async () => {
    const { stderrSpy } = spyOnConsole();

    expect(await runCli(["scaffold-locale"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(
      1,
      'The "scaffold-locale" command requires a <locale> argument.',
    );

    expect(await runCli(["scaffold-locale", "de"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(
      2,
      'The "scaffold-locale" command requires --from <locale>.',
    );
  });

  function stubAdoptWorkspace(save: ReturnType<typeof vi.fn>) {
    const config = createConfig({
      catalogs: [
        {
          id: "json",
        } as unknown as AiTranslateConfig["catalogs"][number],
      ],
      state: {
        load: vi.fn().mockResolvedValue({
          entries: {},
        }),
        save,
      } as unknown as AiTranslateConfig["state"],
      targetLocales: ["fr", "de"],
    });
    mockLoadEnvFiles.mockResolvedValue({});
    mockLoadConfig.mockResolvedValue({
      config,
      configPath: "/repo/ai-translate.config.ts",
    });

    return config;
  }

  const adoptedState = {
    entries: {
      "fr::json::common::/cta": {
        origin: "legacy-unknown",
      },
    },
    version: 2,
  };

  it("adopts existing translations and reports what it found", async () => {
    const { stderrSpy, stdoutSpy } = spyOnConsole();
    const save = vi.fn().mockResolvedValue(undefined);
    const config = stubAdoptWorkspace(save);
    mockAdoptExistingTranslations.mockResolvedValue({
      adopted: 1,
      identicalToSource: 2,
      state: adoptedState,
      untranslated: 3,
    });

    expect(await runCli(["adopt"], "/repo")).toBe(0);

    expect(mockAdoptExistingTranslations).toHaveBeenCalledWith({
      catalogs: config.catalogs,
      identicalToSource: "adopt",
      sourceLocale: "en",
      targetLocales: ["fr", "de"],
    });
    expect(save).toHaveBeenCalledWith(adoptedState);
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toEqual({
      adopted: 1,
      dryRun: false,
      identicalToSource: 2,
      status: "ok",
      untranslated: 3,
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("forwards an explicit identical-to-source policy and skips the write on a dry run", async () => {
    const { stdoutSpy } = spyOnConsole();
    const save = vi.fn().mockResolvedValue(undefined);
    const config = stubAdoptWorkspace(save);
    mockAdoptExistingTranslations.mockResolvedValue({
      adopted: 0,
      identicalToSource: 0,
      state: adoptedState,
      untranslated: 0,
    });

    expect(
      await runCli(["adopt", "--identical-to-source=skip", "--dry-run"], "/repo"),
    ).toBe(0);

    expect(mockAdoptExistingTranslations).toHaveBeenCalledWith({
      catalogs: config.catalogs,
      identicalToSource: "skip",
      sourceLocale: "en",
      targetLocales: ["fr", "de"],
    });
    expect(save).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      dryRun: true,
    });
  });

  it("reports parse and command errors", async () => {
    const { stderrSpy } = spyOnConsole();

    expect(await runCli(["deploy"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(1, 'Unknown command "deploy".');

    expect(await runCli(["validate", "--bogus"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(2, 'Unknown option "--bogus".');

    expect(await runCli(["validate", "--"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(3, "Encountered an empty option flag.");

    expect(await runCli(["validate", "--config"], "/repo")).toBe(1);
    expect(stderrSpy).toHaveBeenNthCalledWith(4, 'Option "--config" requires a value.');
  });

  it("reports unexpected non-Error failures", async () => {
    const { stderrSpy } = spyOnConsole();
    mockLoadEnvFiles.mockRejectedValue("boom");

    expect(await runCli(["sync"], "/repo")).toBe(1);

    expect(stderrSpy).toHaveBeenCalledWith("Unexpected CLI failure: boom");
  });
});
