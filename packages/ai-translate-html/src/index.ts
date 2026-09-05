import { promises as fs } from "node:fs";
import * as path from "node:path";

import { globby } from "globby";
import { HTMLElement, TextNode, parse } from "node-html-parser";

import { digestValue } from "@ai-translate/core/hash";
import { tokenizeText, validateTokenParity } from "@ai-translate/core/tokens";
import type {
  CatalogAdapter,
  DocumentRef,
  Entry,
  LoadedDocument,
  ScaffoldLocaleOptions,
  ScaffoldLocaleResult,
} from "@ai-translate/core/types";

interface InlineElement {
  element: HTMLElement;
  opaque: boolean;
}

type HtmlBinding =
  | {
      element: HTMLElement;
      inlineElements: Map<string, InlineElement>;
      kind: "block";
      sourceText: string;
    }
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

const INLINE_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "BR",
  "CITE",
  "CODE",
  "DEL",
  "EM",
  "I",
  "IMG",
  "INS",
  "KBD",
  "MARK",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR",
  "WBR",
]);
const OPAQUE_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "PRE",
  "CODE",
  "KBD",
  "SAMP",
  "SVG",
  "MATH",
]);
const VOID_TAGS = new Set(["BR", "IMG", "WBR"]);

function opaqueElement(node: HTMLElement): boolean {
  return OPAQUE_TAGS.has(node.tagName) || node.getAttribute("translate")?.toLowerCase() === "no";
}

function htmlRole(
  node: HTMLElement,
): "heading" | "ui-label" | "link-anchor" | "table-cell" | "body" {
  if (/^H[1-6]$/u.test(node.tagName) || node.tagName === "TITLE") {
    return "heading";
  }
  if (node.tagName === "BUTTON" || node.tagName === "LABEL" || node.tagName === "OPTION") {
    return "ui-label";
  }
  if (node.tagName === "A") {
    return "link-anchor";
  }
  if (node.tagName === "TD" || node.tagName === "TH") {
    return "table-cell";
  }
  return "body";
}

