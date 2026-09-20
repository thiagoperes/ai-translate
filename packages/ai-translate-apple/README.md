# @ai-translate/apple

Native Apple localization resources for ai-translate. Works with SwiftUI, UIKit,
AppKit, Swift packages, and any application that loads Apple string resources.

```bash
npm install --save-dev @ai-translate/apple @ai-translate/cli @ai-translate/fs-json @ai-translate/provider-openai
```

Requires Node 20.19+. Resource translation runs on any supported operating
system; Xcode resource extraction and app compilation require Apple's tools.

## Xcode string catalogs

```ts
import { createAppleStringCatalog } from "@ai-translate/apple";

const native = createAppleStringCatalog({
  id: "native",
  rootDir: "Shared/Resources",
  sourceLocale: "en",
  // Optional globs relative to rootDir:
  include: ["**/*.xcstrings"],
});
```

Add this adapter to your configuration's `catalogs` array. Every `.xcstrings`
file is one document unit, named by its relative path without the extension;
every locale writes to the same physical file. The source language must match
`sourceLocale`. Discovery excludes common build/dependency directories.

Only string-unit values are translated. Source text falls back to the key when
there is no explicit source localization. Comments and variant context reach
the provider. Metadata, source content, unrelated locales, and nontranslatable
entries are preserved. Empty keys, `shouldTranslate: false`, and stale extracted
entries are skipped. String Catalog versions 1.0–1.3 are supported and preserved,
including the version emitted by Xcode 27. Unknown versions and unsupported
localization structures fail explicitly.

Plural/device variants and substitutions are supported. Target plural categories
are expanded from the source fallback; existing authored categories remain.
Apple printf tokens are protected automatically. Xcode `new` and `needs_review`
values remain pending; accepted generated values are marked `translated`.
Scaffolded values are marked `new` and still require a sync.

Existing locale-specific device and plural variants may vary a plain source
message. Named substitutions require matching definitions in the source
localization: a target-only `%#@count@` fragment cannot be safely inferred from
a flat source such as `Found %lld birds`. The adapter reports the affected key
and substitution before translation. Define the corresponding source
substitution in Xcode, including its plural fragments, then sync again.
Named substitutions may reorder in translations: their source `argNum` bindings
keep each reference attached to the same runtime argument. Ordinary printf
arguments still require compatible types and explicit positions when reordered.

For literal percentages that resemble format directives, such as `100% done`,
set `plainTextKeys: ["progress"]` on either Apple adapter, using the exact
resource lookup key. Those keys use the core plain message format; every other
key keeps printf protection. The setting applies to all variants of a catalog
key and to matching keys in every table selected by that adapter. Use it only
for messages without runtime printf arguments or named substitutions: literal
text and directives cannot be distinguished reliably from their spelling.

Paths for `--include-path` are locale-independent JSON pointers, for example
`/welcome/stringUnit/value` or
`/items/variations/plural/few/stringUnit/value`. Escape key slashes as `~1` and
tildes as `~0`. A path-scoped run requires an existing target document; first
scaffold it or perform an initial full sync. Seeding a new structured message may
create required fallback arms marked `new`; those are not accepted translations.

## Legacy strings tables

```ts
import { createAppleStringsCatalog } from "@ai-translate/apple";

const tables = createAppleStringsCatalog({
  id: "legacy",
  rootDir: "App/Resources", // contains en.lproj, de.lproj, ...
  sourceLocale: "en",
  // sourceLocaleDirectory: "Base.lproj",
  // include: ["Localizable.strings", "InfoPlist.strings"],
});
```

Units are table paths relative to the source `.lproj` directory, including the
`.strings` suffix. Entry paths are `/<key>`. The adapter handles UTF-8 with or
without BOM and UTF-16 in either byte order. It preserves existing formatting,
comments, encoding, and unrelated target keys; it rejects ambiguous duplicate
keys and malformed syntax. Key-only entries (`"Hello";`) and optional dictionary
braces are supported. Apple printf validation is automatic here too.

## Discovery and composition

`ai-translate init --integration apple --preview` inspects native resources,
Xcode projects, and Apple Swift packages without executing project code. Projects
without catalogs receive explicit extraction/setup warnings. `init` writes only
the configuration; it does not edit Xcode projects or extract hardcoded text.

Generated configs list the authored files found during detection. Mixed
`Base.lproj` and source-locale tables are partitioned without translating the
same table twice. Nested projects with another declared source language are
reported for separate configuration. Expo native trees follow their ancestor
ignore rules; compiled app/framework bundles and build folders are excluded.

When no usable resources exist, the starter has `include: []`. After adding or
repairing resources, run `init --preview` and update the include lists from its
output. Legacy directory names such as `French.lproj` or `pt_BR.lproj` need
manual setup or migration to language tags such as `fr` and `pt-BR`.

`appleIntegration` implements the platform-neutral `Integration` interface from
`@ai-translate/integrations`. Both adapters implement `CatalogAdapter`, so they
compose with existing JSON, HTML, or Markdoc adapters and every provider.

Use the [native app guide](../../docs/native-apps.md) for a full configuration and
specific Swift package, shared iOS/macOS, Expo, and Tauri setup recipes. For Expo
prebuild, translate committed locale JSON using `applePrintfMessageFormat` from
`@ai-translate/message-formats`; preserve generated iOS resources through Expo's
own build workflow.

The CLI stages resource and state writes together. It checks for changes to live
files before committing and aborts if they were edited during translation; rerun
to use those edits. Use `sync --dry-run` to plan,
`adopt` to migrate existing translations, and `check` as a read-only CI gate.
Direct programmatic adapter writes are atomic per file, not across an entire
configuration; use the CLI when you need the transaction guarantee.

Legacy `.stringsdict`, XLIFF, source rewriting, and runtime lookup installation
are outside this package. Xcode can migrate legacy plural files into string
catalogs. Runtime layout and bundle membership still need app-level validation.
