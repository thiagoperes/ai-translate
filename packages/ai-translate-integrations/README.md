# @ai-translate/integrations

Read-only project detection and config generation, independent of application platforms. The CLI composes the Apple and Next.js detectors; callers can supply their own.

```ts
import { detectProject, defineIntegration, renderConfig } from "@ai-translate/integrations";

const custom = defineIntegration({
  id: "custom",
  displayName: "Custom resources",
  async detect(context) {
    if (await context.readFile("resources/source.txt") === null) return null;
    return {
      integrationId: "custom",
      displayName: "Custom resources",
      confidence: 0.9,
      evidence: [{ source: "resources/source.txt", detail: "Source resources" }],
      plan: {
        catalog: {
          kind: "adapter",
          factory: { from: "my-translation-adapter", name: "createCatalog" },
          options: { id: "custom", rootDir: "resources" },
        },
        messageFormat: "plain",
        sourceLocale: "en",
        targetLocales: ["fr"],
        warnings: [],
      },
    };
  },
});

const [setup] = await detectProject(process.cwd(), { integrations: [custom] });
if (setup) process.stdout.write(renderConfig(setup.plan));
```

`detectProject` has no default detectors. It catches individual detector failures so other integrations can still match and ranks matches by confidence. Detection reads files as text and never imports or executes application code. `findProjectFiles` skips dependencies, generated directories, hidden directories, and symlinks.

Context reads stay within the project and reject descendant symlinks; the project
root itself may be a symlink. Traversal also skips compiled Apple application and
framework bundles. `findProjectFiles(context, matches, shouldVisitDirectory)`
accepts an optional synchronous or asynchronous directory predicate for platform
rules such as generated native trees. Rejected directories are never enumerated.

A plan contains `catalog` and optional `additionalCatalogs`, sharing one source and target locale list. JSON catalog plans retain the existing `document-json` and `namespace-json` forms. An `adapter` plan supplies a named factory import and JSON-literal `options`; the renderer adds `sourceLocale` unless explicitly provided. Adapters advertise their own message formats to the engine. JSON plans use the plan's `messageFormat` (`plain`, `icu`, `i18next`, or a `{ from, name }` import).

`requiredConfigPackages(plan, options)` reports the installable packages required by the generated config. It resolves package subpaths such as `@acme/localization/apple` to `@acme/localization`, deduplicates them, and omits local files, URLs, package import aliases, and Node built-ins. Import specifiers in the generated config remain unchanged. `renderConfig` supports the OpenAI and AI SDK provider options already accepted by the CLI. Neither function writes files.

Existing `@ai-translate/next` imports remain supported, including its default Next.js detector list and JSON-specific plan types. Use this package to compose detectors from different platforms.
