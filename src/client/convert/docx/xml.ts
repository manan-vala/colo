/**
 * Namespace-aware helpers over the standard DOM, for WordprocessingML. The parser is passed in:
 * the browser uses its DOMParser; tests in workerd use @xmldom/xmldom, which has the same API.
 */

export type XmlParser = (text: string) => Document;

export const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  v: "urn:schemas-microsoft-com:vml",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  dc: "http://purl.org/dc/elements/1.1/",
} as const;

export type Namespace = (typeof NS)[keyof typeof NS];

const ELEMENT_NODE = 1;

export function isElement(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === ELEMENT_NODE;
}

/** Whether a node is the named element (a plain check, so else-branches keep their type). */
export function is(node: Node, ns: Namespace, local: string): boolean {
  return isElement(node) && node.namespaceURI === ns && node.localName === local;
}

/** Element children, optionally only those with the given name. */
export function children(parent: Element, ns?: Namespace, local?: string): Element[] {
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (!isElement(node)) continue;
    if (ns && (node.namespaceURI !== ns || (local && node.localName !== local))) continue;
    out.push(node);
  }
  return out;
}

export function child(parent: Element | null | undefined, ns: Namespace, local: string): Element | null {
  if (!parent) return null;
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (isElement(node) && node.namespaceURI === ns && node.localName === local) return node;
  }
  return null;
}

/** All descendants with the given name, in document order. */
export function descendants(parent: Element | Document, ns: Namespace, local: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(ns, local));
}

export function attr(element: Element | null | undefined, ns: Namespace, local: string): string | null {
  return element?.hasAttributeNS(ns, local) ? element.getAttributeNS(ns, local) : null;
}

/** `w:val` of a child element, e.g. `val(pPr, "jc")`. */
export function val(parent: Element | null | undefined, local: string): string | null {
  return attr(child(parent, NS.w, local), NS.w, "val");
}

/** A WordprocessingML on/off property: present means on unless its value says otherwise. */
export function onOff(parent: Element | null | undefined, local: string): boolean | undefined {
  const element = child(parent, NS.w, local);
  if (!element) return undefined;
  const value = attr(element, NS.w, "val");
  return value === null || !["0", "false", "off", "none"].includes(value);
}

export function intAttr(element: Element | null | undefined, ns: Namespace, local: string): number | null {
  const value = attr(element, ns, local);
  if (value === null || value === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parses a part, turning parser failures (including browsers' <parsererror>) into null. */
export function parsePart(parse: XmlParser, text: string | null): Document | null {
  if (text === null) return null;
  try {
    const doc = parse(text);
    const root = doc.documentElement;
    if (!root || root.localName === "parsererror" || root.getElementsByTagName("parsererror").length > 0) return null;
    return doc;
  } catch {
    return null;
  }
}
