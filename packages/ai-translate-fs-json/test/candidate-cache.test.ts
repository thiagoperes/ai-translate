import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createLegacyTranslationCandidateCacheProbeKey,
  createTranslationCandidateCacheKey,
} from "@ai-translate/core";
import { digestValue } from "@ai-translate/core/hash";
import type { TranslationCandidateCacheKey } from "@ai-translate/core/types";
import { describe, expect, it } from "vitest";

import { createFileTranslationCandidateCache } from "../src/candidate-cache";

function candidateKey(
  sourceText = "Source",
  revisions: {
    generationRevision?: string;
    providerRevision?: string;
  } = {}
): TranslationCandidateCacheKey {
  return createTranslationCandidateCacheKey({
    contentRoleRevision: "body-v1",
    generationRevision: revisions.generationRevision ?? "generation-v1",
    identity: {
      modelId: "model-v1",
      providerId: "provider",
      providerRevision: revisions.providerRevision ?? "provider-v1",
    },
    instructionDigest: "instructions-v1",
    request: {
      catalogId: "messages",
      contentRole: "body",
      key: "/body",
      locale: "de",
      path: "/content/messages/en.json",
      provenance: {
        catalogId: "messages",
        jsonPointer: "/body",
        unitId: "messages",
      },
      sourceText,
      unitId: "messages",
    },
  });
}

