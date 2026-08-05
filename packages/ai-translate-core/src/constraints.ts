import type {
  TranslationConstraint,
  TranslationValidationIssue,
  TranslationValidator,
} from "./types";

function candidatesForConstraint(constraint: TranslationConstraint): readonly string[] {
  if (constraint.requirement === "preserve") {
    return [constraint.value];
  }

  return constraint.targetValues?.length ? constraint.targetValues : [constraint.value];
}

function normalizePhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[\p{P}\p{S}\p{Z}\s]+/gu, " ")
    .trim();
}

function containsCandidate(
  targetText: string,
  candidate: string,
  match: "exact" | "normalized-phrase",
): boolean {
  if (match === "exact") {
    const escapedCandidate = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const leadingBoundary = /^[\p{L}\p{N}_]/u.test(candidate) ? "(?<![\\p{L}\\p{N}_])" : "";
    const trailingBoundary = /[\p{L}\p{N}_]$/u.test(candidate) ? "(?![\\p{L}\\p{N}_])" : "";
    return new RegExp(`${leadingBoundary}${escapedCandidate}${trailingBoundary}`, "u").test(
      targetText,
    );
  }

  const normalizedTarget = normalizePhrase(targetText);
  const normalizedCandidate = normalizePhrase(candidate);
  return (
    normalizedCandidate.length > 0 && ` ${normalizedTarget} `.includes(` ${normalizedCandidate} `)
  );
}

export function validateTranslationConstraints(args: {
  constraints: readonly TranslationConstraint[] | undefined;
  targetText: string;
}): TranslationValidationIssue[] {
  const issues: TranslationValidationIssue[] = [];

  for (const constraint of args.constraints ?? []) {
    const candidates = candidatesForConstraint(constraint);
    const match =
      constraint.match ?? (constraint.requirement === "preserve" ? "exact" : "normalized-phrase");
    if (
      constraint.requirement === "required-one-of" &&
      !candidates.some((candidate) => containsCandidate(args.targetText, candidate, match))
    ) {
      issues.push({
        code: "constraint-required-one-of",
        message: `Translation must contain one of: ${candidates.join(", ")}.`,
        severity: "error",
      });
    }

    if (
      constraint.requirement === "preserve" &&
      !containsCandidate(args.targetText, constraint.value, match)
    ) {
      issues.push({
        code: "constraint-preserve",
        message: `Translation must preserve "${constraint.value}" exactly.`,
        severity: "error",
      });
    }

    if (
      constraint.requirement === "forbid-any" &&
      candidates.some((candidate) => containsCandidate(args.targetText, candidate, match))
    ) {
      issues.push({
        code: "constraint-forbid-any",
        message: `Translation must not contain any of: ${candidates.join(", ")}.`,
        severity: "error",
      });
    }
  }

  return issues;
}

export const translationConstraintValidator: TranslationValidator = ({ context, targetText }) =>
  validateTranslationConstraints({
    constraints: context?.constraints,
    targetText,
  });
