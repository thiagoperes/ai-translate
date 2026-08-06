---
"@ai-translate/provider-ai-sdk": minor
"@ai-translate/provider-core": minor
"@ai-translate/provider-openai": minor
"@ai-translate/next": minor
"@ai-translate/cli": minor
---

Make the model vendor a choice rather than a dependency.

The translation and semantic-audit engine — prompt assembly, batching, key
aliasing, response decoding, the repair loop, self-check attestation — now
lives in `@ai-translate/provider-core` and talks to exactly one vendor
interface, `StructuredCompletionTransport.complete`.

`@ai-translate/provider-openai` keeps its API and becomes a thin transport over
that engine. The new `@ai-translate/provider-ai-sdk` is a second transport over
the same engine, so any AI SDK model works — Anthropic, Google, Bedrock, Groq,
xAI, a gateway, or a local model — for both translation and semantic audits:

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { createAiSdkTranslationProvider } from "@ai-translate/provider-ai-sdk";

provider: createAiSdkTranslationProvider({ model: anthropic("claude-sonnet-4") });
```

`ai-translate init` can generate either wiring: `--provider ai-sdk`,
`--provider-package @ai-sdk/anthropic`, and `--model <id>` pick the provider
package, the vendor factory, and the model written into the config.

The output contract material is now a vendor-neutral JSON Schema rather than an
OpenAI response format object, so the translation and semantic-audit contract
revisions change and previously accepted translations are re-verified on the
next sync. Semantic audits also gained the wall-clock deadline the translation
path already had, so a transport that ignores its own timeout can no longer
hang a run.

Both provider packages require Node 22 or newer, matching the `openai` and `ai`
SDKs they wrap. Everything else still runs on Node 20.19.
