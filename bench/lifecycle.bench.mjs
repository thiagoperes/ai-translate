/**
 * Lifecycle benchmark: what each kind of run costs on a corpus that already exists.
 *
 * A sync is not one workload. The first pass translates everything and is
 * dominated by the provider; every run after it is dominated by the engine
 * deciding what *not* to translate, and that decision has to stay cheap as the
 * corpus grows. The interesting cases are therefore:
 *
 *   first pass   nothing in state, everything queued
 *   no-op        nothing changed, which is what CI runs on every push
 *   delta        a small fraction of source strings edited
 *   removal      a small fraction of source keys deleted
 *   check        the read-only CI gate over the whole corpus
 *
 * Provider latency is fixed at zero here on purpose: this measures the engine,
 * so a regression in reconciliation or validation cannot hide behind model time.
 *
 *   node bench/lifecycle.bench.mjs
 *   node bench/lifecycle.bench.mjs --documents 2000 --locales 8
 *   node bench/lifecycle.bench.mjs --json
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { syncCatalogs, validateCatalogs } from "../packages/ai-translate-core/dist/index.mjs";
import {
  createNamespaceJsonCatalog,
  createShardedJsonStateStore,
} from "../packages/ai-translate-fs-json/dist/index.mjs";

const LOCALE_POOL = ["de", "es", "fr", "it", "nl", "pt", "pl", "sv", "da", "fi"];

function parseArgs(argv) {
  const options = { changedFraction: 0.01, documents: 500, entries: 20, json: false, locales: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const numeric = {
      "--changed": "changedFraction",
      "--documents": "documents",
      "--entries": "entries",
      "--locales": "locales",
    }[arg];
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

const unitPath = (contentDir, unit) =>
  path.join(contentDir, "en", `unit-${String(unit)}.json`);

function sourceRoot(unit, entries, revision) {
  return Object.fromEntries(
    Array.from({ length: entries }, (_unused, index) => [
      `key${String(index)}`,
      `Source string ${String(unit)}-${String(index)} rev ${String(revision)} for the localization benchmark.`,
    ]),
  );
}

async function writeCorpus(contentDir, { documents, entries }) {
  await mkdir(path.join(contentDir, "en"), { recursive: true });
  await Promise.all(
    Array.from({ length: documents }, async (_unused, unit) => {
      await writeFile(unitPath(contentDir, unit), `${JSON.stringify(sourceRoot(unit, entries, 0), null, 2)}\n`, "utf8");
    }),
  );
}

/** Edits one string in the first `count` documents, as an author would. */
async function editSources(contentDir, count, entries) {
  await Promise.all(
    Array.from({ length: count }, async (_unused, unit) => {
      const root = sourceRoot(unit, entries, 1);
      await writeFile(unitPath(contentDir, unit), `${JSON.stringify(root, null, 2)}\n`, "utf8");
    }),
  );
}

/** Deletes the last key from the first `count` documents. */
async function removeKeys(contentDir, count) {
  await Promise.all(
    Array.from({ length: count }, async (_unused, unit) => {
      const file = unitPath(contentDir, unit);
      const root = JSON.parse(await readFile(file, "utf8"));
      const keys = Object.keys(root);
      const last = keys.at(-1);
      if (last !== undefined) {
        delete root[last];
      }
      await writeFile(file, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    }),
  );
}

function createCountingProvider() {
  let requests = 0;
  return {
    provider: {
      translate({ locale, requests: batch }) {
        requests += batch.length;
        return Promise.resolve(
          batch.map((request) => ({
            key: request.key,
            translation: `${request.sourceText} [${locale}]`,
          })),
        );
      },
    },
    requests: () => requests,
  };
}

async function timed(run) {
  const startedAt = performance.now();
  const value = await run();
  return { elapsedMs: performance.now() - startedAt, value };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = await mkdtemp(path.join(tmpdir(), "ai-translate-lifecycle-"));
  try {
    const contentDir = path.join(rootDir, "content");
    await writeCorpus(contentDir, options);

    const counting = createCountingProvider();
    const config = {
      catalogs: [
        createNamespaceJsonCatalog({ id: "messages", rootDir: contentDir, sourceLocale: "en" }),
      ],
      concurrency: { documents: 32 },
      // A bare config skips context resolution and glossary selection entirely,
      // which are per-entry costs every real project pays. Measuring without
      // them would report a run nobody actually has.
      context: {
        project: {
          audience: "software teams evaluating developer tooling",
          product: "a hosted workspace for software teams",
          tone: "direct, concrete, and free of hype",
        },
      },
      glossary: [
        { note: "Never translate the brand name.", source: "Acme", target: "Acme" },
        { source: "workspace", target: "Arbeitsbereich" },
        { source: "deployment", target: "Bereitstellung" },
      ],
      provider: counting.provider,
      sourceLocale: "en",
      state: createShardedJsonStateStore({ rootDir }),
      targetLocales: LOCALE_POOL.slice(0, options.locales),
    };

    const touched = Math.max(1, Math.round(options.documents * options.changedFraction));
    const rows = [];
    const record = async (name, run) => {
      const before = counting.requests();
      const { elapsedMs, value } = await timed(run);
      rows.push({
        elapsedMs: Math.round(elapsedMs),
        entries: value?.metrics?.translatedEntries ?? 0,
        name,
        translated: counting.requests() - before,
      });
    };

    await record("first pass", () => syncCatalogs(config));
    await record("no-op sync", () => syncCatalogs(config));
    await record("check (read-only)", () => validateCatalogs(config));
    await record(`delta (${String(touched)} docs edited)`, async () => {
      await editSources(contentDir, touched, options.entries);
      return syncCatalogs(config);
    });
    await record(`removal (${String(touched)} keys deleted)`, async () => {
      await removeKeys(contentDir, touched);
      return syncCatalogs(config);
    });

    const totalEntries = options.documents * options.entries * options.locales;
    if (options.json) {
      console.log(JSON.stringify({ options, rows, totalEntries }, null, 2));
      return;
    }

    console.log(
      `Corpus: ${String(options.documents)} documents x ${String(options.entries)} entries x ` +
        `${String(options.locales)} locales = ${totalEntries.toLocaleString()} entries\n`,
    );
    console.log("run                             elapsed   translated   us/entry");
    const firstPass = rows[0];
    for (const row of rows) {
      const perEntry = ((row.elapsedMs * 1000) / totalEntries).toFixed(1);
      console.log(
        `${row.name.padEnd(30)} ${`${String(row.elapsedMs)}ms`.padStart(8)}   ${String(row.translated).padStart(10)}   ${perEntry.padStart(8)}`,
      );
    }
    console.log(
      `\nA no-op sync is ${(firstPass.elapsedMs / Math.max(1, rows[1].elapsedMs)).toFixed(1)}x ` +
        "faster than the first pass; that ratio is what keeps steady-state runs cheap.",
    );
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

await main();
