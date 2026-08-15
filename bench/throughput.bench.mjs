/**
 * Sync throughput benchmark: where wall-clock goes on a large corpus.
 *
 * The provider is the expensive part of a real sync, so anything the engine
 * spends outside it has to be small enough to disappear behind it. That is not
 * something you can eyeball from the code: a scan that awaits one file at a
 * time looks identical to one that awaits a thousand. This measures the phases
 * a sync already reports (catalog scan, prepare, provider, write, state) over a
 * synthetic corpus on a real filesystem, plus the latency the engine adds on
 * top of a provider whose per-call cost is known.
 *
 *   node bench/throughput.bench.mjs
 *   node bench/throughput.bench.mjs --documents 2000 --locales 10
 *   node bench/throughput.bench.mjs --json
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { syncCatalogs } from "../packages/ai-translate-core/dist/index.mjs";
import {
  createNamespaceJsonCatalog,
  createShardedJsonStateStore,
} from "../packages/ai-translate-fs-json/dist/index.mjs";

const LOCALE_POOL = ["de", "es", "fr", "it", "nl", "pt", "pl", "sv", "da", "fi"];

function parseArgs(argv) {
  const options = {
    concurrency: undefined,
    documents: 400,
    entries: 20,
    json: false,
    latencyMs: 40,
    locales: 4,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const numeric = { "--concurrency": "concurrency", "--documents": "documents", "--entries": "entries", "--latency": "latencyMs", "--locales": "locales" }[arg];
    if (numeric === undefined) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    i += 1;
    options[numeric] = Number(argv[i]);
  }
  if (options.locales > LOCALE_POOL.length) {
    throw new Error(`--locales must be at most ${String(LOCALE_POOL.length)}.`);
  }
  return options;
}

async function writeCorpus(rootDir, { documents, entries, sourceLocale }) {
  const localeDir = path.join(rootDir, sourceLocale);
  await mkdir(localeDir, { recursive: true });
  await Promise.all(
    Array.from({ length: documents }, async (_unused, unit) => {
      const root = Object.fromEntries(
        Array.from({ length: entries }, (_ignored, index) => [
          `key${String(index)}`,
          `Source string ${String(unit)}-${String(index)} for the localization benchmark.`,
        ]),
      );
      await writeFile(path.join(localeDir, `unit-${String(unit)}.json`), `${JSON.stringify(root, null, 2)}\n`, "utf8");
    }),
  );
}

/**
 * Stands in for a hosted model at a fixed per-call latency, so provider time is
 * a known quantity and everything else in the report is engine overhead. It
 * also records peak in-flight calls, which is the only way to tell a raised
 * concurrency setting from one that never reaches the transport.
 */
function createFakeProvider(latencyMs) {
  let active = 0;
  let calls = 0;
  let peakConcurrency = 0;
  return {
    metrics: () => ({ calls, peakConcurrency }),
    provider: {
      async translate({ requests }) {
        active += 1;
        calls += 1;
        peakConcurrency = Math.max(peakConcurrency, active);
        try {
          await new Promise((resolve) => {
            setTimeout(resolve, latencyMs);
          });
          return requests.map((request) => ({
            key: request.key,
            translation: `${request.sourceText} [${request.locale}]`,
          }));
        } finally {
          active -= 1;
        }
      },
    },
  };
}

async function measure(options) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "ai-translate-throughput-"));
  try {
    const contentDir = path.join(rootDir, "content");
    const sourceLocale = "en";
    await writeCorpus(contentDir, { ...options, sourceLocale });

    const fake = createFakeProvider(options.latencyMs);
    const config = {
      catalogs: [createNamespaceJsonCatalog({ id: "messages", rootDir: contentDir, sourceLocale })],
      ...(options.concurrency === undefined
        ? {}
        : { concurrency: { documents: options.concurrency } }),
      provider: fake.provider,
      sourceLocale,
      state: createShardedJsonStateStore({ rootDir }),
      targetLocales: LOCALE_POOL.slice(0, options.locales),
    };

    const startedAt = performance.now();
    const result = await syncCatalogs(config);
    const wallClockMs = performance.now() - startedAt;

    return {
      ...fake.metrics(),
      documents: result.metrics.scannedDocuments,
      phases: result.metrics.phases,
      translatedEntries: result.metrics.translatedEntries,
      wallClockMs: Math.round(wallClockMs),
    };
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

function report(options, measured) {
  const { phases } = measured;
  // What the provider alone would take at the concurrency the run reached, and
  // at the concurrency it was asked for. A gap between the two means requests
  // queued behind something other than the model.
  const providerFloorMs =
    Math.ceil(measured.calls / Math.max(1, measured.peakConcurrency)) * options.latencyMs;

  console.log(
    `Corpus: ${String(options.documents)} source documents x ${String(options.entries)} entries x ` +
      `${String(options.locales)} locales = ${measured.translatedEntries.toLocaleString()} translated entries`,
  );
  console.log(
    `Provider: ${String(measured.calls)} calls at ${String(options.latencyMs)}ms, ` +
      `peak ${String(measured.peakConcurrency)} in flight\n`,
  );
  for (const [name, value] of [
    ["catalog scan", phases.catalogScanMs],
    ["cache lookup", phases.cacheLookupMs],
    ["validation", phases.validationMs],
    ["document write", phases.documentWriteMs],
    ["state load", phases.stateLoadMs],
    ["state write", phases.stateWriteMs],
  ]) {
    console.log(`  ${name.padEnd(14)} ${`${String(Math.round(value))}ms`.padStart(8)}`);
  }
  console.log(
    `\n  ${"provider floor".padEnd(14)} ${`${String(providerFloorMs)}ms`.padStart(8)}` +
      `  (aggregate across concurrent calls: ${String(Math.round(phases.providerMs))}ms)`,
  );
  console.log(
    `  ${"wall clock".padEnd(14)} ${`${String(measured.wallClockMs)}ms`.padStart(8)}` +
      `  (${String(measured.wallClockMs - providerFloorMs)}ms on top of the provider)`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const measured = await measure(options);
  if (options.json) {
    console.log(JSON.stringify({ options, ...measured }, null, 2));
    return;
  }
  report(options, measured);
}

await main();
