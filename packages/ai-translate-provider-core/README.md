# @ai-translate/provider-core

The vendor-neutral generation engine behind [ai-translate](https://github.com/thiagoperes/ai-translate)'s translation and semantic-audit providers.

Most projects never import this package directly. Install [`@ai-translate/provider-openai`](../ai-translate-provider-openai) to talk to OpenAI, or [`@ai-translate/provider-ai-sdk`](../ai-translate-provider-ai-sdk) to talk to anything the AI SDK reaches. Both are thin transports over what lives here.

## What it owns

Everything that decides what a model is asked and how its reply is judged:

- System prompt assembly, including project context, glossary, content roles, and self-check plans.
- Batching by count and character budget, with splitting and salvage on failure.
- Key aliasing, so a catalog key never leaks into the prompt as a translatable string.
- A strict per-batch response schema: exact keys, protected slots, length caps, and digit-free prose.
- Response decoding, deterministic re-validation, and the repair loop that retries a failed candidate rather than shipping it.
- The output contract revision: a digest of every output-affecting decision, which is what makes an accepted translation stay accepted only while the contract that produced it holds.

Transport, batching concurrency, and retry timing are deliberately excluded from that digest, so tuning throughput never invalidates a translation.

## Adding a vendor

Implement one interface:

```ts
import type { StructuredCompletionTransport } from "@ai-translate/provider-core";

const transport: StructuredCompletionTransport = {
  async complete(request) {
    // request.messages, request.modelId, request.schema, request.schemaName,
    // request.signal, and the optional maxCompletionTokens / temperature /
    // reasoningEffort / promptCacheKey hints.
    // Return the decoded object, or undefined when nothing parseable came back.
  },
  label: "Acme", // how the vendor should read in error messages
};
```

Then wrap it:

```ts
import {
  createStructuredSemanticAuditProvider,
  createStructuredTranslationProvider,
} from "@ai-translate/provider-core";

const provider = createStructuredTranslationProvider({ model: "acme-large", transport });
const audit = createStructuredSemanticAuditProvider({ transport });
```

Returning `undefined` from `complete` is not a failure: the engine reads an absent payload as a retryable batch and repairs it, which is the right outcome for a model that produced nothing parseable. Throw only for genuine transport errors.
