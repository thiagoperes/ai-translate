import { tokenizeText, validateTokenParity } from "./tokens";
import type {
  AiTranslateConfig,
  CatalogAdapter,
  Token,
  TranslationValidationIssue,
} from "./types";

/**
 * The identifier carried by {@link import("./types").Entry.messageFormatId}.
 * `plain` is the implicit default, so an entry that omits the field and an
 * entry that sets it to `plain` must validate identically.
 */
export const PLAIN_MESSAGE_FORMAT_ID = "plain";

export interface MessageParityArgs {
  /** The locale of `targetText`. Plural-bearing formats need it to know which
   * CLDR categories the target is required to supply. */
  locale: string;
  sourceLocale: string;
  sourceText: string;
  targetText: string;
}

/**
 * How a single message encodes variables, markup, and plural selection.
 *
 * This is the axis that sits between storage (which file holds the message,
 * owned by {@link CatalogAdapter}) and framework (how the app reads it). A
 * format never touches the filesystem; it only interprets one string.
 *
 * Implementations must be pure and synchronous. `tokenize` runs once per entry
 * per load over the whole corpus, and `validateParity` runs on every candidate
 * and every existing translation, so both are hot.
 */
export interface MessageFormat {
  /** Stable across releases: it is written into entries and therefore into the
   * validation cache key. Renaming one re-validates every affected entry. */
  readonly id: string;
  tokenize(value: string): readonly Token[];
  validateParity(args: MessageParityArgs): readonly TranslationValidationIssue[];
}

/**
 * The historical behaviour: double- and single-brace placeholders, HTML and
 * component tags, and Markdown inline structure, compared as a flat ordered
 * token sequence.
 *
 * Every entry that does not name a format resolves to this, so its output must
 * stay byte-identical to calling {@link tokenizeText} and
 * {@link validateTokenParity} directly.
 */
export const plainMessageFormat: MessageFormat = {
  id: PLAIN_MESSAGE_FORMAT_ID,
  tokenize: tokenizeText,
  validateParity: ({ sourceText, targetText }) => validateTokenParity(sourceText, targetText),
};

export interface MessageFormatRegistry {
  /**
   * Resolves the format an entry named. Passing `undefined` yields the plain
   * format, which is what makes the field optional on {@link import("./types").Entry}.
   *
   * @throws when the id is unknown. A silent fallback to plain would validate
   * ICU plurals with the flat tokenizer and quietly accept broken output, so a
   * missing registration has to fail loudly.
   */
  resolve(id: string | undefined): MessageFormat;
}

function describeKnownIds(formats: ReadonlyMap<string, MessageFormat>): string {
  return [...formats.keys()].toSorted((left, right) => left.localeCompare(right)).join(", ");
}

/**
 * Builds the lookup used during validation from the formats a config's
 * catalogs advertise, plus any registered directly on the config.
 *
 * Collecting from catalogs is what keeps a config free of duplication: an
 * adapter constructed with a format both stamps entries with its id and
 * declares the object here, so the user never registers it twice.
 *
 * @throws when two different format objects claim the same id, which would
 * otherwise make validation depend on catalog ordering.
 */
export function createMessageFormatRegistry(args: {
  catalogs?: readonly CatalogAdapter[];
  formats?: readonly MessageFormat[];
}): MessageFormatRegistry {
  const formats = new Map<string, MessageFormat>([[PLAIN_MESSAGE_FORMAT_ID, plainMessageFormat]]);

  for (const format of [
    ...(args.catalogs ?? []).flatMap((catalog) => [...(catalog.messageFormats ?? [])]),
    ...(args.formats ?? []),
  ]) {
    const existing = formats.get(format.id);
    if (existing !== undefined && existing !== format) {
      throw new Error(
        `Two different message formats are registered as "${format.id}". Ids must be unique.`,
      );
    }
    formats.set(format.id, format);
  }

  return {
    resolve(id) {
      if (id === undefined) {
        return plainMessageFormat;
      }
      const format = formats.get(id);
      if (format === undefined) {
        throw new Error(
          `Unknown message format "${id}". Registered formats: ${describeKnownIds(formats)}. ` +
            "Add it to the catalog that produced the entry, or to config.messageFormats.",
        );
      }
      return format;
    },
  };
}

/**
 * Registries are derived purely from the config, so they are memoised against
 * it. Validation resolves a format for every candidate and every existing
 * translation, and rebuilding the map on each of those would walk every catalog
 * hundreds of thousands of times on a full corpus.
 */
const registriesByConfig = new WeakMap<AiTranslateConfig, MessageFormatRegistry>();

export function resolveConfigMessageFormat(
  config: AiTranslateConfig,
  id: string | undefined,
): MessageFormat {
  if (id === undefined) {
    return plainMessageFormat;
  }

  let registry = registriesByConfig.get(config);
  if (registry === undefined) {
    registry = createMessageFormatRegistry({
      catalogs: config.catalogs,
      ...(config.messageFormats === undefined ? {} : { formats: config.messageFormats }),
    });
    registriesByConfig.set(config, registry);
  }
  return registry.resolve(id);
}
