import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { addressToJsonPointer } from "@ai-translate/core/address";
import { digestValue } from "@ai-translate/core/hash";
import {
  cloneJsonValue,
  getJsonValueAtAddress,
  setJsonValueAtAddress,
  visitJsonLeaves,
} from "@ai-translate/core/json";
import { rebaseIndexedEntries } from "@ai-translate/core/reconcile";
import { tokenizeText, validateTokenParity } from "@ai-translate/core/tokens";
import type {
  CatalogAdapter,
  Entry,
  JsonObject,
  JsonValue,
  LoadedDocument,
  ReconcileHistoryEntry,
  ScaffoldLocaleOptions,
  ScaffoldLocaleResult,
} from "@ai-translate/core/types";
import { globby } from "globby";
import matter from "gray-matter";

type FrontmatterRoot = JsonObject;
interface MarkdocRuntime {
  parse(source: string): unknown;
}

interface MarkdocParseError {
  id?: string;
  level?: string;
  message?: string;
}

const requireMarkdoc = createRequire(import.meta.url);
const { parse: parseMarkdoc } = requireMarkdoc("@markdoc/markdoc") as MarkdocRuntime;

interface BodyBinding {
  kind: "line" | "table-cell";
  lineIndex: number;
  cellIndex?: number;
  prefix: string;
  suffix: string;
}

interface MarkdocDocumentState {
  bodyBindings: Map<string, BodyBinding>;
  initialBodyValues: ReadonlyMap<string, string>;
  bodyLines: string[];
  frontmatter: FrontmatterRoot;
}

export interface MarkdocCatalogOptions {
  id?: string;
  include?: readonly string[];
  rootDir: string;
  sourceLocale: string;
}

