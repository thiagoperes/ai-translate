import { digestTranslationContext } from "./acceptance";
import { digestValue } from "./hash";
import type {
  AiTranslateConfig,
  GlossaryTerm,
  TranslationCandidateCacheIdentity,
  TranslationCandidateCacheKey,
  TranslationRequest,
} from "./types";

/**
 * The provider's own identity unless the config overrides it, so turning the
 * cache on does not mean restating the model and vendor the provider was already
 * constructed with — and cannot silently disagree with them.
 */
export function resolveCandidateCacheIdentity(
  config: Pick<AiTranslateConfig, "candidateCache" | "provider">
): TranslationCandidateCacheIdentity | undefined {
  return (
    config.candidateCache?.identity ?? config.provider.candidateCacheIdentity
  );
}

/**
 * Generation-cache identity contains only model-visible inputs. Validator
 * revisions, audit provenance, transport knobs, and concurrency never belong
 * here — those are revalidated/rebound after a cache hit.
 */
interface TranslationCandidateCacheKeyArgs {
  contentRoleRevision?: string;
  generationRevision: string;
  glossary?: readonly GlossaryTerm[];
  identity: TranslationCandidateCacheIdentity;
  instructionDigest: string;
  request: TranslationRequest;
}

type GenerationKeyMaterial = Omit<TranslationCandidateCacheKey, "digest">;

function keyMaterial(key: GenerationKeyMaterial) {
  return {
    catalogId: key.catalogId,
    ...(key.contentRole === undefined ? {} : { contentRole: key.contentRole }),
    contentRoleRevision: key.contentRoleRevision,
    generationRevision: key.generationRevision,
    glossaryDigest: key.glossaryDigest,
    instructionDigest: key.instructionDigest,
    jsonPointer: key.jsonPointer,
    locale: key.locale,
    modelId: key.modelId,
    path: key.path,
    providerId: key.providerId,
    providerRevision: key.providerRevision,
    requestContextDigest: key.requestContextDigest,
    schemaVersion: key.schemaVersion,
    sourceDigest: key.sourceDigest,
    sourceText: key.sourceText,
    unitId: key.unitId,
  };
}

/** Glossary terms whose source form appears in the request text. */
export function selectRelevantGlossaryTerms(
  sourceText: string,
  glossary: readonly GlossaryTerm[] = [],
): GlossaryTerm[] {
  if (glossary.length === 0 || sourceText.length === 0) {
    return [];
  }
  const haystack = sourceText.toLocaleLowerCase();
  return glossary.filter((term) => {
    const needle = term.source.trim().toLocaleLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

function buildGenerationMaterial(args: {
  contentRoleRevision?: string;
  generationRevision: string;
  glossary?: readonly GlossaryTerm[];
  identity: TranslationCandidateCacheIdentity;
  instructionDigest: string;
  request: TranslationRequest;
}): GenerationKeyMaterial {
  const relevantGlossary = selectRelevantGlossaryTerms(
    args.request.sourceText,
    args.glossary,
  );
  return {
    catalogId: args.request.catalogId,
    ...(args.request.contentRole === undefined
      ? {}
      : { contentRole: args.request.contentRole }),
    contentRoleRevision: args.contentRoleRevision ?? "",
    generationRevision: args.generationRevision,
    glossaryDigest: digestValue(JSON.stringify(relevantGlossary)),
    instructionDigest: args.instructionDigest,
    jsonPointer: args.request.provenance.jsonPointer,
    locale: args.request.locale,
    modelId: args.identity.modelId,
    path: args.request.path,
    providerId: args.identity.providerId,
    providerRevision: args.identity.providerRevision,
    requestContextDigest: digestTranslationContext(args.request.context),
    schemaVersion: 2,
    sourceDigest: digestValue(args.request.sourceText),
    sourceText: args.request.sourceText,
    unitId: args.request.unitId,
  };
}

export function digestTranslationCandidateCacheKey(
  key: GenerationKeyMaterial,
): string {
  return digestValue(JSON.stringify(keyMaterial(key)));
}

/**
 * Digest for schemaVersion-1 records that still hashed
 * `deterministicContractRevision` into the key material.
 */
export function digestLegacyTranslationCandidateCacheKey(args: {
  material: GenerationKeyMaterial;
  deterministicContractRevision: string;
}): string {
  const { schemaVersion: _schemaVersion, ...shared } = keyMaterial(args.material);
  return digestValue(
    JSON.stringify({
      ...shared,
      deterministicContractRevision: args.deterministicContractRevision,
      schemaVersion: 1,
    }),
  );
}

export function createTranslationCandidateCacheKey({
  contentRoleRevision,
  generationRevision,
  glossary,
  identity,
  instructionDigest,
  request,
}: TranslationCandidateCacheKeyArgs): TranslationCandidateCacheKey {
  const material = buildGenerationMaterial({
    ...(contentRoleRevision === undefined ? {} : { contentRoleRevision }),
    generationRevision,
    ...(glossary === undefined ? {} : { glossary }),
    identity,
    instructionDigest,
    request,
  });
  return {
    ...material,
    digest: digestTranslationCandidateCacheKey(material),
  };
}

/** Probe key that locates a pre-redesign cache file by its historical digest. */
export function createLegacyTranslationCandidateCacheProbeKey(args: {
  deterministicContractRevision: string;
  key: TranslationCandidateCacheKey;
}): TranslationCandidateCacheKey {
  const { digest: _digest, ...material } = args.key;
  return {
    ...material,
    digest: digestLegacyTranslationCandidateCacheKey({
      deterministicContractRevision: args.deterministicContractRevision,
      material,
    }),
  };
}

export function generationCacheKeyMaterialMatches(
  left: GenerationKeyMaterial,
  right: GenerationKeyMaterial,
): boolean {
  return (
    left.catalogId === right.catalogId &&
    left.contentRole === right.contentRole &&
    left.contentRoleRevision === right.contentRoleRevision &&
    left.generationRevision === right.generationRevision &&
    left.glossaryDigest === right.glossaryDigest &&
    left.instructionDigest === right.instructionDigest &&
    left.jsonPointer === right.jsonPointer &&
    left.locale === right.locale &&
    left.modelId === right.modelId &&
    left.path === right.path &&
    left.providerId === right.providerId &&
    left.providerRevision === right.providerRevision &&
    left.requestContextDigest === right.requestContextDigest &&
    left.sourceDigest === right.sourceDigest &&
    left.sourceText === right.sourceText &&
    left.unitId === right.unitId
  );
}

export function isValidTranslationCandidateCacheKey(
  key: TranslationCandidateCacheKey,
): boolean {
  const { digest, ...material } = key;
  return (
    /^[a-f0-9]{64}$/u.test(digest) &&
    digest === digestTranslationCandidateCacheKey(material)
  );
}

/** True for current keys and for legacy migration probes (historical digests). */
export function isReadableTranslationCandidateCacheKey(
  key: TranslationCandidateCacheKey,
): boolean {
  return (
    isValidTranslationCandidateCacheKey(key) ||
    (/^[a-f0-9]{64}$/u.test(key.digest) && key.schemaVersion === 2)
  );
}
