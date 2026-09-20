# Native project smoke tests

Verified on 2026-09-20 with Xcode 27.0 (27A266a) and Apple Swift 6.4. The tests
read the current Swift sources and project metadata from the local app checkouts.
Extraction, generated configuration, translation state, compiled resources, and
runtime harnesses lived in temporary directories. No app files were changed.

The completed workspace validation passed 1,239 tests, with one pre-existing
optional Next.js fixture skipped. This round added 29 regression cases. Lint,
typechecking, builds, packed-package smoke tests, and coverage gates passed.
The Apple package has 98.02% line and 93.48% branch coverage.

## Real project inputs and results

| Project | Sources inspected | Extracted catalog | Translated entries |
| --- | --- | --- | --- |
| `translator-rn` / Hoioi | 132 Swift files in `native/HoioiKit`; native Xcode and Swift package metadata | 73 keys, including one intentionally skipped empty key | 216 across `fr`, `pl`, `ar` |
| `newsblocker` | 8 Swift files in `Shared/Views`; `NewsBlocker.xcodeproj` metadata | 40 keys | 120 across `fr`, `pl`, `ar` |

Apple's `xcstringstool extract --SwiftUI --modern-localizable-strings
--legacy-localizable-strings --output-format xcstrings` produced version 1.3
catalogs. This caught a compatibility defect in the original 1.0-only parser.
The adapter now accepts versions 1.0–1.3, retains their version, and continues
to validate the localization structure. Apple's compiler accepted all four
versions with the extracted Hoioi content.

For both projects, the smoke test:

1. Copied project metadata into an isolated directory and extracted real source
   text into the resource directory described in the [app guide](native-apps.md).
2. Ran the built CLI's `init` and verified its exact native file selection.
3. Selected French, Polish, and Arabic in the generated config and substituted
   a deterministic local provider, with no network translation requests.
4. Ran `sync --dry-run`, `sync`, `check`, and a second `sync`. Dry runs preserved
   the catalog bytes; the second sync translated zero entries and wrote no
   catalog changes. Original source localizations, metadata, and key sets survived.
5. Compiled the resulting catalogs with `xcstringstool compile`.
6. Loaded compiled resources through Foundation in a small native `.app` harness.
   All six project/language combinations resolved the expected text, including
   “Speak like a local” and “Private by design.”
7. Compared hashes of every inspected Swift file and project metadata file to
   confirm the smoke test had not changed its source inputs.

A separate Swift package harness used Hoioi's target name and resource layout,
`defaultLocalization`, `.process("Resources")`, and localized string lookup with
`bundle: .module`. It built successfully and resolved all three languages from a packaged
resource bundle after its build-directory resource fallback was removed. The
host app declared its supported languages, as a shipping app must.

These are resource and runtime plumbing tests. The provider mostly emitted
language-prefixed text, so the results do not measure translation quality. The
full Hoioi and NewsBlocker apps were not built or launched. Their checked-in
sources still need catalog creation, extraction review, target membership, and
explicit localization of stored strings. Lightweight extraction also leaves
unknown interpolation types as `%arg`; shipping catalogs need compiler extraction.

## Permanent regression coverage

The local app checkouts are not required for the repository test suite.

- `xcstrings-native.test.ts` invokes the installed lightweight extractor and the
  Swift compiler on representative SwiftUI source. It verifies detection,
  translation, source preservation, repeat sync, native compilation, and typed
  interpolation (`%@` and `%lld`). It also verifies that plain stored strings
  are absent from extracted resources.
- `xcstrings-runtime.test.ts` compiles translated plural resources into a real
  app bundle and checks Foundation's language selection and formatting. German
  and Polish cases include 1, 2, 5, 21, and 22, plus reordered named arguments.
- `detection-review.test.ts` adds canonical locale aliases, physical resource
  spelling, nested Expo ignore rules, Swift raw strings, and authored bundles.
- `files.test.ts` verifies existing native file permissions survive restrictive
  process umasks while new files keep normal umask behavior.

Run the focused checks on macOS with Xcode installed:

```sh
pnpm --filter @ai-translate/apple test
pnpm --filter @ai-translate/apple coverage
```

Native tool tests skip when their required Apple tools are unavailable; parser,
adapter, detection, and CLI tests remain portable. Full workspace validation is
`pnpm validate`, which also checks the built and packed packages in an isolated
consumer and executes generated native and web configurations.

## Architecture review

Three fresh independent passes reviewed architecture, detection, and native
resource behavior. Confirmed defects were corrected: Xcode 1.3 compatibility,
canonical locale collisions, and mode preservation in direct adapter writes.

The extension boundaries remain small: `CatalogAdapter` owns file structure and
merging, `MessageFormat` owns message syntax, and `Integration` describes
read-only detection and generated configuration. Core reconciliation, providers,
state, and CLI transactions serve every adapter. Future resource formats can
implement these contracts without introducing a platform-specific engine.
One source language per configuration and app-owned runtime wiring remain
deliberate boundaries.