const BODY_LINE_PATTERN = /^(\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)?)(.*?)(\s*)$/u;
const CODE_FENCE_PATTERN = /^\s*(```|~~~)/u;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-+:?$/u;
const THEMATIC_BREAK_PATTERN = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;

function lineStructureSignature(prefix: string): string {
  const indentation = /^\s*/u.exec(prefix)?.[0].length ?? 0;
  const heading = /#{1,6}/u.exec(prefix)?.[0];
  if (heading) {
    return `heading:${String(heading.length)}`;
  }

  const blockquoteDepth = (prefix.match(/>/gu) ?? []).length;
  if (blockquoteDepth > 0) {
    return `blockquote:${String(blockquoteDepth)}:indent:${String(indentation)}`;
  }

  if (/[-*+]\s+$/u.test(prefix)) {
    return `unordered-list:indent:${String(indentation)}`;
  }

  if (/\d+\.\s+$/u.test(prefix)) {
    return `ordered-list:indent:${String(indentation)}`;
  }

  return `paragraph:indent:${String(indentation)}`;
}

interface MarkdownTableRow {
  cells: string[];
  leadingWhitespace: string;
  trailingWhitespace: string;
}

function splitTableCells(value: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const token of tokenizeText(value)) {
    if (token.type === "markdown-inline-code") {
      current += token.raw;
      continue;
    }

    for (const character of token.raw) {
      if (escaped) {
        current += character;
        escaped = false;
        continue;
      }

      if (character === "\\") {
        current += character;
        escaped = true;
        continue;
      }

      if (character === "|") {
        cells.push(current);
        current = "";
        continue;
      }

      current += character;
    }
  }

  cells.push(current);
  return cells;
}

function collectMarkdocParseErrors(node: unknown, errors: MarkdocParseError[]): void {
  if (typeof node !== "object" || node === null) {
    return;
  }

  const candidate = node as { children?: unknown; errors?: unknown };
  if (Array.isArray(candidate.errors)) {
    errors.push(
      ...candidate.errors.filter(
        (error): error is MarkdocParseError => typeof error === "object" && error !== null,
      ),
    );
  }
  if (Array.isArray(candidate.children)) {
    candidate.children.forEach((child) => collectMarkdocParseErrors(child, errors));
  }
}

function validateMarkdocSyntax(raw: string): void {
  const parsed = matter(raw);
  const ast = parseMarkdoc(parsed.content);
  const errors: MarkdocParseError[] = [];
  collectMarkdocParseErrors(ast, errors);
  if (errors.length === 0) {
    return;
  }

  throw new Error(
    `Invalid Markdoc syntax: ${errors
      .map((error) => error.message ?? error.id ?? "unknown parse error")
      .join(" ")}`,
  );
}

function parseMarkdownTableRow(line: string): MarkdownTableRow | null {
  const leadingWhitespace = /^\s*/u.exec(line)?.[0] ?? "";
  const trailingWhitespace = /\s*$/u.exec(line)?.[0] ?? "";
  const trimmedLine = line.trim();

  if (!trimmedLine.startsWith("|") || !trimmedLine.endsWith("|")) {
    return null;
  }

  const cells = splitTableCells(trimmedLine.slice(1, -1));
  if (cells.length < 2) {
    return null;
  }

  return {
    cells,
    leadingWhitespace,
    trailingWhitespace,
  };
}

function isMarkdownTableSeparatorLine(line: string): boolean {
  const tableRow = parseMarkdownTableRow(line);
  if (!tableRow) {
    return false;
  }

  return tableRow.cells.every((cell) => {
    const trimmedCell = cell.trim();
    return trimmedCell.length > 0 && TABLE_SEPARATOR_CELL_PATTERN.test(trimmedCell);
  });
}

function serializeMarkdownTableRow(row: MarkdownTableRow): string {
  return `${row.leadingWhitespace}|${row.cells.join("|")}|${row.trailingWhitespace}`;
}

function sliceBindingValue(value: string, binding: BodyBinding): string {
  const end = binding.suffix.length === 0 ? value.length : value.length - binding.suffix.length;
  return value.slice(binding.prefix.length, end);
}

function getBoundSourceValue(
  state: MarkdocDocumentState,
  binding: BodyBinding,
): string | undefined {
  const line = state.bodyLines[binding.lineIndex];
  if (line === undefined) {
    return undefined;
  }
  if (binding.kind === "line") {
    return sliceBindingValue(line, binding);
  }

  const row = parseMarkdownTableRow(line);
  const cell = binding.cellIndex === undefined ? undefined : row?.cells[binding.cellIndex];
  return cell === undefined ? undefined : sliceBindingValue(cell, binding);
}

async function readMarkdoc(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeMarkdoc(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.tmp-${String(process.pid)}-${String(Date.now())}`,
  );
  try {
    await fs.writeFile(tempFile, content, "utf8");
    await fs.rename(tempFile, filePath);
  } finally {
    await fs.rm(tempFile, { force: true });
  }
}

function buildEntriesFromJson(root: JsonValue): Entry[] {
  const entries: Entry[] = [];
  visitJsonLeaves(root, ({ address, value }) => {
    entries.push(
      typeof value === "string"
        ? {
            address: [...address],
            policy: "translate",
            storage: "string",
            tokens: tokenizeText(value),
            value,
          }
        : {
            address: [...address],
            policy: "copy",
            storage: "scalar",
            value,
          },
    );
  });

  return entries;
}

function reconcileJsonRoot(
  sourceRoot: JsonValue,
  targetRoot: JsonValue | undefined,
  history: readonly ReconcileHistoryEntry[],
): { reconciliation?: LoadedDocument["reconciliation"]; root: JsonValue } {
  const nextRoot = cloneJsonValue(sourceRoot);
  if (targetRoot === undefined) {
    return { root: nextRoot };
  }

  const indexed = rebaseIndexedEntries({
    history,
    sourceEntries: buildEntriesFromJson(sourceRoot),
    targetEntries: buildEntriesFromJson(targetRoot),
  });
  visitJsonLeaves(sourceRoot, ({ address }) => {
    const pointer = addressToJsonPointer(address);
    const targetValue = address.some((segment) => segment.kind === "index")
      ? indexed.valuesByPointer.get(pointer)
      : getJsonValueAtAddress(targetRoot, address);
    if (targetValue !== undefined) {
      setJsonValueAtAddress(nextRoot, address, targetValue);
    }
  });

  return {
    ...(indexed.reconciliation === undefined ? {} : { reconciliation: indexed.reconciliation }),
    root: nextRoot,
  };
}

