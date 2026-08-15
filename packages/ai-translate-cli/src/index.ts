import {
  auditCatalogs,
  resolveStateScope,
  syncCatalogs,
  usesGeneratorSelfCheck,
  validateCatalogs,
  withTranslationIssueCache,
} from "@ai-translate/core";
import type {
  AiTranslateConfig,
  CatalogScaffoldStrategy,
  SemanticAuditResult,
  SyncCatalogsOptions,
  SyncResult,
  SyncStateSnapshot,
  ValidationResult,
} from "@ai-translate/core/types";
import { adoptExistingTranslations } from "@ai-translate/fs-json";
import type { IdenticalToSourcePolicy } from "@ai-translate/fs-json";
import type { ProviderChoice } from "@ai-translate/next";

import { loadConfig, loadEnvFiles } from "./config";
import { runInit } from "./init";
import { runStagedCatalogTransaction } from "./transaction";

export { defineConfig } from "@ai-translate/core";
export { findConfigPath, loadConfig, loadEnvFiles } from "./config";

interface CommandOptions {
  auditCheck?: boolean;
  catalogIds?: string[];
  config?: string;
  documentConcurrency?: number;
  dryRun?: boolean;
  force?: boolean;
  forceRetranslate?: boolean;
  forceRetranslatePaths?: string[];
  includePaths?: string[];
  from?: string;
  identicalToSource?: IdenticalToSourcePolicy;
  locales?: string[];
  integration?: string;
  maxPendingTranslations?: number;
  model?: string;
  preview?: boolean;
  provider?: string;
  providerPackage?: string;
  refresh?: boolean;
  strategy?: CatalogScaffoldStrategy;
  unitIds?: string[];
}

interface ParsedCommand {
  command?: string;
  options: CommandOptions;
  positionals: string[];
}

function requireOptionValue(optionName: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`Option "--${optionName}" requires a value.`);
  }

  return value;
}

function requireProviderChoice(value: string): ProviderChoice {
  if (value !== "ai-sdk" && value !== "openai") {
    throw new Error(`Option "--provider" accepts "openai" or "ai-sdk", not "${value}".`);
  }

  return value;
}

function requireIdenticalToSourcePolicy(value: string): IdenticalToSourcePolicy {
  if (value !== "adopt" && value !== "skip") {
    throw new Error(
      `Option "--identical-to-source" accepts "adopt" or "skip", not "${value}".`,
    );
  }

  return value;
}

function requireNonNegativeIntegerOption(optionName: string, value: string | undefined): number {
  const rawValue = requireOptionValue(optionName, value);
  const parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`Option "--${optionName}" requires a non-negative integer.`);
  }
  return parsedValue;
}

function requirePositiveIntegerOption(optionName: string, value: string | undefined): number {
  const parsedValue = requireNonNegativeIntegerOption(optionName, value);
  if (parsedValue < 1) {
    throw new Error(`Option "--${optionName}" requires a positive integer.`);
  }
  return parsedValue;
}

async function validateConfig(
  config: AiTranslateConfig,
  configPath: string,
  options: SyncCatalogsOptions,
): Promise<ValidationResult> {
  const result = await validateCatalogs(config, options);
  return {
    ...result,
    configPath,
  };
}

const DEFAULT_SEMANTIC_REPAIR_ROUNDS = 0;

interface SemanticAuditConvergenceResult {
  audit: SemanticAuditResult | undefined;
  repairRounds: number;
  sync: SyncResult;
}

function printSyncSummary(
  result: SyncResult,
  semanticAudit?: SemanticAuditResult,
  semanticRepairRounds = 0,
): void {
  const pendingTranslationReasons = summarizePendingTranslationReasons(result);
  const failedTranslationIssues = summarizeFailedTranslationIssues(result);
  console.log(
    JSON.stringify(
      {
        dryRun: result.dryRun,
        metrics: result.metrics,
        ...(result.dryRun && Object.keys(pendingTranslationReasons).length > 0
          ? { pendingTranslationReasons }
          : {}),
        ...(semanticAudit === undefined ? {} : { semanticAudit, semanticRepairRounds }),
        ...(failedTranslationIssues === undefined ? {} : { failedTranslationIssues }),
      },
      null,
      2,
    ),
  );
}

