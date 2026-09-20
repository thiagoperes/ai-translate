import { promises as fs } from "node:fs";
import * as path from "node:path";

import { appleIntegration, expoIntegration } from "@ai-translate/apple";
import {
  detectProject,
  isLocaleTag,
  renderConfig,
  requiredConfigPackages,
} from "@ai-translate/integrations";
import type {
  CatalogPlan,
  DetectedSetup,
  Integration,
  ProviderChoice,
} from "@ai-translate/integrations";
import { builtinIntegrations as nextIntegrations } from "@ai-translate/next";

import { CONFIG_CANDIDATES } from "./config";
import { applyProjectSetup, planProjectSetup } from "./init-project";
import type { PackageManager } from "./init-project";

const CONFIG_FILENAME = "ai-translate.config.ts";

/** Detection and config plans stay independent of the installation workflow. */
export const builtinInitIntegrations: readonly Integration[] = [
  ...nextIntegrations,
  appleIntegration,
  expoIntegration,
];

export interface InitOptions {
  /** Overwrites a changed existing config. Identical configs can be resumed without this. */
  force?: boolean;
  /** Install dependencies with the detected package manager. Defaults to true. */
  install?: boolean;
  integration?: string;
  integrations?: readonly Integration[];
  /** Explicit target languages when the project does not declare them yet. */
  locales?: readonly string[];
  model?: string;
  packageManager?: PackageManager;
  /** Show the complete setup plan without writes, installs, or project-code execution. */
  preview?: boolean;
  provider?: ProviderChoice;
  providerPackage?: string;
}

export interface InitResult {
  configPath: string | null;
  lines: readonly string[];
  setup: DetectedSetup;
}

function catalogs(setup: DetectedSetup): readonly CatalogPlan[] {
  return [setup.plan.catalog, ...(setup.plan.additionalCatalogs ?? [])];
}

function hasResources(setup: DetectedSetup): boolean {
  return catalogs(setup).some(
    (catalog) =>
      catalog.kind !== "adapter" ||
      !Array.isArray(catalog.options.include) ||
      catalog.options.include.length > 0,
  );
}

function overlaps(left: CatalogPlan, right: CatalogPlan): boolean {
  if (left.kind === "adapter" || right.kind === "adapter") {
    return (
      left.kind === "adapter" &&
      right.kind === "adapter" &&
      left.factory.from === right.factory.from &&
      left.factory.name === right.factory.name &&
      left.options.rootDir === right.options.rootDir
    );
  }
  const a = path.resolve(left.rootDir);
  const b = path.resolve(right.rootDir);
  const leftFiles =
    left.kind === "document-json" && left.localeFiles !== undefined
      ? Object.values(left.localeFiles).map((file) => path.resolve(a, file))
      : undefined;
  const rightFiles =
    right.kind === "document-json" && right.localeFiles !== undefined
      ? Object.values(right.localeFiles).map((file) => path.resolve(b, file))
      : undefined;
  if (leftFiles !== undefined && rightFiles !== undefined) {
    return leftFiles.some((file) => rightFiles.includes(file));
  }
  if (leftFiles !== undefined) {
    return leftFiles.some((file) =>
      right.kind === "document-json"
        ? path.dirname(file) === b
        : file.startsWith(`${b}${path.sep}`),
    );
  }
  if (rightFiles !== undefined) {
    return rightFiles.some((file) =>
      left.kind === "document-json"
        ? path.dirname(file) === a
        : file.startsWith(`${a}${path.sep}`),
    );
  }
  return (
    a === b ||
    a.startsWith(`${b}${path.sep}`) ||
    b.startsWith(`${a}${path.sep}`)
  );
}