function updateJsonRootFromEntries(root: JsonValue, entries: readonly Entry[]): JsonValue {
  const nextRoot = cloneJsonValue(root);
  for (const entry of entries) {
    setJsonValueAtAddress(nextRoot, entry.address, entry.value);
  }

  return nextRoot;
}

function getNodeId(entry: Entry): string | undefined {
  const firstSegment = entry.address[0];
  return firstSegment?.kind === "node" ? firstSegment.id : undefined;
}

function bodyValuesByNode(entries: readonly Entry[]): Map<string, string> {
  return new Map(
    entries.flatMap((entry) => {
      const nodeId = getNodeId(entry);
      return entry.storage === "markdoc" && nodeId !== undefined && typeof entry.value === "string"
        ? [[nodeId, entry.value] as const]
        : [];
    }),
  );
}

function jsonStructure(value: JsonValue): unknown {
  if (Array.isArray(value)) {
    return value.map(jsonStructure);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, nextValue]) => [key, jsonStructure(nextValue)]),
    );
  }
  return typeof value;
}

function markdocStructureDigest(
  lines: readonly string[],
  bindings: ReadonlyMap<string, BodyBinding>,
  frontmatter: FrontmatterRoot,
): string {
  const skeleton = [...lines];
  // Serializers such as gray-matter append a trailing newline that hand
  // authored source files may not carry. Trailing blank lines carry no
  // structure, so ignore them; otherwise every written localized document
  // reports a structure mismatch against its source.
  while (skeleton.length > 0 && (skeleton[skeleton.length - 1] ?? "").trim() === "") {
    skeleton.pop();
  }
  for (const binding of bindings.values()) {
    if (binding.kind === "table-cell") {
      const line = skeleton[binding.lineIndex];
      const row = line ? parseMarkdownTableRow(line) : null;
      if (row && binding.cellIndex !== undefined && row.cells[binding.cellIndex] !== undefined) {
        row.cells[binding.cellIndex] = `${binding.prefix}{{translated}}${binding.suffix}`;
        skeleton[binding.lineIndex] = serializeMarkdownTableRow(row);
      }
      continue;
    }
    skeleton[binding.lineIndex] = `${binding.prefix}{{translated}}${binding.suffix}`;
  }
  return digestValue(JSON.stringify({ body: skeleton, frontmatter: jsonStructure(frontmatter) }));
}

function createBodyEntries(body: string): {
  bindings: Map<string, BodyBinding>;
  entries: Entry[];
  lines: string[];
} {
  const bindings = new Map<string, BodyBinding>();
  const entries: Entry[] = [];
  const lines = body.split("\n");
  let insideFence = false;

  lines.forEach((line, index) => {
    if (CODE_FENCE_PATTERN.test(line)) {
      insideFence = !insideFence;
      return;
    }

    if (
      insideFence ||
      line.trim().length === 0 ||
      line.trim().startsWith("{%") ||
      THEMATIC_BREAK_PATTERN.test(line)
    ) {
      return;
    }

    if (isMarkdownTableSeparatorLine(line)) {
      return;
    }

    const tableRow = parseMarkdownTableRow(line);
    if (tableRow) {
      tableRow.cells.forEach((cell, cellIndex) => {
        const text = cell.trim();
        if (text.length === 0) {
          return;
        }

        const prefix = /^\s*/u.exec(cell)?.[0] ?? "";
        const suffix = /\s*$/u.exec(cell)?.[0] ?? "";
        const id = `body.line.${String(index)}.cell.${String(cellIndex)}`;
        bindings.set(id, {
          kind: "table-cell",
          lineIndex: index,
          cellIndex,
          prefix,
          suffix,
        });
        entries.push({
          address: [{ id, kind: "node" }],
          meta: {
            contentRole: "table-cell",
            structureSignature: `table-cell:${String(cellIndex)}:of:${String(tableRow.cells.length)}`,
          },
          policy: "translate",
          storage: "markdoc",
          tokens: tokenizeText(text),
          value: text,
        });
      });
      return;
    }

    const match = BODY_LINE_PATTERN.exec(line);
    if (!match) {
      return;
    }

    const [, prefix = "", text = "", suffix = ""] = match;
    if (text.trim().length === 0 || THEMATIC_BREAK_PATTERN.test(text)) {
      return;
    }

    const id = `body.line.${String(index)}`;
    bindings.set(id, {
      kind: "line",
      lineIndex: index,
      prefix,
      suffix,
    });
    entries.push({
      address: [{ id, kind: "node" }],
      meta: {
        contentRole: /^\s*#{1,6}\s+/u.test(prefix) ? "heading" : "body",
        structureSignature: lineStructureSignature(prefix),
      },
      policy: "translate",
      storage: "markdoc",
      tokens: tokenizeText(text),
      value: text,
    });
  });

  return {
    bindings,
    entries,
    lines,
  };
}