function summarizeFailedTranslationIssues(result: SyncResult):
  | {
      counts: Record<string, number>;
      examples: readonly {
        catalogId: string;
        code: string;
        locale: string;
        message: string;
        path: string;
        unitId: string;
      }[];
    }
  | undefined {
  if (result.metrics.failedEntries === 0) {
    return undefined;
  }
  const errors = result.documents.flatMap((document) =>
    document.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => ({
        catalogId: document.catalogId,
        code: issue.code,
        locale: document.locale,
        message: issue.message,
        path: document.path,
        unitId: document.unitId,
      })),
  );
  const counts: Record<string, number> = {};
  for (const issue of errors) {
    counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  }
  return {
    counts: Object.fromEntries(
      Object.entries(counts).toSorted(
        ([leftCode, leftCount], [rightCode, rightCount]) =>
          rightCount - leftCount || leftCode.localeCompare(rightCode),
      ),
    ),
    examples: errors.slice(0, 25),
  };
}

function summarizePendingTranslationReasons(result: SyncResult): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const document of result.documents) {
    for (const [reason, count] of Object.entries(document.pendingTranslationReasons ?? {})) {
      summary[reason] = (summary[reason] ?? 0) + count;
    }
  }
  return Object.fromEntries(
    Object.entries(summary).toSorted(
      ([leftReason, leftCount], [rightReason, rightCount]) =>
        rightCount - leftCount || leftReason.localeCompare(rightReason),
    ),
  );
}

function dryRunBudgetError(config: AiTranslateConfig, result: SyncResult): string | undefined {
  if (!result.dryRun || config.validation?.dryRunBudget === undefined) {
    return undefined;
  }
  const budget = config.validation.dryRunBudget;
  if (
    budget.maxPendingTranslations !== undefined &&
    result.metrics.translatedEntries > budget.maxPendingTranslations
  ) {
    return (
      `Translation dry-run planned ${String(
        result.metrics.translatedEntries,
      )} provider translations, ` +
      `exceeding the configured budget of ${String(budget.maxPendingTranslations)}.`
    );
  }
  const reasons = summarizePendingTranslationReasons(result);
  const forbidden = (budget.forbiddenPendingTranslationReasons ?? []).filter(
    (reason) => (reasons[reason] ?? 0) > 0,
  );
  return forbidden.length === 0
    ? undefined
    : `Translation dry-run included forbidden selection reasons: ${forbidden
        .map((reason) => `${reason} (${String(reasons[reason] ?? 0)})`)
        .join(", ")}.`;
}

function assertDryRunBudget(config: AiTranslateConfig, result: SyncResult): void {
  const error = dryRunBudgetError(config, result);
  if (error !== undefined) {
    throw new Error(error);
  }
}

async function convergeSemanticAudits(
  config: AiTranslateConfig,
  options: SyncCatalogsOptions,
): Promise<SemanticAuditConvergenceResult> {
  let sync = await syncCatalogs(config, options);
  if (
    options.dryRun === true ||
    sync.metrics.failedEntries > 0 ||
    (config.semanticAudits?.length ?? 0) === 0 ||
    usesGeneratorSelfCheck(config)
  ) {
    return { audit: undefined, repairRounds: 0, sync };
  }

  let audit = await auditCatalogs(config, options);
  let repairRounds = 0;
  const maxSemanticRepairRounds =
    config.validation?.semanticRepairAttempts ?? DEFAULT_SEMANTIC_REPAIR_ROUNDS;
  const repairOptions = { ...options };
  delete repairOptions.forceRetranslate;
  delete repairOptions.forceRetranslatePaths;
  while (audit.retranslate > 0 && repairRounds < maxSemanticRepairRounds) {
    repairRounds += 1;
    sync = await syncCatalogs(config, repairOptions);
    if (sync.metrics.failedEntries > 0) {
      break;
    }
    audit = await auditCatalogs(config, options);
  }

  return { audit, repairRounds, sync };
}

async function syncWithSemanticAuditConvergence(
  config: AiTranslateConfig,
  options: SyncCatalogsOptions,
): Promise<SemanticAuditConvergenceResult> {
  if (options.dryRun === true) {
    return convergeSemanticAudits(config, options);
  }
  return runStagedCatalogTransaction(
    config,
    (stagedConfig) => convergeSemanticAudits(stagedConfig, options),
    (result) => semanticAuditConvergenceError(result) === undefined,
    resolveStateScope(config, options),
  );
}

