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
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

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
 * Reasoning-capable and inexpensive. Callers who want a different trade-off
 * pass `model` explicitly.
 */
export const DEFAULT_MODEL = "gpt-5.6-luna";
export const DEFAULT_REASONING_EFFORT = "medium";

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

export interface OpenAiTransportOptions {
  apiKey?: string;
  client?: OpenAI;
  requestTimeoutMs?: number;
}

/**
 * Speaks the OpenAI Chat Completions dialect of the engine's request contract.
 * Retries stay off here because the engine owns the retry and repair loop.
 */
export function createOpenAiTransport(
  options: OpenAiTransportOptions = {},
): StructuredCompletionTransport {
  if (!options.client && !options.apiKey) {
    throw new Error("OpenAI transport requires either apiKey or client.");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const client =
    options.client ??
    new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: requestTimeoutMs });

  return {
    async complete(request: StructuredCompletionRequest): Promise<unknown> {
      const completion = await client.chat.completions.parse(
        {
          messages: request.messages.map((message) => ({
            content: message.content,
            role: message.role,
          })),
          model: request.modelId,
          ...(request.maxCompletionTokens === undefined
            ? {}
            : { max_completion_tokens: request.maxCompletionTokens }),
          ...(request.promptCacheKey === undefined
            ? {}
            : { prompt_cache_key: request.promptCacheKey }),
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: request.reasoningEffort }),
          response_format: zodResponseFormat(request.schema, request.schemaName),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        },
        {
          maxRetries: 0,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          timeout: requestTimeoutMs,
        },
      );
      return completion.choices[0]?.message.parsed;
    },
    label: "OpenAI",
  };
}

export interface OpenAiTranslationProviderOptions
  extends Omit<StructuredTranslationProviderOptions, "model" | "transport"> {
  apiKey?: string;
  client?: OpenAI;
  model?: string;
}

export class OpenAiTranslationProvider extends StructuredTranslationProvider {
  constructor(options: OpenAiTranslationProviderOptions = {}) {
    const { apiKey, client, model, ...engineOptions } = options;
    super({
      ...engineOptions,
      model: model ?? DEFAULT_MODEL,
      reasoningEffort: engineOptions.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      transport: createOpenAiTransport({
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(client === undefined ? {} : { client }),
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
      }),
    });
  }
}

export interface OpenAiSemanticAuditProviderOptions
  extends Omit<StructuredSemanticAuditProviderOptions, "transport"> {
  apiKey?: string;
  client?: OpenAI;
}

export class OpenAiSemanticAuditProvider extends StructuredSemanticAuditProvider {
  constructor(options: OpenAiSemanticAuditProviderOptions = {}) {
    const { apiKey, client, ...engineOptions } = options;
    super({
      ...engineOptions,
      transport: createOpenAiTransport({
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(client === undefined ? {} : { client }),
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
      }),
    });
  }
}

export function createOpenAiTranslationProvider(
  options: OpenAiTranslationProviderOptions = {},
): TranslationProvider {
  return new OpenAiTranslationProvider(options);
}

export function createOpenAiSemanticAuditProvider(
  options: OpenAiSemanticAuditProviderOptions = {},
): SemanticAuditProvider {
  return new OpenAiSemanticAuditProvider(options);
}
