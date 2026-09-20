# Translating native and cross-platform apps

`ai-translate` translates localization resources and maintains their provenance.
Xcode, Swift, Expo, and your JavaScript/Rust runtime remain responsible for
extracting text and selecting the correct language at runtime.

## Automatic setup

From the app root, run `npx ai-translate init`. The command detects authored native,
Expo, and web localization resources; combines compatible catalogs; installs the
required packages; and creates the config, translation scripts, and API-key template.
It uses the existing package manager. A Swift-only project gets a private tooling
`package.json`. Use `--preview` for a read-only plan or `--no-install` to prepare files
offline. Existing resource files and runtime code are preserved.

Set the provider key in your shell or `.env.local`. Target languages are read from
the project; supply `--locale fr --locale pl` if they have not been declared yet.
Projects with hardcoded text still need the extraction and runtime steps below.
After extracting resources, review `init --preview` and rerun with `--force` to
refresh the generated config.

## Choose the resource boundary

| Surface | Resource | Adapter / message format |
| --- | --- | --- |
| SwiftUI, UIKit, AppKit | Xcode `.xcstrings` | `createAppleStringCatalog` |
| Existing native resources | `<locale>.lproj/*.strings` | `createAppleStringsCatalog` |
| Expo permissions and native labels | Committed `expo.locales` JSON | `createLocalizedJsonDocument` + `applePrintfMessageFormat` |
| Shared React Native / web / Tauri UI | Locale JSON loaded by the app | JSON adapter + the runtime's message format, such as i18next |

These adapters share `CatalogAdapter`, state, providers, scoping, validation,
and the CLI transaction. There is no separate native translation engine.
Catalogs with different source languages should use separate configurations.

The [design references](native-design-notes.md) compare these boundaries with
Xcode, Expo, SwiftGen, Weblate, Flutter, and Android resource tooling.
The [smoke test report](native-smoke-tests.md) records real Swift project
extraction, native compilation, bundle lookup, and the permanent regressions.

`init --preview` discovers authored files without running project code. It
validates catalog structure, respects nested project source-language declarations,
and excludes generated Expo trees and compiled native bundles. Different source
languages require separate configs; the preview identifies excluded projects.
Generated include lists select the files that were found, including tables split
between `Base.lproj` and a source locale. After adding resources, review another
preview and update those lists. A project with no usable resources starts with
`include: []` and extraction instructions.

Locale declarations are compared canonically, so `en` and `EN` cannot become
separate source and target languages. Generated configs preserve existing
resource spelling. If multiple resource spellings identify the same locale
(for example `fr` and `FR`, or `he` and `iw`), detection warns and omits that
target until the resource names are normalized. Ambiguous source directories
are also excluded; preview warnings identify the affected resources.

## Xcode string catalogs

Create `Localizable.xcstrings` in Xcode and add it to each target that uses it.
Build with localization extraction enabled so compiler-supported SwiftUI
literals and `String(localized:)` calls populate the catalog. Add languages to
the project and review source strings, comments, plural forms, and target
membership before syncing. Use `InfoPlist.xcstrings` for localized app metadata
such as camera and microphone permission descriptions.

Catalog versions 1.0–1.3 are supported without rewriting their version. Apple's
lightweight `xcstringstool extract` can help inventory SwiftUI text, but it may
emit `%arg` when interpolation types are unknown. Use compiler extraction before
shipping so native runtime arguments have their actual types. Ordinary stored
strings still need explicit localization, as described below.

```ts
import { defineConfig } from "@ai-translate/cli";
import { createAppleStringCatalog } from "@ai-translate/apple";
import { createJsonStateStore } from "@ai-translate/fs-json";
import { createOpenAiTranslationProvider } from "@ai-translate/provider-openai";

export default defineConfig({
  sourceLocale: "en",
  targetLocales: ["de", "fr", "pl", "ja"],
  catalogs: [createAppleStringCatalog({
    id: "native",
    rootDir: "Shared/Resources",
    sourceLocale: "en",
  })],
  state: createJsonStateStore({ rootDir: process.cwd() }),
  provider: createOpenAiTranslationProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5.6-luna",
  }),
});
```