interface RebaseNode {
  entry: Entry;
  history?: ReconcileHistoryEntry;
  pointer: string;
}

function longestCommonSubsequence(
  previous: readonly RebaseNode[],
  current: readonly RebaseNode[],
): ReadonlyMap<number, number> {
  const currentDigests = current.map((node) => digestValue(node.entry.value));
  const nodesMatch = (previousIndex: number, currentIndex: number): boolean => {
    const previousNode = previous[previousIndex];
    const currentNode = current[currentIndex];
    return (
      previousNode?.history?.sourceDigest === currentDigests[currentIndex] &&
      previousNode?.entry.meta?.structureSignature === currentNode?.entry.meta?.structureSignature
    );
  };

  // Translation checks overwhelmingly reconcile an unchanged source skeleton.
  // Keep the quadratic LCS only for actual insertions, removals, or moves.
  if (
    previous.length === current.length &&
    previous.every((_, index) => nodesMatch(index, index))
  ) {
    return new Map(current.map((_, index) => [index, index]));
  }

  const lengths = Array.from({ length: previous.length + 1 }, () =>
    Array<number>(current.length + 1).fill(0),
  );

  for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex -= 1) {
      const previousNode = previous[previousIndex];
      const currentNode = current[currentIndex];
      if (!previousNode || !currentNode) {
        continue;
      }

      const matches = nodesMatch(previousIndex, currentIndex);
      const row = lengths[previousIndex];
      if (!row) {
        continue;
      }
      row[currentIndex] = matches
        ? 1 + (lengths[previousIndex + 1]?.[currentIndex + 1] ?? 0)
        : Math.max(
            lengths[previousIndex + 1]?.[currentIndex] ?? 0,
            lengths[previousIndex]?.[currentIndex + 1] ?? 0,
          );
    }
  }

  const matches = new Map<number, number>();
  let previousIndex = 0;
  let currentIndex = 0;
  while (previousIndex < previous.length && currentIndex < current.length) {
    if (nodesMatch(previousIndex, currentIndex)) {
      matches.set(currentIndex, previousIndex);
      previousIndex += 1;
      currentIndex += 1;
      continue;
    }

    if (
      (lengths[previousIndex + 1]?.[currentIndex] ?? 0) >=
      (lengths[previousIndex]?.[currentIndex + 1] ?? 0)
    ) {
      previousIndex += 1;
    } else {
      currentIndex += 1;
    }
  }

  return matches;
}

