# ai-translate

**AI-powered localization for JSON, Markdoc, HTML, and Next.js content — incremental, validated, and built for CI.**

[![CI](https://github.com/thiagoperes/ai-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/thiagoperes/ai-translate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen.svg)](#install)

`ai-translate` is a TypeScript toolkit and CLI for keeping every locale in sync with a single source locale. It detects only new or changed content, sends just that work to your translation provider, validates every candidate before writing it, and records provenance so CI can prove translations are current—without retranslating unchanged content or overwriting human corrections.

Key features:

| | |
| --- | --- |
| ⚡ **Incremental** | Translate only new or changed strings. |
| 🛡️ **Validated** | Protect placeholders, tags, glossary terms, and structure. |
| ✅ **CI-ready** | Catch stale locales with a read-only `check`. |
| 🧩 **Flexible** | Supports JSON, Markdoc, HTML, ICU, i18next, and Next.js. |
| ✍️ **Human-friendly** | Preserve manual edits with atomic writes. |
| 📈 **Scalable** | Use sharded state, scoped runs, and pluggable providers. |
| 💸 **Cheap** | Around [$1 per million source words, per locale](#what-it-costs). |

```bash
npx ai-translate sync --dry-run   # what would be translated, and why
npx ai-translate sync             # translate, validate, write
npx ai-translate check            # CI gate: fails if a locale is behind
```

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

A glossary costs nothing it does not earn. Each call carries only the terms that appear in the strings it is translating, so a 500-term glossary and no glossary at all bill the same for a batch that uses neither — 16.6 tokens per key at 100 keys per call, against 95.7 if all 500 terms rode along.

Repeated source text is worth paying for once. State stops a pointer being retranslated; the [candidate cache](packages/ai-translate-cli/README.md#reusing-translations-across-documents) stops the same English string being translated twice because it appears in two files. It is two lines of config and keys itself on the model your provider reports, so switching models invalidates it rather than serving the old one's output.

Token counts are measured by capturing the payloads the provider actually sends at stock defaults, the same method as [`bench/prompt.bench.mjs`](bench/prompt.bench.mjs), rather than estimated from the prompt source. Prices are the published rate cards as of 2026-08-07 and will drift; re-check them before quoting a budget.

## Install

```bash
npm install --save-dev @ai-translate/cli @ai-translate/core @ai-translate/fs-json @ai-translate/provider-openai
```

Requires Node 20.19 or newer. The provider packages need Node 22+, because the
`openai` and `ai` SDKs they wrap do.

## Quickstart

### Already using Next.js?

```bash
npx ai-translate init
```

`init` inspects the project, works out whether it uses **next-intl** or **i18next**, finds the message files, reads the locale list and the default locale, and writes an `ai-translate.config.ts` wired to what it found. It prints the evidence for every conclusion, and writes nothing else — installing packages and setting `OPENAI_API_KEY` stay in your hands.

```text
Detected i18next:
  - i18next, react-i18next declared as dependencies (package.json)
  - i18next settings module (lib/i18n/i18n.settings.ts)
  - 28 namespace file(s) across 16 locales (public/locales/en)
  - Source locale en, 15 target locale(s): de, el, es, et, fi, fr, ga, hr, it, lt, lv, nl, pt, sk, sl
```

Use `--preview` to see the config without writing it, and `--integration <id>` if the project runs more than one library. Detection is read-only and never imports project code; see [`@ai-translate/next`](packages/ai-translate-next) to add your own integration.

To generate a config that runs on a model other than OpenAI's, add `--provider ai-sdk` and name the AI SDK vendor package:

```bash
npx ai-translate init --provider ai-sdk --provider-package @ai-sdk/anthropic --model claude-sonnet-4
```

Suffix-keyed plurals are handled for you. English declares `items_one` and `items_other`; Polish files get `one`, `few`, `many`, and `other`, Japanese keeps just what it needs, and each added form is translated rather than left seeded in English.

### Starting from scratch

Create `ai-translate.config.ts` in your project root:

```ts
import { defineConfig } from "@ai-translate/cli";
import { createNamespaceJsonCatalog, createShardedJsonStateStore } from "@ai-translate/fs-json";
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

  state: createShardedJsonStateStore({ rootDir: process.cwd() }),

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

With `content/messages/en/*.json` in place, run `npx ai-translate sync`. Translated files land next to the source (`content/messages/de/*.json`) and state is written to `.ai-translate/`. Commit both — the state is what makes the next run cheap.

State is written as one small file per document, so it stays reviewable and stays inside what a repository will accept: 1.5M records across 5,000 documents is 255 MB spread over 5,000 files, none larger than 0.1 MB, and a run that changes one document rewrites exactly one of them. `createJsonStateStore` keeps everything in a single file instead, which is simpler for a small project but reaches 183 MB at 247k records — past what GitHub will accept in a push — so it refuses to write a file that large rather than let you discover it at push time.

Then wire the gate into CI:

```yaml
- run: npx ai-translate check
```

## Commands

| Command | What it does |
| --- | --- |
| `init` | Detect a Next.js localization setup and write `ai-translate.config.ts` for it. |
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
| [`@ai-translate/markdoc`](packages/ai-translate-markdoc) | Markdoc catalog adapter, including frontmatter and tag attributes. |
| [`@ai-translate/html`](packages/ai-translate-html) | HTML catalog adapter for text nodes and translatable attributes. |
| [`@ai-translate/keystatic`](packages/ai-translate-keystatic) | Localized singleton paths and locale seeds for Keystatic. |
| [`@ai-translate/message-formats`](packages/ai-translate-message-formats) | ICU and i18next message formats, plus CLDR plural key strategies. |
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

## Scaling a run

Two limits decide throughput, and the lower one wins: `concurrency.documents`
(default 4) bounds how many documents the engine works on at once — every local
phase, from reading sources to writing results — and the provider's
`concurrentRequests` (default 6) bounds how many requests reach the model. Raise
both; raising one alone moves the bottleneck rather than removing it. A single
run can override the first with `--concurrency <n>`.

On 800 source documents across 4 locales, going from 1 to 64 takes a sync from
15.2s to 2.5s of engine time. See the [CLI README](packages/ai-translate-cli/README.md#concurrency)
for how the two interact.

## Benchmarks

Space, memory, token cost, and throughput are measured against both synthetic and real corpora, with a baseline guard in CI so a regression fails the build:

```bash
pnpm bench           # measure
pnpm bench:baseline  # record a baseline
pnpm bench:check     # fail on regression
```

`bench/throughput.bench.mjs` reports where a sync's wall clock goes — catalog
scan, document write, state load and write — against a provider of known latency,
so an engine-side regression is visible separately from model time:

```bash
node bench/throughput.bench.mjs --documents 800 --locales 4 --concurrency 64
```

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

The workspace development toolchain uses Node 24.15.0 (see [`.node-version`](.node-version)); published packages declare their own runtime requirements.

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
