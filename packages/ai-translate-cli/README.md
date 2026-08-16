# @ai-translate/cli

The `ai-translate` command line interface. It loads your config, runs a sync, check, or audit, and prints a JSON report.

See the [project README](../../README.md) for what the toolkit does and how a sync decides what to translate.

## Install

```bash
npm install --save-dev @ai-translate/cli
```

Requires Node 20.19 or newer.

## Configuration

The CLI looks for the first of these in the current working directory, unless you pass `--config`:

```
ai-translate.config.ts
ai-translate.config.mts
ai-translate.config.js
ai-translate.config.mjs
```

TypeScript configs are loaded with [jiti](https://github.com/unjs/jiti), so no build step is needed. The file must default-export an object with at least `catalogs`, `provider`, `sourceLocale`, `state`, and `targetLocales`. Wrap it in `defineConfig` for type checking:

```ts
import { defineConfig } from "@ai-translate/cli";

export default defineConfig({
  sourceLocale: "en",
  targetLocales: ["de", "fr"],
  catalogs: [/* ... */],
  state: /* ... */,
  provider: /* ... */,
});
```

The full config surface is documented as types in [`@ai-translate/core`](../ai-translate-core), on the `AiTranslateConfig` interface.

### Reusing translations across documents

State makes a run skip work it has already done for *this* pointer in *this*
locale. The candidate cache is what stops you paying twice for the same English
string appearing in two places — a shared button label, a repeated heading, a
paragraph that moved between files. It is off by default and takes two settings:

```ts
import { createFileTranslationCandidateCache } from "@ai-translate/fs-json";
import { TRANSLATION_OUTPUT_CONTRACT_REVISION } from "@ai-translate/provider-openai";

export default defineConfig({
  // ...
  generationRevision: TRANSLATION_OUTPUT_CONTRACT_REVISION,
  candidateCache: {
    store: createFileTranslationCandidateCache({ rootDir: process.cwd() }),
  },
});
```

`generationRevision` states which generation contract your stored translations
came from, so a prompt or schema change that alters output retranslates instead
of being served from cache. Pinning it to the provider's exported contract
revision keeps that automatic.

Nothing else is needed: the cache keys itself on the model and vendor the
provider reports, so changing `model` invalidates the cache on its own rather
than quietly serving the previous model's output. Set `candidateCache.identity`
only for a custom provider that cannot report one.

The cache writes one file per candidate at roughly 900 bytes, so a small project
can commit `.ai-translate/candidate-cache/` and share hits across CI runs. Do not
commit it at scale: a million candidates is a million files and over a gigabyte,
which no repository handles well. Add it to `.gitignore` and restore it between
CI runs with your runner's cache instead — it is derived data, and a cold cache
costs model calls rather than correctness.

State is the opposite: it is small, it is the record of what is current, and it
belongs in the repository.

### Environment variables

Before every command the CLI loads, in order and without overriding anything already set in the environment:

```
.env
.env.local
.env.$NODE_ENV
.env.$NODE_ENV.local
```

This is how a provider API key normally reaches your config, for example `apiKey: process.env.OPENAI_API_KEY`.

## Commands

### `init`

Detects the project's Next.js localization setup and writes `ai-translate.config.ts` for it. This is the only command that runs without an existing config.

```bash
ai-translate init
ai-translate init --preview
ai-translate init --integration i18next
```

Recognises **next-intl** and **i18next** (including `react-i18next` and `next-i18next`), inferring the message layout, the locale list, and the source locale, then printing the evidence behind each conclusion.

It writes exactly one file and nothing else. Installing packages, setting `OPENAI_API_KEY`, and reviewing the model choice are printed as next steps rather than done for you, so running it against an unfamiliar repository is safe.

| Flag | Effect |
| --- | --- |
| `--preview` | Print the config that would be written and touch nothing. |
| `--integration <id>` | Choose between setups when a project matches more than one. |
| `--force` | Overwrite an existing `ai-translate.config.ts`. Refuses without it. |

Exits non-zero when nothing is recognised, when a named integration was not detected, or when a config already exists and `--force` was not passed.

### `sync`

Translates everything that needs it, validates each candidate, runs semantic audits if configured, and writes the results.

```bash
ai-translate sync
ai-translate sync --dry-run
ai-translate sync --locale de --catalog messages
```

Writes happen inside a staged transaction: files and state are committed together only if the run converges, so an interrupted or failing sync leaves your content untouched. When semantic audits reject a translation, the run retries it up to `validation.semanticRepairAttempts` times before failing.

Exits non-zero if any entry failed, if audits did not converge, or if a `--dry-run` exceeded the configured `validation.dryRunBudget`.

### `check`

The CI gate. Runs validation, a dry-run sync, and an audit provenance check, and refuses to write anything — the state store is swapped for a read-only snapshot for the duration.

```bash
ai-translate check
ai-translate check --locale de
```

Exits non-zero if validation reports an error, if a sync would have work to do, or if audit provenance is missing or stale. The error message tells you which: run `ai-translate sync` for pending content, `ai-translate audit --refresh` for stale audits.

### `validate`

Structural and source-level validation with no provider calls. Reports source document counts, target locales, and any issues.

```bash
ai-translate validate
```

### `audit`

Runs the configured semantic audits over existing translations.

```bash
ai-translate audit            # audit anything not already covered
ai-translate audit --check    # verify stored provenance only, no provider calls
ai-translate audit --refresh  # re-run audits even where provenance exists
```

### `new-locale <locale>`

Scaffolds the files for a new locale and translates it, in a single transaction.

```bash
ai-translate new-locale pt
ai-translate new-locale pt --from es --strategy copy-locale-and-retranslate
```

`--from` defaults to the source locale and `--strategy` to `copy-source`. Strategies are `copy-source`, `copy-locale`, `copy-locale-and-retranslate`, and `empty`; anything other than `copy-source` requires `--from` to be an already-translated locale. With `--dry-run`, only `--from <sourceLocale>` and `--strategy copy-source` are supported.

### `scaffold-locale <locale> --from <locale>`

Creates the files for a locale without translating anything. Defaults to `--strategy copy-locale`.

### `adopt`

One-time migration from whatever tool translated your catalogs before this one. It reads the catalogs themselves and records every existing translation as state, so the first `sync` afterwards only translates what is genuinely missing instead of redoing the whole corpus.

Because catalogs carry no evidence of who wrote their text, every adopted entry is recorded with an origin of `legacy-unknown`. What happens to those entries later is up to `legacyOriginPolicy` in your config, and the choice matters more than it looks:

| Policy | First sync after adopting | Once English changes |
| --- | --- | --- |
| `preserve` (default) | Nothing. | The entry is reported as stale rather than retranslated, so `check` fails and a human decides. |
| `validate-existing` | Runs the deterministic validators over the existing text, no model calls, and promotes surviving entries to `generated`. | Retranslated automatically, like any other entry. |
| `retranslate` | Regenerates every adopted entry under the current contract. | Retranslated automatically. |

`validate-existing` is the one you want for a migration. It costs no model calls, it checks the inherited text instead of trusting it, and it graduates the corpus into normal behaviour in a single pass — otherwise every adopted entry keeps acting like a hand-written override and your next copy edit turns into a CI failure instead of a translation. Expect that first pass to surface a punch list of pre-existing problems; that is the validators doing their job.

A source string with no target text, or an empty one, is left out of state entirely so the next sync still picks it up.

Target text byte-identical to the source is ambiguous — it is either a correct translation that happens to match (`Excel`, or `Status` in German) or a placeholder from a pipeline that backfilled missing keys with English. `--identical-to-source adopt` is the default and keeps it; `skip` leaves those entries to the next sync. The command reports the count either way, so start with `--dry-run` and decide from the number.

```bash
ai-translate adopt --dry-run
ai-translate adopt
```

## Flags

| Flag | Commands | Meaning |
| --- | --- | --- |
| `--config <path>` | all | Path to the config file instead of auto-discovery. |
| `--locale <locale>` | sync, check, audit, validate | Limit to a locale. Repeatable. |
| `--catalog <id>` | sync, check, audit, validate | Limit to a catalog. Repeatable. |
| `--unit <id>` | sync, check, audit, validate | Limit to a document unit. Repeatable. |
| `--include-path <pointer>` | sync, check, audit, validate | Limit to exact JSON pointers; everything else is left untouched. Repeatable. |
| `--dry-run` | sync, new-locale, adopt | Plan the work and report it without writing. |
| `--force-retranslate` | sync | Retranslate the selected scope even when state is current. |
| `--force-retranslate-path <pointer>` | sync | Force retranslation of specific pointers. Repeatable. |
| `--max-pending-translations <n>` | sync, check | Abort before any provider call if the scope would translate more than `n` entries. |
| `--concurrency <n>` | sync, check, audit, validate | Documents to work on at once, overriding `concurrency.documents`. See [Concurrency](#concurrency). |
| `--check` | audit | Verify stored provenance without calling the provider. |
| `--refresh` | audit | Re-run audits even where provenance already exists. |
| `--from <locale>` | new-locale, scaffold-locale | Locale to seed from. |
| `--strategy <strategy>` | new-locale, scaffold-locale | Scaffolding strategy. |
| `--identical-to-source <adopt\|skip>` | adopt | What to do with target text identical to its source. Defaults to `adopt`. |
| `--help`, `-h` | | Print usage. |
| `--version`, `-v` | | Print the version. |

Flags accept both `--locale de` and `--locale=de`.

## Concurrency

Two separate limits decide how fast a run goes, and the lower one wins.

**How many documents the engine works on at once** — `concurrency.documents` in
the config, or `--concurrency <n>` for a single run. Defaults to 4. This governs
everything the run does locally: reading sources, reconciling targets, preparing
entries, dispatching batches, writing results. It is the number to raise on a
large corpus, where the run spends most of its time on file I/O.

**How many requests reach the model at once** — `concurrentRequests` on the
provider. Defaults to 6, and is shared across every batch in flight:

```ts
provider: createOpenAiTranslationProvider({
  apiKey: process.env.OPENAI_API_KEY,
  concurrentRequests: 64,
  model: "gpt-5.6-luna",
}),
```

Raising only the first will not push more work through the model, and raising
only the second will not help a run still reading one file at a time. Pick the
provider number against your rate limit and the document number against your
disk, and raise both.

Note that a state store's lock is held for the whole run, so two syncs cannot
share one `.ai-translate` directory concurrently. Split large jobs by locale
across separate checkouts rather than separate processes.

## Output and exit codes

Every command prints a JSON report to stdout — sync metrics, validation issues, audit counts — and errors to stderr. Exit code is `0` on success and `1` on any failure, which makes `ai-translate check` usable directly as a CI step.

A dry-run sync also reports `pendingTranslationReasons`, a count of why each entry was selected. That is the fastest way to understand an unexpectedly large run.

## Programmatic use

```ts
import { runCli, loadConfig, findConfigPath, defineConfig } from "@ai-translate/cli";

const exitCode = await runCli(["sync", "--dry-run"], process.cwd());
```

## License

MIT © Thiago Peres
