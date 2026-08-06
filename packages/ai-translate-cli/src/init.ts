import { promises as fs } from "node:fs";
import * as path from "node:path";

import { detectProject, renderConfig } from "@ai-translate/next";
import type { DetectedSetup, Integration, ProviderChoice } from "@ai-translate/next";

const CONFIG_FILENAME = "ai-translate.config.ts";
const DEFAULT_AI_SDK_PACKAGE = "@ai-sdk/openai";

/** Packages a generated config imports from, whichever provider it wires up. */
const REQUIRED_PACKAGES = ["@ai-translate/cli", "@ai-translate/fs-json"];

export interface InitOptions {
  /** Overwrites an existing config instead of refusing. */
  force?: boolean;
  /** Selects an integration when detection finds more than one. */
  integration?: string;
  /** Replaces the shipped integrations. A project that localizes something the
   * toolkit does not recognise can register its own detector rather than
   * writing the config by hand. */
  integrations?: readonly Integration[];
  /** Model id written into the generated config. */
  model?: string;
  /** Prints the config that would be written and touches nothing. */
  preview?: boolean;
  /** `openai` talks to OpenAI directly; `ai-sdk` routes through the AI SDK. */
  provider?: ProviderChoice;
  /** AI SDK vendor package, for example `@ai-sdk/anthropic`. */
  providerPackage?: string;
}

export interface InitResult {
  configPath: string | null;
  lines: readonly string[];
  setup: DetectedSetup;
}

function describe(setup: DetectedSetup): string[] {
  return [
    `Detected ${setup.displayName}:`,
    ...setup.evidence.map((item) => `  - ${item.detail} (${item.source})`),
    `  - Source locale ${setup.plan.sourceLocale}, ${String(
      setup.plan.targetLocales.length,
    )} target locale(s): ${setup.plan.targetLocales.join(", ")}`,
  ];
}

async function missingPackages(
  cwd: string,
  plan: DetectedSetup["plan"],
  options: InitOptions,
): Promise<string[]> {
  const expected = [
    ...REQUIRED_PACKAGES,
    ...(plan.messageFormat === "plain" ? [] : ["@ai-translate/message-formats"]),
    ...(options.provider === "ai-sdk"
      ? ["@ai-translate/provider-ai-sdk", "ai", options.providerPackage ?? DEFAULT_AI_SDK_PACKAGE]
      : ["@ai-translate/provider-openai"]),
  ];

  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const manifest = JSON.parse(raw) as Record<string, Record<string, string> | undefined>;
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    return expected.filter((name) => !declared.has(name));
  } catch {
    return expected;
  }
}

function chooseSetup(
  setups: readonly DetectedSetup[],
  requested: string | undefined,
): DetectedSetup {
  if (requested !== undefined) {
    const match = setups.find((setup) => setup.integrationId === requested);
    if (match === undefined) {
      throw new Error(
        `No ${requested} setup was detected. Detected: ${
          setups.map((setup) => setup.integrationId).join(", ") || "none"
        }.`,
      );
    }
    return match;
  }

  const [best, ...rest] = setups;
  if (best === undefined) {
    throw new Error(
      "No supported Next.js localization setup was found. ai-translate init currently " +
        "recognises next-intl and i18next. Write ai-translate.config.ts by hand, or run " +
        "init from the directory holding package.json and your locale files.",
    );
  }
  if (rest.length > 0 && rest[0]?.confidence === best.confidence) {
    // Two equally plausible setups is a genuine ambiguity, not something to
    // resolve by coin flip: writing the wrong one silently would point the
    // whole pipeline at the wrong catalog.
    throw new Error(
      `Found more than one localization setup (${setups
        .map((setup) => setup.integrationId)
        .join(", ")}). Re-run with --integration <id> to choose.`,
    );
  }
  return best;
}

/**
 * Detects the project's localization setup and writes a config for it.
 *
 * Nothing else is touched. Installing packages, wiring scripts, and editing the
 * Next.js config stay in the user's hands, so `init` on an unfamiliar repository
 * produces exactly one new file and a list of instructions.
 */
export async function runInit(cwd: string, options: InitOptions = {}): Promise<InitResult> {
  const setups = await detectProject(
    cwd,
    options.integrations === undefined ? {} : { integrations: options.integrations },
  );
  const setup = chooseSetup(setups, options.integration);
  const contents = renderConfig(setup.plan, {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.providerPackage === undefined ? {} : { providerPackage: options.providerPackage }),
  });
  const configPath = path.join(cwd, CONFIG_FILENAME);
  const lines = describe(setup);

  for (const warning of setup.plan.warnings) {
    lines.push(`  ! ${warning}`);
  }

  const others = setups.filter((candidate) => candidate !== setup);
  if (others.length > 0) {
    lines.push(
      `Also detected, not used: ${others.map((candidate) => candidate.displayName).join(", ")}.`,
    );
  }

  if (options.preview === true) {
    lines.push("", `Would write ${CONFIG_FILENAME}:`, "", contents);
    return { configPath: null, lines, setup };
  }

  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (exists && options.force !== true) {
    throw new Error(`${CONFIG_FILENAME} already exists. Pass --force to overwrite it.`);
  }

  await fs.writeFile(configPath, contents, "utf8");
  lines.push("", `Wrote ${CONFIG_FILENAME}.`, "", "Next steps:");

  const install = await missingPackages(cwd, setup.plan, options);
  let step = 1;
  if (install.length > 0) {
    lines.push(`  ${String(step++)}. Install: ${install.join(" ")}`);
  }
  const apiKeyVariable =
    options.provider === "ai-sdk"
      ? `the API key your ${options.providerPackage ?? DEFAULT_AI_SDK_PACKAGE} provider reads`
      : "OPENAI_API_KEY";
  lines.push(
    `  ${String(step++)}. Set ${apiKeyVariable}, in your shell or in .env.local.`,
    `  ${String(step++)}. Review the model and locale list in ${CONFIG_FILENAME}.`,
    `  ${String(step++)}. Run "ai-translate validate" to confirm the config loads.`,
    `  ${String(step++)}. Run "ai-translate check" to see what a sync would do.`,
    `  ${String(step)}. Run "ai-translate sync" to translate.`,
  );

  return { configPath, lines, setup };
}
