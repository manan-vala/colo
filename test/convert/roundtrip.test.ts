import type { JSONContent } from "@tiptap/core";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { PageSettings } from "../../src/shared/doc-schema";
import { readDocx } from "../../src/client/convert/docx/read-docx";
import { writeDocx, type ExportThread } from "../../src/client/convert/docx/write-docx";
import { findAll, parseXml, textOf } from "./helpers";

/** A document using everything the DOCX writer supports, as the editor's JSON. */
const text = (value: string, ...marks: JSONContent["marks"] & object) => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) });
const para = (content: JSONContent[], attrs: Record<string, unknown> = {}) => ({ type: "paragraph", attrs: { textAlign: null, indent: 0, ...attrs }, content });
const item = (value: string, nested?: JSONContent) => ({ type: "listItem", content: [para([text(value)]), ...(nested ? [nested] : [])] });
const cell = (type: string, value: string, attrs: Record<string, unknown> = {}) => ({
  type,
  attrs: { colspan: 1, rowspan: 1, colwidth: [120], ...attrs },
  content: [para([text(value)])],
});
const IMAGE_SRC = "/api/docs/01ARZ3NDEKTSV4RRFFQ69G5FAV/images/01ARZ3NDEKTSV4RRFFQ69G5FAW";

const content: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1, textAlign: "center", indent: 0 }, content: [text("Report")] },
    para([
      text("bold", { type: "bold" }),
      text(" italic", { type: "italic" }),
      text(" under", { type: "underline" }),
      text(" struck", { type: "strike" }),
      text(" H"),
      text("2", { type: "subscript" }),
      text("O x"),
      text("3", { type: "superscript" }),
      text(" red", { type: "textStyle", attrs: { color: "#ff0000" } }),
      text(" serif", { type: "textStyle", attrs: { fontFamily: "Tinos, 'Times New Roman', serif", fontSize: "14pt" } }),
      text(" marked", { type: "highlight", attrs: { color: "#b7e1cd" } }),
      text(" a\tb"),
      { type: "hardBreak" },
      text("site", { type: "link", attrs: { href: "https://example.com/" } }),
      text(" commented", { type: "comment", attrs: { threadId: "t1" } }),
      text(" text", { type: "bold" }, { type: "comment", attrs: { threadId: "t1" } }),
    ]),
    para([text("Indented and justified")], { indent: 2, textAlign: "justify" }),
    { type: "heading", attrs: { level: 2, textAlign: null, indent: 0 }, content: [text("Two")] },
    { type: "heading", attrs: { level: 3, textAlign: null, indent: 0 }, content: [text("Three")] },
    { type: "heading", attrs: { level: 4, textAlign: null, indent: 0 }, content: [text("Four", { type: "comment", attrs: { threadId: "t2" } })] },
    { type: "bulletList", content: [item("one", { type: "bulletList", content: [item("one.a")] }), item("two")] },
    { type: "orderedList", attrs: { start: 3 }, content: [item("third", { type: "orderedList", content: [item("third.i")] }), item("fourth")] },
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [para([text("done")])] },
        { type: "taskItem", attrs: { checked: false }, content: [para([text("to do")])] },
      ],
    },
    { type: "blockquote", content: [para([text("Quoted words")])] },
    { type: "codeBlock", content: [text("const a = 1;\nconst b = 2;")] },
    { type: "horizontalRule" },
    { type: "pageBreak" },
    { type: "image", attrs: { src: IMAGE_SRC, alt: "A chart", width: 200, height: 100, textAlign: "center" } },
    {
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableHeader", "A"), cell("tableHeader", "B"), cell("tableHeader", "C")] },
        { type: "tableRow", content: [cell("tableCell", "wide", { colspan: 2, colwidth: [120, 120] }), cell("tableCell", "tall", { rowspan: 2 })] },
        { type: "tableRow", content: [cell("tableCell", "x"), cell("tableCell", "y")] },
      ],
    },
    para([text("The end.")]),
  ],
};

const settings: PageSettings = {
  pageSize: "LETTER",
  orientation: "landscape",
  margins: { top: 20, bottom: 20, left: 15, right: 15 },
  header: { left: "Colo", right: "Page {page} of {total}" },
  footer: { left: "", right: "{page}" },
  pagination: true,
};

