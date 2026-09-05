import { AsyncLocalStorage } from "node:async_hooks";

import type { ProviderRequestMetrics } from "./types";

interface ProviderRun {
  caches: WeakMap<object, Map<string, Promise<unknown>>>;
  onRequest: (metrics: ProviderRequestMetrics) => void;
}

const providerRun = new AsyncLocalStorage<ProviderRun>();

/** Isolates usage accounting and generation reuse to one sync, including its repairs. */
export function withProviderTelemetry<Result>(
  onRequest: (metrics: ProviderRequestMetrics) => void,
  operation: () => Promise<Result>,
): Promise<Result> {
  return providerRun.run({ caches: new WeakMap(), onRequest }, operation);
}

export function reportProviderRequest(metrics: ProviderRequestMetrics): void {
  providerRun.getStore()?.onRequest(metrics);
}

/** Only the owning provider interprets values in its run-local cache. */
export function getProviderRunCache<Result>(
  owner: object,
): Map<string, Promise<Result>> | undefined {
  const run = providerRun.getStore();
  if (run === undefined) {
    return undefined;
  }
  let cache = run.caches.get(owner);
  if (cache === undefined) {
    cache = new Map();
    run.caches.set(owner, cache);
  }
  return cache as Map<string, Promise<Result>>;
}
