import path from "node:path";

import {
  defineIntegration,
  findProjectFiles,
  isLocaleTag,
  readStringLiteral,
  resolveSourceLocale,
} from "@ai-translate/integrations";
import { convertPathToPattern } from "globby";
import ignore from "ignore";

import { parseCatalog } from "./xcstrings-model";
import type {
  AdapterCatalogPlan,
  DetectionContext,
  DetectionEvidence,
  Integration,
} from "@ai-translate/integrations";

export const APPLE_INTEGRATION_ID = "apple";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CatalogMetadata {
  file: string;
  locales: readonly string[];
  sourceLocale: string;
}

async function readCatalogMetadata(
  context: DetectionContext,
  file: string,
): Promise<CatalogMetadata | null> {
  try {
    const text = ((await context.readFile(file)) ?? "").replace(/^\uFEFF/u, "");
    const parsed: unknown = JSON.parse(text);
    if (!record(parsed) || typeof parsed.sourceLanguage !== "string" ||
      !isLocaleTag(parsed.sourceLanguage) || !record(parsed.strings)) {
      return null;
    }
    parseCatalog(text, file, parsed.sourceLanguage);
    const locales = new Set<string>();
    for (const entry of Object.values(parsed.strings)) {
      if (record(entry) && record(entry.localizations)) {
        for (const locale of Object.keys(entry.localizations)) {
          if (isLocaleTag(locale)) {
            locales.add(locale);
          }
        }
      }
    }
    return { file, locales: [...locales], sourceLocale: parsed.sourceLanguage };
  } catch {
    return null;
  }
}

interface ProjectMetadata {
  file: string;
  rootDir: string;
  sourceLocale: string | undefined;
  locales: readonly string[];
}

function inside(file: string, root: string): boolean {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

function localeIdentity(locale: string): string {
  return Intl.getCanonicalLocales(locale)[0]?.toLowerCase() ?? locale.toLowerCase();
}

/** A single configured locale must address one physical spelling everywhere.
 * Resource names take precedence over project metadata; conflicting resource
 * aliases require normalization before they can safely share a target. */
function selectTargetLocales(
  resourceLocales: Iterable<string>,
  declaredLocales: Iterable<string>,
  sourceLocale: string,
  warnings: string[],
): readonly string[] {
  const source = localeIdentity(sourceLocale);
  const spellings = new Map<string, Set<string>>();
  for (const locale of resourceLocales) {
    const identity = localeIdentity(locale);
    if (identity === source) { continue; }
    const names = spellings.get(identity) ?? new Set<string>();
    names.add(locale);
    spellings.set(identity, names);
  }
  const targets = new Map<string, string>();
  for (const [identity, names] of spellings) {
    const [locale] = names;
    if (names.size > 1) {
      warnings.push(`Locale spellings ${[...names].toSorted().join(", ")} identify the same language in existing resources. This language was omitted from targetLocales; normalize its resource names before syncing.`);
    } else if (locale !== undefined) {
      targets.set(identity, locale);
    }
  }
  for (const locale of declaredLocales) {
    const identity = localeIdentity(locale);
    if (identity !== source && !spellings.has(identity)) {
      targets.set(identity, Intl.getCanonicalLocales(locale)[0] ?? locale);
    }
  }
  return [...targets.values()].toSorted();
}

function commentsRemoved(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const start = index;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      while (index < source.length) {
        const character = source[index++];
        if (character === "\\") { index += 1; }
        else if (character === quote) { break; }
      }
      result += source.slice(start, index);
    } else if (source.startsWith("//", index)) {
      while (index < source.length && !/[\r\n]/u.test(source[index] ?? "")) { index += 1; }
      result += " ";
    } else if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) { depth += 1; index += 2; }
        else if (source.startsWith("*/", index)) { depth -= 1; index += 2; }
        else { index += 1; }
      }
      result += source.slice(start, index).replace(/[^\r\n]/gu, " ");
    } else {
      result += source[index++];
    }
  }
  return result;
}

function projectMetadata(file: string, source: string): ProjectMetadata {
  const tokens = [...commentsRemoved(source).matchAll(/"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_-]*|[=;(),{}]/gu)]
    .map(([token]) => token.replace(/^"|"$/gu, ""));
  let sourceLocale: string | undefined;
  const locales: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index + 1] !== "=") { continue; }
    if (tokens[index] === "developmentRegion" && tokens[index + 3] === ";") {
      const value = tokens[index + 2];
      if (value !== undefined && isLocaleTag(value)) { sourceLocale = value; }
    }
    if (tokens[index] === "knownRegions" && tokens[index + 2] === "(") {
      for (let cursor = index + 3; cursor < tokens.length && tokens[cursor] !== ")"; cursor += 1) {
        const value = tokens[cursor];
        if (value !== undefined && isLocaleTag(value)) { locales.push(value); }
      }
    }
  }
  return { file, rootDir: path.posix.dirname(path.posix.dirname(file)), sourceLocale, locales };
}

