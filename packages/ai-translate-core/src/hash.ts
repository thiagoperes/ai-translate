import { createHash } from "node:crypto";

/**
 * Digests short values through a cache, because a run hashes the same entry text
 * many times over.
 *
 * A single entry's source string is hashed to decide whether it changed, again to
 * record the state it produced, again while resolving acceptance, and again by
 * validation — the same bytes, the same answer. On a corpus of a million entries
 * that was the largest single block of CPU in a run that translates nothing.
 *
 * Only short values are cached. Long ones are contract material and prompt
 * payloads: hashed once, never repeated, and large enough that keeping them would
 * cost more memory than the hash saves. The cache is cleared wholesale when it
 * fills rather than evicting one entry at a time; correctness does not depend on
 * a hit, so the simplest bound is the right one.
 */
const MAX_CACHED_VALUE_LENGTH = 4096;
const MAX_CACHE_ENTRIES = 200_000;
const digestCache = new Map<string, string>();

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestValue(value: boolean | number | string | null): string {
  const text = typeof value === "string" ? value : String(value);
  if (text.length > MAX_CACHED_VALUE_LENGTH) {
    return sha256Hex(text);
  }

  const cached = digestCache.get(text);
  if (cached !== undefined) {
    return cached;
  }

  const digest = sha256Hex(text);
  if (digestCache.size >= MAX_CACHE_ENTRIES) {
    digestCache.clear();
  }
  digestCache.set(text, digest);
  return digest;
}