function chooseSetup(
  setups: readonly DetectedSetup[],
  requested?: string,
): DetectedSetup {
  if (requested !== undefined) {
    const match = setups.find((setup) => setup.integrationId === requested);
    if (match === undefined) {
      throw new Error(
        `No ${requested} setup was detected. Detected: ${setups.map((setup) => setup.integrationId).join(", ") || "none"}.`,
      );
    }
    return match;
  }
  const [best] = setups;
  if (best === undefined) {
    throw new Error(
      "No supported localization setup was found. ai-translate init recognises next-intl and i18next, " +
        "Expo locale mappings, Apple String Catalogs, localized .strings tables, and Xcode or Apple Swift package projects. " +
        "For apps with hardcoded text, first externalize strings into localization resources. " +
        "Run init from the project root; extraction and runtime wiring are described in docs/native-apps.md.",
    );
  }
  const selected: DetectedSetup[] = [];
  for (const candidate of setups.filter(hasResources)) {
    const conflict = selected.find((other) =>
      catalogs(other).some((left) =>
        catalogs(candidate).some((right) => overlaps(left, right)),
      ),
    );
    if (conflict !== undefined) {
      if (conflict.confidence === candidate.confidence) {
        throw new Error(
          `Found overlapping localization setups (${conflict.integrationId}, ${candidate.integrationId}). Re-run with --integration <id> to choose.`,
        );
      }
      continue;
    }
    selected.push(candidate);
  }
  if (selected.length < 2) {
    return selected[0] ?? best;
  }
  if (
    selected.some((setup) => setup.plan.sourceLocale !== best.plan.sourceLocale)
  ) {
    throw new Error(
      "Detected setups use different source locales. Run init with --integration <id> and use separate configs for each source locale.",
    );
  }
  const targetLocales = resolveTargets(
    selected.flatMap((setup) => setup.plan.targetLocales),
    best.plan.sourceLocale,
  );
  const combined = selected.flatMap((setup) =>
    catalogs(setup).map((catalog, index): CatalogPlan => {
      const id = `${setup.integrationId}-${String(index + 1)}`;
      return catalog.kind === "adapter"
        ? { ...catalog, options: { ...catalog.options, id } }
        : {
            ...catalog,
            id,
            messageFormat: catalog.messageFormat ?? setup.plan.messageFormat,
          };
    }),
  );
  return {
    confidence: best.confidence,
    displayName: selected.map((setup) => setup.displayName).join(" + "),
    evidence: selected.flatMap((setup) => setup.evidence),
    integrationId: selected.map((setup) => setup.integrationId).join("+"),
    plan: {
      ...best.plan,
      catalog: combined[0] ?? best.plan.catalog,
      additionalCatalogs: combined.slice(1),
      targetLocales,
      warnings: selected.flatMap((setup) => setup.plan.warnings),
    },
  };
}

function resolveTargets(locales: readonly string[], source: string): string[] {
  const names = new Map<string, string>();
  const sourceTag = Intl.getCanonicalLocales(source)[0];
  for (const locale of locales) {
    if (!isLocaleTag(locale)) {
      throw new Error(`Invalid target locale ${JSON.stringify(locale)}.`);
    }
    const canonical = Intl.getCanonicalLocales(locale)[0] ?? locale;
    if (canonical === sourceTag) {
      throw new Error(`Target locale ${locale} is also the source locale.`);
    }
    const previous = names.get(canonical);
    if (previous !== undefined && previous !== locale) {
      throw new Error(
        `Locale aliases ${previous} and ${locale} refer to the same language. Normalize the resource names before combining setups.`,
      );
    }
    names.set(canonical, locale);
  }
  return [...names.values()];
}

interface SetupFile {
  contents: string;
  name: string;
  original: string | null;
}