The adapter reads the source localization when present and otherwise uses the
catalog key as the source text. It translates string-unit values, including
plural/device variants and substitution values. Keys and native metadata stay
outside the translation request. Comments and variant context guide the model.
`shouldTranslate: false` entries and stale extracted entries are skipped.
Unsupported or malformed resource structures fail explicitly.

Use native plural variations for counts. The adapter adds the target language's
CLDR categories from the source `other` arm where necessary. It preserves
authored source categories, including when the target language uses fewer forms.
Placeholders such as `%@`, `%lld`, `%1$@`, `%%`, and `%#@count@` are protected and
validated. Positional arguments may reorder only when their types and argument
identities remain compatible.

Literal percentages can resemble printf directives: `100% done` contains the
valid directive `% d`. For messages used as plain text, add the exact lookup key
to the adapter's `plainTextKeys`, for example `plainTextKeys: ["progress"]`.
Both Apple adapters support this option; other keys retain printf validation.
Do not list messages that receive runtime format arguments or substitutions.

Xcode permits a target locale to introduce a named substitution even when its
source is flat text. This adapter requires the corresponding substitution in
the source localization, because it cannot infer fragment meanings safely.
For example, if German uses `%#@birds@ entdeckt` while English is
`Found %lld birds`, define the source `birds` substitution and its plural
fragments in Xcode before syncing. Otherwise the adapter reports the key and
substitution before provider calls and leaves the resource unchanged.
Once source bindings exist, named references may reorder naturally in the
translation. For example, `%#@animals@ and %#@birds@` can become
`%#@birds@ und %#@animals@`; the catalog's `argNum` metadata preserves argument
identity. Standalone `.strings` and JSON printf messages still need positional
arguments for reordering.

Run from the directory containing the config:

```bash
npx ai-translate sync --dry-run
npx ai-translate sync
npx ai-translate check
```

Commit the catalogs and `.ai-translate/` state. If translations already exist,
review `ai-translate adopt --dry-run` first; use `legacyOriginPolicy:
"validate-existing"` to validate and migrate accepted translations into the
incremental workflow. `check` and dry runs are read-only.

For additional native verification on macOS:

```bash
mkdir -p /tmp/ai-translate-compiled
xcrun xcstringstool compile Shared/Resources/Localizable.xcstrings \
  --output-directory /tmp/ai-translate-compiled
```

Then build and launch each app target in representative languages, including a
language with more plural forms and an RTL language. Resource compilation proves
format validity; it does not prove bundle lookup, target membership, or layout.

### Ordinary Swift strings need explicit localization

Compiler extraction cannot make arbitrary stored `String` values localizable.
`Text(variable)` displays a plain string. Localize it at its declaration or use
a localized resource type supported by the receiving API:

```swift
let title = String(localized: "Speak like a local")
Text(title)
```

Keep identifiers, SF Symbol names, URLs, domain names, and user-generated content
as ordinary strings. Avoid concatenating fragments to make a localized sentence;
use a complete message with interpolation instead.

## `translator-rn`: Hoioi's native Swift package

The native project is `native/HoioiNative.xcodeproj`; shared UI lives in the
`HoioiKit` target declared by `native/Package.swift`. At inspection it had no
checked-in localization catalogs, despite preferring string catalogs in Xcode.

1. Add `native/HoioiKit/Resources/Localizable.xcstrings` and extract/review UI text.
2. Add `defaultLocalization: "en"` to the `Package` declaration, and
   `resources: [.process("Resources")]` to the `HoioiKit` target.
3. Resolve package strings from the resource bundle:
   `String(localized: "Speak like a local", bundle: .module)` or
   `Text("Speak like a local", bundle: .module)` inside that package.
4. Point the adapter at `native/HoioiKit/Resources` when the config is at the
   repository root. Add a separate app-target catalog for `Info-iOS.plist`
   permission descriptions; those belong to the app bundle.
5. Review stored strings such as sheet titles and onboarding button labels, and
   replace hand-built singular/plural labels with native plural resources.

Keep `Hoioi` and `Hoioi Plus` in the glossary or mark brand-only entries
nontranslatable. Build both iOS and macOS through the repository's existing
workflow to verify shared package resources.

The app target must also declare its supported languages. Foundation selects
package languages in coordination with the main app; setting a formatting
locale does not independently select the package's localization.

