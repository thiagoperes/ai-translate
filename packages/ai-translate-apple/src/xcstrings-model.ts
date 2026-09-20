import { addressToJsonPointer } from "@ai-translate/core/address";
import { digestValue } from "@ai-translate/core/hash";
import { plainMessageFormat } from "@ai-translate/core/message-format";
import { isPluralCategory, pluralCategoriesFor, sortPluralCategories } from "@ai-translate/core/plural";
import type { Entry, JsonObject, JsonValue } from "@ai-translate/core/types";
import { applePrintfMessageFormat } from "@ai-translate/message-formats";

export interface StringCatalog extends JsonObject {
  sourceLanguage: string;
  strings: JsonObject;
  version: string;
}

export interface CatalogState {
  catalog: StringCatalog;
  /** Canonical source shapes, possibly expanded for one target locale. */
  sourceRoots: JsonObject;
  roots: JsonObject;
  originalValues: ReadonlyMap<string, string>;
  writeState?: "new";
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function own(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export function put(object: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, { configurable: true, enumerable: true, value, writable: true });
}

function requireObject(value: unknown, location: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`Invalid String Catalog at ${location}: expected an object.`);
  }
  return value;
}

function validateNode(value: unknown, location: string, requireFallback: boolean, depth = 0): void {
  if (depth > 64) {
    throw new Error(`String Catalog localization nesting exceeds 64 levels at ${location}.`);
  }
  const node = requireObject(value, location);
  if (node.stringUnit === undefined && node.variations === undefined) {
    throw new Error(`Unsupported String Catalog localization at ${location}: expected stringUnit or variations.`);
  }
  if (node.stringUnit !== undefined) {
    const unit = requireObject(node.stringUnit, `${location}.stringUnit`);
    if (typeof unit.value !== "string" || typeof unit.state !== "string") {
      throw new Error(`Invalid String Catalog stringUnit at ${location}: value and state must be strings.`);
    }
  }
  if (node.variations !== undefined) {
    const variations = requireObject(node.variations, `${location}.variations`);
    if (Object.keys(variations).length === 0) {
      throw new Error(`Empty String Catalog variations at ${location}.`);
    }
    for (const [dimension, rawArms] of Object.entries(variations)) {
      if (dimension !== "plural" && dimension !== "device") {
        throw new Error(`Unsupported String Catalog variation "${dimension}" at ${location}.`);
      }
      const arms = requireObject(rawArms, `${location}.variations.${dimension}`);
      if (requireFallback && !Object.hasOwn(arms, "other")) {
        throw new Error(`String Catalog ${dimension} variation requires an other arm at ${location}.`);
      }
      for (const [arm, child] of Object.entries(arms)) {
        if (dimension === "plural" && !isPluralCategory(arm)) {
          throw new Error(`Invalid String Catalog plural category "${arm}" at ${location}.`);
        }
        validateNode(child, `${location}.variations.${dimension}.${arm}`, requireFallback, depth + 1);
      }
    }
  }
  if (node.substitutions !== undefined) {
    const substitutions = requireObject(node.substitutions, `${location}.substitutions`);
    for (const [name, rawSubstitution] of Object.entries(substitutions)) {
      const substitution = requireObject(rawSubstitution, `${location}.substitutions.${name}`);
      if (!Number.isSafeInteger(substitution.argNum) || (substitution.argNum as number) < 1 ||
        typeof substitution.formatSpecifier !== "string" || substitution.formatSpecifier.length === 0) {
        throw new Error(`Invalid String Catalog substitution "${name}" at ${location}: expected argNum and formatSpecifier.`);
      }
      validateNode(substitution, `${location}.substitutions.${name}`, requireFallback, depth + 1);
    }
  }
}

