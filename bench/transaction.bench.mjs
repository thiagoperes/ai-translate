/**
 * Staged transaction benchmark: what a narrow run pays for the rest of the corpus.
 *
 * A sync reads state only through its target locales, but the CLI wraps every
 * write in a staged transaction that historically loaded, cloned, and rewrote
 * the whole corpus regardless. On a 15-locale project that means a one-locale
 * run carries fourteen locales through every copy. This measures the retained
 * heap and peak RSS of that path with and without a scope, so the saving is a
 * number rather than an argument.
 *
 *   node --expose-gc bench/transaction.bench.mjs
 *   node --expose-gc bench/transaction.bench.mjs --scale 0.25
 *   node --expose-gc bench/transaction.bench.mjs --json
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  createShardedJsonStateStore,
  DURABLE_TRANSACTION_STATE_STORE,
} from "../packages/ai-translate-fs-json/dist/index.mjs";

import { corpusLocales, generateCorpus } from "./lib/corpus.mjs";

if (typeof global.gc !== "function") {
  console.error(
    "bench/transaction.bench.mjs requires --expose-gc:\n  node --expose-gc bench/transaction.bench.mjs",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const options = { json: false, root: undefined, scale: 1, scenario: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") {
      options.json = true;
    } else if (argv[i] === "--scale") {
      i += 1;
      options.scale = Number(argv[i]);
    } else if (argv[i] === "--scenario") {
      i += 1;
      options.scenario = argv[i];
    } else if (argv[i] === "--root") {
      i += 1;
      options.root = argv[i];
    }
  }
  return options;
}

/** Settles the heap so a retained-size reading is not dominated by garbage. */
function settle() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

/**
 * Peak RSS is sampled rather than derived: the transaction's cost is spread
 * across clones that are individually short-lived, so an end-state reading
 * would miss it entirely.
 */
async function withPeakRss(operation) {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 20);
  try {
    const value = await operation();
    peak = Math.max(peak, process.memoryUsage.rss());
    return { peak, value };
  } finally {
    clearInterval(timer);
  }
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Mirrors the CLI's staged transaction closely enough to measure it: load the
 * snapshot under a scope, clone it the way staging does, and commit through the
 * durable coordinator.
 */
async function measureTransaction(rootDir, scope) {
  const store = createShardedJsonStateStore({ rootDir });
  const before = settle();

  const { peak, value } = await withPeakRss(async () =>
    store.withLock(async () => {
      const initialState = await store.load(scope);
      // Staging keeps an untouched copy to roll back to, and hands a second one
      // to the operation; both are live at commit time.
      const staged = structuredClone(initialState);
      const rollback = structuredClone(initialState);
      await store[DURABLE_TRANSACTION_STATE_STORE].commit({
        documents: [],
        initialState: rollback,
        nextState: staged,
        ...(scope === undefined ? {} : { scope }),
      });
      return Object.keys(initialState.entries).length;
    }),
  );

  const retained = settle() - before;
  return { entriesLoaded: value, peakRss: peak, retainedHeap: retained };
}

/**
 * Scope counts, not names: the child re-derives the locale list so the parent
 * only has to pass a number.
 */
function scenarioScope(localeCount, locales) {
  return localeCount === 0 ? undefined : { locales: locales.slice(0, localeCount) };
}

const SCENARIOS = [
  { localeCount: 0, name: "full corpus (unscoped)" },
  { localeCount: 1, name: "1 locale, scoped" },
  { localeCount: 4, name: "4 locales, scoped" },
];

/**
 * RSS never falls, so a second scenario in the same process inherits the peak
 * of the first and every saving disappears. Each measurement therefore gets a
 * process whose only prior work is opening the store.
 */
async function runChild(scenario, rootDir) {
  const { execPath } = process;
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      execPath,
      [
        "--expose-gc",
        new URL(import.meta.url).pathname,
        "--scenario",
        String(scenario.localeCount),
        "--root",
        rootDir,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Scenario "${scenario.name}" exited with code ${String(code)}.`));
        return;
      }
      resolve(JSON.parse(output));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const locales = corpusLocales();

  if (options.scenario !== undefined) {
    const measured = await measureTransaction(
      options.root,
      scenarioScope(Number(options.scenario), locales),
    );
    console.log(JSON.stringify(measured));
    return;
  }

  const snapshot = generateCorpus({ scale: options.scale });
  const totalEntries = Object.keys(snapshot.entries).length;

  const rootDir = await mkdtemp(path.join(tmpdir(), "ai-translate-txn-bench-"));
  try {
    await createShardedJsonStateStore({ rootDir }).save(snapshot);

    const results = [];
    for (const scenario of SCENARIOS) {
      results.push({ ...(await runChild(scenario, rootDir)), name: scenario.name });
    }

    if (options.json) {
      console.log(JSON.stringify({ locales: locales.length, results, totalEntries }, null, 2));
      return;
    }

    console.log(
      `Corpus: ${totalEntries.toLocaleString()} records across ${String(locales.length)} locales\n`,
    );
    const baseline = results[0];
    for (const result of results) {
      const share = ((result.peakRss / baseline.peakRss) * 100).toFixed(0);
      console.log(
        `${result.name.padEnd(24)} entries ${String(result.entriesLoaded).padStart(7)}  ` +
          `retained ${mib(result.retainedHeap).padStart(9)}  ` +
          `peak RSS ${mib(result.peakRss).padStart(9)}  (${share}% of full)`,
      );
    }
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

await main();
