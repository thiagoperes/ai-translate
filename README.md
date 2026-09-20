# ai-translate

**AI-powered localization for Apple apps, JSON, Markdoc, HTML, and Next.js — incremental, validated, and built for CI.**

[![CI](https://github.com/thiagoperes/ai-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/thiagoperes/ai-translate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen.svg)](#install)

`ai-translate` keeps localization resources in sync with your source language. It
translates new or changed strings, validates the results, preserves human edits,
and checks for stale translations in CI. MIT licensed; bring your own model API key.

## Supported projects and formats

| Project | Translation resources | Automatic setup |
| --- | --- | --- |
| iOS / macOS: SwiftUI, UIKit, AppKit | Xcode `.xcstrings` and `.lproj/*.strings` | Detects catalogs, tables, Xcode projects, and Apple Swift packages. |
| Expo native permissions and labels | JSON files mapped by `expo.locales` | Reads `app.json` or a static `app.config.ts` / `.js` without executing it. |
| React Native / Tauri shared UI | i18next locale JSON | Detects existing i18next resources; composes them with native resources. |
| Next.js | next-intl or i18next messages | Detects message files, source language, and target languages. |
| Other apps, websites, and content | JSON, HTML, Markdoc; ICU and i18next messages | Compose adapters in a config; custom detectors use the same integration interface. |

Native catalogs support plural/device variations and Apple printf placeholders.
App code still needs to use its platform's localization APIs: the CLI translates
resources, while Xcode and your runtime handle extraction, bundles, and display.
See the [native app guide](docs/native-apps.md) for that wiring.

## Get started

Run from your app's root with Node 22 or newer:

```bash
npx ai-translate init
```

`init` detects supported resources, combines compatible setups, writes the config,
installs its dependencies with your project's npm, pnpm, Yarn, or Bun, and validates
the generated config and source resources. It also
adds translation scripts, an API-key template, and ignore entries for local secrets
and `node_modules`. Swift-only projects get a private `package.json` for the tooling.
Existing dependency versions, scripts, resource files, and credentials are preserved.

Set your provider key in the shell or `.env.local` (`OPENAI_API_KEY` by default), then:

```bash
npx ai-translate sync --dry-run   # inspect what needs translation
npx ai-translate sync             # translate, validate, write
npx ai-translate check            # read-only CI gate
```

Use `init --preview` to see every setup change without writing or installing.
Use `init --locale fr --locale de` when the project has no target languages yet.
`--no-install` prepares the files and prints the install command. If a config
already exists, identical setup can be resumed; changed configs require `--force`.

Key features:

| | |
| --- | --- |
| ⚡ **Incremental** | Translate only new or changed strings. |
| 🛡️ **Validated** | Protect placeholders, tags, glossary terms, and structure. |
| ✅ **CI-ready** | Catch stale locales with a read-only `check`. |
| ✍️ **Human-friendly** | Preserve manual edits with atomic writes. |
| 🧩 **Composable** | Share state, providers, and validation across resource adapters. |
| 💸 **Usage-based** | Pay your model provider for the work that changes; see the [cost examples](#what-it-costs). |

## Why this exists

Most "translate my JSON with an LLM" tools re-send everything on every run and trust whatever comes back. This one is built around two ideas.

### Nothing is translated twice without a reason

Because every entry carries the digests that produced it, a run can prove what is still current — and `--dry-run` shows you the decision before you pay for it:

```jsonc
{
  "dryRun": true,
  "metrics": {
    "scannedDocuments": 412,
    "translatedEntries": 37,      // would be sent to the model
    "copiedEntries": 5891,        // already current, untouched
    "invalidationReasons": {
      "source-changed": 31,
      "context-changed": 4,
      "missing-state": 2
    }
  }
}
```

### Checked where it counts, quiet everywhere else

Validation blocks on the things that break your app — a placeholder the code supplies but the translation dropped, an invented one that would render as literal `{{braces}}`, markup the runtime cannot map. Those cost a retry rather than a production string in a language you cannot read.

It deliberately stays out of the way everywhere else. Word order is the translator's business, not the validator's: German fronting `{{count}}` ahead of `{{language}}` is correct output, and a tool that rejects it discards a good translation and leaves the string in English forever. Cosmetic differences like dropped emphasis are reported as warnings and ship.

Semantic preservation rides along with the translation request by default, so it costs no extra model calls. Set `validation.semanticAuditExecution: "provider"` when you want a second model to re-read the output independently.

## What it costs

Cost scales with translatable segments, not with files or repositories. A full first pass over a large blog — 5,000 posts of 1,500 words into 10 target locales — is 7.5M source words, about 1.06M segments, and roughly 267M input plus 140M output tokens:

| Model | Input $/M | Output $/M | Full first pass | Per 1M words, per locale |
| --- | --- | --- | --- | --- |
| DeepSeek V4 Flash | $0.14 | $0.28 | $77 | $1.02 |
| Gemini 2.5 Flash-Lite | $0.10 | $0.40 | $83 | $1.10 |
| GPT-5.6 Luna | $0.20 | $1.20 | $221 | $2.95 |

About a dollar per million source words per locale on the cheap tiers. That is the one-off cost of catching up; every run after it pays only for what changed, so steady-state spend tracks your edit rate rather than your corpus size.

Two things move the total more than the rate card does:

- **Reasoning tokens**, which bill at the output rate. Defaults differ sharply: DeepSeek V4 Flash thinks by default, GPT-5.6 Luna inherits the API's default effort, and Gemini 2.5 Flash-Lite ships with thinking off. The table assumes reasoning is disabled; leaving the defaults alone costs $116 and $389 for the two that think.
- **Figures in the source.** A paragraph containing a number is translated through a protected-assembly schema that pins every digit and enumerates the target locale's number forms, costing around 132 tokens per entry against 36 for plain prose. The table assumes a quarter of paragraphs carry one.

Prompt caching is not a meaningful lever here. The only prefix shared across calls is the system prompt, which is roughly a tenth of input tokens once amortised across a batch, and input is the cheaper half of the bill.

Token counts are measured by capturing the payloads the provider actually sends at stock defaults, the same method as [`bench/prompt.bench.mjs`](bench/prompt.bench.mjs), rather than estimated from the prompt source. Prices are the published rate cards as of 2026-08-07 and will drift; re-check them before quoting a budget.

## Install

```bash
npm install --save-dev @ai-translate/cli @ai-translate/core @ai-translate/fs-json @ai-translate/provider-openai
```

Requires Node 20.19 or newer. The provider packages need Node 22+, because the
`openai` and `ai` SDKs they wrap do.

## Quickstart

### iOS, macOS, Swift, or Expo?

Use [`@ai-translate/apple`](packages/ai-translate-apple) for Xcode `.xcstrings`
catalogs and `.lproj/*.strings` resources. Apple printf placeholders are validated
automatically, and translator comments become request context. Multiple locales
in one string catalog are updated without replacing the source or other locales.

```bash
npx ai-translate init
```

For Expo, translate committed `expo.locales` JSON with the existing JSON adapter
and `applePrintfMessageFormat`; Expo prebuild generates the native resources.
Compose it with an i18next JSON catalog for shared React Native/Tauri UI.

The [native app guide](docs/native-apps.md) covers initial extraction, Swift
package bundles, Xcode target membership, Expo permission strings, and concrete
setup recipes for `translator-rn`, `newsblocker`, and `tools`. Existing hardcoded
UI text needs resource extraction and runtime lookups before a translated
catalog can affect the app.

### Already using Next.js?

```bash
npx ai-translate init
```

`init` detects **next-intl**, **i18next**, **Expo locale mappings**, and **Apple resources**, then sets up the config, dependencies, and scripts. It prints the evidence for each conclusion. Independent resource sets with the same source locale share one config; overlapping or incompatible setups can be selected with `--integration <id>`.

```text
Detected i18next:
  - i18next, react-i18next declared as dependencies (package.json)
  - i18next settings module (lib/i18n/i18n.settings.ts)
  - 28 namespace file(s) across 16 locales (public/locales/en)
  - Source locale en, 15 target locale(s): de, el, es, et, fi, fr, ga, hr, it, lt, lv, nl, pt, sk, sl
```

Use `--preview` to see the full setup plan without writes or installation. Detection is read-only and never imports project code; see [`@ai-translate/integrations`](packages/ai-translate-integrations) to add your own integration.

To generate a config that runs on a model other than OpenAI's, add `--provider ai-sdk` and name the AI SDK vendor package:

```bash
npx ai-translate init --provider ai-sdk --provider-package @ai-sdk/anthropic --model claude-sonnet-4
```

Suffix-keyed plurals are handled for you. English declares `items_one` and `items_other`; Polish files get `one`, `few`, `many`, and `other`, Japanese keeps just what it needs, and each added form is translated rather than left seeded in English.

### Starting from scratch

Create `ai-translate.config.ts` in your project root:

```ts
import { defineConfig } from "@ai-translate/cli";
import { createNamespaceJsonCatalog, createJsonStateStore } from "@ai-translate/fs-json";
import { createOpenAiTranslationProvider } from "@ai-translate/provider-openai";

export default defineConfig({
  sourceLocale: "en",
  targetLocales: ["de", "fr", "es"],

  catalogs: [
    createNamespaceJsonCatalog({
      id: "messages",
      rootDir: "content/messages",
      sourceLocale: "en",
    }),
  ],

  state: createJsonStateStore({ rootDir: process.cwd() }),

  provider: createOpenAiTranslationProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5.6-luna",
  }),

  context: {
    project: {
      product: "Acme",
      audience: "small business owners",
      tone: "direct, plain language",
    },
  },

  glossary: [{ source: "Acme", target: "Acme", note: "Never translate the brand name." }],
});
```

### Using a different model vendor

Every prompt, batch, retry, and validation step is vendor-neutral; only the last hop to the model is not. Swap `@ai-translate/provider-openai` for `@ai-translate/provider-ai-sdk` and any [AI SDK](https://ai-sdk.dev) model works — Anthropic, Google, Bedrock, Groq, xAI, a gateway, or a local model:

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { createAiSdkTranslationProvider } from "@ai-translate/provider-ai-sdk";

provider: createAiSdkTranslationProvider({
  model: anthropic("claude-sonnet-4"),
}),
```

Both packages are thin transports over the same engine in [`@ai-translate/provider-core`](packages/ai-translate-provider-core), so the generation contract, the repair loop, and the accepted-translation bookkeeping behave identically whichever you pick. Bringing your own vendor means implementing one method, `StructuredCompletionTransport.complete`.

With `content/messages/en/*.json` in place, run `npx ai-translate sync`. Translated files land next to the source (`content/messages/de/*.json`) and state is written to `.ai-translate/`. Commit both — the state file is what makes the next run cheap.

Then wire the gate into CI:

```yaml
- run: npx ai-translate check
```

## Commands

| Command | What it does |
| --- | --- |
| `init` | Detect localization resources, generate a config, and install project tooling. |
| `sync` | Translate everything that needs it, validate, audit, and write. |
| `check` | Read-only CI gate. Fails if validation, a dry-run sync, or audit provenance would produce work. |
| `validate` | Structural and source-level validation only, no provider calls. |
| `audit` | Run or refresh semantic audits over existing translations. |
| `new-locale <locale>` | Scaffold a new locale and translate it in one transaction. |
| `scaffold-locale <locale> --from <locale>` | Create the files for a locale without translating. |
| `adopt` | Seed state from translations an earlier tool already produced, so the first sync only fills real gaps. |

Every command accepts `--config` plus the scoping flags above. See the [CLI README](packages/ai-translate-cli/README.md) for the full flag reference.

## Packages

| Package | Purpose |
| --- | --- |
| [`@ai-translate/core`](packages/ai-translate-core) | The engine: reconciliation, state, validators, audits, and all shared types. |
| [`@ai-translate/cli`](packages/ai-translate-cli) | The `ai-translate` command, config loading, and staged transactions. |
| [`@ai-translate/fs-json`](packages/ai-translate-fs-json) | JSON catalog adapters, state stores, and the candidate cache. |
| [`@ai-translate/apple`](packages/ai-translate-apple) | Xcode string catalogs, Apple `.strings`, and native project discovery. |
| [`@ai-translate/integrations`](packages/ai-translate-integrations) | Platform-neutral project discovery and composable config plans. |
| [`@ai-translate/markdoc`](packages/ai-translate-markdoc) | Markdoc catalog adapter, including frontmatter and tag attributes. |
| [`@ai-translate/html`](packages/ai-translate-html) | HTML catalog adapter for text nodes and translatable attributes. |
| [`@ai-translate/keystatic`](packages/ai-translate-keystatic) | Localized singleton paths and locale seeds for Keystatic. |
| [`@ai-translate/message-formats`](packages/ai-translate-message-formats) | Apple printf, ICU, and i18next message formats, plus CLDR plural key strategies. |
| [`@ai-translate/next`](packages/ai-translate-next) | Next.js auto-discovery for next-intl and i18next, and config generation. |
| [`@ai-translate/provider-core`](packages/ai-translate-provider-core) | The vendor-neutral generation engine: prompting, batching, repair, and the output contract. |
| [`@ai-translate/provider-openai`](packages/ai-translate-provider-openai) | OpenAI translation and semantic-audit providers. |
| [`@ai-translate/provider-ai-sdk`](packages/ai-translate-provider-ai-sdk) | The same providers over the Vercel AI SDK, for Anthropic, Google, Bedrock, or any AI SDK model. |

Need a different format, a different model, or a different i18n library? `CatalogAdapter`, `TranslationProvider`, `SemanticAuditProvider`, `SyncStateStore`, `MessageFormat`, and `Integration` are plain interfaces, and everything shipped here is written against them.

## How a sync decides what to translate

1. Each catalog lists its source documents and loads them into addressable entries.
2. Path policies mark each entry `translate`, `copy`, or `exclude`.
3. The target document is reconciled against the source, so renamed or reordered keys keep their existing translations instead of being regenerated.
4. An entry is queued only if its source digest, resolved context digest, or generation revision no longer matches the recorded state — or if you forced it with `--force-retranslate`.
5. Queued entries are batched per locale and sent to the provider, with any glossary terms and context rules that apply.
6. Candidates are validated, optionally audited, and written atomically. State is updated in the same transaction.

## Benchmarks

Space, memory, and token cost are measured against both synthetic and real corpora, with a baseline guard in CI so a regression fails the build:

```bash
pnpm bench           # measure
pnpm bench:baseline  # record a baseline
pnpm bench:check     # fail on regression
```

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

The workspace development toolchain uses Node 24.20.0 (see [`.node-version`](.node-version)); published packages declare their own runtime requirements.

Releases use [changesets](https://github.com/changesets/changesets). Add one
with `pnpm exec changeset`, then version the release branch:

```bash
GITHUB_TOKEN="$(gh auth token)" pnpm release:version
```

The token is not optional — the changelog generator attributes each entry to its
commit and author, and fails the whole command without one. Nothing is published
locally: once the versioned changes reach `main`, the
[Release workflow](.github/workflows/release.yml) publishes from CI using the
`NPM_TOKEN` repository secret, with signed provenance. It can also be started by
hand from the Actions tab, which is the way to retry a release that failed for a
reason outside the tree.

## License

MIT © Thiago Peres
