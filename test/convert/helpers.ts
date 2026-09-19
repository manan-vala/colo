import { DOMParser } from "@xmldom/xmldom";
import type { JSONContent } from "@tiptap/core";
import type { XmlParser } from "../../src/client/convert/docx/xml";

/** The browser's DOMParser is not in workerd; xmldom has the same API. */
export const parseXml: XmlParser = (text) => new DOMParser().parseFromString(text, "application/xml") as unknown as Document;

/** Decodes a fixture imported with `?inline` (a base64 data URL). */
export function fixtureBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Every node of a type, depth first. */
export function findAll(node: JSONContent, type: string): JSONContent[] {
  const out: JSONContent[] = node.type === type ? [node] : [];
  for (const child of node.content ?? []) out.push(...findAll(child, type));
  return out;
}

/** A node's text, as the editor would show it. */
export function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(textOf).join("");
}

/** The text nodes whose text includes `needle`. */
export function textNodes(node: JSONContent, needle: string): JSONContent[] {
  return findAll(node, "text").filter((t) => t.text?.includes(needle));
}

export const markTypes = (node: JSONContent) => (node.marks ?? []).map((mark) => mark.type).sort();