async function readSetupFile(
  cwd: string,
  name: string,
): Promise<string | null> {
  try {
    const file = path.join(cwd, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `${name} must be a regular file; init will not follow symbolic links.`,
      );
    }
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function appendLines(
  original: string | null,
  additions: readonly string[],
): string {
  const existing = original ?? "";
  const missing = additions.filter(
    (line) => !existing.split(/\r?\n/u).includes(line),
  );
  if (missing.length === 0) {
    return existing;
  }
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  return `${existing}${existing.length > 0 && !existing.endsWith("\n") ? newline : ""}${missing.join(newline)}${newline}`;
}

function apiKeyVariable(options: InitOptions): string | undefined {
  if (options.provider !== "ai-sdk") {
    return "OPENAI_API_KEY";
  }
  const keys: Record<string, string> = {
    "@ai-sdk/anthropic": "ANTHROPIC_API_KEY",
    "@ai-sdk/google": "GOOGLE_GENERATIVE_AI_API_KEY",
    "@ai-sdk/groq": "GROQ_API_KEY",
    "@ai-sdk/mistral": "MISTRAL_API_KEY",
    "@ai-sdk/openai": "OPENAI_API_KEY",
    "@ai-sdk/xai": "XAI_API_KEY",
  };
  return keys[options.providerPackage ?? "@ai-sdk/openai"];
}

/** Detect, plan all changes, then install the generated config's direct dependencies. */
export async function runInit(
  cwd: string,
  options: InitOptions = {},
): Promise<InitResult> {
  await readSetupFile(cwd, "package.json");
  const setups = await detectProject(cwd, {
    integrations: options.integrations ?? builtinInitIntegrations,
  });
  const detected = chooseSetup(setups, options.integration);
  const requestedLocales =
    options.locales === undefined
      ? undefined
      : resolveTargets(options.locales, detected.plan.sourceLocale).map(
          (locale) =>
            detected.plan.targetLocales.find(
              (existing) =>
                Intl.getCanonicalLocales(existing)[0] ===
                Intl.getCanonicalLocales(locale)[0],
            ) ?? locale,
        );
  const setup =
    requestedLocales === undefined
      ? detected
      : {
          ...detected,
          plan: { ...detected.plan, targetLocales: requestedLocales },
        };
  for (const catalog of catalogs(setup)) {
    if (catalog.kind !== "document-json" || catalog.localeFiles === undefined) {
      continue;
    }
    const missing = setup.plan.targetLocales.filter(
      (locale) => !Object.hasOwn(catalog.localeFiles ?? {}, locale),
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing locale file mappings for ${missing.join(", ")}. Add them to the project's locale configuration (expo.locales for Expo), or use --locale to select only mapped languages.`,
      );
    }
  }
  const contents = renderConfig(setup.plan, options);
  const lines = [
    `Detected ${setup.displayName}:`,
    ...setup.evidence.map((item) => `  - ${item.detail} (${item.source})`),
    `  - Source locale ${setup.plan.sourceLocale}, ${String(setup.plan.targetLocales.length)} target locale(s): ${setup.plan.targetLocales.join(", ")}`,
    ...setup.plan.warnings.map((warning) => `  ! ${warning}`),
  ];
  const selectedIds = setup.integrationId.split("+");
  const others = setups.filter(
    (candidate) => !selectedIds.includes(candidate.integrationId),
  );
  if (others.length > 0) {
    lines.push(
      `Also detected, not used: ${others.map((candidate) => candidate.displayName).join(", ")}.`,
    );
  }

  const existing: SetupFile[] = [];
  for (const name of CONFIG_CANDIDATES) {
    const original = await readSetupFile(cwd, name);
    if (original !== null) {
      existing.push({ contents, name, original });
    }
  }
  if (existing.length > 1) {
    throw new Error(
      `Multiple ai-translate configs exist: ${existing.map((file) => file.name).join(", ")}. Keep one config before running init.`,
    );
  }
  const config = existing[0] ?? {
    contents,
    name: CONFIG_FILENAME,
    original: null,
  };
  if (
    config.original !== null &&
    config.original !== contents &&
    options.force !== true &&
    options.preview !== true
  ) {
    throw new Error(
      `${config.name} already exists with different contents. Use --preview to review changes or --force to overwrite it.`,
    );
  }
  const project = await planProjectSetup(
    cwd,
    requiredConfigPackages(setup.plan, options),
    options.packageManager === undefined
      ? {}
      : { packageManager: options.packageManager },
  );
  const files = [config];
  const ignore = await readSetupFile(cwd, ".gitignore");
  files.push({
    name: ".gitignore",
    original: ignore,
    contents: appendLines(ignore, [
      "node_modules/",
      ".env.local",
      ".env.*.local",
    ]),
  });
  const key = apiKeyVariable(options);
  if (key !== undefined) {
    const example = await readSetupFile(cwd, ".env.example");
    const hasKey =
      example
        ?.split(/\r?\n/u)
        .some((line) => line.trimStart().startsWith(`${key}=`)) === true;
    files.push({
      name: ".env.example",
      original: example,
      contents: hasKey ? example : appendLines(example, [`${key}=`]),
    });
  }
  lines.push("", `Package manager: ${project.packageManager}.`);
  if (options.preview === true) {
    lines.push(...project.notices);
    for (const file of files) {
      if (file.contents !== file.original || file === config) {
        lines.push(
          "",
          `Would write ${file.name}:`,
          "",
          file.name === ".env.example"
            ? `${key ?? "PROVIDER_API_KEY"}= (existing entries preserved)`
            : file.contents,
        );
      }
    }
    if (project.manifestContents !== undefined) {
      lines.push("", "Would write package.json:", "", project.manifestContents);
    }
    for (const command of project.installCommands) {
      lines.push(
        "",
        `Would ${options.install === false ? "skip installation; run" : "install with"}: ${command.command} ${command.args.join(" ")}`,
      );
    }
    return { configPath: null, lines, setup };
  }
  for (const file of files) {
    if (file.contents === file.original) {
      continue;
    }
    if ((await readSetupFile(cwd, file.name)) !== file.original) {
      throw new Error(
        `${file.name} changed during init; rerun to review the current project.`,
      );
    }
    await fs.writeFile(path.join(cwd, file.name), file.contents, {
      encoding: "utf8",
      flag: file.original === null ? "wx" : "w",
    });
    lines.push(`Wrote ${file.name}.`);
  }
  lines.push(
    ...(await applyProjectSetup(project, {
      install: options.install !== false,
    })),
  );
  lines.push("", "Setup complete. Before translating:");
  if (key !== undefined) {
    lines.push(
      `  Set ${key} in your shell or .env.local; .env.example documents the variable.`,
    );
  } else {
    lines.push(
      `  Configure the credentials your ${options.providerPackage ?? "AI SDK"} provider reads.`,
    );
  }
  if (setup.plan.targetLocales.length === 0) {
    lines.push(
      `  Choose target languages in ${config.name}, or rerun init --locale fr --locale de --force.`,
    );
  }
  if (!hasResources(setup)) {
    lines.push(
      "  Extract localization resources using the instructions above, then rerun init --force.",
    );
  }
  lines.push(
    "  Run npx ai-translate sync --dry-run to review the work, then npx ai-translate sync to translate.",
  );
  return { configPath: path.join(cwd, config.name), lines, setup };
}