function rebaseBodyEntries(args: {
  current: LoadedDocument<MarkdocDocumentState>;
  history: readonly ReconcileHistoryEntry[];
  target?: LoadedDocument<MarkdocDocumentState>;
}): void {
  const historyByPointer = new Map(args.history.map((entry) => [entry.jsonPointer, entry]));
  const previous = (args.target?.entries ?? [])
    .filter((entry) => entry.storage === "markdoc")
    .map((entry): RebaseNode => {
      const pointer = addressToJsonPointer(entry.address);
      const history = historyByPointer.get(pointer);
      return { entry, ...(history === undefined ? {} : { history }), pointer };
    })
    .filter(
      (node): node is RebaseNode & { history: ReconcileHistoryEntry } =>
        node.history !== undefined && digestValue(node.entry.value) === node.history.targetDigest,
    );
  const current = args.current.entries
    .filter((entry) => entry.storage === "markdoc")
    .map(
      (entry): RebaseNode => ({
        entry,
        pointer: addressToJsonPointer(entry.address),
      }),
    );
  const matches = longestCommonSubsequence(previous, current);
  const previousPointers: Record<string, string> = {};
  const retainedStateKeys = new Set<string>();

  for (const [currentIndex, previousIndex] of matches) {
    const currentNode = current[currentIndex];
    const previousNode = previous[previousIndex];
    if (!currentNode || !previousNode?.history) {
      continue;
    }

    currentNode.entry.value = previousNode.entry.value;
    retainedStateKeys.add(previousNode.history.stateKey);
    if (currentNode.pointer !== previousNode.pointer) {
      previousPointers[currentNode.pointer] = previousNode.pointer;
    }
  }

  const retiredStateKeys = args.history
    .filter((entry) => entry.jsonPointer.startsWith("/@node:body.line."))
    .map((entry) => entry.stateKey)
    .filter((stateKey) => !retainedStateKeys.has(stateKey));
  if (Object.keys(previousPointers).length > 0 || retiredStateKeys.length > 0) {
    args.current.reconciliation = {
      ...(Object.keys(previousPointers).length === 0 ? {} : { previousPointers }),
      ...(retiredStateKeys.length === 0 ? {} : { retiredStateKeys }),
    };
  }
}

/**
 * Names the nodes whose surrounding markup changed so a structural rejection
 * points at the offending translation instead of only the document. Boundary
 * whitespace inside a translated value is the usual cause: the line parser
 * absorbs it into the binding prefix or suffix.
 */
function describeStructuralDrift(
  before: ReadonlyMap<string, BodyBinding>,
  after: ReadonlyMap<string, BodyBinding>,
): string {
  const drifted = [...after.keys()]
    .filter((nodeId) => {
      const previous = before.get(nodeId);
      const next = after.get(nodeId);
      return (
        previous === undefined ||
        next === undefined ||
        previous.prefix !== next.prefix ||
        previous.suffix !== next.suffix
      );
    })
    .map((nodeId) => `/@node:${nodeId}`);
  const appeared = [...before.keys()].filter((nodeId) => !after.has(nodeId));
  const affected = [...new Set([...drifted, ...appeared.map((id) => `/@node:${id}`)])];
  return affected.length === 0
    ? ""
    : ` Affected entries: ${affected.slice(0, 5).join(", ")}${affected.length > 5 ? ` (+${String(affected.length - 5)} more)` : ""}.`;
}

function loadMarkdocState(
  ref: LoadedDocument["ref"],
  raw: string,
): LoadedDocument<MarkdocDocumentState> {
  validateMarkdocSyntax(raw);
  const parsed = matter(raw);

  const { bindings, entries: bodyEntries, lines } = createBodyEntries(parsed.content);
  const frontmatter: FrontmatterRoot = parsed.data;
  const frontmatterEntries = buildEntriesFromJson(frontmatter);

  return {
    entries: [...frontmatterEntries, ...bodyEntries],
    ref,
    state: {
      bodyBindings: bindings,
      initialBodyValues: bodyValuesByNode(bodyEntries),
      bodyLines: lines,
      frontmatter,
    },
    structureDigest: markdocStructureDigest(lines, bindings, frontmatter),
  };
}

