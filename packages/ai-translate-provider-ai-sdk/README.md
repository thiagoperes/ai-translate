# @ai-translate/provider-ai-sdk

Run [ai-translate](https://github.com/thiagoperes/ai-translate) against any [AI SDK](https://ai-sdk.dev) model — OpenAI, Anthropic, Google, Bedrock, Groq, xAI, a gateway, or a local model.

This package is a transport. Every decision that shapes a translation — prompt assembly, batching, key aliasing, response decoding, the repair loop, self-check attestation — lives in [`@ai-translate/provider-core`](../ai-translate-provider-core) and behaves identically whichever vendor you point it at.

## Install

```bash
npm install --save-dev @ai-translate/provider-ai-sdk ai @ai-sdk/anthropic
```

`ai` is a peer dependency, as is whichever AI SDK vendor package you use.

## Usage

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { createAiSdkTranslationProvider } from "@ai-translate/provider-ai-sdk";

export default defineConfig({
  provider: createAiSdkTranslationProvider({
    model: anthropic("claude-sonnet-4"),
  }),
  // ...
});
```

Credentials are the AI SDK's business: each vendor package reads its own environment variable, so nothing about keys belongs in your ai-translate config.

### Semantic audits

```ts
import { createAiSdkSemanticAuditProvider } from "@ai-translate/provider-ai-sdk";

semanticAudit: {
  provider: createAiSdkSemanticAuditProvider({
    model: (modelId) => registry.languageModel(modelId),
  }),
}
```

An audit names its model per request — the forward and adversarial passes routinely differ — so pass a resolver function when the two passes should run on different models. A single `LanguageModel` also works and serves every request that names it.

### Vendor-specific settings

Anything the neutral request has no field for travels as `providerOptions`, keyed by AI SDK provider id:

```ts
createAiSdkTranslationProvider({
  model: anthropic("claude-sonnet-4"),
  providerOptions: { anthropic: { thinking: { budgetTokens: 4_096, type: "enabled" } } },
});
```

Prompt cache keys and reasoning effort are derived from the request automatically and merged under `openai`; anything you configure explicitly wins.

## Bringing your own vendor

If a model is not reachable through the AI SDK, implement `StructuredCompletionTransport` — one `complete` method and a `label` — and hand it to `createStructuredTranslationProvider` from `@ai-translate/provider-core`.
