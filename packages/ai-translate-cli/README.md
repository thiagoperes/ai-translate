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

Detects the project's localization resources and writes `ai-translate.config.ts`. This is the only command that runs without an existing config.

```bash
ai-translate init
ai-translate init --preview
ai-translate init --integration i18next
ai-translate init --integration apple --preview
```

Recognises **next-intl**, **i18next** (including Expo/React Native projects using `react-i18next`), and **Apple localization** (`.xcstrings` catalogs and `.lproj/*.strings` tables). Detection infers source and target languages from resources and Xcode settings and prints the evidence behind each conclusion. Multiple native resource roots become one configuration.

For an Xcode or Apple Swift package project without resources, `init` writes a starter config with explicit extraction instructions. Create and populate a String Catalog with Xcode, then configure your target languages. `init` does not extract hardcoded Swift, JavaScript, or Rust text and never invents target languages. Expo and Tauri projects without localization resources must externalize their text first.

Native configs use explicit file includes; an empty starter uses `include: []`.
After creating or repairing resources, review `init --preview` and update the
includes. Detection partitions mixed Base/source tables, reports neighboring
projects with different source languages, and excludes generated native output.

Custom detectors use the platform-neutral `@ai-translate/integrations` interfaces. Adapter plans declare the package, factory export, and literal options, so adding a platform does not require changing the CLI's config renderer. `@ai-translate/next` retains its existing detection APIs for compatibility.

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

Before committing, the CLI verifies that live files still match the snapshots it
staged. If a developer or Xcode saved a file during translation, the run aborts
without replacing those edits. Rerun to translate from the updated resources.

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
| `--check` | audit | Verify stored provenance without calling the provider. |
| `--refresh` | audit | Re-run audits even where provenance already exists. |
| `--from <locale>` | new-locale, scaffold-locale | Locale to seed from. |
| `--strategy <strategy>` | new-locale, scaffold-locale | Scaffolding strategy. |
| `--identical-to-source <adopt\|skip>` | adopt | What to do with target text identical to its source. Defaults to `adopt`. |
| `--help`, `-h` | | Print usage. |
| `--version`, `-v` | | Print the version. |

Flags accept both `--locale de` and `--locale=de`.

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
