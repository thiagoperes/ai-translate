import { addressToJsonPointer } from "./address";
import type {
  Entry,
  PathPolicyRule,
  Policy,
  TranslationConstraint,
  TranslationContext,
  TranslationContextRule,
} from "./types";

function splitPattern(pattern: string): string[] {
  if (pattern === "" || pattern === "/") {
    return [];
  }

  const normalized = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return normalized.split("/").slice(1);
}

function matchesPath(pattern: string, pointer: string): boolean {
  const patternSegments = splitPattern(pattern);
  const pointerSegments = splitPattern(pointer);

  let patternIndex = 0;
  let pointerIndex = 0;

  while (patternIndex < patternSegments.length && pointerIndex < pointerSegments.length) {
    const patternSegment = patternSegments[patternIndex];
    const pointerSegment = pointerSegments[pointerIndex];

    if (patternSegment === "**") {
      if (patternIndex === patternSegments.length - 1) {
        return true;
      }

      const nextPattern = patternSegments[patternIndex + 1];
      while (pointerIndex < pointerSegments.length) {
        if (nextPattern === pointerSegments[pointerIndex]) {
          break;
        }

        pointerIndex += 1;
      }

      patternIndex += 1;
      continue;
    }

    if (patternSegment !== "*" && patternSegment !== pointerSegment) {
      return false;
    }

    patternIndex += 1;
    pointerIndex += 1;
  }

  return patternIndex === patternSegments.length && pointerIndex === pointerSegments.length;
}

function matchesValue(pattern: RegExp | string | undefined, value: string): boolean {
  if (pattern === undefined) {
    return true;
  }

  if (typeof pattern === "string") {
    return pattern === value;
  }

  return pattern.test(value);
}

function normalizeContextValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConstraint(
  constraint: TranslationConstraint,
): TranslationConstraint | undefined {
  const value = constraint.value.trim();
  if (value.length === 0) {
    return undefined;
  }

  const note = normalizeContextValue(constraint.note);
  const sourceValues = [...new Set(
    (constraint.sourceValues ?? [])
      .map((candidate) => normalizeContextValue(candidate))
      .filter((candidate): candidate is string => candidate !== undefined),
  )].toSorted();
  const targetValue = normalizeContextValue(constraint.targetValue);
  const targetValues = [...new Set(
    [targetValue, ...(constraint.targetValues ?? [])]
      .map((candidate) => normalizeContextValue(candidate))
      .filter((candidate): candidate is string => candidate !== undefined),
  )].toSorted();
  return {
    kind: constraint.kind,
    ...(constraint.match === undefined ? {} : { match: constraint.match }),
    ...(note === undefined ? {} : { note }),
    ...(constraint.requirement === undefined ? {} : { requirement: constraint.requirement }),
    ...(sourceValues.length === 0 ? {} : { sourceValues }),
    ...(targetValues.length === 0 ? {} : { targetValues }),
    value,
  };
}

function constraintKey(constraint: TranslationConstraint): string {
  return JSON.stringify([
    constraint.kind,
    constraint.match ?? "",
    constraint.value,
    constraint.requirement ?? "",
    ...(constraint.sourceValues === undefined
      ? []
      : ["source-values", ...constraint.sourceValues]),
    ...(constraint.targetValues ?? []),
    constraint.note ?? "",
  ]);
}

function normalizeConstraints(
  constraints: readonly TranslationConstraint[] | undefined,
): readonly TranslationConstraint[] | undefined {
  if (!constraints || constraints.length === 0) {
    return undefined;
  }

  const normalized = constraints
    .map(normalizeConstraint)
    .filter((constraint): constraint is TranslationConstraint => constraint !== undefined);
  const deduplicated = new Map(normalized.map((constraint) => [constraintKey(constraint), constraint]));
  const result = [...deduplicated.values()].toSorted((left, right) =>
    constraintKey(left).localeCompare(constraintKey(right)),
  );
  return result.length === 0 ? undefined : result;
}

/**
 * Normalization is a pure function of the context object, and the objects that
 * reach it are long-lived: a run resolves the same `context.project` and the
 * same rule contexts once per entry, which on a large corpus means normalizing
 * the identical object a million times — trimming the same strings, sorting and
 * stringifying the same constraints. Keyed on identity rather than content
 * because hashing the content is the work being avoided.
 *
 * Contexts are treated as immutable values everywhere in the engine. Mutating
 * one after it has been normalized would serve the previous result.
 */
const normalizedContexts = new WeakMap<
  TranslationContext,
  TranslationContext | undefined
>();