## `newsblocker`: shared iOS and macOS targets

The project is `NewsBlocker.xcodeproj`, with UI in `Shared/Views`. At inspection,
it had no checked-in localization catalogs.

Create `Shared/Resources/Localizable.xcstrings`, include it in both app targets,
and use that directory in the configuration above. Review `WelcomeSlide` and
`WizardStep` stored title/detail/action strings: the plain `Text(slide.title)`
pattern needs explicit localized values. Keep `BlockTheNews`, `Safari`, and
example domain names intact. The Safari extension's HTML/JavaScript is another
resource surface; add its own catalog and runtime lookup rather than assuming
the app's Swift catalog covers it.

## `tools`: Expo native metadata plus shared UI

`tools` currently has hardcoded React Native UI, Rust Tauri menus, and native
module strings. Its `/ios/` and `/android/` trees are generated. Keep translation
inputs in committed source files so prebuild cannot erase them.

For native permissions, create `locales/native/en.json`:

```json
{
  "ios": {
    "NSPhotoLibraryUsageDescription": "Beauty needs access to your photos so you can place them into a document. Images stay on this device.",
    "Localizable.strings": {
      "notification.body": "%@ shared a document"
    }
  },
  "android": {
    "app_name": "Beauty"
  }
}
```

Map those files in Expo's app configuration, adding each target locale. `init` reads these mappings automatically, including filenames that differ from the locale name:

```json
{
  "expo": {
    "locales": {
      "en": "./locales/native/en.json",
      "de": "./locales/native/de.json"
    }
  }
}
```

Expo consumes the `ios` dictionary to generate `InfoPlist.strings` and the
optional `Localizable.strings` dictionary at prebuild. The same JSON can carry
Android metadata. Follow the app's existing native build wrapper after syncing.

Compose native metadata and shared i18next messages in one config:

```ts
import { defineConfig } from "@ai-translate/cli";
import { createLocalizedJsonDocument, createNamespaceJsonCatalog, createJsonStateStore } from "@ai-translate/fs-json";
import { applePrintfMessageFormat, i18nextMessageFormat, i18nextPluralKeys } from "@ai-translate/message-formats";
import { createOpenAiTranslationProvider } from "@ai-translate/provider-openai";

export default defineConfig({
  sourceLocale: "en",
  targetLocales: ["de"],
  catalogs: [
    createLocalizedJsonDocument({
      id: "native-metadata",
      rootDir: "locales/native",
      unitId: "permissions",
      sourceLocale: "en",
      messageFormat: applePrintfMessageFormat,
    }),
    createNamespaceJsonCatalog({
      id: "ui",
      rootDir: "locales/ui",
      sourceLocale: "en",
      messageFormat: i18nextMessageFormat,
      plurals: i18nextPluralKeys,
    }),
  ],
  glossary: [{ source: "Beauty", target: "Beauty" }],
  state: createJsonStateStore({ rootDir: process.cwd() }),
  provider: createOpenAiTranslationProvider({ apiKey: process.env.OPENAI_API_KEY }),
});
```

Create `locales/ui/en/common.json`, externalize UI/accessibility labels, and load
the resulting files through the chosen JavaScript localization runtime. Tauri
can share this UI resource layer; Rust menus still need their own lookup wiring.
Native Swift modules use their own bundled Apple resources. `ai-translate` does
not install an app runtime or rewrite Swift, TSX, Rust, or generated native code.

## Add another platform

Implement `CatalogAdapter` for file storage and `MessageFormat` for message
syntax. Keep their responsibilities independent. An adapter can expose several
logical documents per physical file; it must merge writes without losing sibling
documents and honor scoped entry updates. Use `localizeSourceDocument` when
target locales need a different source shape, and `Entry.context` for translator
notes that must participate in incremental context checks.

For project setup, implement `Integration` from `@ai-translate/integrations`.
Its declarative adapter plan specifies an import, factory, and literal options;
new platforms do not require adding branches to the core engine or config
renderer. `@ai-translate/next` retains its existing public detection APIs.

Legacy XML `.stringsdict`, XLIFF import/export, source-code rewriting, runtime
installation, and Xcode project modification are outside these adapters. Migrate
legacy plural resources to Xcode string catalogs before translating them here.
