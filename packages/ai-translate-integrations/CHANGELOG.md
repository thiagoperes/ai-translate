# @ai-translate/integrations

## 0.1.0

### Minor Changes

- [`73a3630`](https://github.com/thiagoperes/ai-translate/commit/73a363060564659139f7c995d762f57d579bd34a) Thanks [@thiagoperes](https://github.com/thiagoperes)! - Add native Xcode String Catalog and Apple strings-table adapters, Apple printf
  validation, and composable project discovery with Apple setup detection. Native
  catalogs preserve source text, metadata, and sibling locales while supporting
  incremental translation, plural variants, scoped updates, and CLI transactions.

  Carry adapter context and message tokens through translation, preserve adapter
  hooks through CLI staging, and use locale-specific source shapes consistently
  for validation, audits, and adoption. Existing Next.js discovery APIs remain
  available through compatibility exports. Document Swift package, shared
  iOS/macOS, and Expo/Tauri resource workflows.

  Validation now reports missing required plural arms in existing JSON catalogs;
  run sync to fill them. Preserve simultaneous manual target corrections and
  source edits under the default manual-origin policy.

  Abort staged commits when live localization files have changed during translation,
  preserving concurrent source and unrelated locale edits in shared resources.

  Harden automatic project detection for nested source-language declarations,
  mixed Base/source tables, literal filenames, Expo ignore rules, compiled bundles,
  and malformed catalogs. Generated native plans explicitly select discovered files.
  JSON detection skips empty layouts and missing declared sources, and reads literal
  locale settings conservatively without interpreting comments or computed code.

  Accept and preserve String Catalog versions 1.0–1.3, including current Xcode
  extraction output. Deduplicate canonical locale declarations and warn about
  ambiguous physical aliases. Preserve existing file permissions in direct native
  adapter writes. Verify compiler extraction, compiled bundle lookup, and native
  plural formatting alongside resource and CLI regression tests.
