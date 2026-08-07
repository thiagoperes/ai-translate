import { addressToJsonPointer, jsonPointerToAddress } from "./address";
import { digestValue } from "./hash";
import type {
  DocumentReconciliation,
  Entry,
  ReconcileHistoryEntry,
} from "./types";

interface IndexedNode {
  entry: Entry;
  history?: ReconcileHistoryEntry;
  pointer: string;
}

function indexedSignature(entry: Entry): string | undefined {
  if (!entry.address.some((segment) => segment.kind === "index")) {
    return undefined;
  }

  return entry.address
    .map((segment) =>
      segment.kind === "key"
        ? `key:${segment.key}`
        : segment.kind === "node"
          ? `node:${segment.id}`
          : "index:*",
    )
    .join("/");
}

function stablePath(entry: Entry): string | undefined {
  const stableSegments = entry.address
    .filter((segment) => segment.kind === "index")
    .map((segment) => segment.stableId);
  return stableSegments.length > 0 && stableSegments.every((value) => value !== undefined)
    ? stableSegments.join("/")
    : undefined;
}

function nodesMatch(previous: IndexedNode, current: IndexedNode): boolean {
  if (previous.history?.sourceDigest !== digestValue(current.entry.value)) {
    return false;
  }

  const previousStablePath = stablePath(previous.entry);
  const currentStablePath = stablePath(current.entry);
  return (
    previousStablePath === undefined ||
    currentStablePath === undefined ||
    previousStablePath === currentStablePath
  );
}

function lcs(previous: readonly IndexedNode[], current: readonly IndexedNode[]): Map<number, number> {
  const lengths = Array.from({ length: previous.length + 1 }, () =>
    Array<number>(current.length + 1).fill(0),
  );
  for (let left = previous.length - 1; left >= 0; left -= 1) {
    for (let right = current.length - 1; right >= 0; right -= 1) {
      const previousNode = previous[left];
      const currentNode = current[right];
      if (!previousNode || !currentNode) {
        continue;
      }
      const row = lengths[left];
      if (!row) {
        continue;
      }
      row[right] = nodesMatch(previousNode, currentNode)
        ? 1 + (lengths[left + 1]?.[right + 1] ?? 0)
        : Math.max(lengths[left + 1]?.[right] ?? 0, lengths[left]?.[right + 1] ?? 0);
    }
  }

  const matches = new Map<number, number>();
  let left = 0;
  let right = 0;
  while (left < previous.length && right < current.length) {
    const previousNode = previous[left];
    const currentNode = current[right];
    if (previousNode && currentNode && nodesMatch(previousNode, currentNode)) {
      matches.set(right, left);
      left += 1;
      right += 1;
    } else if ((lengths[left + 1]?.[right] ?? 0) >= (lengths[left]?.[right + 1] ?? 0)) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return matches;
}

export function rebaseIndexedEntries(args: {
  history: readonly ReconcileHistoryEntry[];
  sourceEntries: readonly Entry[];
  targetEntries: readonly Entry[];
}): {
  reconciliation?: DocumentReconciliation;
  valuesByPointer: ReadonlyMap<string, Entry["value"]>;
} {
  const historyByPointer = new Map(args.history.map((entry) => [entry.jsonPointer, entry]));
  const groups = new Map<string, { current: IndexedNode[]; previous: IndexedNode[] }>();

  const addNode = (entry: Entry, side: "current" | "previous"): void => {
    const signature = indexedSignature(entry);
    if (signature === undefined) {
      return;
    }
    const pointer = addressToJsonPointer(entry.address);
    const history = historyByPointer.get(pointer);
    const group = groups.get(signature) ?? { current: [], previous: [] };
    group[side].push({ entry, ...(history === undefined ? {} : { history }), pointer });
    groups.set(signature, group);
  };
  args.sourceEntries.forEach((entry) => { addNode(entry, "current"); });
  args.targetEntries.forEach((entry) => { addNode(entry, "previous"); });

  const previousPointers: Record<string, string> = {};
  const retainedStateKeys = new Set<string>();
  const valuesByPointer = new Map<string, Entry["value"]>();
  for (const group of groups.values()) {
    const trustedPrevious = group.previous.filter(
      (node): node is IndexedNode & { history: ReconcileHistoryEntry } =>
        node.history !== undefined && digestValue(node.entry.value) === node.history.targetDigest,
    );
    const matches = new Map<number, number>();
    const matchedPrevious = new Set<number>();
    const stablePrevious = new Map<string, number[]>();
    trustedPrevious.forEach((node, index) => {
      const key = stablePath(node.entry);
      if (key !== undefined) {
        stablePrevious.set(key, [...(stablePrevious.get(key) ?? []), index]);
      }
    });
    group.current.forEach((node, currentIndex) => {
      const key = stablePath(node.entry);
      const candidates = key === undefined ? undefined : stablePrevious.get(key);
      if (candidates?.length !== 1) {
        return;
      }
      const previousIndex = candidates[0];
      if (previousIndex === undefined) {
        return;
      }
      const previous = trustedPrevious[previousIndex];
      if (!previous || !nodesMatch(previous, node)) {
        return;
      }
      matches.set(currentIndex, previousIndex);
      matchedPrevious.add(previousIndex);
    });

    const remainingCurrent = group.current
      .map((node, index) => ({ index, node }))
      .filter(({ index }) => !matches.has(index));
    const remainingPrevious = trustedPrevious
      .map((node, index) => ({ index, node }))
      .filter(({ index }) => !matchedPrevious.has(index));
    for (const [currentIndex, previousIndex] of lcs(
      remainingPrevious.map(({ node }) => node),
      remainingCurrent.map(({ node }) => node),
    )) {
      const current = remainingCurrent[currentIndex];
      const previous = remainingPrevious[previousIndex];
      if (!current || !previous?.node.history) {
        continue;
      }
      matches.set(current.index, previous.index);
      matchedPrevious.add(previous.index);
    }

    for (const [currentIndex, previousIndex] of matches) {
      const current = group.current[currentIndex];
      const previous = trustedPrevious[previousIndex];
      if (!current || !previous?.history) {
        continue;
      }
      valuesByPointer.set(current.pointer, previous.entry.value);
      retainedStateKeys.add(previous.history.stateKey);
      if (current.pointer !== previous.pointer) {
        previousPointers[current.pointer] = previous.pointer;
      }
    }
  }

  const retiredStateKeys = args.history
    .filter((entry) =>
      jsonPointerToAddress(entry.jsonPointer).some((segment) => segment.kind === "index"),
    )
    .map((entry) => entry.stateKey)
    .filter((stateKey) => !retainedStateKeys.has(stateKey));
  const reconciliation =
    Object.keys(previousPointers).length > 0 || retiredStateKeys.length > 0
      ? {
          ...(Object.keys(previousPointers).length === 0 ? {} : { previousPointers }),
          ...(retiredStateKeys.length === 0 ? {} : { retiredStateKeys }),
        }
      : undefined;
  return {
    ...(reconciliation === undefined ? {} : { reconciliation }),
    valuesByPointer,
  };
}
