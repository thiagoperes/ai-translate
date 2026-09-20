import { isBuiltin } from "node:module";

import type {
  CatalogPlan,
  ConfigImport,
  IntegrationPlan,
  RenderConfigOptions,
} from "./types";

const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_AI_SDK_PACKAGE = "@ai-sdk/openai";
const FS_JSON_PACKAGE = "@ai-translate/fs-json";
const MESSAGE_FORMATS_PACKAGE = "@ai-translate/message-formats";

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

function messageFormatImport(plan: Pick<IntegrationPlan, "messageFormat">): ConfigImport | undefined {
  if (typeof plan.messageFormat !== "string") {
    return plan.messageFormat;
  }
  if (plan.messageFormat === "plain") {
    return undefined;
  }
  return {
    from: MESSAGE_FORMATS_PACKAGE,
    name: plan.messageFormat === "icu" ? "icuMessageFormat" : "i18nextMessageFormat",
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function localeList(locales: readonly string[]): string {
  const inline = locales.map((locale) => quote(locale)).join(", ");
  return inline.length <= 68
    ? `[${inline}]`
    : `[\n${locales.map((locale) => `  ${quote(locale)},`).join("\n")}\n]`;
}

function catalogFactory(catalog: CatalogPlan): ConfigImport {
  return catalog.kind === "adapter"
    ? catalog.factory
    : {
        from: FS_JSON_PACKAGE,
        name: catalog.kind === "document-json"
          ? "createLocalizedJsonDocument"
          : "createNamespaceJsonCatalog",
      };
}

function catalogPlans(plan: IntegrationPlan): readonly CatalogPlan[] {
  return [plan.catalog, ...(plan.additionalCatalogs ?? [])];
}

/** Import subpaths belong to their root package; files, aliases, URLs, and Node
 * built-ins are resolvable imports but are not dependencies to install. */
function importPackageName(specifier: string): string | undefined {
  if (/^(?:[./\\#]|[A-Za-z][A-Za-z\d+.-]*:)/u.test(specifier) || isBuiltin(specifier)) {
    return undefined;
  }
  const [first, second] = specifier.split("/");
  if (first === undefined || first === "") {
    return undefined;
  }
  return first.startsWith("@")
    ? second === undefined || second === "" ? undefined : `${first}/${second}`
    : first;
}

/** Installable dependencies used by the generated config, including custom adapters. */
export function requiredConfigPackages(
  plan: IntegrationPlan,
  options: RenderConfigOptions = {},
): readonly string[] {
  const catalogs = catalogPlans(plan);
  const specifiers = [
    "@ai-translate/cli",
    FS_JSON_PACKAGE,
    ...catalogs.map((catalog) => catalogFactory(catalog).from),
    ...catalogs.flatMap((catalog) => {
      if (catalog.kind === "adapter") {return [];}
      const format = messageFormatImport({ messageFormat: catalog.messageFormat ?? plan.messageFormat });
      return format === undefined ? [] : [format.from];
    }),
    ...(catalogs.some((catalog) => catalog.kind !== "adapter" && catalog.plurals !== undefined)
      ? [MESSAGE_FORMATS_PACKAGE]
      : []),
    ...(options.provider === "ai-sdk"
      ? ["@ai-translate/provider-ai-sdk", "ai", options.providerPackage ?? DEFAULT_AI_SDK_PACKAGE]
      : ["@ai-translate/provider-openai"]),
  ];
  return [...new Set(specifiers.flatMap((specifier) => {
    const packageName = importPackageName(specifier);
    return packageName === undefined ? [] : [packageName];
  }))];
}

/** Render data-only adapter plans into a self-contained config without importing project code. */
export function renderConfig(plan: IntegrationPlan, options: RenderConfigOptions = {}): string {
  const imports = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  function addImport(reference: ConfigImport): string {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(reference.name) ||
      /^(?:arguments|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|eval|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield|sourceLocale|targetLocales|process)$/u.test(reference.name)) {
      throw new Error(`Invalid config import name ${quote(reference.name)}.`);
    }
    const previous = names.get(reference.name);
    if (previous !== undefined && previous !== reference.from) {
      throw new Error(`Config import ${quote(reference.name)} is declared by both ${previous} and ${reference.from}.`);
    }
    names.set(reference.name, reference.from);
    const members = imports.get(reference.from) ?? new Set<string>();
    members.add(reference.name);
    imports.set(reference.from, members);
    return reference.name;
  }

  const usesAiSdk = options.provider === "ai-sdk";
  const providerPackage = options.providerPackage ?? DEFAULT_AI_SDK_PACKAGE;
  const factoryName = usesAiSdk
    ? addImport({ from: providerPackage, name: aiSdkFactory(providerPackage) })
    : undefined;
  addImport({ from: "@ai-translate/cli", name: "defineConfig" });
  // Preserve the original JSON config's import ordering.
  const catalogs = catalogPlans(plan);
  for (const catalog of catalogs) {
    if (catalog.kind !== "adapter") {
      addImport(catalogFactory(catalog));
    }
  }
  addImport({ from: FS_JSON_PACKAGE, name: "createShardedJsonStateStore" });

  const renderedCatalogs = catalogs.map((catalog) => {
    const factory = addImport(catalogFactory(catalog));
    let properties: string[];
    if (catalog.kind === "adapter") {
      properties = Object.entries(catalog.options).map(([key, value]) =>
        `${quote(key)}: ${JSON.stringify(value)},`,
      );
      if (!Object.hasOwn(catalog.options, "sourceLocale")) {
        properties.push("sourceLocale,");
      }
    } else {
      const format = messageFormatImport({ messageFormat: catalog.messageFormat ?? plan.messageFormat });
      properties = [
        ...(catalog.id === undefined ? [] : [`id: ${quote(catalog.id)},`]),
        ...(format === undefined ? [] : [`messageFormat: ${addImport(format)},`]),
        ...(catalog.plurals === undefined
          ? []
          : [`plurals: ${addImport({ from: MESSAGE_FORMATS_PACKAGE, name: "i18nextPluralKeys" })},`]),
        `rootDir: ${quote(catalog.rootDir)},`,
        ...(catalog.kind === "document-json" && catalog.localeFiles !== undefined
          ? [`localeFiles: ${JSON.stringify(catalog.localeFiles)},`]
          : []),
        "sourceLocale,",
        ...(catalog.kind === "document-json"
          ? [`unitId: ${quote(catalog.unitId ?? "messages")},`]
          : []),
      ];
    }
    return `    ${factory}({\n${properties.map((property) => `      ${property}`).join("\n")}\n    }),`;
  });

  const model = options.model ?? DEFAULT_MODEL;
  const provider = usesAiSdk
    ? `${addImport({ from: "@ai-translate/provider-ai-sdk", name: "createAiSdkTranslationProvider" })}({
    model: ${factoryName ?? "model"}(${quote(model)}),
  })`
    : `${addImport({ from: "@ai-translate/provider-openai", name: "createOpenAiTranslationProvider" })}({
    apiKey: process.env.OPENAI_API_KEY,
    model: ${quote(model)},
  })`;
  const warningComments = plan.warnings.flatMap((warning) => warning.split(/\r\n|[\r\n\u2028\u2029]/u))
    .map((line) => `// TODO: ${line}`).join("\n");

  return `${[...imports].map(([from, members]) => `import { ${[...members].join(", ")} } from ${quote(from)};`).join("\n")}

const sourceLocale = ${quote(plan.sourceLocale)};
const targetLocales = ${localeList(plan.targetLocales)};

${warningComments.length === 0 ? "" : `${warningComments}\n\n`}export default defineConfig({
  catalogs: [
${renderedCatalogs.join("\n")}
  ],
  provider: ${provider},
  sourceLocale,
  state: createShardedJsonStateStore({ rootDir: process.cwd() }),
  targetLocales,
});
`;
}
