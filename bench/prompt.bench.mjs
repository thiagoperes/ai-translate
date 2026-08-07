/**
 * Token benchmark: what a translation actually costs to ask for.
 *
 * Captures the real payloads the OpenAI provider would send (via a fake client)
 * rather than reasoning about the prompt source, and amortises the fixed prompt
 * cost across batch sizes. Token counts are character-based estimates, labelled
 * as such - the ratios between variants are the useful output, not the absolute
 * numbers.
 *
 *   node bench/prompt.bench.mjs
 *   node bench/prompt.bench.mjs --json
 */
import { createOpenAiTranslationProvider } from "../packages/ai-translate-provider-openai/dist/index.mjs";

/** English prose runs ~4 characters per token across GPT tokenizers. */
const CHARS_PER_TOKEN = 4;
const estimateTokens = (text) => Math.round(text.length / CHARS_PER_TOKEN);

/** OpenAI only serves a cached prefix once it reaches this many tokens. */
const PREFIX_CACHE_MINIMUM_TOKENS = 1024;

/**
 * Do not "fix" the low cross-locale shared prefix by moving the locale line
 * further down buildSystemPrompt.
 *
 * buildSystemPrompt is hashed via Function#toString into
 * OPENAI_TRANSLATION_OUTPUT_CONTRACT_MATERIAL, so *any* edit to it - including
 * a pure reordering that changes no rendered output - rotates
 * OPENAI_TRANSLATION_OUTPUT_CONTRACT_REVISION and invalidates the accepted
 * contract revision on every stored entry. On a 246k-record corpus at the
 * measured ~181 tokens/key that is ~45M tokens of revalidation to save the
 * ~16k tokens per sync that cross-locale prefix caching would return. Measure
 * before assuming this trade has changed.
 */

const SOURCE_STRINGS = [
  "Track every request in one place.",
  "Set usage limits per project and per member.",
  "Download a complete report at the end of each month.",
  "Your workspace syncs across more than 20,000 records.",
  "Approve or decline a change from your phone in seconds.",
  "Connect your existing tools and stop copying data by hand.",
  "See exactly what each environment costs to run.",
  "Flag unusual activity before it reaches production.",
];

function captureClient() {
  const calls = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          parse: (payload) => {
            calls.push(payload);
            // Answer whatever keys the strict schema demands, so the provider's
            // own decoder accepts the reply and we measure a complete exchange.
            const properties =
              payload.response_format?.json_schema?.schema?.properties?.translations?.properties ??
              {};
            const translations = Object.fromEntries(
              Object.keys(properties).map((key) => [key, { translation: "vertaling" }]),
            );
            const parsed = { translations };
            return Promise.resolve({
              choices: [{ message: { content: JSON.stringify(parsed), parsed } }],
            });
          },
        },
      },
    },
  };
}

function buildRequests(count, locale) {
  return Array.from({ length: count }, (_, index) => ({
    catalogId: "messages",
    key: `key-${index}`,
    locale,
    path: `/section/${index}`,
    provenance: {
      catalogId: "messages",
      jsonPointer: `/section/${index}`,
      unitId: "messages",
    },
    sourceText: SOURCE_STRINGS[index % SOURCE_STRINGS.length],
    unitId: "messages",
  }));
}

function payloadChars(payload) {
  const system = payload.messages.find((message) => message.role === "system")?.content ?? "";
  const user = payload.messages.find((message) => message.role === "user")?.content ?? "";
  const schema = JSON.stringify(payload.response_format ?? {});
  return { schema: schema.length, system: system.length, systemText: system, user: user.length };
}

