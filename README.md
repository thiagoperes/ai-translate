# ai-translate

**AI translation and localization for JSON, Markdoc, and HTML content — incremental, validated, and safe to run in CI.**

[![CI](https://github.com/thiagoperes/ai-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/thiagoperes/ai-translate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen.svg)](#install)

`ai-translate` is a TypeScript toolkit and CLI that keeps a multi-language website or app translated from a single source locale. You write content in one language; it works out which strings are new, changed, or no longer valid under the current translation contract, sends only those to an LLM, checks every candidate before it reaches disk, and records enough provenance that the next run can prove what is still current.

```bash
npx ai-translate sync --dry-run   # what would be translated, and why
npx ai-translate sync             # translate, validate, write
npx ai-translate check            # CI gate: fails if a locale is behind
```

## Features

- **Incremental by design.** Every entry stores a digest of its source text, its resolved context, and the contract that generated it. Change one heading and one heading is sent — not the file, not the locale.
- **Validated before anything is written.** Placeholder and tag parity, glossary and forbidden terms, preserved numbers, currencies, dates, and links, plus any validator you add.
- **Semantic audits.** An optional second model pass, forward and adversarial, catches meaning that was narrowed, broadened, omitted, or contradicted.
- **A CI gate that costs nothing.** `ai-translate check` runs validation, a dry-run sync, and a provenance check without calling the model or writing a byte, then exits non-zero if a locale is stale.
- **JSON, Markdoc, and HTML out of the box.** Nested namespace files, frontmatter, inline tokens and tag attributes, text nodes and translatable attributes.
- **Drop-in for Next.js.** `ai-translate init` detects next-intl or i18next, infers locales and message layout, and writes the config. ICU and i18next messages are validated as structures, and locale-specific plural forms are generated and translated.
- **Your manual edits survive.** A hand-corrected translation is recorded as `manual` and honoured on later runs instead of being silently overwritten.
- **Atomic runs.** Content files and translation state are committed in one transaction, so an interrupted or failing sync leaves the working tree untouched.
- **Work on a slice.** `--locale`, `--catalog`, `--unit`, and `--include-path` scope a run to exactly what you are changing.
- **Built for large catalogs.** Sharded state and locale-scoped loads hold a single-locale check to 7.9 MB of heap on a 246,000-entry corpus.
- **Pluggable end to end.** Catalog adapters, translation providers, audit providers, and state stores are plain TypeScript interfaces.

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

### Nothing is written without being checked

Deterministic validation runs first, then optional semantic audits. A candidate that fails is retried or quarantined, never silently shipped — so a bad generation costs you a retry, not a production string in a language you cannot read.

## Install

```bash
npm install --save-dev @ai-translate/cli @ai-translate/core @ai-translate/fs-json @ai-translate/provider-openai
```

Requires Node 20.19 or newer (Node 22+ for `@ai-translate/provider-openai`).

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
    model: "gpt-5.4",
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

With `content/messages/en/*.json` in place, run `npx ai-translate sync`. Translated files land next to the source (`content/messages/de/*.json`) and state is written to `.ai-translate/`. Commit both — the state file is what makes the next run cheap.

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
| `migrate-state --from startup-v1` | Import a legacy lock file into translation state. |

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
| [`@ai-translate/provider-openai`](packages/ai-translate-provider-openai) | OpenAI translation and semantic-audit providers. |

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

The workspace development toolchain uses Node 24.15.0 (see [`.node-version`](.node-version)); published packages declare their own runtime requirements.

Releases use [changesets](https://github.com/changesets/changesets): add one with `pnpm exec changeset`, run `pnpm release:version` on the reviewed release branch, and publishing happens from CI after the versioned changes reach `main`.

## License

MIT © Thiago Peres