export function parseCatalog(text: string, filePath: string, sourceLocale: string): StringCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in String Catalog ${filePath}.`, { cause: error });
  }
  const catalog = requireObject(parsed, filePath);
  // Current Xcode extraction emits 1.3. These minor versions retain the
  // localization tree validated below; preserve their version and metadata.
  if (typeof catalog.version !== "string" || !["1.0", "1.1", "1.2", "1.3"].includes(catalog.version)) {
    throw new Error(`Unsupported String Catalog version in ${filePath}: expected "1.0", "1.1", "1.2", or "1.3".`);
  }
  if (catalog.sourceLanguage !== sourceLocale) {
    throw new Error(`String Catalog ${filePath} sourceLanguage must match sourceLocale "${sourceLocale}".`);
  }
  const strings = requireObject(catalog.strings, `${filePath}.strings`);
  for (const [key, rawString] of Object.entries(strings)) {
    const string = requireObject(rawString, `${filePath}.strings[${JSON.stringify(key)}]`);
    if (string.shouldTranslate !== undefined && typeof string.shouldTranslate !== "boolean") {
      throw new Error(`Invalid shouldTranslate for String Catalog key ${JSON.stringify(key)} in ${filePath}.`);
    }
    if (string.comment !== undefined && typeof string.comment !== "string") {
      throw new Error(`Invalid comment for String Catalog key ${JSON.stringify(key)} in ${filePath}.`);
    }
    if (string.localizations !== undefined) {
      const localizations = requireObject(string.localizations, `${filePath}.${key}.localizations`);
      for (const [locale, localization] of Object.entries(localizations)) {
        validateNode(localization, `${filePath}.${key}.localizations.${locale}`, locale === sourceLocale);
      }
    }
  }
  return catalog as StringCatalog;
}

export function isTranslatable(key: string, string: JsonObject): boolean {
  return key.length > 0 && string.shouldTranslate !== false && string.extractionState !== "stale";
}

export function localeRoots(catalog: StringCatalog, locale: string): JsonObject {
  return Object.fromEntries(Object.entries(catalog.strings).flatMap(([key, rawString]) => {
    const string = rawString as JsonObject;
    if (!isTranslatable(key, string)) {
      return [];
    }
    const localizations = string.localizations as JsonObject | undefined;
    const node = localizations === undefined ? undefined : own(localizations, locale);
    if (node !== undefined) {
      return [[key, structuredClone(node)]];
    }
    return locale === catalog.sourceLanguage
      ? [[key, { stringUnit: { state: "translated", value: key } }]]
      : [];
  }));
}

function fallbackNode(node: JsonObject): JsonObject {
  if (isObject(node.stringUnit)) {
    const fallback = structuredClone(node);
    delete fallback.variations;
    return fallback;
  }
  for (const arms of Object.values(isObject(node.variations) ? node.variations : {})) {
    if (isObject(arms) && isObject(arms.other)) {
      return fallbackNode(arms.other);
    }
  }
  throw new Error("String Catalog source variation requires a string fallback.");
}

function assertSourceSubstitutions(source: JsonObject, target: JsonObject | undefined, location: string): void {
  const sourceBindings = isObject(source.substitutions) ? source.substitutions : {};
  const targetBindings = isObject(target?.substitutions) ? target.substitutions : {};
  for (const name of Object.keys(targetBindings)) {
    if (!Object.hasOwn(sourceBindings, name)) {
      throw new Error(`Unsupported target-only String Catalog substitution ${JSON.stringify(name)} at ${location}. Define the corresponding substitution in the source localization before translating; its fragment meaning cannot be derived safely from flat source text.`);
    }
  }
}

export function expandNode(node: JsonObject, locale: string, target?: JsonObject, location = "localization"): JsonObject {
  assertSourceSubstitutions(node, target, `${location} (${locale})`);
  const expanded = structuredClone(node);
  const sourceVariations = isObject(node.variations) ? node.variations : {};
  const targetVariations = isObject(target?.variations) ? target.variations : {};
  const dimensions = [...new Set([...Object.keys(sourceVariations), ...Object.keys(targetVariations)])];
  if (dimensions.length > 0) {
    const variations: JsonObject = {};
    for (const dimension of dimensions) {
      const arms = (own(sourceVariations, dimension) ?? {}) as JsonObject;
      const targetArms = (own(targetVariations, dimension) ?? {}) as JsonObject;
      const present = [...new Set([...Object.keys(arms), ...Object.keys(targetArms), "other"])];
      const categories = dimension === "plural"
        ? sortPluralCategories([...new Set([...present, ...pluralCategoriesFor(locale)])])
        : present;
      const fallback = own(arms, "other") ?? fallbackNode(node);
      put(variations, dimension, Object.fromEntries(categories.map((category) => [
        category,
        expandNode((own(arms, category) ?? fallback) as JsonObject, locale, own(targetArms, category) as JsonObject | undefined,
          `${location}.variations.${dimension}.${category}`),
      ])));
    }
    expanded.variations = variations;
    // Xcode allows a locale to vary an otherwise plain source string, for
    // example shortening only its Apple Watch translation. The fallback
    // source text supplies those branches; translated text never becomes a
    // translation source.
    if (Object.keys(sourceVariations).length === 0 && target?.stringUnit === undefined) {
      delete expanded.stringUnit;
    }
  }
  if (isObject(node.substitutions)) {
    expanded.substitutions = Object.fromEntries(Object.entries(node.substitutions)
      .map(([name, substitution]) => [name, expandNode(substitution as JsonObject, locale,
        isObject(target?.substitutions) ? own(target.substitutions, name) as JsonObject | undefined : undefined,
        `${location}.substitutions.${name}`)]));
  }
  return expanded;
}

function substitutionBindings(node: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(isObject(node.substitutions) ? node.substitutions : {})
    .map(([name, substitution]) => {
      const binding = substitution as JsonObject;
      return [name, [binding.argNum ?? null, binding.formatSpecifier ?? null]];
    }));
}

function visitUnits(
  node: JsonObject,
  keys: readonly string[],
  visit: (unit: JsonObject, keys: readonly string[], bindings: JsonObject) => void,
  inheritedBindings: JsonObject = {},
): void {
  const bindings = { ...inheritedBindings, ...substitutionBindings(node) };
  if (isObject(node.stringUnit)) {
    visit(node.stringUnit, [...keys, "stringUnit", "value"], bindings);
  }
  if (isObject(node.variations)) {
    for (const [dimension, arms] of Object.entries(node.variations)) {
      for (const [arm, child] of Object.entries(arms as JsonObject)) {
        visitUnits(child as JsonObject, [...keys, "variations", dimension, arm], visit, bindings);
      }
    }
  }
  if (isObject(node.substitutions)) {
    for (const [name, substitution] of Object.entries(node.substitutions)) {
      visitUnits(substitution as JsonObject, [...keys, "substitutions", name], visit, bindings);
    }
  }
}

export function buildCatalogEntries(catalog: StringCatalog, roots: JsonObject, source: boolean, plainTextKeys?: ReadonlySet<string>): Entry[] {
  const entries: Entry[] = [];
  for (const [key, root] of Object.entries(roots)) {
    const string = own(catalog.strings, key) as JsonObject;
    const format = plainTextKeys?.has(key) === true ? plainMessageFormat : applePrintfMessageFormat;
    visitUnits(root as JsonObject, [key], (unit, keys, unitBindings) => {
      const bindings = JSON.stringify(Object.fromEntries(Object.entries(unitBindings).toSorted(([left], [right]) => left.localeCompare(right))));
      const address = keys.map((part) => ({ kind: "key" as const, key: part }));
      const notes = [`Apple string key: ${JSON.stringify(key)}`];
      if (typeof string.comment === "string" && string.comment.length > 0) {
        notes.push(string.comment);
      }
      if (bindings !== "{}") {
        notes.push(`Apple substitution arguments: ${bindings}.`);
      }
      const groupKeys = [...keys];
      let plural = false;
      for (let index = 1; index < keys.length; index += 1) {
        if (keys[index] === "variations") {
          const dimension = keys[index + 1];
          const arm = keys[index + 2];
          notes.push(`${dimension === "plural" ? "Plural category" : "Device"}: ${arm ?? ""}.`);
          if (dimension === "plural") {
            groupKeys[index + 2] = "*";
            plural = true;
          }
          index += 2;
        } else if (keys[index] === "substitutions") {
          notes.push(`Substitution: ${keys[index + 1] ?? ""}.`);
          index += 1;
        }
      }
      const value = source || unit.state === "translated" ? unit.value as string : null;
      entries.push({
        address,
        context: { notes: notes.join("\n") },
        messageFormatId: format.id,
        meta: {
          appleSubstitutionBindings: bindings,
          ...(typeof string.comment === "string" ? { comment: string.comment } : {}),
          ...(bindings === "{}" ? {} : { structureSignature: bindings }),
          ...(plural ? { structureGroup: addressToJsonPointer(groupKeys.map((part) => ({ kind: "key", key: part }))) } : {}),
        },
        policy: "translate",
        storage: "string",
        ...(value === null ? {} : { tokens: [...format.tokenize(value)] }),
        value,
      });
    });
  }
  return entries;
}

export function structureDigest(entries: readonly Entry[]): string {
  return digestValue(JSON.stringify([...new Set(entries.map((entry) =>
    entry.meta?.structureGroup ?? addressToJsonPointer(entry.address)))].toSorted((left, right) => String(left).localeCompare(String(right)))));
}

export function entryValues(entries: readonly Entry[]): ReadonlyMap<string, string> {
  return new Map(entries.flatMap((entry) => typeof entry.value === "string"
    ? [[addressToJsonPointer(entry.address), entry.value]] : []));
}

export function pendingNode(node: JsonObject): JsonObject {
  const pending = structuredClone(node);
  visitUnits(pending, [], (unit) => { unit.state = "new"; });
  return pending;
}

function assertUnchanged(current: JsonValue | undefined, original: JsonValue | undefined): void {
  if (JSON.stringify(current) !== JSON.stringify(original)) {
    throw new Error("String Catalog translation structure changed before writing.");
  }
}

/** Keep target metadata, but replace structural fields removed by the source. */
export function alignNode(node: JsonObject, template: JsonObject, original: JsonObject = {}): void {
  assertSourceSubstitutions(template, node, "target localization");
  for (const field of ["stringUnit", "variations", "substitutions"]) {
    if (template[field] === undefined && node[field] !== undefined) {
      assertUnchanged(node[field], original[field]);
      delete node[field];
    }
  }
  if (template.argNum !== undefined) {
    for (const field of ["argNum", "formatSpecifier"]) {
      if (node[field] !== template[field]) {
        assertUnchanged(node[field], original[field]);
      }
    }
    node.argNum = template.argNum;
    node.formatSpecifier = template.formatSpecifier as string;
  }
  for (const field of ["variations", "substitutions"]) {
    if (!isObject(template[field]) || !isObject(node[field])) {
      continue;
    }
    const target = node[field];
    const source = template[field];
    const previous = isObject(original[field]) ? original[field] : {};
    for (const [name, child] of Object.entries(target)) {
      const sourceChild = own(source, name);
      if (!isObject(sourceChild)) {
        assertUnchanged(child, own(previous, name));
        delete target[name];
      } else if (isObject(child)) {
        const originalChild = own(previous, name);
        const previousChild = isObject(originalChild) ? originalChild : {};
        if (field === "substitutions") {
          alignNode(child, sourceChild, previousChild);
        } else {
          for (const [arm, armNode] of Object.entries(child)) {
            const sourceArm = own(sourceChild, arm);
            const originalArm = own(previousChild, arm);
            if (isObject(armNode) && isObject(sourceArm)) {
              alignNode(armNode, sourceArm, isObject(originalArm) ? originalArm : {});
            }
          }
        }
      }
    }
  }
}

/** Sets one leaf without copying untranslated siblings from the source shape. */
export function setUnit(root: JsonObject, template: JsonObject, keys: readonly string[], value: string, state: string): void {
  if (keys.length < 3 || keys.at(-2) !== "stringUnit" || keys.at(-1) !== "value") {
    throw new Error(`Invalid String Catalog entry address ${JSON.stringify(keys)}.`);
  }
  let node = root;
  let source = template;
  for (const key of keys.slice(0, -2)) {
    const sourceChild = own(source, key);
    if (!isObject(sourceChild)) {
      throw new Error(`Cannot write unknown String Catalog entry ${JSON.stringify(keys)}.`);
    }
    const existing = own(node, key);
    if (!isObject(existing)) {
      // A new plural/device node needs its fallback arms to remain compilable.
      // Those seeded siblings stay `new`, so a scoped write never accepts them
      // as translations. Other top-level keys remain completely absent.
      put(node, key, sourceChild.stringUnit !== undefined || sourceChild.variations !== undefined
        ? pendingNode(sourceChild) : {});
    }
    node = own(node, key) as JsonObject;
    source = sourceChild;
  }
  const sourceUnit = source.stringUnit;
  if (!isObject(sourceUnit)) {
    throw new Error(`Cannot write unknown String Catalog stringUnit ${JSON.stringify(keys)}.`);
  }
  node.stringUnit = { ...sourceUnit, ...(isObject(node.stringUnit) ? node.stringUnit : {}), state, value };
}
