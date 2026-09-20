# @ai-translate/next

Auto-discovery for Next.js localization setups. Given a project directory, it works out which i18n library is in use, where the messages live, which locales exist, and which one is the source — then renders an `ai-translate.config.ts` for it.

This supplies the Next.js and i18next detectors used by [`ai-translate init`](../ai-translate-cli#readme). Shared detection and rendering live in [`@ai-translate/integrations`](../ai-translate-integrations#readme); existing exports and default detectors from this package remain available. Use the neutral package to compose detectors for different platforms.

## Install

```bash
npm install @ai-translate/next
```

## Usage

```ts
import { detectProject, renderConfig } from "@ai-translate/next";

const setups = await detectProject(process.cwd());

for (const setup of setups) {
  console.log(setup.integrationId, setup.confidence);
  for (const item of setup.evidence) {
    console.log(`  ${item.detail} (${item.source})`);
  }
}

if (setups[0]) {
  console.log(renderConfig(setups[0].plan));
}
```

`detectProject` returns every match, best first. A repository midway through a migration legitimately matches more than one.

## What it recognises

| Integration | Detected from | Message layout | Message format |
| --- | --- | --- | --- |
| `next-intl` | the `next-intl` dependency, `i18n/request.ts`, `i18n/routing.ts` | `messages/{locale}.json` or `messages/{locale}/{namespace}.json` | ICU |
| `i18next` | `i18next`, `react-i18next`, or `next-i18next`, plus a settings module | `public/locales/{locale}/{namespace}.json` | i18next, with suffix-keyed plurals |

Both look under the project root and under `src/`. next-intl checks `messages`, `src/messages`, `locales`, and `src/locales`; i18next checks `public/locales`, `src/public/locales`, `locales`, `src/locales`, and `app/locales`, in that order. Namespace layouts require JSON files immediately inside the locale folder, matching the namespace adapter's scope. Empty placeholder folders do not hide a populated later root or a file-per-locale layout.

An inferred source must have a document in the selected layout. If the declared source is missing, detection checks later conventional roots instead of generating a config that would translate from a different language. Explicit target locales may still be missing on disk: sync can create them. Duplicate and non-locale declarations are filtered. If several populated layouts exist, the selected layout and alternatives appear in the plan's warnings; add separate catalogs when the project uses more than one.

## Detection is read-only

Nothing is written and no project code is executed. Config modules are read as text and scanned for literal `locales` arrays and `defaultLocale` strings, never imported — importing a Next.js config would pull in plugins, environment access, and arbitrary side effects. Comments, quoted examples, and similarly named properties are ignored. Plain quoted literals, trailing commas, and `as const` are supported. Computed arrays, spreads, interpolation, escapes, conflicting declarations, and syntax outside this literal subset are not inferred; detection falls back to locale files and folders. This deliberately conservative scan does not resolve imports, custom runtime paths, or arbitrary JavaScript/TypeScript expressions. Configure these layouts explicitly.

That fallback is reported rather than hidden: the resulting plan carries a `warnings` entry, and `renderConfig` turns each warning into a `// TODO:` comment in the generated file.

## Writing your own integration

An integration is a detector. It receives a read-only view of the project and either returns a plan or `null`.

```ts
import { defineIntegration, detectProject } from "@ai-translate/next";
import type { Integration } from "@ai-translate/next";

const paraglide: Integration = defineIntegration({
  async detect(context) {
    const manifest = await context.packageJson();
    if (manifest?.dependencies?.["@inlang/paraglide-js"] === undefined) {
      return null;
    }

    const locales = await context.listDirectories("messages");
    return {
      confidence: 0.9,
      displayName: "Paraglide",
      evidence: [{ detail: "Paraglide is a dependency", source: "package.json" }],
      integrationId: "paraglide",
      plan: {
        catalog: { kind: "document-json", rootDir: "messages" },
        messageFormat: "icu",
        sourceLocale: "en",
        targetLocales: locales.filter((locale) => locale !== "en"),
        warnings: [],
      },
    };
  },
  displayName: "Paraglide",
  id: "paraglide",
});

const setups = await detectProject(process.cwd(), { integrations: [paraglide] });
```

Passing `integrations` replaces the shipped set. `ai-translate init` accepts the same option.

Confidence only ranks candidates. Keep it below `1` unless the evidence is conclusive, and reserve the high end for cases where both a dependency and a recognised message layout are present — a dependency alone is not enough, since a project can depend on a library it no longer uses.

## License

MIT
