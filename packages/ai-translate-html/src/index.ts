import { promises as fs } from "node:fs";
import * as path from "node:path";

import { globby } from "globby";
import { HTMLElement, NodeType, TextNode, parse } from "node-html-parser";

import { tokenizeText } from "@ai-translate/core/tokens";
import type {
  CatalogAdapter,
  DocumentRef,
  Entry,
  LoadedDocument,
  ScaffoldLocaleOptions,
  ScaffoldLocaleResult,
} from "@ai-translate/core/types";

type HtmlBinding =
  | {
      attributeName: string;
      element: HTMLElement;
      kind: "attribute";
    }
  | {
      kind: "text";
      node: TextNode;
    };

interface HtmlDocumentState {
  bindings: Map<string, HtmlBinding>;
  root: HTMLElement;
  sourceHtml: string;
}

export interface HtmlCatalogOptions {
  attributeNames?: readonly string[];
  id?: string;
  include?: readonly string[];
  rootDir: string;
  sourceLocale: string;
}

const DEFAULT_ATTRIBUTE_NAMES = ["alt", "aria-label", "placeholder", "title"];

async function readHtml(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeHtml(filePath: string, html: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.tmp-${String(process.pid)}-${String(Date.now())}`,
  );
  await fs.writeFile(tempFile, html, "utf8");
  await fs.rename(tempFile, filePath);
}

function getNodeId(entry: Entry): string | undefined {
  const firstSegment = entry.address[0];
  return firstSegment?.kind === "node" ? firstSegment.id : undefined;
}

function buildState(
  catalogId: string,
  ref: DocumentRef,
  html: string,
  attributeNames: readonly string[],
): LoadedDocument<HtmlDocumentState> {
  const root = parse(html, {
    comment: true,
  });
  const bindings = new Map<string, HtmlBinding>();
  const entries: Entry[] = [];

  const visitNode = (node: HTMLElement | TextNode, pathParts: number[]): void => {
    if (node.nodeType === NodeType.TEXT_NODE && node instanceof TextNode) {
      const text = node.rawText;
      if (text.trim().length > 0 && !text.trim().toLowerCase().startsWith("<!doctype")) {
        const id = `${pathParts.join(".")}.text`;
        bindings.set(id, {
          kind: "text",
          node,
        });
        entries.push({
          address: [{ id, kind: "node" }],
          policy: "translate",
          storage: "html",
          tokens: tokenizeText(text),
          value: text,
        });
      }

      return;
    }

    if (!(node instanceof HTMLElement)) {
      return;
    }

    const nodeId = pathParts.join(".");
    attributeNames.forEach((attributeName) => {
      const value = node.getAttribute(attributeName);
      if (!value || value.trim().length === 0) {
        return;
      }

      const id = `${nodeId}.@${attributeName}`;
      bindings.set(id, {
        attributeName,
        element: node,
        kind: "attribute",
      });
      entries.push({
        address: [{ id, kind: "node" }],
        policy: "translate",
        storage: "html",
        tokens: tokenizeText(value),
        value,
      });
    });

    node.childNodes.forEach((child, index) => {
      if (child instanceof HTMLElement || child instanceof TextNode) {
        visitNode(child, [...pathParts, index]);
      }
    });
  };

  root.childNodes.forEach((child, index) => {
    if (child instanceof HTMLElement || child instanceof TextNode) {
      visitNode(child, [index]);
    }
  });

  return {
    entries,
    ref: {
      ...ref,
      catalogId,
    },
    state: {
      bindings,
      root,
      sourceHtml: html,
    },
  };
}

export function createHtmlCatalog(options: HtmlCatalogOptions): CatalogAdapter {
  const catalogId = options.id ?? "html";
  const attributeNames = options.attributeNames ?? DEFAULT_ATTRIBUTE_NAMES;
  const include = options.include ?? ["**/*.html"];

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
          format: "html",
          locale: sourceLocale,
          path: filePath,
          unitId: relativePath,
        } satisfies DocumentRef;
      });
    },
    async loadDocument(ref) {
      const html = await readHtml(ref.path);
      if (html === null) {
        return null;
      }

      return buildState(catalogId, ref, html, attributeNames);
    },
    reconcileDocument({ ref, source, target }) {
      const nextDocument = buildState(
        catalogId,
        ref,
        (source.state as HtmlDocumentState).sourceHtml,
        attributeNames,
      );
      const targetValues = new Map(
        (target?.entries ?? []).map((entry) => [getNodeId(entry) ?? "", entry.value]),
      );
      nextDocument.entries.forEach((entry) => {
        const bindingId = getNodeId(entry);
        if (!bindingId) {
          return;
        }

        const targetValue = targetValues.get(bindingId);
        if (typeof targetValue === "string") {
          entry.value = targetValue;
        }
      });

      return Promise.resolve(nextDocument);
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
          const source = await readHtml(ref.path);
          if (source === null) {
            skippedDocuments += 1;
            return;
          }

          const targetPath = `${options.rootDir}/${scaffoldOptions.locale}/${ref.unitId}`;
          if (await pathExists(targetPath)) {
            skippedDocuments += 1;
            return;
          }

          await writeHtml(targetPath, source);
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
      const state = document.state as HtmlDocumentState;
      document.entries.forEach((entry) => {
        const bindingId = getNodeId(entry);
        if (!bindingId) {
          return;
        }

        const binding = state.bindings.get(bindingId);
        if (!binding || typeof entry.value !== "string") {
          return;
        }

        if (binding.kind === "text") {
          binding.node.rawText = entry.value;
        } else {
          binding.element.setAttribute(binding.attributeName, entry.value);
        }
      });

      await writeHtml(document.ref.path, state.root.toString());
    },
  };

  return adapter;
}