function escapeHtmlText(text: string): string {
  return text
    .replaceAll(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/giu, "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderBlock(value: string, binding: Extract<HtmlBinding, { kind: "block" }>): string {
  const issues = validateTokenParity(binding.sourceText, value);
  if (issues.some(({ severity }) => severity === "error")) {
    throw new Error("HTML translation changed protected inline elements or placeholders.");
  }
  const stack: string[] = [];
  const result = tokenizeText(value)
    .map((token) => {
      if (token.type !== "tag") {
        return escapeHtmlText(token.raw);
      }
      const inline = binding.inlineElements.get(token.name);
      if (inline === undefined) {
        throw new Error("HTML translation introduced an unknown inline element.");
      }
      if (inline.opaque) {
        if (token.tagKind !== "self") {
          throw new Error("HTML translation changed an opaque element.");
        }
        return inline.element.toString();
      }
      if (token.tagKind === "close") {
        if (stack.pop() !== token.name) {
          throw new Error("HTML translation crossed inline element boundaries.");
        }
        return `</${inline.element.rawTagName}>`;
      }
      if (token.tagKind !== "open") {
        throw new Error("HTML translation changed an inline element.");
      }
      stack.push(token.name);
      return `<${inline.element.rawTagName}${inline.element.rawAttrs ? ` ${inline.element.rawAttrs}` : ""}>`;
    })
    .join("");
  if (stack.length > 0) {
    throw new Error("HTML translation left an inline element unclosed.");
  }
  return result;
}

function buildState(
  catalogId: string,
  ref: DocumentRef,
  html: string,
  attributeNames: readonly string[],
): LoadedDocument<HtmlDocumentState> {
  const root = parse(html, { comment: true });
  const bindings = new Map<string, HtmlBinding>();
  const entries: Entry[] = [];
  const addAttributes = (node: HTMLElement, nodeId: string): void => {
    for (const attributeName of attributeNames) {
      const value = node.getAttribute(attributeName);
      if (!value?.trim()) {
        continue;
      }
      const id = `${nodeId}.@${attributeName}`;
      bindings.set(id, { attributeName, element: node, kind: "attribute" });
      entries.push({
        address: [{ id, kind: "node" }],
        meta: { contentRole: "ui-label" },
        policy: "translate",
        storage: "html",
        tokens: tokenizeText(value),
        value,
      });
    }
  };
  const inlineIdentity = (node: HTMLElement): string => {
    const attributes = Object.entries(node.attributes)
      .filter(([name]) => !attributeNames.includes(name))
      .toSorted(([a], [b]) => a.localeCompare(b));
    return `${node.rawTagName.toLowerCase()}_i${digestValue(JSON.stringify(attributes)).slice(0, 8)}`;
  };
  const canGroup = (node: HTMLElement): boolean => {
    const identities = new Map<string, boolean>();
    const visit = (parent: HTMLElement): boolean => parent.childNodes.every((child) => {
      if (child instanceof TextNode) {
        return true;
      }
      if (!(child instanceof HTMLElement) || !INLINE_TAGS.has(child.tagName)) {
        return false;
      }
      const identity = inlineIdentity(child);
      const hasAttributes = attributeNames.some((name) => child.hasAttribute(name));
      // A moved pair of identical elements cannot be identified again from
      // translated attributes alone. Retain separate units in this case.
      if (identities.has(identity) && (identities.get(identity) === true || hasAttributes)) {
        return false;
      }
      identities.set(identity, hasAttributes);
      return opaqueElement(child) || VOID_TAGS.has(child.tagName) || visit(child);
    });
    return visit(node);
  };
  const visitNode = (node: HTMLElement | TextNode, pathParts: number[]): void => {
    if (node instanceof TextNode) {
      const text = node.rawText;
      if (text.trim() && !text.trim().toLowerCase().startsWith("<!doctype")) {
        const id = `${pathParts.join(".")}.text`;
        bindings.set(id, { kind: "text", node });
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
    if (node.getAttribute("translate")?.toLowerCase() === "no") {
      return;
    }
    const nodeId = pathParts.join(".");
    addAttributes(node, nodeId);
    if (opaqueElement(node)) {
      return;
    }
    if (node.childNodes.length > 0 && canGroup(node) && node.text.trim().length > 0) {
      const inlineElements = new Map<string, InlineElement>();
      const serialize = (child: HTMLElement | TextNode): string => {
        if (child instanceof TextNode) {
          return child.rawText;
        }
        const base = inlineIdentity(child);
        let index = 0;
        while (inlineElements.has(`${base}_${String(index)}`)) {
          index += 1;
        }
        const alias = `${base}_${String(index)}`;
        const opaque = opaqueElement(child) || VOID_TAGS.has(child.tagName);
        inlineElements.set(alias, { element: child, opaque });
        if (child.getAttribute("translate")?.toLowerCase() !== "no") {
          addAttributes(child, `${nodeId}.inline.${alias}`);
        }
        if (opaque) {
          return `<${alias}/>`;
        }
        return `<${alias}>${child.childNodes
          .map((descendant) =>
            descendant instanceof HTMLElement || descendant instanceof TextNode
              ? serialize(descendant)
              : "",
          )
          .join("")}</${alias}>`;
      };
      const value = node.childNodes
        .map((child) =>
          child instanceof HTMLElement || child instanceof TextNode ? serialize(child) : "",
        )
        .join("");
      const id = `${nodeId}.block`;
      bindings.set(id, { element: node, inlineElements, kind: "block", sourceText: value });
      entries.push({
        address: [{ id, kind: "node" }],
        meta: { contentRole: htmlRole(node), inlineMarkup: true },
        policy: "translate",
        storage: "html",
        tokens: tokenizeText(value),
        value,
      });
      return;
    }
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
  return { entries, ref: { ...ref, catalogId }, state: { bindings, root, sourceHtml: html } };
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
        } else if (binding.kind === "attribute") {
          binding.element.setAttribute(binding.attributeName, entry.value);
        }
      });

      for (const entry of document.entries) {
        const binding = state.bindings.get(getNodeId(entry) ?? "");
        if (binding?.kind === "block" && typeof entry.value === "string") {
          binding.element.set_content(renderBlock(entry.value, binding));
        }
      }

      await writeHtml(document.ref.path, state.root.toString());
    },
  };

  return adapter;
}