describe("file translation candidate cache", () => {
  it("persists immutable candidates across cache instances", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-cache-")
    );
    try {
      const key = candidateKey();
      const first = createFileTranslationCandidateCache({ rootDir });
      await first.put(key, "Erste Übersetzung");
      await first.put(key, "Spätere Übersetzung");

      const reopened = createFileTranslationCandidateCache({ rootDir });
      await expect(reopened.get(key)).resolves.toBe("Erste Übersetzung");
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });

  it("persists generation-time self-check attestations separately from legacy text", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-cache-")
    );
    try {
      const key = candidateKey();
      const candidate = {
        selfCheck: {
          modelId: "translation-model",
          planDigests: ["plan-v1"],
          verified: true as const,
        },
        translation: "Attested translation",
      };
      const cache = createFileTranslationCandidateCache({ rootDir });
      await cache.putAttested?.(key, candidate);

      const reopened = createFileTranslationCandidateCache({ rootDir });
      await expect(reopened.getAttested?.(key)).resolves.toEqual(candidate);
      await reopened.reject(key, candidate.translation);
      await expect(reopened.getAttested?.(key)).resolves.toBeUndefined();
      await expect(reopened.get(key)).resolves.toBeUndefined();
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });

  it("migrates compatible generation revisions without validator identity", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-cache-")
    );
    try {
      const legacyKey = candidateKey("Compatible attestation", {
        generationRevision: "generation-legacy",
      });
      const currentKey = candidateKey("Compatible attestation", {
        generationRevision: "generation-current",
      });
      const candidate = {
        selfCheck: {
          modelId: "translation-model",
          planDigests: ["plan-v1"],
          verified: true as const,
        },
        translation: "Attested translation",
      };
      await createFileTranslationCandidateCache({ rootDir }).putAttested?.(
        legacyKey,
        candidate
      );

      const compatible = createFileTranslationCandidateCache({
        compatibleGenerationRevisions: ["generation-legacy"],
        rootDir,
      });
      await expect(compatible.getAttested?.(currentKey)).resolves.toEqual(
        candidate
      );

      const exactOnly = createFileTranslationCandidateCache({ rootDir });
      await expect(
        exactOnly.getAttested?.(currentKey)
      ).resolves.toBeUndefined();
      await compatible.putAttested?.(currentKey, candidate);
      await expect(exactOnly.getAttested?.(currentKey)).resolves.toEqual(
        candidate
      );
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });

  it("locates pre-redesign digests that still hashed validator revisions", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-cache-")
    );
    try {
      const currentKey = candidateKey("Legacy validator digest");
      const legacyProbe = createLegacyTranslationCandidateCacheProbeKey({
        deterministicContractRevision: "contract-legacy",
        key: currentKey,
      });
      const candidate = {
        selfCheck: {
          modelId: "translation-model",
          planDigests: ["plan-v1"],
          verified: true as const,
        },
        translation: "Legacy attested translation",
      };

      // Simulate an on-disk v1-era attested record under the historical digest.
      const shard = path.join(
        rootDir,
        ".ai-translate",
        "candidate-cache",
        "v2",
        legacyProbe.digest.slice(0, 2)
      );
      await fs.mkdir(shard, { recursive: true });
      const legacyStoredKey = {
        ...currentKey,
        deterministicContractRevision: "contract-legacy",
        digest: legacyProbe.digest,
        schemaVersion: 1,
      };
      await fs.writeFile(
        path.join(shard, `${legacyProbe.digest}.json`),
        `${JSON.stringify({
          candidate,
          candidateDigest: digestValue(JSON.stringify(candidate)),
          key: legacyStoredKey,
          keyDigest: legacyProbe.digest,
          schemaVersion: 2,
          writtenAt: new Date().toISOString(),
        })}\n`,
        "utf8"
      );

      const cache = createFileTranslationCandidateCache({
        compatibleRevisionPairs: [
          {
            deterministicContractRevision: "contract-legacy",
            generationRevision: currentKey.generationRevision,
          },
        ],
        rootDir,
      });
      await expect(cache.getAttested?.(currentKey)).resolves.toEqual(candidate);
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });

  it("migrates explicitly compatible provider revisions", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-cache-")
    );
    try {
      const legacyKey = candidateKey("Provider migration", {
        providerRevision: "provider-v1",
      });
      const currentKey = candidateKey("Provider migration", {
        providerRevision: "provider-v2",
      });
      const first = createFileTranslationCandidateCache({ rootDir });
      await first.put(legacyKey, "Cached translation");

      const compatible = createFileTranslationCandidateCache({
        compatibleProviderRevisions: ["provider-v1"],
        rootDir,
      });
      await expect(compatible.get(currentKey)).resolves.toBe(
        "Cached translation"
      );
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });

  it("probes standalone legacy contracts against current generation cohorts", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-cache-")
    );
    try {
      const currentKey = candidateKey("Standalone legacy contract");
      const legacyProbe = createLegacyTranslationCandidateCacheProbeKey({
        deterministicContractRevision: "contract-standalone",
        key: currentKey,
      });
      await writeAttestedRecordOnDisk(rootDir, legacyProbe, currentKey, {
        deterministicContractRevision: "contract-standalone",
        translation: "Standalone legacy translation",
      });

      const compatible = createFileTranslationCandidateCache({
        legacyDeterministicContractRevisions: ["contract-standalone"],
        rootDir,
      });
      await expect(
        compatible.getAttested?.(currentKey)
      ).resolves.toMatchObject({ translation: "Standalone legacy translation" });
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });

  it("does not cross-multiply pair contract revisions with other pairs' generations", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "candidate-cache-")
    );
    try {
      const currentKey = candidateKey("Pairs stay pairs");
      // Record written under contract A but paired with generation B, a
      // combination that only exists if pairs are cross-multiplied.
      const otherGenerationKey = candidateKey("Pairs stay pairs", {
        generationRevision: "generation-B",
      });
      const crossProbe = createLegacyTranslationCandidateCacheProbeKey({
        deterministicContractRevision: "contract-A",
        key: otherGenerationKey,
      });
      await writeAttestedRecordOnDisk(rootDir, crossProbe, otherGenerationKey, {
        deterministicContractRevision: "contract-A",
        translation: "Cross-product translation",
      });

      const compatible = createFileTranslationCandidateCache({
        compatibleRevisionPairs: [
          {
            deterministicContractRevision: "contract-A",
            generationRevision: currentKey.generationRevision,
          },
          {
            deterministicContractRevision: "contract-B",
            generationRevision: "generation-B",
          },
        ],
        rootDir,
      });
      await expect(
        compatible.getAttested?.(currentKey)
      ).resolves.toBeUndefined();

      // The exact recorded pair (contract-B, generation-B) is still located.
      const pairProbe = createLegacyTranslationCandidateCacheProbeKey({
        deterministicContractRevision: "contract-B",
        key: otherGenerationKey,
      });
      await writeAttestedRecordOnDisk(rootDir, pairProbe, otherGenerationKey, {
        deterministicContractRevision: "contract-B",
        translation: "Paired translation",
      });
      // A fresh instance re-indexes the on-disk records.
      const reopened = createFileTranslationCandidateCache({
        compatibleRevisionPairs: [
          {
            deterministicContractRevision: "contract-A",
            generationRevision: currentKey.generationRevision,
          },
          {
            deterministicContractRevision: "contract-B",
            generationRevision: "generation-B",
          },
        ],
        rootDir,
      });
      await expect(reopened.getAttested?.(currentKey)).resolves.toMatchObject({
        translation: "Paired translation",
      });
    } finally {
      await fs.rm(rootDir, { force: true, recursive: true });
    }
  });
});

async function writeAttestedRecordOnDisk(
  rootDir: string,
  probe: TranslationCandidateCacheKey,
  materialKey: TranslationCandidateCacheKey,
  options: { deterministicContractRevision: string; translation: string }
): Promise<void> {
  const candidate = {
    selfCheck: {
      modelId: "translation-model",
      planDigests: ["plan-v1"],
      verified: true as const,
    },
    translation: options.translation,
  };
  const shard = path.join(
    rootDir,
    ".ai-translate",
    "candidate-cache",
    "v2",
    probe.digest.slice(0, 2)
  );
  await fs.mkdir(shard, { recursive: true });
  await fs.writeFile(
    path.join(shard, `${probe.digest}.json`),
    `${JSON.stringify({
      candidate,
      candidateDigest: digestValue(JSON.stringify(candidate)),
      key: {
        ...materialKey,
        deterministicContractRevision: options.deterministicContractRevision,
        digest: probe.digest,
        schemaVersion: 1,
      },
      keyDigest: probe.digest,
      schemaVersion: 2,
      writtenAt: new Date().toISOString(),
    })}\n`,
    "utf8"
  );
}
