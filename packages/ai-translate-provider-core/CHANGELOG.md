# @ai-translate/provider-core

## 0.3.0

### Minor Changes

- Deduplicate equivalent translation requests across batches and concurrent calls, and reuse successful results for the duration of a sync. Adaptive batching now sizes short-text batches to the available concurrency and input/output budgets, while keeping protected and long-form content isolated. Translate complete inline markup units with structural and numeric validation, preserve heading reasoning, and report actual transport attempts and billed usage. Retry handling recognizes AI SDK failures without multiplying SDK and engine retries.

### Patch Changes

- Updated dependencies
  - @ai-translate/core@0.3.0

## 0.2.0

### Minor Changes

- [`10723fc`](https://github.com/thiagoperes/ai-translate/commit/10723fc6443171641cb201f9f3d5ca2a5d7bb407) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Stop rejecting correct translations, and make semantic preservation free by default.

  **Token parity no longer checks order.** `validateTokenParity` compared protected tokens by position, so any translation that moved a placeholder to satisfy target grammar failed. On a 82,335-pair production corpus, five of the seven reported failures were correct translations — German fronting `{{count}}` ahead of `{{language}}`, Irish reordering a parenthetical, Lithuanian moving `{{method}}` before `{{time}}`.

  The consequence was worse than a noisy report. With the default `candidateRepairAttempts: 0`, a failed candidate is discarded and the entry marked `failed`, leaving the target absent and the string falling back to source at runtime. Because the model keeps producing the same correct text, it failed identically on every subsequent sync — a permanent hole that never healed.

  Parity now compares tokens as a set and ignores position entirely. Placeholders resolve by name and indexed tags by index, so order never carried meaning.

  **Severity now follows runtime impact.** Placeholder and tag differences stay errors: a dropped one loses data, an invented one renders as literal braces. Markdown differences — emphasis, inline code, link destinations, formatting-scope expansion — are warnings that record and ship. The same corpus now reports one error, a genuine dropped `{{last4}}`, plus two warnings.

  Issue codes `token-count-mismatch` and `token-order-mismatch` are replaced by `token-missing` and `token-unexpected`, which name the differing token. Update any `validation.existingIssueSeverity` keys.

  Two boundaries stay strict, because there the tokens are masked placeholders the model must echo back verbatim rather than translator judgement: Markdoc write-time structure checks, where the value is spliced into an AST and markdown _is_ structure, and provider-level protected-text restoration.

  **`semanticAuditExecution` now defaults to `generator-self-check`.** Self-check folds semantic preservation into the translation request for zero extra provider calls, against one or two calls per 50-entry batch for a separate replay. Set `"provider"` to keep a second model's independent opinion.

  Flipping that default surfaced two places where the mode was standing in for "attestations are required", both of which would have silently degraded every existing setup:

  - The candidate cache switches to the optional `getAttested`/`putAttested` pair in self-check mode, and both call sites bail out silently when a store does not implement them. Every ordinary `get`/`put` store would have stopped caching with no error and a doubled model bill.
  - Segment-delta reuse disabled itself in self-check mode.

  Both now key off whether semantic audits are actually configured. With none, nothing can demand an attestation, so caching and delta reuse behave exactly as before.

  Generated entries no longer carry an empty `validationAudits: {}`, which self-check would otherwise have written onto every entry in the state file.

### Patch Changes

- [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Turn on type-aware linting and fix what it found.

  The config already asked for `no-floating-promises`, `no-misused-promises`,
  `no-confusing-void-expression` and `require-await`, but oxlint skips rules that
  need type information unless it is run with `--type-aware` and can find
  `oxlint-tsgolint`. Neither was in place, so those four rules had been inert.
  Both are now wired into every `lint` script, along with a set of type-aware
  rules that were clean on the first run and now hold that line: `await-thenable`,
  `no-base-to-string`, `restrict-template-expressions`, `restrict-plus-operands`,
  `prefer-readonly`, `use-unknown-in-catch-callback-variable`, and others.

  Two real defects came out of it:

  - The semantic-audit repair note was assembled as `text + reason ? a : b`.
    Because `+` binds tighter than `?:`, that parsed as `(text + reason) ? a : b`,
    whose left side is a non-empty string and therefore always truthy. Every
    repair prompt lost both the requirement description and the "preserve the
    English meaning" instruction, and printed `undefined` as the diagnostic reason
    when there was none. Now assembled as a single template, with a test that pins
    the note in full.
  - Four call sites detached a method from an object supplied by the caller — a
    candidate-cache store, a message format, the Markdoc runtime — and then called
    it unbound, which drops `this` for any implementation written as a class.
    These now call through their receiver.

  Rules deliberately left off, with the reasoning recorded in `.oxlintrc.json`:
  `no-unnecessary-condition` (reads concurrent state mutated across an `await` as
  always-false, and treats runtime guards over unverified JSON as dead code),
  `no-unsafe-type-assertion` (the assertions it flags are the correct idiom at
  this toolkit's dynamic boundaries), `unicorn/no-array-callback-reference`
  (wrapping `filter(isFoo)` in an arrow discards the type predicate), and
  `no-loop-func` (a `var`-era rule that here reports only safe code).

- Updated dependencies [[`11ba29d`](https://github.com/thiagoperes/ai-translate/commit/11ba29d663e87e86d40b4030b2f8f22b110ff4a1), [`d62127f`](https://github.com/thiagoperes/ai-translate/commit/d62127f7c6d7745765d13cf8f051203846c1ea3c), [`3da86ad`](https://github.com/thiagoperes/ai-translate/commit/3da86ad9998bce8a9bedf681a3c2875bff38a72d), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e), [`10723fc`](https://github.com/thiagoperes/ai-translate/commit/10723fc6443171641cb201f9f3d5ca2a5d7bb407), [`806eea3`](https://github.com/thiagoperes/ai-translate/commit/806eea32e99673bc250c4e59a9b695363062db2e)]:
  - @ai-translate/core@0.2.0

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

- [`18f220e`](https://github.com/thiagoperes/ai-translate/commit/18f220e63f5ce99ffa4197d52dfc28b396fdd2fc) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Drop the `openai` dev dependency from `@ai-translate/provider-core`.

  The engine is vendor-neutral, but its test harness still rendered request
  schemas with `zodResponseFormat` from the OpenAI SDK, which requires Node 22.
  That pulled a vendor — and a runtime floor — into a package that claims neither.
  The harness now renders the same JSON Schema with `zod`, so the assertions still
  compare what a model is actually shown and the package's Node 20.19 claim holds.

- Updated dependencies [[`2236243`](https://github.com/thiagoperes/ai-translate/commit/223624367f1870fcd0a8dcd753cbfa57b06c4c43), [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c), [`43cd89f`](https://github.com/thiagoperes/ai-translate/commit/43cd89f0c681f9a70405477f4d8882c8f2cf4f48)]:
  - @ai-translate/core@0.1.0
