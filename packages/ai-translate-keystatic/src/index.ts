export interface LocalizedSingletonPathOptions {
  extension?: string;
  locales: readonly string[];
  rootDir: string;
}

export interface LocaleSeedOptions<TSeed> {
  overrides?: Partial<Record<string, Partial<TSeed>>>;
  seed: TSeed;
}

function withLeadingDot(extension: string): string {
  return extension.startsWith(".") ? extension : `.${extension}`;
}

export function createLocalizedSingletonPaths(
  options: LocalizedSingletonPathOptions,
): Record<string, string> {
  const extension = withLeadingDot(options.extension ?? ".json");
  return Object.fromEntries(
    options.locales.map((locale) => [locale, `${options.rootDir}/${locale}${extension}`]),
  );
}

export function buildLocalizedSeedMap<TSeed extends Record<string, unknown>>(
  locales: readonly string[],
  options: LocaleSeedOptions<TSeed>,
): Record<string, TSeed> {
  return Object.fromEntries(
    locales.map((locale) => [
      locale,
      {
        ...structuredClone(options.seed),
        ...options.overrides?.[locale],
      },
    ]),
  );
}

export function scaffoldLocaleSeed<TSeed extends Record<string, unknown>>(
  seed: TSeed,
  override?: Partial<TSeed>,
): TSeed {
  return {
    ...structuredClone(seed),
    ...override,
  };
}