export function createMarkdocCatalog(options: MarkdocCatalogOptions): CatalogAdapter {
  const catalogId = options.id ?? "markdoc";
  const include = options.include ?? ["**/*.md", "**/*.mdoc"];

  async function pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  const adapter: CatalogAdapter = {
    createDocumentRef(sourceRef, locale) {
      return {
        ...sourceRef,
        catalogId,
        locale,
        path: `${options.rootDir}/${locale}/${sourceRef.unitId}`,
      };
    },
    id: catalogId,
    async listDocumentRefs(sourceLocale) {
      const files = await globby(include, {
        absolute: true,
        cwd: `${options.rootDir}/${sourceLocale}`,
      });

      return files.toSorted().map((filePath) => {
        const relativePath = path.relative(`${options.rootDir}/${sourceLocale}`, filePath);
        return {
          catalogId,
          format: "markdoc",
          locale: sourceLocale,
          path: filePath,
          unitId: relativePath,
        };
      });
    },
    async loadDocument(ref) {
      const raw = await readMarkdoc(ref.path);
      if (raw === null) {
        return null;
      }

      return loadMarkdocState(ref, raw);
    },
    reconcileDocument({ history = [], ref, source, target }) {
      const sourceState = source.state as MarkdocDocumentState;
      const targetState = target?.state as MarkdocDocumentState | undefined;
      const frontmatterResult = reconcileJsonRoot(
        sourceState.frontmatter,
        targetState?.frontmatter,
        history,
      );
      const nextFrontmatter = frontmatterResult.root as FrontmatterRoot;
      const next = loadMarkdocState(
        ref,
        matter.stringify(sourceState.bodyLines.join("\n"), nextFrontmatter),
      );
      const targetValues = new Map<string, Entry["value"]>(
        (target?.entries ?? [])
          .filter((entry) => entry.storage !== "markdoc")
          .map((entry) => [getNodeId(entry) ?? "", entry.value]),
      );
      next.entries.forEach((entry) => {
        const nodeId = getNodeId(entry);
        const targetValue = nodeId ? targetValues.get(nodeId) : undefined;
        if (targetValue !== undefined) {
          entry.value = targetValue;
        }
      });
      rebaseBodyEntries({
        current: next,
        history,
        ...(targetState === undefined
          ? {}
          : { target: target as LoadedDocument<MarkdocDocumentState> }),
      });
      (next.state as MarkdocDocumentState).initialBodyValues = bodyValuesByNode(next.entries);
      if (frontmatterResult.reconciliation) {
        next.reconciliation = {
          previousPointers: {
            ...frontmatterResult.reconciliation.previousPointers,
            ...next.reconciliation?.previousPointers,
          },
          retiredStateKeys: [
            ...(frontmatterResult.reconciliation.retiredStateKeys ?? []),
            ...(next.reconciliation?.retiredStateKeys ?? []),
          ],
        };
      }

      return Promise.resolve(next);
    },
    async scaffoldLocale(scaffoldOptions: ScaffoldLocaleOptions): Promise<ScaffoldLocaleResult> {
      const strategy = scaffoldOptions.strategy ?? "copy-source";
      const refs = await adapter.listDocumentRefs(options.sourceLocale);
      if (strategy === "empty") {
        return {
          catalogId,
          createdDocuments: 0,
          locale: scaffoldOptions.locale,
          skippedDocuments: refs.length,
          strategy,
        };
      }

      const fromLocale =
        strategy === "copy-source"
          ? options.sourceLocale
          : (scaffoldOptions.fromLocale ?? options.sourceLocale);
      const sourceRefs = await adapter.listDocumentRefs(fromLocale);
      let createdDocuments = 0;
      let skippedDocuments = 0;

      await Promise.all(
        sourceRefs.map(async (ref) => {
          const raw = await readMarkdoc(ref.path);
          if (raw === null) {
            skippedDocuments += 1;
            return;
          }

          const targetPath = `${options.rootDir}/${scaffoldOptions.locale}/${ref.unitId}`;
          if (await pathExists(targetPath)) {
            skippedDocuments += 1;
            return;
          }

          await writeMarkdoc(targetPath, raw);
          createdDocuments += 1;
        }),
      );

      return {
        catalogId,
        createdDocuments,
        locale: scaffoldOptions.locale,
        skippedDocuments,
        strategy,
      };
    },
    async writeDocument(document) {
      const state = document.state as MarkdocDocumentState;
      const frontmatterEntries = document.entries.filter((entry) => entry.storage !== "markdoc");
      const bodyEntries = document.entries.filter((entry) => entry.storage === "markdoc");
      const nextFrontmatter = updateJsonRootFromEntries(
        state.frontmatter,
        frontmatterEntries,
      ) as FrontmatterRoot;
      const nextLines = [...state.bodyLines];
      bodyEntries.forEach((entry) => {
        const nodeId = getNodeId(entry);
        if (!nodeId || typeof entry.value !== "string") {
          throw new Error(
            `Invalid Markdoc body entry for ${document.ref.locale}:${document.ref.unitId}.`,
          );
        }

        const binding = state.bodyBindings.get(nodeId);
        if (!binding) {
          throw new Error(
            `Missing Markdoc target binding for ${document.ref.locale}:${document.ref.unitId}:${nodeId}.`,
          );
        }

        const sourceValue = getBoundSourceValue(state, binding);
        if (sourceValue === undefined) {
          throw new Error(`Missing Markdoc source binding for ${nodeId}.`);
        }
        if (/[\r\n]/u.test(entry.value)) {
          throw new Error(`Translation for ${nodeId} would introduce a structural newline.`);
        }
        const changedFromInitialValue = state.initialBodyValues.get(nodeId) !== entry.value;
        // A path-scoped sync serializes onto the existing localized backing
        // state so unrelated target entries remain untouched. The entry token
        // stream still comes from the reconciled English source and is the
        // authoritative structure contract for the translated value.
        const structuralSourceValue =
          entry.tokens?.map((token) => token.raw).join("") ?? sourceValue;
        const structuralIssues = changedFromInitialValue
          ? validateTokenParity(structuralSourceValue, entry.value).filter(
              (issue) => issue.severity === "error",
            )
          : [];
        if (structuralIssues.length > 0) {
          throw new Error(
            `Translation for ${document.ref.locale}:${document.ref.unitId}:${nodeId} would change protected Markdown structure: ${structuralIssues
              .map((issue) => issue.message)
              .join(" ")}`,
          );
        }

        if (binding.kind === "table-cell") {
          const line = nextLines[binding.lineIndex];
          const tableRow = line ? parseMarkdownTableRow(line) : null;
          const cellIndex = binding.cellIndex;
          if (!tableRow || cellIndex === undefined || tableRow.cells[cellIndex] === undefined) {
            throw new Error(
              `Missing Markdoc table-cell binding for ${document.ref.locale}:${document.ref.unitId}:${nodeId}.`,
            );
          }

          tableRow.cells[cellIndex] = `${binding.prefix}${entry.value}${binding.suffix}`;
          nextLines[binding.lineIndex] = serializeMarkdownTableRow(tableRow);
          return;
        }

        nextLines[binding.lineIndex] = `${binding.prefix}${entry.value}${binding.suffix}`;
      });

      const content = matter.stringify(nextLines.join("\n"), nextFrontmatter);
      validateMarkdocSyntax(content);
      const candidate = loadMarkdocState(document.ref, content);
      if (
        document.structureDigest !== undefined &&
        candidate.structureDigest !== document.structureDigest
      ) {
        throw new Error(
          `Translation for ${document.ref.locale}:${document.ref.unitId} would change the assembled Markdoc document structure.${describeStructuralDrift(
            state.bodyBindings,
            candidate.state.bodyBindings,
          )}`,
        );
      }
      const candidateValues = new Map(
        candidate.entries.map((entry) => [addressToJsonPointer(entry.address), entry.value]),
      );
      for (const entry of document.entries) {
        const pointer = addressToJsonPointer(entry.address);
        const persistedValue = candidateValues.get(pointer);
        if (
          persistedValue === undefined ||
          digestValue(persistedValue) !== digestValue(entry.value)
        ) {
          throw new Error(
            `Translation for ${document.ref.locale}:${document.ref.unitId}:${pointer} was not preserved by Markdoc serialization.`,
          );
        }
      }
      await writeMarkdoc(document.ref.path, content);
    },
  };

  return adapter;
}
