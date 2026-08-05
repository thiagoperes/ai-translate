# ai-translate

Keep a multi-locale site or app in sync from a single source locale, using an LLM to translate and a durable state file to decide what actually needs retranslating.

You author content in one language. `ai-translate` walks your catalogs, works out which strings are new, changed, or no longer valid under the current contract, sends only those to a translation provider, validates every candidate before it is written to disk, and records provenance so the next run can prove what is still current.

## Why this exists

Most "translate my JSON with an LLM" tools re-send everything on every run and trust whatever comes back. This one is built around two ideas:

**Nothing is translated twice without a reason.** Every translated entry stores a digest of its source text, its resolved context, and the generation contract that produced it. A run only touches entries whose inputs changed, and `--dry-run` tells you exactly what would be sent and why.

**Nothing is written without being checked.** Candidates pass deterministic validation first — placeholder and tag parity, glossary and forbidden terms, preserved numbers, currencies, dates and links, plus any validator you supply. Optional semantic audits then use a second model pass (forward and adversarial) to catch meaning that was narrowed, broadened, omitted, or contradicted. A candidate that fails is retried or quarantined, never silently shipped.

## Install

```bash
npm install --save-dev @ai-translate/cli @ai-translate/core @ai-translate/fs-json @ai-translate/provider-openai
```

Requires Node 20.19+ (Node 22+ if you use `@ai-translate/provider-openai`).

## Quickstart

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

With `content/messages/en/*.json` in place, run:

```bash
npx ai-translate sync --dry-run   # show what would be translated, and why
npx ai-translate sync             # translate, validate, and write
npx ai-translate check            # CI gate: fails if anything is out of sync
```

Translated files land next to the source (`content/messages/de/*.json`), and state is written to `.ai-translate/translation-state.json`. Commit both.

## Commands

| Command | What it does |
| --- | --- |
| `sync` | Translate everything that needs it, validate, audit, and write. |
| `check` | Read-only CI gate. Fails if validation, a dry-run sync, or audit provenance would produce work. |
| `validate` | Structural and source-level validation only, no provider calls. |
| `audit` | Run or refresh semantic audits over existing translations. |
| `new-locale <locale>` | Scaffold a new locale and translate it in one transaction. |
| `scaffold-locale <locale> --from <locale>` | Create the files for a locale without translating. |
| `migrate-state --from startup-v1` | Import a legacy lock file into translation state. |

Every command accepts `--config`, and the scoping flags `--locale`, `--catalog`, `--unit`, and `--include-path` so you can work on one slice at a time. See the [CLI README](packages/ai-translate-cli/README.md) for the full flag reference.

## Packages

| Package | Purpose |
| --- | --- |
| [`@ai-translate/core`](packages/ai-translate-core) | The engine: reconciliation, state, validators, audits, and all shared types. |
| [`@ai-translate/cli`](packages/ai-translate-cli) | The `ai-translate` command, config loading, and staged transactions. |
| [`@ai-translate/fs-json`](packages/ai-translate-fs-json) | JSON catalog adapters, state stores, and the candidate cache. |
| [`@ai-translate/markdoc`](packages/ai-translate-markdoc) | Markdoc catalog adapter, including frontmatter and tag attributes. |
| [`@ai-translate/html`](packages/ai-translate-html) | HTML catalog adapter for text nodes and translatable attributes. |
| [`@ai-translate/keystatic`](packages/ai-translate-keystatic) | Localized singleton paths and locale seeds for Keystatic. |
| [`@ai-translate/provider-openai`](packages/ai-translate-provider-openai) | OpenAI translation and semantic-audit providers. |

Catalog adapters and providers are plain interfaces (`CatalogAdapter`, `TranslationProvider`, `SemanticAuditProvider`, `SyncStateStore`), so you can supply your own for a format or model that isn't covered here.

## How a sync decides what to translate

1. Each catalog lists its source documents and loads them into addressable entries.
2. Path policies mark each entry `translate`, `copy`, or `exclude`.
3. The target document is reconciled against the source, so renamed or reordered keys keep their existing translations instead of being regenerated.
4. An entry is queued only if its source digest, resolved context digest, or generation revision no longer matches the recorded state — or if you forced it with `--force-retranslate`.
5. Queued entries are batched per locale and sent to the provider, with any glossary terms and context rules that apply.
6. Candidates are validated, optionally audited, and written atomically. State is updated in the same transaction.

Manual edits are respected: entries recorded with a `manual` origin follow `manualOriginPolicy`, so a hand-corrected translation is preserved rather than overwritten on the next run.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Releases use [changesets](https://github.com/changesets/changesets): add one with `pnpm exec changeset`, and publishing happens from CI on merge to `main`.

## License

MIT © Thiago Peres
