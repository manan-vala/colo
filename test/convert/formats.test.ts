import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { toMarkdown } from "../../src/client/convert/markdown";
import { fromPlainText, toPlainText } from "../../src/client/convert/text";

const text = (value: string, ...marks: JSONContent["marks"] & object) => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) });
const para = (...content: JSONContent[]) => ({ type: "paragraph", content });
const item = (value: string, ...nested: JSONContent[]) => ({ type: "listItem", content: [para(text(value)), ...nested] });

const doc: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
    para(
      text("Bold", { type: "bold" }),
      text(" and "),
      text("both ", { type: "bold" }, { type: "italic" }),
      text("x", { type: "strike" }),
      text(" H"),
      text("2", { type: "subscript" }),
      text("O, "),
      text("code", { type: "code" }),
      text(", "),
      text("a link", { type: "link", attrs: { href: "https://example.com/a b" } }),
      text(" *not emphasis* # [x]"),
      { type: "hardBreak" },
      text("coloured", { type: "textStyle", attrs: { color: "#ff0000" } }),
    ),
    { type: "bulletList", content: [item("one", { type: "bulletList", content: [item("one.a")] }), item("two")] },
    { type: "orderedList", attrs: { start: 9 }, content: [item("nine"), item("ten")] },
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [para(text("done"))] },
        { type: "taskItem", attrs: { checked: false }, content: [para(text("open"))] },
      ],
    },
    { type: "blockquote", content: [para(text("Quoted")), para(text("Twice"))] },
    { type: "codeBlock", attrs: { language: "js" }, content: [text("const a = `x`;\n```")] },
    { type: "horizontalRule" },
    { type: "image", attrs: { src: "/api/docs/D/images/I", alt: "Chart" } },
    {
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [para(text("Name"))] }, { type: "tableHeader", content: [para(text("Role"))] }] },
        { type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [para(text("a|b"))] }] },
      ],
    },
    { type: "paragraph" },
    { type: "pageBreak" },
    para(text("End")),
  ],
};

describe("Markdown export", () => {
  it("writes GitHub-flavoured Markdown", () => {
    expect(toMarkdown(doc, { imageUrl: (src) => `https://colo.example${src}` })).toBe(
      [
        "## Plan",
        "",
        "**Bold** and ***both*** ~~x~~ H<sub>2</sub>O, `code`, [a link](https://example.com/a%20b) \\*not emphasis\\* # \\[x\\]\\",
        "coloured",
        "",
        "- one",
        "  - one.a",
        "- two",
        "",
        "9. nine",
        "10. ten",
        "",
        "- [x] done",
        "- [ ] open",
        "",
        "> Quoted",
        ">",
        "> Twice",
        "",
        "````js",
        "const a = `x`;",
        "```",
        "````",
        "",
        "---",
        "",
        "![Chart](https://colo.example/api/docs/D/images/I)",
        "",
        "| Name | Role |",
        "| --- | --- |",
        "| a\\|b |  |",
        "",
        "",
        "",
        "<!-- page break -->",
        "",
        "End",
        "",
      ].join("\n"),
    );
  });
});

describe("plain text", () => {
  it("exports readable text with list markers and tab-separated tables", () => {
    expect(toPlainText(doc)).toBe(
      [
        "Plan",
        "Bold and both x H2O, code, a link *not emphasis* # [x]",
        "coloured",
        "• one",
        "   • one.a",
        "• two",
        "9. nine",
        "10. ten",
        "[x] done",
        "[ ] open",
        "    Quoted",
        "    Twice",
        "const a = `x`;",
        "```",
        "————————————————————",
        "[Image: Chart]",
        "Name\tRole",
        "a|b",
        "",
        "End",
        "",
      ].join("\n"),
    );
  });

  it("imports each line as a paragraph", () => {
    expect(fromPlainText("First\r\n\r\nThird\n")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }, { type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "Third" }] }],
    });
  });
});