/** Longest common prefix of the system prompts, i.e. what a cache could reuse. */
function sharedPrefix(texts) {
  if (texts.length === 0) {
    return "";
  }
  let prefix = texts[0];
  for (const text of texts.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < text.length && prefix[index] === text[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

async function measureBatchSize(batchSize, keys, locale) {
  const { calls, client } = captureClient();
  const provider = createOpenAiTranslationProvider({ batchSize, client, model: "bench-model" });
  await provider.translate({ locale, requests: buildRequests(keys, locale) });

  let systemChars = 0;
  let userChars = 0;
  let schemaChars = 0;
  const systemTexts = [];
  for (const call of calls) {
    const parts = payloadChars(call);
    systemChars += parts.system;
    userChars += parts.user;
    schemaChars += parts.schema;
    systemTexts.push(parts.systemText);
  }

  const totalTokens = estimateTokens(
    "x".repeat(systemChars + userChars + schemaChars),
  );
  return {
    batchSize,
    calls: calls.length,
    keys,
    promptOverheadTokensPerKey: Number(
      (estimateTokens("x".repeat(systemChars + schemaChars)) / keys).toFixed(1),
    ),
    systemPromptTokens: estimateTokens(systemTexts[0] ?? ""),
    totalTokens,
    totalTokensPerKey: Number((totalTokens / keys).toFixed(1)),
  };
}

/**
 * A bare prompt understates real deployments. Production configs add a project
 * prompt, shared context and a glossary, and it is that fuller prompt that
 * decides whether prefix caching can engage at all.
 */
const PRODUCTION_LIKE = {
  batchContext: {
    audience: "engineering teams evaluating developer tooling",
    constraints: [
      {
        kind: "forbidden-term",
        value: "Never introduce a vendor, product, or partner brand absent from the source.",
      },
      {
        kind: "number",
        value: "Keep every figure, currency, and percentage exactly as written in the source.",
      },
    ],
    notes: "Marketing site copy. Prefer natural target-language phrasing over literal translation.",
    product: "a hosted workspace for software teams",
    tone: "direct, concrete, and free of hype",
  },
  glossary: [
    { source: "workspace", target: "Arbeitsbereich" },
    { source: "deployment", target: "Bereitstellung" },
    { source: "usage report", target: "Nutzungsbericht" },
  ],
  systemPrompt:
    "Return the exact structured schema requested by the provider. When candidateCount is greater than 1, produce every required candidate in this single response. When a request includes semanticSelfCheck, return \"verified\": true only after checking every candidate against every listed facet.",
};

async function renderSystemPrompt(locale, { productionLike }) {
  const { calls, client } = captureClient();
  const provider = createOpenAiTranslationProvider({
    batchSize: 8,
    client,
    model: "bench-model",
    ...(productionLike ? { systemPrompt: PRODUCTION_LIKE.systemPrompt } : {}),
  });
  await provider.translate({
    locale,
    requests: buildRequests(4, locale),
    ...(productionLike
      ? { batchContext: PRODUCTION_LIKE.batchContext, glossary: PRODUCTION_LIKE.glossary }
      : {}),
  });
  return payloadChars(calls[0]).systemText;
}

async function measureCrossLocalePrefix(locales, options) {
  const systemTexts = [];
  for (const locale of locales) {
    systemTexts.push(await renderSystemPrompt(locale, options));
  }
  const prefix = sharedPrefix(systemTexts);
  const full = systemTexts[0] ?? "";
  return {
    cacheableAcrossLocales: estimateTokens(prefix) >= PREFIX_CACHE_MINIMUM_TOKENS,
    cacheableWithinLocale: estimateTokens(full) >= PREFIX_CACHE_MINIMUM_TOKENS,
    fullPromptTokens: estimateTokens(full),
    sharedPrefixTokens: estimateTokens(prefix),
  };
}

async function main() {
  const json = process.argv.includes("--json");
  const keys = 240;
  const batches = [];
  for (const batchSize of [8, 16, 32, 64, 120]) {
    batches.push(await measureBatchSize(batchSize, keys, "de"));
  }
  const locales = ["de", "es", "fr"];
  const prefix = await measureCrossLocalePrefix(locales, { productionLike: false });
  const productionPrefix = await measureCrossLocalePrefix(locales, { productionLike: true });
  const report = { batches, keys, prefix, productionPrefix };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`translating ${keys} keys, token counts estimated at ${CHARS_PER_TOKEN} chars/token\n`);
  console.log("batch   calls   system prompt   prompt overhead/key   total tokens/key");
  for (const row of batches) {
    console.log(
      `${String(row.batchSize).padStart(5)}   ${String(row.calls).padStart(5)}   ` +
        `${String(row.systemPromptTokens).padStart(13)}   ` +
        `${String(row.promptOverheadTokensPerKey).padStart(19)}   ${String(row.totalTokensPerKey).padStart(16)}`,
    );
  }
  console.log(`\nprefix caching (needs >= ${PREFIX_CACHE_MINIMUM_TOKENS} tokens of exact prefix)`);
  for (const [label, measurement] of [
    ["bare config", prefix],
    ["production-like", productionPrefix],
  ]) {
    console.log(
      `  ${label.padEnd(16)} prompt ${String(measurement.fullPromptTokens).padStart(5)} tok  ` +
        `shared prefix ${String(measurement.sharedPrefixTokens).padStart(5)} tok  ` +
        `cacheable within/across locale: ${measurement.cacheableWithinLocale}/${measurement.cacheableAcrossLocales}`,
    );
  }
}

await main();