function semanticAuditConvergenceError(result: SemanticAuditConvergenceResult): string | undefined {
  if (result.sync.metrics.failedEntries > 0) {
    return "Sync completed with failed translation entries.";
  }
  if ((result.audit?.unresolved ?? 0) > 0) {
    return "Sync completed with unresolved semantic audits. Review or refresh the audit findings.";
  }
  if ((result.audit?.retranslate ?? 0) > 0) {
    return `Semantic audit rejected translations after ${String(
      result.repairRounds,
    )} configured repair round(s).`;
  }
  if (result.audit?.issues.some((issue) => issue.severity === "error")) {
    return "Semantic audit completed with unresolved or unsafe translations.";
  }
  return undefined;
}

function assertSemanticAuditConvergence(result: SemanticAuditConvergenceResult): void {
  const error = semanticAuditConvergenceError(result);
  if (error !== undefined) {
    throw new Error(error);
  }
}

function buildSyncOptions(options: CommandOptions): SyncCatalogsOptions {
  const syncOptions: SyncCatalogsOptions = {};
  if (options.catalogIds && options.catalogIds.length > 0) {
    syncOptions.catalogIds = options.catalogIds;
  }

  if (options.documentConcurrency !== undefined) {
    syncOptions.documentConcurrency = options.documentConcurrency;
  }

  if (options.dryRun !== undefined) {
    syncOptions.dryRun = options.dryRun;
  }

  if (options.forceRetranslate !== undefined) {
    syncOptions.forceRetranslate = options.forceRetranslate;
  }

  if (options.forceRetranslatePaths && options.forceRetranslatePaths.length > 0) {
    syncOptions.forceRetranslate = true;
    syncOptions.forceRetranslatePaths = options.forceRetranslatePaths;
  }

  if (options.includePaths && options.includePaths.length > 0) {
    syncOptions.includePaths = options.includePaths;
  }

  if (options.locales && options.locales.length > 0) {
    syncOptions.locales = options.locales;
  }

  if (options.maxPendingTranslations !== undefined) {
    syncOptions.maxPendingTranslations = options.maxPendingTranslations;
  }

  if (options.unitIds && options.unitIds.length > 0) {
    syncOptions.unitIds = options.unitIds;
  }

  return syncOptions;
}

function projectStateLocales(
  state: SyncStateSnapshot,
  locales: readonly string[] | undefined,
): SyncStateSnapshot {
  if (locales === undefined || locales.length === 0) {
    return state;
  }
  const included = new Set(locales);
  return {
    entries: Object.fromEntries(
      Object.entries(state.entries).filter(([, entry]) => included.has(entry.locale)),
    ),
    version: state.version,
  };
}

function hasStoredSemanticAudits(state: SyncStateSnapshot): boolean {
  return Object.values(state.entries).some(
    (entry) => Object.keys(entry.validationAudits ?? {}).length > 0,
  );
}

const EMPTY_SEMANTIC_AUDIT = {
  accepted: 0,
  audited: 0,
  cached: 0,
  checked: 0,
  issues: [],
  retranslate: 0,
  unresolved: 0,
} as const;

async function scaffoldLocale(
  config: AiTranslateConfig,
  locale: string,
  options: {
    fromLocale?: string;
    strategy?: CatalogScaffoldStrategy;
  } = {},
) {
  return Promise.all(
    config.catalogs.map(async (catalog) => {
      if (!catalog.scaffoldLocale) {
        return null;
      }

      return  catalog.scaffoldLocale({
        ...(options.fromLocale === undefined ? {} : { fromLocale: options.fromLocale }),
        locale,
        ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
      });
    }),
  );
}