function nearestProjects(file: string, projects: readonly ProjectMetadata[]): readonly ProjectMetadata[] {
  const candidates = projects.filter((project) => inside(file, project.rootDir));
  const depth = Math.max(-1, ...candidates.map((project) => project.rootDir === "." ? 0 : project.rootDir.split("/").length));
  return candidates.filter((project) => (project.rootDir === "." ? 0 : project.rootDir.split("/").length) === depth);
}

async function expoDiscovery(context: DetectionContext): Promise<{
  accept(file: string): boolean;
  visit(directory: string): Promise<boolean>;
}> {
  const expoRoots = new Set<string>();
  const rules = new Map<string, ReturnType<typeof ignore>>();
  const ignored = (file: string): boolean => {
    let result = false;
    for (const [root, matcher] of rules) {
      if (!inside(file, root)) { continue; }
      const relative = root === "." ? file : file.slice(root.length + 1);
      if (relative.length === 0) { continue; }
      const match = matcher.test(relative);
      result = match.ignored || (result && !match.unignored);
    }
    return result;
  };
  const generated = (file: string): boolean => [...expoRoots].some((root) =>
    inside(file, root === "." ? "ios" : `${root}/ios`)) && ignored(file);
  const visit = async (directory: string): Promise<boolean> => {
    if (generated(`${directory}/`)) { return false; }
    const root = directory || ".";
    const relative = (name: string) => root === "." ? name : `${root}/${name}`;
    const [manifest, gitignore] = await Promise.all([
      context.readFile(relative("package.json")), context.readFile(relative(".gitignore")),
    ]);
    if (gitignore !== null) { rules.set(root, ignore().add(gitignore)); }
    try {
      const parsed: unknown = JSON.parse((manifest ?? "").replace(/^\uFEFF/u, ""));
      if (record(parsed) && ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .some((section) => record(parsed[section]) && Object.hasOwn(parsed[section], "expo"))) {
        expoRoots.add(root);
      }
    } catch { /* A non-package directory or malformed manifest cannot declare Expo. */ }
    return true;
  };
  await visit("");
  return { accept: (file) => !generated(file), visit };
}

function adapterPlan(factory: string, id: string, include?: readonly string[]): AdapterCatalogPlan {
  return {
    factory: { from: "@ai-translate/apple", name: factory },
    kind: "adapter",
    options: { id, rootDir: ".", ...(include === undefined ? {} : { include }) },
  };
}

/** Native resources are shared by Swift, Objective-C, React Native and Expo
 * prebuild projects, so discovery follows authored resources rather than a UI framework. */
