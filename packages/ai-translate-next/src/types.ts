/** A file or fact that supports a detection, shown to the user so an
 * auto-configured project is auditable rather than magic. */
export interface DetectionEvidence {
  detail: string;
  /** Project-relative path, or `package.json#dependencies` style locator. */
  source: string;
}

export type CatalogKind = "document-json" | "namespace-json";

export interface CatalogPlan {
  kind: CatalogKind;
  /** Suffix-key plural strategy, when the ecosystem uses one. ICU-based
   * setups leave this unset because their plurals live inside the message. */
  plurals?: "i18next-v4";
  /** Project-relative directory holding the locale folders or files. */
  rootDir: string;
}

export interface IntegrationPlan {
  catalog: CatalogPlan;
  messageFormat: "i18next" | "icu" | "plain";
  sourceLocale: string;
  targetLocales: readonly string[];
  /** Things the user must resolve by hand. A plan with warnings is still
   * usable; the warnings are printed next to the generated config. */
  warnings: readonly string[];
}

/**
 * Which provider package the generated config wires up.
 *
 * `openai` talks to OpenAI directly. `ai-sdk` routes through the AI SDK, which
 * is what makes the model vendor a one-line change afterwards.
 */
export type ProviderChoice = "ai-sdk" | "openai";

export interface RenderConfigOptions {
  /** Model id written into the config. Defaults per provider. */
  model?: string;
  provider?: ProviderChoice;
  /**
   * AI SDK vendor package the model factory is imported from, for example
   * `@ai-sdk/anthropic`. Ignored unless `provider` is `ai-sdk`.
   */
  providerPackage?: string;
}

export interface DetectedSetup {
  /** 0 to 1. Used only to rank candidates and to decide whether `init` can
   * proceed without the user naming an integration explicitly. */
  confidence: number;
  displayName: string;
  evidence: readonly DetectionEvidence[];
  integrationId: string;
  plan: IntegrationPlan;
}

/**
 * Read-only view of the project under inspection.
 *
 * Detection never writes and never executes project code — a config file is
 * parsed as text, not imported — so running `init` against an unfamiliar
 * repository is safe.
 */
export interface DetectionContext {
  /** Directory names directly under a project-relative path. */
  listDirectories(relativePath: string): Promise<readonly string[]>;
  /** File names directly under a project-relative path. */
  listFiles(relativePath: string): Promise<readonly string[]>;
  packageJson(): Promise<Record<string, unknown> | null>;
  readFile(relativePath: string): Promise<string | null>;
  readonly root: string;
}

export interface Integration {
  detect(context: DetectionContext): Promise<DetectedSetup | null>;
  readonly displayName: string;
  readonly id: string;
}

/** Identity helper that exists for inference and symmetry with `defineConfig`. */
export function defineIntegration(integration: Integration): Integration {
  return integration;
}
