# @ai-translate/provider-openai

## 0.1.1

### Patch Changes

- Updated dependencies [[`11ba29d`](https://github.com/thiagoperes/ai-translate/commit/11ba29d663e87e86d40b4030b2f8f22b110ff4a1), [`d62127f`](https://github.com/thiagoperes/ai-translate/commit/d62127f7c6d7745765d13cf8f051203846c1ea3c), [`3da86ad`](https://github.com/thiagoperes/ai-translate/commit/3da86ad9998bce8a9bedf681a3c2875bff38a72d), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e), [`10723fc`](https://github.com/thiagoperes/ai-translate/commit/10723fc6443171641cb201f9f3d5ca2a5d7bb407), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e)]:
  - @ai-translate/core@0.2.0
  - @ai-translate/provider-core@0.2.0

## 0.1.0

### Minor Changes

- [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Add drop-in Next.js support: auto-discovery, message formats, and locale-aware plurals.

  `ai-translate init` detects a project's localization setup — next-intl or i18next — infers the message layout, locale list, and source locale, and writes an `ai-translate.config.ts` for it. Detection is read-only and never imports project code, and `@ai-translate/next` exposes the same engine as data, including a `defineIntegration` hook for setups the toolkit does not recognise.

  `@ai-translate/message-formats` adds ICU and i18next message formats. A message format decides what structural parity means for one string, so ICU plural and select branches are now compared against the target locale's own CLDR categories rather than the source's, and i18next `$t()` nesting keys are checked for accidental translation.

  Suffix-keyed plurals now work across locales. A `CatalogAdapter` may implement `localizeSourceDocument` to reshape the source for one target locale, and the JSON catalogs use it to give each locale the plural forms its grammar requires — seeded from the nearest source form and then translated like any other new entry. Forms the source declares are always preserved, so i18next's `_zero` and English's `one` survive into locales that have no grammatical use for them. Entries may also declare `meta.structureGroup`, which lets a plural family of differing cardinality compare equal during structural validation.

- [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Require Node.js 22 or later, and update the `openai` dependency to 7.1.0.

  The v7 SDK declares `engines.node >=22.0.0`, following Node 20 reaching
  end-of-life on 2026-04-30. That floor propagates: this package can no longer
  honour its previous `>=20.19.0` claim, so `engines` now states `>=22.0.0`.

  No API surface changed. openai v7 ships exactly one breaking change — the Node
  floor itself — and the request and response shapes this provider uses
  (`chat.completions.parse`, `zodResponseFormat`) are byte-identical to v6.

  The emitted JSON Schema is also unchanged, so the translation output contract
  revision does not move and no cached translations are invalidated.

  The other `@ai-translate/*` packages are unaffected and continue to support
  Node 20.19 and later.

- [`9cb4e88`](https://github.com/thiagoperes/ai-translate/commit/9cb4e88b323c6c6831c630e116e255c276bd2fce) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Default to `gpt-5.6-luna`, and stop sending a temperature unless one is configured.

  The previous default paired a `gpt-5.4` model with a temperature of 0.1, and `ai-translate init` wrote `gpt-4.1-mini` into generated configs. Reasoning models reject any temperature but their own default, so no provider-level value is both safe and meaningful: 0.1 would fail every request on the new default, and 1 would quietly loosen a non-reasoning model a caller chose for determinism. The translation provider now omits it, matching what the semantic audit provider already did.

  Callers that set `temperature` explicitly are unaffected.

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
