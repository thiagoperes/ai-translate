import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";

import { config as loadDotenv, parse as parseDotenv } from "dotenv";
import { createJiti } from "jiti";

import { defineConfig } from "@ai-translate/core";
import type { AiTranslateConfig } from "@ai-translate/core/types";

const CONFIG_CANDIDATES = [
  "ai-translate.config.ts",
  "ai-translate.config.mts",
  "ai-translate.config.js",
  "ai-translate.config.mjs",
] as const;

function isAiTranslateConfig(value: unknown): value is AiTranslateConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "catalogs" in value &&
    "provider" in value &&
    "sourceLocale" in value &&
    "state" in value &&
    "targetLocales" in value
  );
}

export function findConfigPath(cwd: string, explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(cwd, explicitPath);
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = path.join(cwd, candidate);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  throw new Error(
    `Unable to find ai-translate config in ${cwd}. Expected one of: ${CONFIG_CANDIDATES.join(", ")}`,
  );
}

export async function loadEnvFiles(cwd: string): Promise<Record<string, string>> {
  const nodeEnv = process.env.NODE_ENV;
  const candidates = [
    ".env",
    ".env.local",
    nodeEnv ? `.env.${nodeEnv}` : undefined,
    nodeEnv ? `.env.${nodeEnv}.local` : undefined,
  ].filter((value): value is string => value !== undefined);

  const merged: Record<string, string> = {};
  for (const fileName of candidates) {
    const filePath = path.join(cwd, fileName);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      Object.assign(merged, parseDotenv(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  loadDotenv({
    override: false,
    path: candidates.map((candidate) => path.join(cwd, candidate)),
    processEnv: process.env,
  });

  return merged;
}

export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<{ config: AiTranslateConfig; configPath: string }> {
  const configPath = findConfigPath(cwd, explicitPath);
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
  });
  const loaded: unknown = await jiti.import(configPath);
  const resolved =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default ?? loaded
      : loaded;

  if (!isAiTranslateConfig(resolved)) {
    throw new Error(`Config file ${configPath} did not export an ai-translate config object.`);
  }

  return {
    config: defineConfig(resolved),
    configPath,
  };
}
