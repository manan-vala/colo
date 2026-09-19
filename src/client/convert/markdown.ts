import type { JSONContent } from "@tiptap/core";

/**
 * Colo documents as Markdown (GitHub-flavoured): headings, paragraphs, bold, italic, strike,
 * code, links, lists and checklists, quotes, code blocks, lines, images and tables. Formatting
 * Markdown has no syntax for (colours, fonts, sizes, underline, highlight, alignment, merged
 * cells, comments) is left out; sub/superscript use HTML tags, which most renderers show.
 *
 * Importing goes the other way through `marked` and the editor's HTML parser (see index.ts).
 */

export interface MarkdownOptions {
  /** The URL written for an image `src` (Colo's are relative and need a session). */
  imageUrl?: (src: string) => string;
}

type Mark = NonNullable<JSONContent["marks"]>[number];

export function toMarkdown(doc: JSONContent, options: MarkdownOptions = {}): string {
  return new MarkdownWriter(options).blocks(doc.content ?? []).trimEnd() + "\n";
}

class MarkdownWriter {
  constructor(private readonly options: MarkdownOptions) {}

  blocks(nodes: JSONContent[]): string {
    return nodes
      .map((node) => this.block(node))
      .filter((block) => block !== null)
      .join("\n\n");
  }

  private block(node: JSONContent): string | null {
    switch (node.type) {
      case "paragraph":
        return this.inline(node.content ?? []);
      case "heading":
        return `${"#".repeat(Math.min(6, Number(node.attrs?.level) || 1))} ${this.inline(node.content ?? [])}`;
      case "bulletList":
      case "orderedList":
      case "taskList":
        return this.list(node);
      case "blockquote":
        return prefixLines(this.blocks(node.content ?? []), "> ");
      case "codeBlock": {
        const code = plain(node);
        const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
        return `${fence}${node.attrs?.language ?? ""}\n${code}\n${fence}`;
      }
      case "horizontalRule":
        return "---";
      case "pageBreak":
        return "<!-- page break -->";
      case "image": {
        const src = String(node.attrs?.src ?? "");
        const url = this.options.imageUrl ? this.options.imageUrl(src) : src;
        return `![${escapeText(String(node.attrs?.alt ?? ""))}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
      }
      case "table":
        return this.table(node);
      default:
        return node.content ? this.blocks(node.content) : null;
    }
  }

  private list(list: JSONContent): string {
    const start = Number(list.attrs?.start) || 1;
    return (list.content ?? [])
      .map((item, i) => {
        const marker =
          list.type === "orderedList" ? `${start + i}.` : list.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}]` : "-";
        const body = this.itemBody(item.content ?? []);
        const indent = " ".repeat(list.type === "orderedList" ? marker.length + 1 : 2);
        const [first = "", ...rest] = body.split("\n");
        return [`${marker} ${first}`, ...rest.map((line) => (line ? indent + line : line))].join("\n");
      })
      .join("\n");
  }

  /** An item's blocks; a nested list follows its text directly, keeping the list tight. */
  private itemBody(nodes: JSONContent[]): string {
    let out = "";
    nodes.forEach((node, i) => {
      const block = this.block(node);
      if (block === null) return;
      if (i > 0) out += /List$/.test(node.type ?? "") ? "\n" : "\n\n";
      out += block;
    });
    return out;
  }

  /** GitHub tables have one header row and no merged cells: spanned positions are left empty. */
  private table(table: JSONContent): string {
    const rows = (table.content ?? []).map((row) =>
      (row.content ?? []).flatMap((cell) => {
        const text = this.inline((cell.content ?? []).flatMap((block, i) => (i ? [{ type: "hardBreak" }, ...(block.content ?? [])] : block.content ?? [])));
        const span = Number(cell.attrs?.colspan) || 1;
        // Pipes are already escaped as text; line breaks become <br>, which tables allow.
        return [text.replace(/\\\n/g, "<br>"), ...Array<string>(span - 1).fill("")];
      }),
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const line = (cells: string[]) => `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;
    return [line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
  }

  inline(nodes: JSONContent[]): string {
    let out = "";
    for (const node of mergeText(nodes)) {
      if (node.type === "hardBreak") out += "\\\n";
      else if (node.type === "text") out += this.text(node.text ?? "", node.marks ?? []);
    }
    return out;
  }

  /** A text node with its marks; whitespace stays outside the delimiters, where Markdown needs it. */
  private text(value: string, marks: Mark[]): string {
    const has = (type: string) => marks.some((m) => m.type === type);
    const code = has("code");
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(value)!;
    if (!core) return value;
    let body = code ? `\`${core}\`` : escapeText(core);
    if (has("subscript")) body = `<sub>${body}</sub>`;
    if (has("superscript")) body = `<sup>${body}</sup>`;
    if (has("strike")) body = `~~${body}~~`;
    if (has("italic")) body = `*${body}*`;
    if (has("bold")) body = `**${body}**`;
    const href = marks.find((m) => m.type === "link")?.attrs?.href;
    if (href) body = `[${body}](${String(href).replace(/[()\s]/g, encodeURIComponent)})`;
    return lead + body + trail;
  }
}

/** Joins neighbouring text nodes with the same marks, so formatting is not split needlessly. */
function mergeText(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    const sameMarks = JSON.stringify(visibleMarks(last)) === JSON.stringify(visibleMarks(node));
    if (last?.type === "text" && node.type === "text" && sameMarks) last.text = (last.text ?? "") + (node.text ?? "");
    else out.push(node.type === "text" ? { ...node, marks: visibleMarks(node) } : node);
  }
  return out;
}

const MARKDOWN_MARKS = new Set(["bold", "italic", "strike", "code", "link", "subscript", "superscript"]);
const visibleMarks = (node: JSONContent | undefined) => (node?.marks ?? []).filter((m) => MARKDOWN_MARKS.has(m.type));

/** Escapes characters Markdown would read as syntax. */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, "\\$&").replace(/^(#{1,6} |[-+] |\d+[.)] |>)/, "\\$1");
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : prefix.trimEnd()))
    .join("\n");
}

function plain(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(plain).join("");
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