function printHelp(): void {
  console.log(`ai-translate

Usage:
  ai-translate init [--integration <next-intl|i18next>] [--provider <openai|ai-sdk>] [--provider-package <@ai-sdk/...>] [--model <id>] [--preview] [--force]
  ai-translate validate [--config <path>]
  ai-translate check [--config <path>] [--locale <locale>] [--catalog <id>] [--unit <id>] [--include-path <json-pointer>] [--max-pending-translations <count>] [--concurrency <count>]
  ai-translate audit [--check] [--refresh] [--config <path>] [--locale <locale>] [--catalog <id>] [--unit <id>] [--include-path <json-pointer>] [--concurrency <count>]
  ai-translate sync [--config <path>] [--dry-run] [--force-retranslate] [--force-retranslate-path <json-pointer>] [--include-path <json-pointer>] [--locale <locale>] [--catalog <id>] [--unit <id>] [--max-pending-translations <count>] [--concurrency <count>]
  ai-translate new-locale <locale> [--from <locale>] [--strategy <strategy>] [--config <path>]
  ai-translate scaffold-locale <locale> --from <locale> [--strategy <strategy>] [--config <path>]
  ai-translate adopt [--identical-to-source <adopt|skip>] [--dry-run] [--config <path>]
  ai-translate --help
  ai-translate --version`);
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const options: CommandOptions = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        command: "help",
        options,
        positionals,
      };
    }

    if (arg === "--version" || arg === "-v") {
      return {
        command: "version",
        options,
        positionals,
      };
    }

    if (arg.startsWith("--")) {
      const [flag = "", inlineValue] = arg.slice(2).split("=", 2);
      if (flag.length === 0) {
        throw new Error("Encountered an empty option flag.");
      }

      const nextValue = inlineValue ?? argv[index + 1];
      switch (flag) {
        case "check":
          options.auditCheck = true;
          break;
        case "config":
          options.config = requireOptionValue(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "catalog":
          (options.catalogIds ??= []).push(requireOptionValue(flag, nextValue));
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "dry-run":
          options.dryRun = true;
          break;
        case "force":
          options.force = true;
          break;
        case "force-retranslate":
          options.forceRetranslate = true;
          break;
        case "force-retranslate-path":
          (options.forceRetranslatePaths ??= []).push(requireOptionValue(flag, nextValue));
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "from":
          options.from = requireOptionValue(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "include-path":
          (options.includePaths ??= []).push(requireOptionValue(flag, nextValue));
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "integration":
          options.integration = requireOptionValue(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "locale":
          (options.locales ??= []).push(requireOptionValue(flag, nextValue));
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "model":
          options.model = requireOptionValue(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "preview":
          options.preview = true;
          break;
        case "provider":
          options.provider = requireOptionValue(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "provider-package":
          options.providerPackage = requireOptionValue(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "max-pending-translations":
          options.maxPendingTranslations = requireNonNegativeIntegerOption(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "concurrency":
          options.documentConcurrency = requirePositiveIntegerOption(flag, nextValue);
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "identical-to-source":
          options.identicalToSource = requireIdenticalToSourcePolicy(
            requireOptionValue(flag, nextValue),
          );
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        case "refresh":
          options.refresh = true;
          break;
        case "strategy": {
          const strategy = requireOptionValue(flag, nextValue) as CatalogScaffoldStrategy;
          options.strategy = strategy;
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        }
        case "unit":
          (options.unitIds ??= []).push(requireOptionValue(flag, nextValue));
          if (inlineValue === undefined) {
            index += 1;
          }
          break;
        default:
          throw new Error(`Unknown option "--${flag}".`);
      }

      continue;
    }

    if (!command) {
      command = arg;
      continue;
    }

    positionals.push(arg);
  }

  const parsedCommand: ParsedCommand = {
    options,
    positionals,
  };
  if (command !== undefined) {
    parsedCommand.command = command;
  }

  return parsedCommand;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<number> {
  try {
    const parsed = parseCommand(argv);
    if (!parsed.command || parsed.command === "help") {
      printHelp();
      return 0;
    }

    if (parsed.command === "version") {
      console.log("0.0.0");
      return 0;
    }

    switch (parsed.command) {
      case "init": {
        // No loadConfig and no loadEnvFiles: init runs before either exists.
        const result = await runInit(cwd, {
          force: parsed.options.force === true,
          ...(parsed.options.integration === undefined
            ? {}
            : { integration: parsed.options.integration }),
          ...(parsed.options.model === undefined ? {} : { model: parsed.options.model }),
          preview: parsed.options.preview === true || parsed.options.dryRun === true,
          ...(parsed.options.provider === undefined
            ? {}
            : { provider: requireProviderChoice(parsed.options.provider) }),
          ...(parsed.options.providerPackage === undefined
            ? {}
            : { providerPackage: parsed.options.providerPackage }),
        });
        console.log(result.lines.join("\n"));
        return 0;
      }
      case "validate": {
        await loadEnvFiles(cwd);
        const { config, configPath } = await loadConfig(cwd, parsed.options.config);
        const summary = await validateConfig(config, configPath, buildSyncOptions(parsed.options));
        console.log(JSON.stringify(summary, null, 2));
        if (summary.issues.some((issue) => issue.severity === "error")) {
          throw new Error("Validation failed.");
        }
        return 0;
      }
      case "check": {
        await loadEnvFiles(cwd);
        const { config, configPath } = await loadConfig(cwd, parsed.options.config);
        const checkOptions: SyncCatalogsOptions = {
          ...buildSyncOptions(parsed.options),
          ...(process.env.AI_TRANSLATE_CHECK_SNAPSHOT_LOCK === "1"
            ? { assumeStateLock: true }
            : {}),
        };
        // Ask the store to materialise only the locales under check, then keep
        // the projection: a store is free to ignore the scope and return a
        // superset, and check must narrow regardless of which store is wired up.
        const stateSnapshot = projectStateLocales(
          await config.state.load(
            checkOptions.locales === undefined ? undefined : { locales: checkOptions.locales },
          ),
          checkOptions.locales,
        );
        const checkConfig: AiTranslateConfig = {
          ...config,
          state: {
            load: () => Promise.resolve(stateSnapshot),
            save: () =>
              Promise.reject(new Error("Translation check cannot persist translation state.")),
            withLock: (operation) => config.state.withLock(operation),
          },
        };
        const needsSemanticAudit =
          (checkConfig.semanticAudits?.length ?? 0) > 0 || hasStoredSemanticAudits(stateSnapshot);
        const { auditResult, dryRunResult, validationResult } = await withTranslationIssueCache(
          async () => {
            const checkedValidation = await validateConfig(checkConfig, configPath, {
              ...checkOptions,
              acceptedProvenanceFastPath: true,
            });
            const checkedDryRun = await syncCatalogs(checkConfig, {
              ...checkOptions,
              dryRun: true,
            });
            const checkedAudit = needsSemanticAudit
              ? await auditCatalogs(checkConfig, {
                  ...checkOptions,
                  checkOnly: true,
                })
              : EMPTY_SEMANTIC_AUDIT;
            return {
              auditResult: checkedAudit,
              dryRunResult: checkedDryRun,
              validationResult: checkedValidation,
            };
          },
        );
        const hasValidationErrors = validationResult.issues.some(
          (issue) => issue.severity === "error",
        );
        const hasPendingSync =
          dryRunResult.metrics.changedDocuments > 0 ||
          dryRunResult.metrics.failedEntries > 0 ||
          dryRunResult.metrics.staleManualEntries > 0 ||
          dryRunResult.metrics.translatedEntries > 0;
        const hasAuditErrors = auditResult.issues.some((issue) => issue.severity === "error");

        console.log(
          JSON.stringify(
            {
              validation: validationResult,
              audit: auditResult,
              dryRun: dryRunResult.metrics,
            },
            null,
            2,
          ),
        );
        if (hasValidationErrors || hasPendingSync || hasAuditErrors) {
          if (hasAuditErrors && !hasValidationErrors && !hasPendingSync) {
            throw new Error(
              "Translation check failed because semantic audit provenance is missing, stale, or unresolved. Run ai-translate audit --refresh.",
            );
          }
          throw new Error(
            "Translation check failed. Run ai-translate sync to reconcile localized content.",
          );
        }
        return 0;
      }
      case "audit": {
        await loadEnvFiles(cwd);
        const { config } = await loadConfig(cwd, parsed.options.config);
        const result = await auditCatalogs(config, {
          ...buildSyncOptions(parsed.options),
          checkOnly: parsed.options.auditCheck ?? false,
          refresh: parsed.options.refresh ?? false,
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.issues.some((issue) => issue.severity === "error")) {
          throw new Error(
            parsed.options.auditCheck
              ? "Semantic audit check failed. Run ai-translate audit --refresh."
              : "Semantic audit completed with unresolved or unsafe translations.",
          );
        }
        return 0;
      }
      case "sync": {
        await loadEnvFiles(cwd);
        const { config } = await loadConfig(cwd, parsed.options.config);
        /*
         * The cache key is the full validation input, so a changed translation
         * gets a fresh entry. Sync validates the same entry once to decide
         * whether existing output is still valid and again while resolving
         * acceptance provenance; `check` has always deduplicated that pair.
         */
        const result = await withTranslationIssueCache(() =>
          syncWithSemanticAuditConvergence(config, buildSyncOptions(parsed.options)),
        );
        printSyncSummary(result.sync, result.audit, result.repairRounds);
        assertDryRunBudget(config, result.sync);
        assertSemanticAuditConvergence(result);
        return 0;
      }
      case "new-locale": {
        const locale = parsed.positionals[0];
        if (!locale) {
          throw new Error('The "new-locale" command requires a <locale> argument.');
        }

        await loadEnvFiles(cwd);
        const { config } = await loadConfig(cwd, parsed.options.config);
        const fromLocale = parsed.options.from ?? config.sourceLocale;
        const strategy = parsed.options.strategy ?? "copy-source";

        if (parsed.options.dryRun && fromLocale !== config.sourceLocale) {
          throw new Error(
            'The "new-locale" command only supports --from <sourceLocale> when used with --dry-run.',
          );
        }

        if (parsed.options.dryRun && strategy !== "copy-source") {
          throw new Error(
            'The "new-locale" command only supports --strategy copy-source when used with --dry-run.',
          );
        }

        if (strategy !== "copy-source" && fromLocale === config.sourceLocale) {
          throw new Error(
            `The "${strategy}" strategy requires --from <locale> to be a translated locale.`,
          );
        }

        const syncOptions: SyncCatalogsOptions = {
          ...buildSyncOptions(parsed.options),
          forceRetranslate: strategy === "copy-locale-and-retranslate",
          locales: [locale],
        };
        const transaction = parsed.options.dryRun
          ? {
              result: await convergeSemanticAudits(config, syncOptions),
              scaffoldResults: [],
            }
          : await runStagedCatalogTransaction(
              config,
              async (stagedConfig) => {
                const scaffoldResults = await scaffoldLocale(stagedConfig, locale, {
                  fromLocale,
                  strategy,
                });
                const result = await convergeSemanticAudits(stagedConfig, syncOptions);
                return { result, scaffoldResults };
              },
              ({ result }) => semanticAuditConvergenceError(result) === undefined,
            );
        const { result, scaffoldResults } = transaction;
        console.log(
          JSON.stringify(
            {
              dryRun: result.sync.dryRun,
              fromLocale,
              locale,
              metrics: result.sync.metrics,
              scaffoldResults,
              ...(result.audit === undefined
                ? {}
                : {
                    semanticAudit: result.audit,
                    semanticRepairRounds: result.repairRounds,
                  }),
              strategy,
              status: semanticAuditConvergenceError(result) === undefined ? "ok" : "failed",
            },
            null,
            2,
          ),
        );
        assertSemanticAuditConvergence(result);
        return 0;
      }
      case "scaffold-locale": {
        const locale = parsed.positionals[0];
        if (!locale) {
          throw new Error('The "scaffold-locale" command requires a <locale> argument.');
        }

        if (!parsed.options.from) {
          throw new Error('The "scaffold-locale" command requires --from <locale>.');
        }

        await loadEnvFiles(cwd);
        const { config } = await loadConfig(cwd, parsed.options.config);
        const scaffoldResults = await scaffoldLocale(config, locale, {
          fromLocale: parsed.options.from,
          strategy: parsed.options.strategy ?? "copy-locale",
        });
        console.log(
          JSON.stringify(
            {
              fromLocale: parsed.options.from,
              locale,
              scaffoldResults,
              strategy: parsed.options.strategy ?? "copy-locale",
              status: "ok",
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "adopt": {
        await loadEnvFiles(cwd);
        const { config } = await loadConfig(cwd, parsed.options.config);
        const result = await adoptExistingTranslations({
          catalogs: config.catalogs,
          identicalToSource: parsed.options.identicalToSource ?? "adopt",
          sourceLocale: config.sourceLocale,
          targetLocales: config.targetLocales,
        });

        if (!parsed.options.dryRun) {
          await config.state.save(result.state);
        }

        console.log(
          JSON.stringify(
            {
              adopted: result.adopted,
              dryRun: parsed.options.dryRun === true,
              identicalToSource: result.identicalToSource,
              status: "ok",
              untranslated: result.untranslated,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      default:
        throw new Error(`Unknown command "${parsed.command}".`);
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : `Unexpected CLI failure: ${String(error)}`,
    );
    return 1;
  }
}
