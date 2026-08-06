import type { IntegrationPlan, RenderConfigOptions } from "./types";

/** Inexpensive and reasoning-capable, matching the provider defaults. */
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_AI_SDK_PACKAGE = "@ai-sdk/openai";

/**
 * Maps an AI SDK vendor package to the factory it exports, so the generated
 * config compiles as written instead of needing a lookup in vendor docs.
 */
function aiSdkFactory(providerPackage: string): string {
  const known: Record<string, string> = {
    "@ai-sdk/amazon-bedrock": "bedrock",
    "@ai-sdk/anthropic": "anthropic",
    "@ai-sdk/azure": "azure",
    "@ai-sdk/google": "google",
    "@ai-sdk/groq": "groq",
    "@ai-sdk/mistral": "mistral",
    "@ai-sdk/openai": "openai",
    "@ai-sdk/xai": "xai",
  };
  return known[providerPackage] ?? "model";
}

const MESSAGE_FORMAT_IMPORTS: Record<IntegrationPlan["messageFormat"], string | null> = {
  i18next: "i18nextMessageFormat",
  icu: "icuMessageFormat",
  plain: null,
};

function quote(value: string): string {
  return JSON.stringify(value);
}

function localeList(locales: readonly string[]): string {
  const inline = locales.map((locale) => quote(locale)).join(", ");
  // One per line once the array stops fitting on a line, which is the point
  // where a reviewer can no longer scan it.
  return inline.length <= 68
    ? `[${inline}]`
    : `[\n${locales.map((locale) => `  ${quote(locale)},`).join("\n")}\n]`;
}

/**
 * Renders a self-contained `ai-translate.config.ts`.
 *
 * The output is deliberately plain: literal locale lists rather than imports
 * from the project's own i18n module, so the file reads correctly without
 * knowing anything about the surrounding codebase and can be edited by hand
 * afterwards.
 */
export function renderConfig(plan: IntegrationPlan, options: RenderConfigOptions = {}): string {
  const messageFormatImport = MESSAGE_FORMAT_IMPORTS[plan.messageFormat];
  const usesPlurals = plan.catalog.plurals !== undefined;
  const usesAiSdk = options.provider === "ai-sdk";
  const model = options.model ?? DEFAULT_MODEL;
  const providerPackage = options.providerPackage ?? DEFAULT_AI_SDK_PACKAGE;
  const factoryName = aiSdkFactory(providerPackage);

  const fsJsonImports = [
    plan.catalog.kind === "document-json"
      ? "createLocalizedJsonDocument"
      : "createNamespaceJsonCatalog",
    "createShardedJsonStateStore",
  ];

  const messageFormatsImports = [
    ...(messageFormatImport === null ? [] : [messageFormatImport]),
    ...(usesPlurals ? ["i18nextPluralKeys"] : []),
  ];

  const imports = [
    ...(usesAiSdk ? [`import { ${factoryName} } from ${quote(providerPackage)};`] : []),
    'import { defineConfig } from "@ai-translate/cli";',
    `import { ${fsJsonImports.join(", ")} } from "@ai-translate/fs-json";`,
    ...(messageFormatsImports.length === 0
      ? []
      : [`import { ${messageFormatsImports.join(", ")} } from "@ai-translate/message-formats";`]),
    usesAiSdk
      ? 'import { createAiSdkTranslationProvider } from "@ai-translate/provider-ai-sdk";'
      : 'import { createOpenAiTranslationProvider } from "@ai-translate/provider-openai";',
  ];

  // The AI SDK path keeps the model behind a vendor factory, so switching
  // vendors later is an import change rather than a provider rewrite.
  const provider = usesAiSdk
    ? `createAiSdkTranslationProvider({
    model: ${factoryName}(${quote(model)}),
  })`
    : `createOpenAiTranslationProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: ${quote(model)},
  })`;

  const catalogOptions = [
    ...(messageFormatImport === null ? [] : [`messageFormat: ${messageFormatImport},`]),
    ...(usesPlurals ? ["plurals: i18nextPluralKeys,"] : []),
    `rootDir: ${quote(plan.catalog.rootDir)},`,
    "sourceLocale,",
    ...(plan.catalog.kind === "document-json" ? ['unitId: "messages",'] : []),
  ];

  const factory =
    plan.catalog.kind === "document-json"
      ? "createLocalizedJsonDocument"
      : "createNamespaceJsonCatalog";

  const warnings =
    plan.warnings.length === 0
      ? ""
      : `${plan.warnings.map((warning) => `// TODO: ${warning}`).join("\n")}\n\n`;

  return `${imports.join("\n")}

const sourceLocale = ${quote(plan.sourceLocale)};
const targetLocales = ${localeList(plan.targetLocales)};

${warnings}export default defineConfig({
  catalogs: [
    ${factory}({
${catalogOptions.map((option) => `      ${option}`).join("\n")}
    }),
  ],
  provider: ${provider},
  sourceLocale,
  state: createShardedJsonStateStore({ rootDir: process.cwd() }),
  targetLocales,
});
`;
}
