import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncCatalogs, validateCatalogs } from "../packages/ai-translate-core/dist/index.mjs";
import { createHtmlCatalog } from "../packages/ai-translate-html/dist/index.mjs";
import { createMarkdocCatalog } from "../packages/ai-translate-markdoc/dist/index.mjs";
import { createOpenAiTranslationProvider } from "../packages/ai-translate-provider-openai/dist/index.mjs";

if (!process.argv.includes("--live")) {
  throw new Error("Pass --live to run paid Luna validation with OPENAI_API_KEY.");
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required.");
}
const localeArgument = process.argv.indexOf("--locales");
const locales = localeArgument < 0 ? ["de", "fr"] : process.argv[localeArgument + 1].split(",");
const model = "gpt-5.6-luna";
const labels = [
  "Save changes",
  "Cancel subscription",
  "Create project",
  "Invite a member",
  "Download invoice",
  "Manage permissions",
  "View all orders",
  "Continue to checkout",
  "Update billing details",
  "Reset password",
  "Search products",
  "Add to cart",
  "Remove from cart",
  "Contact support",
  "Back to overview",
  "Choose a language",
  "Publish article",
  "Preview changes",
  "Archive project",
  "Restore draft",
  "Schedule publication",
  "Manage notifications",
  "Export report",
  "Sign out",
];
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ai-translate-live-"));
const report = { model, workspace, comparisons: [], documents: [] };
const providerOptions = {
  apiKey: process.env.OPENAI_API_KEY,
  model,
  concurrentRequests: 4,
  requestTimeoutMs: 60_000,
};

for (const locale of locales) {
  for (const batchSize of process.argv.includes("--documents-only") ? [] : [1, "adaptive"]) {
    const events = [];
    const provider = createOpenAiTranslationProvider({
      ...providerOptions,
      batchSize,
      onRequest: (event) => {
        events.push(event);
      },
    });
    const requests = [...labels, ...labels.slice(0, 6)].map((sourceText, index) => ({
      catalogId: "labels",
      contentRole: "ui-label",
      key: String(index),
      locale,
      path: `/${index}`,
      provenance: { catalogId: "labels", jsonPointer: `/${index}`, unitId: "labels" },
      sourceText,
      unitId: "labels",
    }));
    const start = performance.now();
    const translations = await provider.translate({ locale, requests });
    assert.equal(translations.length, requests.length, "Every requested label must be translated.");
    const measurement = {
      locale,
      batchSize,
      elapsedMs: Math.round(performance.now() - start),
      apiCalls: events.length,
      requested: requests.length,
      unique: labels.length,
      usage: Object.fromEntries(
        [
          "inputTokens",
          "outputTokens",
          "cachedInputTokens",
          "cacheWriteInputTokens",
          "reasoningTokens",
        ].map((field) => [
          field,
          events.reduce((total, event) => total + (event.usage?.[field] ?? 0), 0),
        ]),
      ),
    };
    report.comparisons.push({ ...measurement, translations, events });
    console.log(JSON.stringify(measurement));
  }
}

await fs.mkdir(path.join(workspace, "html/en"), { recursive: true });
await fs.mkdir(path.join(workspace, "blog/en"), { recursive: true });
await fs.writeFile(
  path.join(workspace, "html/en/index.html"),
  '<!doctype html><html><body><h1>Keep your team in control</h1><p>Read <a href="/guide" title="Setup guide">the setup guide</a> before <strong>publishing your first article</strong>.</p><p>The annual plan costs €1,200 and includes <strong>20 projects</strong>. You can cancel at any time without an additional fee.</p><button>Save changes</button><pre>const plan = "annual";</pre></body></html>',
);
await fs.writeFile(
  path.join(workspace, "blog/en/guide.md"),
  '# A clearer publishing workflow\n\nYour team can review every update\nbefore publishing. Editors keep control\nof the final wording.\n\nThe annual plan costs €1,200 and includes 20 projects.\nYou can cancel at any time without an additional fee.\n\n- Read the setup guide\n  before publishing your first article.\n\n```js\nconst plan = "annual";\n```\n',
);
let state = { version: 2, entries: {} };
const config = {
  sourceLocale: "en",
  targetLocales: locales,
  catalogs: [
    createHtmlCatalog({ rootDir: path.join(workspace, "html"), sourceLocale: "en" }),
    createMarkdocCatalog({ rootDir: path.join(workspace, "blog"), sourceLocale: "en" }),
  ],
  state: {
    load: () => Promise.resolve(structuredClone(state)),
    save: (next) => {
      state = next;
      return Promise.resolve();
    },
    withLock: (operation) => operation(),
  },
  provider: createOpenAiTranslationProvider(providerOptions),
};
const first = await syncCatalogs(config);
report.firstSync = first.metrics;
report.failures = first.documents.flatMap(({ locale, issues }) =>
  issues.map((issue) => ({ locale, ...issue })),
);
const output = path.join(workspace, "report.json");
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output }));
assert.equal(first.metrics.failedEntries, 0, JSON.stringify(report.failures));
const validation = await validateCatalogs(config);
assert.equal(
  validation.issues.filter(({ severity }) => severity === "error").length,
  0,
  JSON.stringify(validation.issues),
);
const second = await syncCatalogs(config);
report.secondSync = second.metrics;
assert.equal(second.metrics.providerRequestCount, 0, "An unchanged sync must make no API calls.");
assert.equal(second.metrics.translatedEntries, 0);
for (const locale of locales) {
  const html = await fs.readFile(path.join(workspace, "html", locale, "index.html"), "utf8");
  const blog = await fs.readFile(path.join(workspace, "blog", locale, "guide.md"), "utf8");
  assert(html.includes('href="/guide"'));
  assert(html.includes('<pre>const plan = "annual";</pre>'));
  assert(blog.includes('```js\nconst plan = "annual";\n```'));
  for (const [, contents] of html.matchAll(/<strong>(.*?)<\/strong>/gu)) {
    assert(
      !/[.!?。！？]\s+\p{L}/u.test(contents),
      "Inline emphasis must not absorb a following sentence.",
    );
  }
  report.documents.push({ locale, html, blog });
}
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ firstSync: report.firstSync, secondSync: report.secondSync, output }));
