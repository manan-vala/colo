import { generateHTML, generateJSON, type JSONContent } from "@tiptap/core";
import { documentExtensions } from "../editor/extensions";
import { ownImagePath } from "../editor/images";
import { NoteList, PENDING_IMAGE, type ImportedDocument } from "./model";

/**
 * HTML in and out through the editor's own schema. Importing parses the HTML in an inert
 * document (no scripts run, nothing loads) and keeps only what Colo can show; embedded (data:)
 * images are kept for upload, images from the web are left out. Exporting writes a standalone
 * page with Colo's text styles and the images embedded.
 */

const WEB_IMAGES = "Images from the web were left out (Colo does not load images from other sites)";

export function readHtml(html: string, fallbackTitle: string): ImportedDocument {
  const page = new DOMParser().parseFromString(html, "text/html");
  const notes = new NoteList();
  const images = new Map<string, Blob>();

  for (const img of Array.from(page.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const data = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,(.+)$/i.exec(src);
    if (data) {
      const key = `image${images.size + 1}`;
      images.set(key, new Blob([Uint8Array.from(atob(data[2]), (c) => c.charCodeAt(0))], { type: data[1].toLowerCase() }));
      img.setAttribute("src", `${PENDING_IMAGE}${key}`);
    } else if (!ownImagePath(src)) {
      notes.add("dropped", WEB_IMAGES);
      img.remove();
    }
  }
  normaliseTaskLists(page);
  for (const comment of commentNodes(page)) {
    // Colo's Markdown export writes page breaks as comments.
    if (/^\s*page break\s*$/i.test(comment.data)) {
      const marker = page.createElement("div");
      marker.setAttribute("data-page-break", "");
      comment.replaceWith(marker);
    }
  }

  const content = generateJSON(page.body.innerHTML, documentExtensions("", { importing: true })) as JSONContent;
  const title = page.querySelector("title")?.textContent?.trim();
  return { title: title || fallbackTitle, content, settings: {}, threads: [], images, notes: notes.list() };
}

/** GitHub-style task lists (`<li><input type=checkbox>`) as Colo checklists. */
function normaliseTaskLists(page: Document) {
  for (const box of Array.from(page.querySelectorAll('li > input[type="checkbox"]:first-child'))) {
    const item = box.parentElement!;
    const list = item.parentElement;
    item.setAttribute("data-type", "taskItem");
    item.setAttribute("data-checked", box.hasAttribute("checked") ? "true" : "false");
    box.remove();
    if (list && (list.tagName === "UL" || list.tagName === "OL")) list.setAttribute("data-type", "taskList");
  }
}

function commentNodes(page: Document): Comment[] {
  const walker = page.createTreeWalker(page.body, NodeFilter.SHOW_COMMENT);
  const out: Comment[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Comment);
  return out;
}

export interface HtmlExport {
  title: string;
  content: JSONContent;
  /** data: URLs by image `src`; images missing here are left out. */
  images: Map<string, string>;
}

/** A standalone web page: Colo's text styles, images embedded, no scripts. */
export function writeHtml(source: HtmlExport): string {
  const content = withImages(source.content, source.images);
  const body = generateHTML(content, documentExtensions(""));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Colo">
<title>${escapeHtml(source.title)}</title>
<style>
body { max-width: 816px; margin: 40px auto; padding: 0 24px; font: 11pt/1.15 Arial, Arimo, sans-serif; color: #000; }
h1 { font-size: 20pt; font-weight: 400; } h2 { font-size: 16pt; font-weight: 400; }
h3 { font-size: 14pt; font-weight: 400; color: #434343; } h4 { font-size: 12pt; font-weight: 400; color: #666; }
p { margin: 0 0 0.5em; } blockquote { border-left: 3px solid #dadce0; margin-left: 0; padding-left: 1em; color: #5f6368; }
pre { background: #f1f3f4; padding: 0.75em 1em; } code { font-family: "Courier New", monospace; }
table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
img { max-width: 100%; height: auto; } hr { border: none; border-top: 1px solid #dadce0; }
ul[data-type="taskList"] { list-style: none; padding-left: 0.5em; } ul[data-type="taskList"] li { display: flex; gap: 0.5em; }
[data-indent="1"] { margin-left: 0.5in; } [data-indent="2"] { margin-left: 1in; } [data-indent="3"] { margin-left: 1.5in; } [data-indent="4"] { margin-left: 2in; }
div[data-page-break] { break-after: page; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Replaces image sources with their embedded data, dropping images without it. */
function withImages(node: JSONContent, images: Map<string, string>): JSONContent {
  if (node.type === "image") {
    const data = images.get(String(node.attrs?.src ?? ""));
    return data ? { ...node, attrs: { ...node.attrs, src: data } } : { type: "paragraph" };
  }
  if (!node.content) return node;
  return { ...node, content: node.content.map((child) => withImages(child, images)) };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