export function normalizeTranslationContext(
  context: TranslationContext | undefined,
): TranslationContext | undefined {
  if (context === undefined) {
    return undefined;
  }

  if (normalizedContexts.has(context)) {
    return normalizedContexts.get(context);
  }

  const result = normalizeTranslationContextUncached(context);
  normalizedContexts.set(context, result);
  return result;
}

function normalizeTranslationContextUncached(
  context: TranslationContext,
): TranslationContext | undefined {
  const normalized: TranslationContext = {};
  const audience = normalizeContextValue(context.audience);
  const constraints = normalizeConstraints(context.constraints);
  const notes = normalizeContextValue(context.notes);
  const product = normalizeContextValue(context.product);
  const purpose = normalizeContextValue(context.purpose);
  const tone = normalizeContextValue(context.tone);

  if (audience !== undefined) {
    normalized.audience = audience;
  }

  if (constraints !== undefined) {
    normalized.constraints = constraints;
  }

  if (notes !== undefined) {
    normalized.notes = notes;
  }

  if (product !== undefined) {
    normalized.product = product;
  }

  if (purpose !== undefined) {
    normalized.purpose = purpose;
  }

  if (tone !== undefined) {
    normalized.tone = tone;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function appendField(
  baseValue: string | undefined,
  nextValue: string | undefined,
): string | undefined {
  if (!baseValue) {
    return nextValue;
  }

  if (!nextValue) {
    return baseValue;
  }

  return `${baseValue}\n${nextValue}`;
}

export function mergeTranslationContexts(
  baseContext: TranslationContext | undefined,
  nextContext: TranslationContext | undefined,
): TranslationContext | undefined {
  if (!baseContext) {
    return nextContext;
  }

  if (!nextContext) {
    return baseContext;
  }

  const merged: TranslationContext = {};
  const audience = appendField(baseContext.audience, nextContext.audience);
  const constraints = normalizeConstraints([
    ...(baseContext.constraints ?? []),
    ...(nextContext.constraints ?? []),
  ]);
  const notes = appendField(baseContext.notes, nextContext.notes);
  const product = appendField(baseContext.product, nextContext.product);
  const purpose = appendField(baseContext.purpose, nextContext.purpose);
  const tone = appendField(baseContext.tone, nextContext.tone);

  if (audience !== undefined) {
    merged.audience = audience;
  }

  if (constraints !== undefined) {
    merged.constraints = constraints;
  }

  if (notes !== undefined) {
    merged.notes = notes;
  }

  if (product !== undefined) {
    merged.product = product;
  }

  if (purpose !== undefined) {
    merged.purpose = purpose;
  }

  if (tone !== undefined) {
    merged.tone = tone;
  }

  return normalizeTranslationContext(merged);
}

function matchesPolicyRule(
  rule: PathPolicyRule,
  args: {
    catalogId: string;
    locale: string;
    pointer: string;
    unitId: string;
  },
): boolean {
  return (
    (rule.catalogId === undefined || rule.catalogId === args.catalogId) &&
    matchesValue(rule.locale, args.locale) &&
    matchesValue(rule.unitId, args.unitId) &&
    matchesPath(rule.path, args.pointer)
  );
}

export function resolvePolicy(
  args: {
    catalogId: string;
    entry: Entry;
    locale: string;
    rules?: readonly PathPolicyRule[];
    unitId: string;
  },
): Policy {
  const { catalogId, entry, locale, rules, unitId } = args;
  if (!rules || rules.length === 0) {
    return entry.policy;
  }

  const pointer = addressToJsonPointer(entry.address);
  let resolved = entry.policy;

  for (const rule of rules) {
    if (
      matchesPolicyRule(rule, {
        catalogId,
        locale,
        pointer,
        unitId,
      })
    ) {
      resolved = rule.policy;
    }
  }

  return resolved;
}

export function resolveTranslationContext(
  args: {
    baseContext?: TranslationContext;
    catalogId: string;
    locale: string;
    rules?: readonly TranslationContextRule[];
    path?: string;
    unitId: string;
  }
): TranslationContext | undefined {
  const { baseContext, catalogId, locale, path, rules, unitId } = args;
  let resolved = normalizeTranslationContext(baseContext);

  for (const rule of rules ?? []) {
    if (rule.catalogId !== undefined && rule.catalogId !== catalogId) {
      continue;
    }

    if (!matchesValue(rule.locale, locale) || !matchesValue(rule.unitId, unitId)) {
      continue;
    }

    if (rule.path !== undefined && !matchesPath(rule.path, path ?? "")) {
      continue;
    }

    const nextContext = normalizeTranslationContext(rule.context);
    resolved =
      rule.mode === "replace"
        ? nextContext
        : mergeTranslationContexts(resolved, nextContext);
  }

  return resolved;
}
