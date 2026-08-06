import type { SemanticAuditProvider, TranslationProvider } from "@ai-translate/core/types";
import {
  StructuredSemanticAuditProvider,
  StructuredTranslationProvider,
} from "@ai-translate/provider-core";
import type {
  StructuredCompletionRequest,
  StructuredCompletionTransport,
  StructuredSemanticAuditProviderOptions,
  StructuredTranslationProviderOptions,
} from "@ai-translate/provider-core";
import {
  generateObject,
  NoObjectGeneratedError,
  type JSONValue,
  type LanguageModel,
} from "ai";

export {
  SEMANTIC_AUDIT_OUTPUT_CONTRACT_MATERIAL,
  SEMANTIC_AUDIT_OUTPUT_CONTRACT_REVISION,
  TRANSLATION_OUTPUT_CONTRACT_MATERIAL,
  TRANSLATION_OUTPUT_CONTRACT_REVISION,
  createSemanticAuditOutputContractRevision,
  createTranslationOutputContractRevision,
} from "@ai-translate/provider-core";
export type {
  ReasoningEffort,
  SemanticAuditOutputContractMaterial,
  SemanticAuditPrompt,
  SemanticAuditPromptArgs,
  SemanticAuditResponseCache,
  StructuredCompletionMessage,
  StructuredCompletionRequest,
  StructuredCompletionTransport,
  SystemPrompt,
  SystemPromptArgs,
  TranslationOutputContractMaterial,
} from "@ai-translate/provider-core";

/**
 * Resolves the model for a request. The semantic audit contract names a model
 * per call — forward and adversarial passes routinely differ — so a transport
 * cannot bind exactly one model and still serve audits faithfully.
 */
export type LanguageModelResolver = (modelId: string) => LanguageModel;

/** Vendor-specific settings, keyed by AI SDK provider id. */
export type ProviderOptions = Record<string, Record<string, JSONValue>>;

export interface AiSdkTransportOptions {
  /**
   * Single model, or a lookup when different requests need different models.
   * A lookup is what makes dual-model semantic audits possible.
   */
  model: LanguageModel | LanguageModelResolver;
  /**
   * Passed through to the AI SDK as `providerOptions`, keyed by provider id —
   * the escape hatch for vendor features the neutral contract has no field for.
   */
  providerOptions?: ProviderOptions;
}

function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/**
 * Runs the engine against any AI SDK provider — OpenAI, Anthropic, Google,
 * Bedrock, a gateway, or a local model — without the engine knowing which.
 */
export function createAiSdkTransport(
  options: AiSdkTransportOptions,
): StructuredCompletionTransport {
  const resolve: LanguageModelResolver =
    typeof options.model === "function"
      ? options.model
      : (modelId: string): LanguageModel => {
          const bound = options.model as LanguageModel;
          if (modelId !== modelIdOf(bound)) {
            throw new Error(
              `This transport is bound to "${modelIdOf(bound)}" but the request asked for "${modelId}". Pass a resolver function as \`model\` to serve more than one model.`,
            );
          }
          return bound;
        };

  return {
    async complete(request: StructuredCompletionRequest): Promise<unknown> {
      const model = resolve(request.modelId);
      // The AI SDK takes the system prompt out of band and rejects a system
      // role inside `messages`, so the neutral message list is split here.
      const instructions = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      try {
        const result = await generateObject({
          messages: request.messages
            .filter((message) => message.role !== "system")
            .map((message) => ({ content: message.content, role: "user" as const })),
          model,
          ...(instructions === "" ? {} : { instructions }),
          schema: request.schema,
          schemaName: request.schemaName,
          ...(request.maxCompletionTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxCompletionTokens }),
          ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          providerOptions: mergeProviderOptions(request, options.providerOptions),
        });
        return result.object;
      } catch (error) {
        // The engine reads an absent payload as a retryable batch failure and
        // repairs it, which is the better outcome than surfacing a raw parse
        // error to the caller mid-sync.
        if (NoObjectGeneratedError.isInstance(error)) {
          return undefined;
        }
        throw error;
      }
    },
    label: "The model",
  };
}

/**
 * Prompt caching and reasoning effort have no neutral home in the AI SDK call
 * surface, so they travel as OpenAI-compatible provider options. Providers
 * that do not recognise them ignore them.
 */
function mergeProviderOptions(
  request: StructuredCompletionRequest,
  configured: ProviderOptions | undefined,
): ProviderOptions {
  const openai = {
    ...(request.promptCacheKey === undefined ? {} : { promptCacheKey: request.promptCacheKey }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...configured?.openai,
  };
  return {
    ...configured,
    ...(Object.keys(openai).length === 0 ? {} : { openai }),
  };
}

export interface AiSdkTranslationProviderOptions
  extends Omit<StructuredTranslationProviderOptions, "model" | "transport"> {
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}

export class AiSdkTranslationProvider extends StructuredTranslationProvider {
  constructor(options: AiSdkTranslationProviderOptions) {
    const { model, providerOptions, ...engineOptions } = options;
    super({
      ...engineOptions,
      model: modelIdOf(model),
      transport: createAiSdkTransport({
        model,
        ...(providerOptions === undefined ? {} : { providerOptions }),
      }),
    });
  }
}

export interface AiSdkSemanticAuditProviderOptions
  extends Omit<StructuredSemanticAuditProviderOptions, "transport"> {
  /**
   * A resolver serves the dual-model audit setup, where the forward and
   * adversarial passes name different models.
   */
  model: LanguageModel | LanguageModelResolver;
  providerOptions?: ProviderOptions;
}

export class AiSdkSemanticAuditProvider extends StructuredSemanticAuditProvider {
  constructor(options: AiSdkSemanticAuditProviderOptions) {
    const { model, providerOptions, ...engineOptions } = options;
    super({
      ...engineOptions,
      transport: createAiSdkTransport({
        model,
        ...(providerOptions === undefined ? {} : { providerOptions }),
      }),
    });
  }
}

export function createAiSdkTranslationProvider(
  options: AiSdkTranslationProviderOptions,
): TranslationProvider {
  return new AiSdkTranslationProvider(options);
}

export function createAiSdkSemanticAuditProvider(
  options: AiSdkSemanticAuditProviderOptions,
): SemanticAuditProvider {
  return new AiSdkSemanticAuditProvider(options);
}
