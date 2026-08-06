/**
 * State store benchmark: disk footprint, load time, and retained heap.
 *
 * Every efficiency change to the sharded state store must be justified here
 * before it lands, and re-run afterwards. Compressed size is reported next to
 * raw size on purpose: the state file is committed, so gzip is the number that
 * decides whether a format change is worth its migration risk.
 *
 *   node --expose-gc bench/state.bench.mjs
 *   node --expose-gc bench/state.bench.mjs --scale 0.25
 *   node --expose-gc bench/state.bench.mjs --corpus path/to/.ai-translate/state
 *   node --expose-gc bench/state.bench.mjs --json > bench/baseline.json
 *   node --expose-gc bench/state.bench.mjs --baseline bench/baseline.json
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

import { createShardedJsonStateStore } from "../packages/ai-translate-fs-json/dist/index.mjs";

import { corpusLocales, generateCorpus } from "./lib/corpus.mjs";

if (typeof global.gc !== "function") {
  console.error("bench/state.bench.mjs requires --expose-gc:\n  node --expose-gc bench/state.bench.mjs");
  process.exit(1);
}

function parseArgs(argv) {
  const options = { baseline: undefined, corpus: undefined, json: false, scale: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--scale") {
      i += 1;
      options.scale = Number(argv[i]);
    } else if (arg === "--corpus") {
      i += 1;
      options.corpus = argv[i];
    } else if (arg === "--baseline") {
      i += 1;
      options.baseline = argv[i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.scale) || options.scale <= 0) {
    throw new Error("--scale must be a positive number.");
  }
  return options;
}

function walkShards(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkShards(full));
    } else if (entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

function measureShardBytes(shardsDir) {
  let raw = 0;
  let gzip = 0;
  const files = walkShards(shardsDir);
  for (const file of files) {
    raw += statSync(file).size;
    gzip += gzipSync(readFileSync(file), { level: 9 }).length;
  }
  return { files: files.length, gzip, raw };
}

/** Retained heap, measured after forcing collection with the result held live. */
async function measureRetained(run) {
  global.gc();
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const result = await run();
  const elapsedMs = performance.now() - startedAt;
  global.gc();
  global.gc();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  const count = Object.keys(result.entries).length;
  return { count, elapsedMs, retainedBytes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workDir = await mkdtemp(path.join(tmpdir(), "ai-translate-bench-"));

  try {
    let shardsDir;
    let rootDir;
    let locales;
    let saveMs = Number.NaN;

    if (options.corpus === undefined) {
      rootDir = workDir;
      const seedStore = createShardedJsonStateStore({ rootDir });
      const corpus = generateCorpus({ scale: options.scale });
      const saveStartedAt = performance.now();
      await seedStore.save(corpus);
      saveMs = performance.now() - saveStartedAt;
      shardsDir = path.join(rootDir, ".ai-translate", "state");
      locales = corpusLocales();
    } else {
      // Real corpus: the store expects <rootDir>/.ai-translate/state.
      shardsDir = path.resolve(options.corpus);
      rootDir = path.resolve(shardsDir, "..", "..");
      const probe = await createShardedJsonStateStore({ rootDir }).load();
      locales = [...new Set(Object.values(probe.entries).map((entry) => entry.locale))].toSorted();
    }

    const store = createShardedJsonStateStore({ rootDir });
    const size = measureShardBytes(shardsDir);
    const full = await measureRetained(() => store.load());
    const oneLocale = locales.slice(0, 1);
    const scoped = await measureRetained(() => store.load({ locales: oneLocale }));

    const report = {
      corpus: options.corpus ?? `synthetic scale=${options.scale}`,
      locales: locales.length,
      save: { elapsedMs: saveMs },
      scopedLoad: { ...scoped, locales: oneLocale },
      shards: size,
      fullLoad: full,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    if (options.baseline !== undefined) {
      compareBaseline(report, JSON.parse(readFileSync(options.baseline, "utf8")));
    }
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
const ms = (value) => (Number.isNaN(value) ? "n/a" : `${value.toFixed(0)} ms`);

function printReport(report) {
  const { fullLoad: full, scopedLoad: scoped, shards } = report;
  console.log(`corpus: ${report.corpus} | ${report.locales} locales | ${shards.files} shards\n`);
  console.log(`disk raw          ${mb(shards.raw)}`);
  console.log(`disk gzip         ${mb(shards.gzip)}  (${(shards.raw / shards.gzip).toFixed(1)}x)`);
  console.log(`save              ${ms(report.save.elapsedMs)}`);
  console.log("");
  console.log(`full load         ${String(full.count).padStart(7)} entries  ${ms(full.elapsedMs).padStart(8)}  ${mb(full.retainedBytes).padStart(9)}  ${Math.round(full.retainedBytes / full.count)} B/entry`);
  console.log(`scoped load       ${String(scoped.count).padStart(7)} entries  ${ms(scoped.elapsedMs).padStart(8)}  ${mb(scoped.retainedBytes).padStart(9)}  ${Math.round(scoped.retainedBytes / Math.max(1, scoped.count))} B/entry`);
  const heapRatio = scoped.retainedBytes / full.retainedBytes;
  console.log(`\nscoped vs full    ${(heapRatio * 100).toFixed(1)}% heap, ${((scoped.elapsedMs / full.elapsedMs) * 100).toFixed(1)}% time`);
}

/**
 * Fails the process when a tracked metric regresses beyond its tolerance.
 *
 * Byte counts are deterministic and get a tight tolerance. Retained heap varies
 * with the V8 build, so its absolute tolerance is loose and the real guard is
 * the scoped/full ratio, which is a property of the loader rather than of the
 * machine measuring it.
 */
function compareBaseline(report, baseline) {
  const scopedShare = (run) => run.scopedLoad.retainedBytes / run.fullLoad.retainedBytes;
  const checks = [
    ["disk raw", report.shards.raw, baseline.shards.raw, 0.02],
    ["disk gzip", report.shards.gzip, baseline.shards.gzip, 0.02],
    ["full load heap", report.fullLoad.retainedBytes, baseline.fullLoad.retainedBytes, 0.2],
    ["scoped load heap", report.scopedLoad.retainedBytes, baseline.scopedLoad.retainedBytes, 0.2],
    ["scoped heap share", scopedShare(report), scopedShare(baseline), 0.25],
  ];
  let failed = false;
  console.log("\nbaseline comparison");
  for (const [label, actual, expected, tolerance] of checks) {
    const delta = actual / expected - 1;
    const ok = delta <= tolerance;
    failed ||= !ok;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${label.padEnd(18)} ${(delta * 100).toFixed(1).padStart(6)}%  (tolerance +${(tolerance * 100).toFixed(0)}%)`,
    );
  }
  if (failed) {
    process.exitCode = 1;
  }
}

await main();