const threads: ExportThread[] = [
  {
    id: "t1",
    quote: "commented text",
    resolved: false,
    comments: [
      { author: "Alex Writer", date: "2026-09-01T10:00:00.000Z", body: "Is this right?" },
      { author: "Bea Editor", date: "2026-09-01T11:00:00.000Z", body: "Yes.\nChecked twice." },
    ],
  },
  { id: "t2", quote: "Four", resolved: true, comments: [{ author: "Bea Editor", date: "2026-09-02T09:00:00.000Z", body: "Done" }] },
  { id: "t3", quote: "gone words", resolved: false, comments: [{ author: "Alex Writer", date: "2026-09-03T09:00:00.000Z", body: "About deleted text" }] },
];

// A 2×1 PNG (red, blue).
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DwnwEIAR3+Av5Zv7hKAAAAAElFTkSuQmCC"),
  (c) => c.charCodeAt(0),
);

/** Drops attributes at their default values and sorts marks, so documents compare by meaning. */
function normalise(node: JSONContent, threadIds: Map<string, string>): JSONContent {
  const out: JSONContent = { type: node.type };
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {}).filter(([key, value]) => value !== null && value !== undefined && !(key === "indent" && value === 0) && !(key === "start" && value === 1)),
  );
  if (node.type === "image") attrs.src = "image";
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (node.text !== undefined) out.text = node.text;
  if (node.marks?.length) {
    out.marks = node.marks
      .map((mark) => (mark.type === "comment" ? { type: "comment", attrs: { threadId: threadIds.get(String(mark.attrs!.threadId)) ?? mark.attrs!.threadId } } : mark))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (node.content?.length) out.content = mergeText(node.content.map((child) => normalise(child, threadIds)));
  return out;
}

function mergeText(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (last?.type === "text" && node.type === "text" && JSON.stringify(last.marks) === JSON.stringify(node.marks)) last.text += node.text!;
    else out.push(node);
  }
  return out;
}

describe("DOCX round trip", async () => {
  const docx = await writeDocx({ title: "Round trip", content, settings, threads, images: new Map([[IMAGE_SRC, { data: PNG, type: "png" }]]) });
  const back = readDocx(docx, { parseXml, fileName: "roundtrip.docx" });

  it("keeps the content", () => {
    // The reader gives threads new IDs; match them by their first comment.
    const ids = new Map(back.threads.map((t) => [t.id, threads.find((o) => o.comments[0].body === t.comments[0].body.replace(/^\(On deleted text “[^”]*”\) /, ""))!.id]));
    expect(normalise(back.content, ids)).toEqual(normalise(content, new Map()));
  });

  it("keeps page setup, header and footer, and the title", () => {
    const { pagination: _, ...rest } = settings;
    expect(back.settings).toEqual(rest);
    expect(back.title).toBe("Round trip");
    // Landscape is stored with the long side as the width, as Word does.
    const xml = strFromU8(unzipSync(docx)["word/document.xml"]);
    const size = /<w:pgSz w:w="(\d+)" w:h="(\d+)"/.exec(xml)!;
    expect(Number(size[1])).toBeGreaterThan(Number(size[2]));
  });

  it("keeps comment threads, replies, resolved state and anchors", () => {
    expect(back.threads.map((t) => ({ quote: t.quote, resolved: t.resolved, comments: t.comments.map((c) => [c.author, c.body, c.date]) }))).toEqual([
      {
        quote: "commented text",
        resolved: false,
        comments: [
          ["Alex Writer", "Is this right?", "2026-09-01T10:00:00.000Z"],
          ["Bea Editor", "Yes.\nChecked twice.", "2026-09-01T11:00:00.000Z"],
        ],
      },
      { quote: "Four", resolved: true, comments: [["Bea Editor", "Done", "2026-09-02T09:00:00.000Z"]] },
      // A thread whose text was deleted stays detached and says what it was about.
      { quote: "", resolved: false, comments: [["Alex Writer", "(On deleted text “gone words”) About deleted text", "2026-09-03T09:00:00.000Z"]] },
    ]);
  });

  it("keeps the image bytes and size", async () => {
    expect(back.images.size).toBe(1);
    const image = back.images.get("image1")!;
    expect(image.type).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    expect(findAll(back.content, "image")[0].attrs).toMatchObject({ width: 200, height: 100, alt: "A chart" });
    expect(textOf(back.content)).toContain("The end.");
    expect(back.notes).toEqual([]);
  });
});
