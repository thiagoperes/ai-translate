# Native localization design references

These comparisons informed the resource boundaries in
[the native app guide](native-apps.md). References were inspected on
2026-09-20; linked framework implementations can change independently.

## What established tools own

| Tool | Resource behavior | Consequence for this library |
| --- | --- | --- |
| [Xcode String Catalogs][apple-catalogs] | Builds extract supported source strings; catalogs store comments, review states, plural/device variants, and named substitutions. The build compiles catalogs to `.strings` and `.stringsdict`. | Translate catalog values while preserving native structure. Source extraction, target membership, and resource lookup remain app responsibilities. |
| [Expo config plugins][expo-locales] | Locale JSON generates `InfoPlist.strings`; `ios["Localizable.strings"]` generates a separate table. [Platform dictionaries override common entries][expo-resolver]. | Translate committed JSON inputs. Prebuild owns generated native files; shared React Native UI needs its own localization runtime. |
| [SwiftGen][swiftgen] | Its strings parser reads `.strings`/`.stringsdict`, discovers format argument types, and produces typed accessors. It documents limitations for nested plural variables. | Code generation and translation are separate operations. Preserve argument identities and types; document supported resource structures explicitly. |
| [Weblate][weblate] / [Translate Toolkit][toolkit] | `.strings` has descriptions and Objective-C format checks; plural resources use a separate `.stringsdict` model. Toolkit keeps the localized format and variable type as metadata around plural translation units. | Keep native metadata out of prose translation requests, while retaining it for serialization and validity checks. Do not flatten every JSON or plist string into a translatable entry. |
| [Flutter `gen_l10n`][flutter] | ARB stores messages beside `@message` descriptions and typed placeholder metadata; messages can contain ICU-style plural/select expressions and configurable escaping. | A future ARB adapter should select message values and expose descriptions as context. Message syntax belongs to a format implementation, not generic JSON traversal. |
| [Android resources][android] | XML stores string/plural resources; Android escaping and whitespace rules apply after XML parsing. Runtime formatting uses numbered arguments such as `%1$s`. | A future Android adapter must preserve XML resource semantics and use Android-compatible formatting rules. Similar percent syntax does not make Apple's formatter interchangeable. |

## Catalog details that matter

Apple's [String Catalog walkthrough][apple-catalogs] demonstrates several
independent contracts:

- `new`, `needs_review`, and translated values express different workflow
  states. Text being present is not proof that a translation is accepted.
  Stale extraction state is separate from a locale's review state.
- A string's source value can differ from its lookup key. Keys, translator
  comments, and extraction metadata are not all translatable values.
- Different languages require different plural categories. Multiple numeric
  arguments can use separate named substitutions; each substitution binds to
  an argument number and a C format specifier.
- A target language can introduce device variants when the source has a plain
  string. Apple's example gives Portuguese an Apple Watch-specific version.
  Source and target localization trees need not be identical.

The last two points deserve validation beyond JSON parsing. During comparison,
the installed `xcstringstool` compiled substitutions named `bird-count`,
`bird count`, `birds.count`, `鳥`, and `2count`, normalizing their symbols in the
compiled resource. A C identifier restriction on catalog substitution names
would reject these inputs. Preserve the catalog reference exactly and let Xcode
own its compiled representation.

The same compiler accepted a localization containing both a root `stringUnit`
and device variations, but emitted `device.other` as the default `.strings`
value. Updating only that root can appear successful while leaving the displayed
translation unchanged. Tests should inspect compiled values for shape changes,
not just a successful compiler exit. Changes to substitution argument bindings
also need validation even when the human-readable message is unchanged.

Apple's [format specifier reference][apple-formats] documents positional
arguments, length modifiers, Objective-C `%@`, and escaped `%%`. Preserve these
as typed message syntax. A translation may reorder arguments with explicit
positions, but changing their identities, types, or dynamic width/precision
arguments can change how the caller's values are consumed.

## Extension boundaries

`CatalogAdapter` owns storage, locale-specific source shape, native metadata,
and merging updates into a physical file. A catalog can hold many locales in
one file, so transaction and concurrency protection must operate on the shared
file as well as its logical documents.

`MessageFormat` owns the syntax and argument validation of one message without
filesystem access. `Entry.context` carries source-authored translation guidance.
`Integration` performs read-only project detection and describes config imports
and options. A new resource format should compose these existing boundaries
without teaching the core engine how to parse that platform's files.

Apple resource compilation checks emitted format semantics. App builds and
representative language launches check the additional bundle, target, runtime,
and layout concerns described in [the native app guide](native-apps.md).

[apple-catalogs]: https://developer.apple.com/videos/play/wwdc2023/10155/
[apple-formats]: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Strings/Articles/formatSpecifiers.html
[expo-locales]: https://github.com/expo/expo/blob/main/packages/%40expo/config-plugins/src/ios/Locales.ts
[expo-resolver]: https://github.com/expo/expo/blob/main/packages/%40expo/config-plugins/src/utils/locales.ts
[swiftgen]: https://github.com/SwiftGen/SwiftGen/blob/stable/Documentation/Parsers/strings.md
[weblate]: https://docs.weblate.org/en/latest/formats/apple.html
[toolkit]: https://github.com/translate/translate/blob/master/translate/storage/stringsdict.py
[flutter]: https://docs.flutter.dev/ui/internationalization
[android]: https://developer.android.com/guide/topics/resources/string-resource