export const appleIntegration: Integration = defineIntegration({
  async detect(context) {
    const discovery = await expoDiscovery(context);
    const files = await findProjectFiles(context, (file) =>
      discovery.accept(file) && (
      file.endsWith(".xcstrings") || /(?:^|\/)project\.pbxproj$/u.test(file) ||
      /(?:^|\/)Package\.swift$/u.test(file) || /\.lproj\/.+\.strings$/u.test(file)),
      (directory) => discovery.visit(directory),
    );
    const catalogFiles = files.filter((file) => file.endsWith(".xcstrings"));
    const legacyFiles = files.filter((file) => file.endsWith(".strings"));
    const projectFiles = files.filter((file) => file.endsWith("project.pbxproj"));
    const packageFiles = files.filter((file) => file.endsWith("Package.swift"));
    const projectSources = await Promise.all(projectFiles.map(async (file) =>
      projectMetadata(file, (await context.readFile(file)) ?? "")));
    const applePackages = (await Promise.all(packageFiles.map(async (file) => ({
      file, text: commentsRemoved((await context.readFile(file)) ?? ""),
    })))).flatMap(({ file, text }) => {
      const declared = readStringLiteral(text, "defaultLocalization");
      const sourceLocale = declared !== null && isLocaleTag(declared) ? declared : undefined;
      const code = text.replace(/"(?:\\.|[^"\\])*"/gu, "\"\"");
      return sourceLocale !== undefined || /\.(?:iOS|macOS|tvOS|watchOS|visionOS)\s*\(/u.test(code)
        ? [{ file, rootDir: path.posix.dirname(file), sourceLocale, locales: [] } satisfies ProjectMetadata]
        : [];
    });
    const projects = [...projectSources, ...applePackages];
    if (catalogFiles.length === 0 && legacyFiles.length === 0 &&
      projectFiles.length === 0 && applePackages.length === 0) {
      return null;
    }

    const warnings: string[] = [];
    const metadata = (await Promise.all(catalogFiles.map((file) => readCatalogMetadata(context, file))))
      .filter((item): item is CatalogMetadata => item !== null);
    for (const file of catalogFiles) {
      if (!metadata.some((item) => item.file === file)) {
        warnings.push(`Could not read a supported String Catalog or its source language from ${file}; repair its JSON, version, and localization structure, then re-run init.`);
      }
    }
    const declaredSources = projects.flatMap(({ sourceLocale }) => sourceLocale === undefined ? [] : [sourceLocale]);
    const rootSources = projects.filter(({ rootDir }) => rootDir === ".")
      .flatMap(({ sourceLocale }) => sourceLocale === undefined ? [] : [sourceLocale]);
    const legacyLocales = [...new Set(legacyFiles.flatMap((file) => {
      const locale = /(?:^|\/)([^/]+)\.lproj\//u.exec(file)?.[1];
      return locale !== undefined && isLocaleTag(locale) ? [locale] : [];
    }))];
    const preferredSource = rootSources[0] ?? metadata[0]?.sourceLocale ?? declaredSources[0] ??
      legacyLocales.find((locale) => localeIdentity(locale) === "en") ?? resolveSourceLocale(legacyLocales, null) ?? "en";
    // Catalog sourceLanguage is an exact JSON key. Retain that spelling when
    // project metadata declares a case/legacy alias of the same language.
    const sourceLocale = metadata.find((item) => localeIdentity(item.sourceLocale) === localeIdentity(preferredSource))?.sourceLocale ?? preferredSource;
    if (metadata.length === 0 && declaredSources.length === 0) {
      warnings.push(`No source language is declared; sourceLocale is provisionally "${sourceLocale}". Confirm it before syncing.`);
    }
    const matchingCatalogs = metadata.filter((item) => item.sourceLocale === sourceLocale);
    for (const item of metadata.filter((catalog) => catalog.sourceLocale !== sourceLocale)) {
      warnings.push(`${item.file} uses source language ${item.sourceLocale}; configure it separately from ${sourceLocale} catalogs.`);
    }
    for (const project of projects) {
      if (project.sourceLocale !== undefined && localeIdentity(project.sourceLocale) !== localeIdentity(sourceLocale)) {
        warnings.push(`${project.file} declares source language ${project.sourceLocale}; configure its resources separately from ${sourceLocale} resources.`);
      }
    }
    const resourceLanguages = new Set(matchingCatalogs.flatMap((item) => [...item.locales]));
    const declaredLanguages = new Set(
      projects.filter((project) => (project.sourceLocale !== undefined && localeIdentity(project.sourceLocale) === localeIdentity(sourceLocale)) ||
        (project.sourceLocale === undefined && (project.rootDir === "." ||
          matchingCatalogs.some((catalog) => nearestProjects(catalog.file, projects).includes(project)))))
        .flatMap((project) => [...project.locales]),
    );

    const catalogs: AdapterCatalogPlan[] = [];
    if (matchingCatalogs.length > 0) {
      catalogs.push(adapterPlan("createAppleStringCatalog", "apple-catalogs", matchingCatalogs.map((item) => convertPathToPattern(item.file))));
    }
    const legacyRoots = new Map<string, Map<string, Set<string>>>();
    for (const file of legacyFiles) {
      const match = /^(?:(.*?)\/)?([^/]+)\.lproj\/(.+\.strings)$/u.exec(file);
      if (match === null) { continue; }
      const root = match[1] ?? ".";
      const languages = legacyRoots.get(root) ?? new Map<string, Set<string>>();
      const language = match[2] ?? "";
      const tables = languages.get(language) ?? new Set<string>();
      tables.add(match[3] ?? "");
      languages.set(language, tables);
      legacyRoots.set(root, languages);
    }
    for (const [rootDir, languages] of legacyRoots) {
      for (const language of languages.keys()) {
        if (language !== "Base" && !isLocaleTag(language)) {
          warnings.push(`Unsupported locale directory ${rootDir}/${language}.lproj. Generated configs require BCP 47 language tags such as en or pt-BR; rename legacy aliases or configure these resources manually.`);
        }
      }
      const owners = nearestProjects(rootDir, projects);
      if (owners.some((project) => project.sourceLocale !== undefined && localeIdentity(project.sourceLocale) !== localeIdentity(sourceLocale))) {
        warnings.push(`Skipped ${rootDir} strings tables because their project declares a different source language. Run init from that project separately.`);
        continue;
      }
      const sourceLanguages = [...languages.keys()].filter((locale) => isLocaleTag(locale) && localeIdentity(locale) === localeIdentity(sourceLocale));
      if (sourceLanguages.length > 1) {
        warnings.push(`Skipped ${rootDir} strings tables because ${sourceLanguages.join(", ")} are ambiguous spellings of source language ${sourceLocale}. Normalize these source directories before syncing.`);
        continue;
      }
      const sourceLanguage = sourceLanguages[0];
      const sourceDirectory = sourceLanguage !== undefined
        ? `${sourceLanguage}.lproj`
        : languages.has("Base") ? "Base.lproj" : undefined;
      if (sourceDirectory === undefined) {
        warnings.push(`No ${sourceLocale}.lproj or Base.lproj strings table was found in ${rootDir}; add a source-language table before configuring legacy strings.`);
        continue;
      }
      for (const language of languages.keys()) {
        if (isLocaleTag(language)) { resourceLanguages.add(language); }
      }
      for (const owner of owners) {
        for (const locale of owner.locales) { declaredLanguages.add(locale); }
      }
      const baseOnlyTables = [...(languages.get("Base") ?? [])]
        .filter((table) => sourceLanguage === undefined || !languages.get(sourceLanguage)?.has(table));
      const mixed = sourceLanguage !== undefined && baseOnlyTables.length > 0;
      catalogs.push({
        ...adapterPlan("createAppleStringsCatalog", `apple-strings:${rootDir}`),
        options: { id: `apple-strings:${rootDir}`, rootDir,
          ...(sourceDirectory !== `${sourceLocale}.lproj` ? { sourceLocaleDirectory: sourceDirectory } : {}),
          include: [...(languages.get(sourceLanguage ?? "Base") ?? [])]
            .map(convertPathToPattern),
        },
      });
      if (mixed) {
        catalogs.push({
          ...adapterPlan("createAppleStringsCatalog", `apple-strings:${rootDir}:Base`),
          options: { id: `apple-strings:${rootDir}:Base`, rootDir, sourceLocaleDirectory: "Base.lproj",
            include: baseOnlyTables.map(convertPathToPattern) },
        });
      }
    }
    const hasResources = catalogs.length > 0;
    if (!hasResources) {
      catalogs.push(adapterPlan("createAppleStringCatalog", "apple-catalogs", []));
      warnings.push("No supported source localization resources were found. Create and populate an Xcode String Catalog (.xcstrings), or extract localized Swift strings with Xcode, then re-run init to select the authored files before syncing. Hardcoded strings are not extracted by ai-translate.");
    }
    const targetLocales = selectTargetLocales(resourceLanguages, declaredLanguages, sourceLocale, warnings);
    if (targetLocales.length === 0) {
      warnings.push("No target languages were found. Add the languages your app supports to targetLocales before syncing.");
    }
    const evidence: DetectionEvidence[] = [
      ...matchingCatalogs.map((item) => ({
        detail: `Xcode String Catalog with source language ${item.sourceLocale}`,
        source: item.file,
      })),
      ...projectSources.map(({ file }) => ({ detail: "Xcode project", source: file })),
      ...applePackages.map(({ file }) => ({ detail: "Swift package with Apple platform support", source: file })),
      ...(legacyFiles.length === 0 ? [] : [{ detail: `${String(legacyFiles.length)} localized strings table(s)`, source: legacyFiles[0] ?? "." }]),
    ];
    const [catalog, ...additionalCatalogs] = catalogs;
    if (catalog === undefined) {
      return null;
    }
    return {
      confidence: hasResources ? 0.98 : 0.6,
      displayName: "Apple localization",
      evidence,
      integrationId: APPLE_INTEGRATION_ID,
      plan: {
        catalog,
        ...(additionalCatalogs.length === 0 ? {} : { additionalCatalogs }),
        messageFormat: "plain",
        sourceLocale,
        targetLocales,
        warnings,
      },
    };
  },
  displayName: "Apple localization (Xcode and Swift packages)",
  id: APPLE_INTEGRATION_ID,
});
