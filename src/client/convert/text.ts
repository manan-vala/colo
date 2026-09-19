import type { JSONContent } from "@tiptap/core";

/**
 * Plain text in and out. Export keeps the reading order and list markers, puts table cells
 * on one line separated by tabs, and writes checklists as [x] / [ ]. Import makes each line a
 * paragraph, as Google Docs does.
 */

export function toPlainText(doc: JSONContent): string {
  return blocks(doc.content ?? [], "").join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function blocks(nodes: JSONContent[], indent: string): string[] {
  return nodes.flatMap((node) => block(node, indent));
}

function block(node: JSONContent, indent: string): string[] {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
      return inline(node)
        .split("\n")
        .map((line) => indent + line);
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const start = Number(node.attrs?.start) || 1;
      return (node.content ?? []).flatMap((item, i) => {
        const marker = node.type === "orderedList" ? `${start + i}. ` : node.type === "taskList" ? `[${item.attrs?.checked ? "x" : " "}] ` : "• ";
        const [first = "", ...rest] = blocks(item.content ?? [], indent + "   ");
        return [indent + marker + first.slice(indent.length + 3), ...rest];
      });
    }
    case "blockquote":
      return blocks(node.content ?? [], indent + "    ");
    case "horizontalRule":
      return [indent + "—".repeat(20)];
    case "pageBreak":
      return [""];
    case "image":
      return node.attrs?.alt ? [`${indent}[Image: ${node.attrs.alt}]`] : [];
    case "table":
      return (node.content ?? []).map((row) => indent + (row.content ?? []).map((cell) => inline(cell).replace(/\n/g, " ")).join("\t"));
    default:
      return node.content ? blocks(node.content, indent) : [];
  }
}

function inline(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const separator = node.type === "tableCell" || node.type === "tableHeader" ? " " : "";
  return (node.content ?? []).map(inline).join(separator);
}

/** Each line becomes a paragraph; blank lines stay as empty paragraphs. */
export function fromPlainText(text: string): JSONContent {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  return {
    type: "doc",
    content: lines.map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
}
