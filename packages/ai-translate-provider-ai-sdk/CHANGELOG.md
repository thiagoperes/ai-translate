# @ai-translate/provider-ai-sdk

## 0.2.0

### Minor Changes

- Report token usage for successful and invalid structured responses, and disable hidden SDK retries so the shared engine owns the retry budget. Preserve the default three total attempts. Adopt adaptive batching, request deduplication, and complete inline markup translation.

### Patch Changes

- Updated dependencies
  - @ai-translate/core@0.3.0
  - @ai-translate/provider-core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`11ba29d`](https://github.com/thiagoperes/ai-translate/commit/11ba29d663e87e86d40b4030b2f8f22b110ff4a1), [`d62127f`](https://github.com/thiagoperes/ai-translate/commit/d62127f7c6d7745765d13cf8f051203846c1ea3c), [`3da86ad`](https://github.com/thiagoperes/ai-translate/commit/3da86ad9998bce8a9bedf681a3c2875bff38a72d), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e), [`10723fc`](https://github.com/thiagoperes/ai-translate/commit/10723fc6443171641cb201f9f3d5ca2a5d7bb407), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e)]:
  - @ai-translate/core@0.2.0
  - @ai-translate/provider-core@0.2.0

## 0.1.0

### Minor Changes

- [`18f220e`](https://github.com/thiagoperes/ai-translate/commit/18f220e63f5ce99ffa4197d52dfc28b396fdd2fc) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Make the model vendor a choice rather than a dependency.

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

  provider: createAiSdkTranslationProvider({
    model: anthropic("claude-sonnet-4"),
  });
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

### Patch Changes

- Updated dependencies [[`18f220e`](https://github.com/thiagoperes/ai-translate/commit/18f220e63f5ce99ffa4197d52dfc28b396fdd2fc), [`2236243`](https://github.com/thiagoperes/ai-translate/commit/223624367f1870fcd0a8dcd753cbfa57b06c4c43), [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c), [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48), [`18f220e`](https://github.com/thiagoperes/ai-translate/commit/18f220e63f5ce99ffa4197d52dfc28b396fdd2fc)]:
  - @ai-translate/provider-core@0.1.0
  - @ai-translate/core@0.1.0
