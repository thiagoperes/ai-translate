import { syncCatalogs } from "@ai-translate/core/sync";
import type { AiTranslateConfig } from "@ai-translate/core/types";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createNamespaceJsonCatalog } from "../src/namespace-json";
import { createShardedJsonStateStore } from "../src/sharded-state";

/**
 * State is committed, so a run that changes nothing has to leave it byte for
 * byte as it was. Anything else turns a one-string edit into a diff touching
 * every shard in the corpus and makes review useless at scale.
 */
async function withProject<T>(
  documents: number,
  run: (args: {
    config: AiTranslateConfig;
    contentDir: string;
    readShards: () => Promise<Map<string, string>>;
    rootDir: string;
  }) => Promise<T>
): Promise<T> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "state-stability-"));
  try {
    const contentDir = path.join(rootDir, "content");
    await fs.mkdir(path.join(contentDir, "en"), { recursive: true });
    for (let unit = 0; unit < documents; unit += 1) {
      const root = Object.fromEntries(
        Array.from({ length: 4 }, (_unused, index) => [
          `key${String(index)}`,
          `Source string ${String(unit)}-${String(index)}.`,
        ])
      );
      await fs.writeFile(
        path.join(contentDir, "en", `unit-${String(unit)}.json`),
        `${JSON.stringify(root, null, 2)}\n`,
        "utf8"
      );
    }

    const shardsDir = path.join(rootDir, ".ai-translate", "state");
    const readShards = async (): Promise<Map<string, string>> => {
      const walk = async (dir: string): Promise<string[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const nested = await Promise.all(
          entries.map(async (entry) =>
            entry.isDirectory()
              ? walk(path.join(dir, entry.name))
              : [path.join(dir, entry.name)]
          )
        );
        return nested.flat();
      };
      const files = await walk(shardsDir);
      return new Map(
        await Promise.all(
          files.map(
            async (file) =>
              [path.relative(shardsDir, file), await fs.readFile(file, "utf8")] as const
          )
        )
      );
    };

    const config: AiTranslateConfig = {
      catalogs: [
        createNamespaceJsonCatalog({ id: "messages", rootDir: contentDir, sourceLocale: "en" }),
      ],
      provider: {
        translate: ({ locale, requests }) =>
          Promise.resolve(
            requests.map((request) => ({
              key: request.key,
              translation: `${request.sourceText} [${locale}]`,
            }))
          ),
      },
      sourceLocale: "en",
      state: createShardedJsonStateStore({ rootDir }),
      targetLocales: ["de", "fr"],
    };

    return await run({ config, contentDir, readShards, rootDir });
  } finally {
    await fs.rm(rootDir, { force: true, recursive: true });
  }
}

describe("state file stability", () => {
  it("leaves every shard byte-identical when nothing changed", async () => {
    await withProject(6, async ({ config, readShards }) => {
      await syncCatalogs(config);
      const first = await readShards();
      expect(first.size).toBe(6);

      await syncCatalogs(config);
      expect(await readShards()).toEqual(first);

      // A third run matters separately: a value backfilled on the second run
      // would converge here and hide the churn from a two-run test.
      await syncCatalogs(config);
      expect(await readShards()).toEqual(first);
    });
  });

  it("does not touch the mtime of a shard it would rewrite identically", async () => {
    await withProject(4, async ({ config, rootDir }) => {
      await syncCatalogs(config);
      const shard = path.join(rootDir, ".ai-translate", "state", "messages", "unit-0.json");
      const before = (await fs.stat(shard)).mtimeMs;

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      await syncCatalogs(config);

      expect((await fs.stat(shard)).mtimeMs).toBe(before);
    });
  });

  it("rewrites only the shard whose document changed", async () => {
    await withProject(6, async ({ config, contentDir, readShards }) => {
      await syncCatalogs(config);
      const before = await readShards();

      const file = path.join(contentDir, "en", "unit-3.json");
      const root = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
      root.key0 = "An edited source string.";
      await fs.writeFile(file, `${JSON.stringify(root, null, 2)}\n`, "utf8");
      await syncCatalogs(config);

      const after = await readShards();
      const changed = [...after.keys()].filter((name) => after.get(name) !== before.get(name));
      expect(changed).toEqual([path.join("messages", "unit-3.json")]);
    });
  });
});
