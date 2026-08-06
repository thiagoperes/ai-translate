import { createHash } from "node:crypto";

/**
 * Cardinalities calibrated against a real 246k-record corpus (15 locales,
 * 16,445 pointers, 84 shards). Synthetic corpora that ignore these ratios make
 * interning and scoping look far better or worse than they are, so the defaults
 * below reproduce the measured distribution rather than a uniform one.
 */
export const MEASURED_CORPUS_SHAPE = Object.freeze({
  contextDigests: 170,
  // 19,956 of 246,381 real records carry `validationAudits: {}` - an empty
  // object that still forces the wide 9-field packed record. No record in the
  // real corpus carries populated audit provenance, so modelling a rich tail
  // here would overstate what the format actually has to carry.
  emptyAuditTailRatio: 0.081,
  generationRevisions: 18,
  locales: 15,
  // 11,765 of 246,381 real records override the pointer-level context digest.
  localeContextOverrideRatio: 0.048,
  pointersPerUnit: 196,
  targetDigestUniqueRatio: 0.7,
  timestampSeconds: 511,
  units: 84,
});

const LOCALE_POOL = [
  "da", "de", "el", "es", "et", "fi", "fr", "it",
  "lt", "lv", "nl", "pl", "pt", "sv", "no", "cs", "sk", "hu",
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

const stateKey = (locale, catalogId, unitId, jsonPointer) =>
  `${locale}::${catalogId}::${unitId}::${jsonPointer}`;

/**
 * Builds a deterministic SyncStateSnapshot whose field cardinalities match the
 * measured shape. `scale` multiplies the pointer count only, so locale and
 * revision cardinality stay realistic as the corpus grows.
 */
export function generateCorpus({ scale = 1, seed = 1, shape = MEASURED_CORPUS_SHAPE } = {}) {
  const random = mulberry32(seed);
  const locales = LOCALE_POOL.slice(0, shape.locales);
  const generationRevisions = Array.from({ length: shape.generationRevisions }, (_, i) =>
    i === 0 ? "legacy-unverified" : `sha256:${digest(`generation-${i}`)}`,
  );
  const contextDigests = Array.from({ length: shape.contextDigests }, (_, i) =>
    digest(`context-${i}`),
  );
  const baseSeconds = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
  const timestamps = Array.from({ length: shape.timestampSeconds }, (_, i) =>
    new Date((baseSeconds + i * 3607) * 1000).toISOString(),
  );
  const pick = (values) => values[Math.floor(random() * values.length)];

  const pointersPerUnit = Math.max(1, Math.round(shape.pointersPerUnit * scale));
  const entries = {};

  for (let unit = 0; unit < shape.units; unit += 1) {
    const catalogId = `catalog-${unit % 6}`;
    const unitId = `unit-${unit}`;
    for (let p = 0; p < pointersPerUnit; p += 1) {
      const jsonPointer = `/section${p % 40}/field${p}`;
      const sourceDigest = digest(`source-${unit}-${p}`);
      const translationContextDigest = pick(contextDigests);
      for (const locale of locales) {
        // Most target digests are unique; the tail repeats, matching the ~70%
        // uniqueness measured on real data.
        const targetDigest =
          random() < shape.targetDigestUniqueRatio
            ? digest(`target-${unit}-${p}-${locale}`)
            : digest(`target-shared-${p % 97}`);
        const entry = {
          acceptedContractRevision: `sha256:${digest(`accepted-${unit}-${p}-${locale}`)}`,
          catalogId,
          generationRevision: pick(generationRevisions),
          jsonPointer,
          locale,
          origin: "generated",
          sourceDigest,
          status: "synced",
          targetDigest,
          translationContextDigest:
            random() < shape.localeContextOverrideRatio
              ? pick(contextDigests)
              : translationContextDigest,
          unitId,
          updatedAt: pick(timestamps),
        };
        if (random() < shape.emptyAuditTailRatio) {
          entry.validationAudits = {};
        }
        entries[stateKey(locale, catalogId, unitId, jsonPointer)] = entry;
      }
    }
  }

  return { entries, version: 1 };
}

export function corpusLocales(shape = MEASURED_CORPUS_SHAPE) {
  return LOCALE_POOL.slice(0, shape.locales);
}
