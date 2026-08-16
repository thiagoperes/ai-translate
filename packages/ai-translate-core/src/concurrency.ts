import type { AiTranslateConfig, SyncCatalogsOptions } from "./types";

/**
 * Documents a run will work on at once. Every document phase — loading sources,
 * reconciling targets, preparing entries, dispatching provider batches, writing
 * results — draws from this one budget, so raising it raises throughput
 * everywhere rather than moving the bottleneck to the next phase.
 *
 * The default is deliberately modest: a run shares the machine with whatever
 * started it, and a default in the thousands would open that many file handles
 * on a laptop to save seconds. Corpora large enough to care set it explicitly.
 */
export const DEFAULT_DOCUMENT_CONCURRENCY = 4;

export function resolveDocumentConcurrency(
  config: Pick<AiTranslateConfig, "concurrency">,
  options: Pick<SyncCatalogsOptions, "documentConcurrency"> = {}
): number {
  const resolved =
    options.documentConcurrency ??
    config.concurrency?.documents ??
    DEFAULT_DOCUMENT_CONCURRENCY;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("Document concurrency must be a positive integer.");
  }
  return resolved;
}

/**
 * Runs `worker` over `values` with at most `concurrency` in flight, returning
 * results in input order however they complete.
 *
 * Fails fast: the first rejection stops new work and is rethrown once the
 * already-started workers settle, so a failing run does not keep spending on
 * provider calls whose results it will discard.
 */
export async function runWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (values.length === 0) {
    return [];
  }

  const results: TResult[] = [];
  let firstError: unknown;
  let hasError = false;
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (!hasError && nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const value = values[currentIndex];
      /* v8 ignore next -- Defensive sparse-array guard; callers pass dense arrays. */
      if (value === undefined) {
        continue;
      }

      try {
        results[currentIndex] = await worker(value, currentIndex);
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    () => runWorker()
  );
  await Promise.all(workers);
  if (hasError) {
    // Rethrown verbatim: wrapping it would replace the original error and its
    // stack with a stringified copy.
    // oxlint-disable-next-line no-throw-literal
    throw firstError;
  }
  return results;
}
