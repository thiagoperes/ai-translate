import type { Entry, TranslationCandidateSegmentDeltaConfig, TranslationRequest } from "./types";

export interface TranslationDeltaSegment {
  separator: string;
  sourceText: string;
}

const DEFAULT_MAX_SEGMENTS = 8;
const DEFAULT_MIN_SEGMENT_LENGTH = 48;
const DEFAULT_MIN_SOURCE_LENGTH = 240;
const SENTENCE_BOUNDARY_PATTERN = /[.!?](?:["'’”)\]}]+)?[ \t]+/gu;
const UNSAFE_PERIOD_ENDING_PATTERN =
  /(?:\b(?:dr|e\.g|etc|fig|i\.e|inc|jr|ltd|mr|mrs|ms|no|prof|sr|st|vs)|\b[A-Z]|\bU\.K|\bU\.S)\.$/u;
const CONTEXT_DEPENDENT_OPENING_PATTERN =
  /^(?:also|and|as a result|because|besides|but|consequently|furthermore|he|her|hers|him|his|however|in addition|instead|it|its|likewise|meanwhile|moreover|nevertheless|otherwise|she|such|that|their|theirs|them|then|therefore|these|they|this|those|thus|yet)\b/iu;
const SENSITIVE_SCOPE_PATTERN =
  /(?:\d|[%€£$]|[:;]|\b(?:all|always|any|cannot|can['’]t|didn['’]t|doesn['’]t|don['’]t|each|every|guarantee|guaranteed|hadn['’]t|hasn['’]t|haven['’]t|isn['’]t|must|neither|never|no|none|nor|not|only|refund|risk-free|unlimited|unless|wasn['’]t|weren['’]t|without|won['’]t)\b)/iu;

export const SEGMENT_DELTA_CONTEXT_NOTE =
  "Sentence delta contract v1: translate this complete source sentence independently. Return only its translation, preserve every claim, qualifier, number, and literal, and do not add context from neighboring sentences. The full field will be reconstructed and validated afterwards.";

function isUnsafeBoundary(value: string): boolean {
  return value.endsWith(".") && UNSAFE_PERIOD_ENDING_PATTERN.test(value);
}

function splitCompleteSentences(sourceText: string): TranslationDeltaSegment[] {
  const segments: TranslationDeltaSegment[] = [];
  let segmentStart = 0;
  for (const match of sourceText.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const trailingWhitespace = /[ \t]+$/u.exec(match[0])?.[0] ?? "";
    const segmentEnd = match.index + match[0].length - trailingWhitespace.length;
    const candidate = sourceText.slice(segmentStart, segmentEnd);
    if (isUnsafeBoundary(candidate)) {
      continue;
    }
    segments.push({ separator: trailingWhitespace, sourceText: candidate });
    segmentStart = segmentEnd + trailingWhitespace.length;
  }
  segments.push({ separator: "", sourceText: sourceText.slice(segmentStart) });
  return segments;
}

function isIndependentSentence(sourceText: string): boolean {
  const normalized = sourceText.replace(/^["'‘’“”([{]+/u, "").trim();
  return (
    !CONTEXT_DEPENDENT_OPENING_PATTERN.test(normalized) &&
    !SENSITIVE_SCOPE_PATTERN.test(normalized)
  );
}

export function splitTranslationDeltaSegments(
  sourceText: string,
  config: TranslationCandidateSegmentDeltaConfig,
): readonly TranslationDeltaSegment[] | undefined {
  const minSourceLength = config.minSourceLength ?? DEFAULT_MIN_SOURCE_LENGTH;
  const minSegmentLength = config.minSegmentLength ?? DEFAULT_MIN_SEGMENT_LENGTH;
  const maxSegments = config.maxSegments ?? DEFAULT_MAX_SEGMENTS;

  if (
    !
    config.enabled ||
    sourceText.length < minSourceLength ||
    sourceText.trim() !== sourceText ||
    /[\r\n]/u.test(sourceText)
  ) {
    return undefined;
  }

  const segments = splitCompleteSentences(sourceText);
  if (
    segments.length < 2 ||
    segments.length > maxSegments ||
    new Set(segments.map(({ sourceText: segment }) => segment)).size !== segments.length ||
    segments.some(
      ({ sourceText: segment }) =>
        segment.length < minSegmentLength ||
        segment.trim() !== segment ||
        segment.split(/\s+/u).length < 5 ||
        !isIndependentSentence(segment),
    )
  ) {
    return undefined;
  }

  return segments;
}

export function alignTranslationDeltaSegments(
  sourceSegments: readonly TranslationDeltaSegment[],
  targetText: string,
): readonly string[] | undefined {
  if (targetText.trim() !== targetText || /[\r\n]/u.test(targetText)) {
    return undefined;
  }
  const targetSegments = splitCompleteSentences(targetText);
  if (
    targetSegments.length !== sourceSegments.length ||
    targetSegments.some(({ sourceText }) => sourceText.trim().length === 0)
  ) {
    return undefined;
  }
  return targetSegments.map(({ sourceText }) => sourceText.trim());
}

export function canReuseTranslationSegments(args: {
  config: TranslationCandidateSegmentDeltaConfig | undefined;
  entry: Entry;
  request: TranslationRequest;
  semanticAuditRepair: boolean;
}): boolean {
  return (
    args.config?.enabled === true &&
    args.request.contentRole === "body" &&
    !
    args.semanticAuditRepair &&
    (args.entry.storage === "markdoc" || args.entry.storage === "string") &&
    (args.entry.tokens === undefined || args.entry.tokens.every((token) => token.type === "text")) &&
    (args.request.context?.constraints?.length ?? 0) === 0
  );
}
