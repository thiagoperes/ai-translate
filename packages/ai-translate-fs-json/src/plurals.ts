import { seedPluralCategory, sortPluralCategories } from "@ai-translate/core/plural";
import type { PluralCategory, PluralKeyStrategy } from "@ai-translate/core/plural";
import type { JsonObject, JsonValue } from "@ai-translate/core/types";

/** Marks a plural family in `Entry.meta.structureGroup`. */
const PLURAL_GROUP_SUFFIX = "#plural";

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ResolvedGroup {
  /** Key of the first member as it appears in the object, so expansion can be
   * emitted in place and leave surrounding key order untouched. */
  anchor: string;
  base: string;
  members: ReadonlyMap<PluralCategory, string>;
}

function resolveGroups(
  object: JsonObject,
  strategy: PluralKeyStrategy,
): { byKey: ReadonlyMap<string, ResolvedGroup>; groups: readonly ResolvedGroup[] } {
  const keys = Object.keys(object);
  const byKey = new Map<string, ResolvedGroup>();
  const groups: ResolvedGroup[] = [];

  for (const group of strategy.groupKeys(keys)) {
    const memberKeys = new Set(group.members.values());
    const anchor = keys.find((key) => memberKeys.has(key));
    if (anchor === undefined) {
      continue;
    }
    // A family is only a family if every member is a string. A nested object
    // sharing the suffix pattern is a coincidence, not grammar.
    if (![...memberKeys].every((key) => typeof object[key] === "string")) {
      continue;
    }
    const resolved: ResolvedGroup = { anchor, base: group.base, members: group.members };
    groups.push(resolved);
    for (const key of memberKeys) {
      byKey.set(key, resolved);
    }
  }

  return { byKey, groups };
}

/**
 * The categories a target locale's file should carry for one family.
 *
 * This is the union of what the locale grammatically requires and what the
 * source already declares, never just the former. Pruning to the locale's own
 * set would delete English's `one` form from a Japanese file — which the engine
 * then reports as a missing target entry — and would also delete i18next's
 * `zero`, a deliberate extra form that sits outside CLDR. Surplus keys are
 * inert at runtime; absent ones are bugs.
 */
export function targetPluralCategories(args: {
  locale: string;
  sourceCategories: readonly PluralCategory[];
  strategy: PluralKeyStrategy;
}): readonly PluralCategory[] {
  return sortPluralCategories([
    ...new Set([...args.strategy.categoriesFor(args.locale), ...args.sourceCategories]),
  ]);
}

/**
 * Rewrites a source document so each plural family carries the forms the target
 * locale needs, seeding new forms from the closest source form.
 *
 * Seeded text is never treated as translated: it enters the pipeline as source
 * content for a pointer the target has no state for, so the engine translates
 * it like any other new entry. Seeding only decides what the model is shown.
 */
export function expandPluralKeys(
  root: JsonValue,
  locale: string,
  strategy: PluralKeyStrategy,
): JsonValue {
  if (Array.isArray(root)) {
    return root.map((item) => expandPluralKeys(item, locale, strategy));
  }
  if (!isJsonObject(root)) {
    return root;
  }

  const { byKey, groups } = resolveGroups(root, strategy);
  if (groups.length === 0) {
    return Object.fromEntries(
      Object.entries(root).map(([key, value]) => [key, expandPluralKeys(value, locale, strategy)]),
    );
  }

  const expanded: JsonObject = {};
  for (const [key, value] of Object.entries(root)) {
    const group = byKey.get(key);
    if (group === undefined) {
      expanded[key] = expandPluralKeys(value, locale, strategy);
      continue;
    }
    if (group.anchor !== key) {
      // Emitted already, with the rest of its family, at the anchor.
      continue;
    }

    const sourceCategories = sortPluralCategories([...group.members.keys()]);
    for (const category of targetPluralCategories({ locale, sourceCategories, strategy })) {
      const seed = group.members.get(seedPluralCategory(category, sourceCategories));
      const seedValue = seed === undefined ? undefined : root[seed];
      if (typeof seedValue === "string") {
        expanded[strategy.formatKey(group.base, category)] = seedValue;
      }
    }
  }

  return expanded;
}

/**
 * Maps each key of a plural family to a stable group id, for every object level
 * in a document.
 *
 * Keys are JSON pointers so the caller can look up an entry by address without
 * re-deriving the object structure.
 */
export function pluralStructureGroups(
  root: JsonValue,
  strategy: PluralKeyStrategy,
): ReadonlyMap<string, string> {
  const groups = new Map<string, string>();

  const walk = (value: JsonValue, pointer: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${pointer}/${String(index)}`);
      });
      return;
    }
    if (!isJsonObject(value)) {
      return;
    }

    const { byKey } = resolveGroups(value, strategy);
    for (const [key, child] of Object.entries(value)) {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const childPointer = `${pointer}/${escaped}`;
      const group = byKey.get(key);
      if (group !== undefined) {
        groups.set(childPointer, `${pointer}/${group.base}${PLURAL_GROUP_SUFFIX}`);
        continue;
      }
      walk(child, childPointer);
    }
  };

  walk(root, "");
  return groups;
}

/**
 * Collapses plural families to their base before digesting, so the raw
 * structure digest of an English file matches its Polish translation even
 * though the Polish file carries two extra keys.
 */
export function collapsePluralFamilies(root: JsonValue, strategy: PluralKeyStrategy): JsonValue {
  if (Array.isArray(root)) {
    return root.map((item) => collapsePluralFamilies(item, strategy));
  }
  if (!isJsonObject(root)) {
    return root;
  }

  const { byKey } = resolveGroups(root, strategy);
  const collapsed: JsonObject = {};
  for (const [key, value] of Object.entries(root)) {
    const group = byKey.get(key);
    if (group === undefined) {
      collapsed[key] = collapsePluralFamilies(value, strategy);
      continue;
    }
    collapsed[`${group.base}${PLURAL_GROUP_SUFFIX}`] = "";
  }

  return collapsed;
}
