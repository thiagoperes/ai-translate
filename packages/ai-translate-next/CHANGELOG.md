# @ai-translate/next

## 0.1.1

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

## 0.1.0

### Minor Changes

- [`fc921aa`](https://github.com/thiagoperes/ai-translate/commit/fc921aaee6f8b8d2d2808f033a25b2fafeb9424c) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Add drop-in Next.js support: auto-discovery, message formats, and locale-aware plurals.

  `ai-translate init` detects a project's localization setup — next-intl or i18next — infers the message layout, locale list, and source locale, and writes an `ai-translate.config.ts` for it. Detection is read-only and never imports project code, and `@ai-translate/next` exposes the same engine as data, including a `defineIntegration` hook for setups the toolkit does not recognise.

  `@ai-translate/message-formats` adds ICU and i18next message formats. A message format decides what structural parity means for one string, so ICU plural and select branches are now compared against the target locale's own CLDR categories rather than the source's, and i18next `$t()` nesting keys are checked for accidental translation.

  Suffix-keyed plurals now work across locales. A `CatalogAdapter` may implement `localizeSourceDocument` to reshape the source for one target locale, and the JSON catalogs use it to give each locale the plural forms its grammar requires — seeded from the nearest source form and then translated like any other new entry. Forms the source declares are always preserved, so i18next's `_zero` and English's `one` survive into locales that have no grammatical use for them. Entries may also declare `meta.structureGroup`, which lets a plural family of differing cardinality compare equal during structural validation.

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
