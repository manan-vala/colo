import type { JSONContent } from "@tiptap/core";
import {
  AlignmentType,
  BorderStyle,
  CheckBox,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import { sheetSize, type HeaderFooterText, type PageSettings } from "../../../shared/doc-schema";
import { BODY_TEXT, HEADING_TEXT, LINE_SPACING, PARAGRAPH_AFTER_PT, QUOTE_TEXT, textLook, type TextLook } from "../defaults";
import { cssFontToOffice } from "./fonts";
import { INDENT_STEP_TWIPS, mmToTwips, pxToTwips } from "./units";

/**
 * Writes a Colo document as .docx with the `docx` library (plan F10, ADR 0005): formatted text,
 * headings, lists and checklists, tables with merged cells, images, links, quotes, code, page
 * breaks and lines; page setup; header and footer with page-number fields; comment threads with
 * replies and resolved state. Styles carry Colo's look, so the file opens looking like Colo.
 */

export interface ExportImage {
  data: Uint8Array;
  type: "png" | "jpg" | "gif" | "bmp";
}

export interface ExportThread {
  id: string;
  quote: string;
  resolved: boolean;
  comments: { author: string; date: string | null; body: string }[];
}

export interface DocxSource {
  title: string;
  content: JSONContent;
  settings: PageSettings;
  threads: ExportThread[];
  /** Image bytes by the image node's `src`; images missing here are left out. */
  images: Map<string, ExportImage>;
}

type Block = Paragraph | Table;
type Mark = NonNullable<JSONContent["marks"]>[number];

const BULLETS = ["●", "○", "■"];
const ORDERED_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
const LIST_LEVELS = 9;
const LIST_INDENT = 360;
const PX_PER_INCH = 96;

export async function writeDocx(source: DocxSource): Promise<Uint8Array> {
  return new DocxWriter(source).write();
}

class DocxWriter {
  /** Word comment IDs of each thread (the root first, then replies). */
  private readonly commentIds = new Map<string, number[]>();
  /** The first and last text node (in document order) of each thread's anchor. */
  private readonly anchors = new Map<string, { first: number; last: number }>();
  private textIndex = 0;
  /** Ordered lists get their own numbering instance (and start); `start` values share configs. */
  private readonly orderedStarts = new Set<number>();
  private listInstance = 0;
  /** Ranges for threads whose text was deleted, placed at the start of the first paragraph. */
  private detachedAnchors: ParagraphChild[] = [];
  private readonly contentWidthPx: number;

  constructor(private readonly source: DocxSource) {
    const sheet = sheetSize(source.settings);
    const { left, right } = source.settings.margins;
    this.contentWidthPx = ((sheet.width - left - right) / 25.4) * PX_PER_INCH;
  }

  async write(): Promise<Uint8Array> {
    this.indexAnchors(this.source.content);
    const comments = this.commentOptions();
    this.detachedAnchors = this.detachedThreadAnchors();
    const children = this.blocks(this.source.content.content ?? [], 0);
    // A document without a paragraph still needs somewhere for detached threads.
    if (this.detachedAnchors.length) children.unshift(new Paragraph({ children: this.detachedAnchors }));

    const { settings } = this.source;
    const sheet = sheetSize({ pageSize: settings.pageSize, orientation: "portrait" });
    const document = new Document({
      title: this.source.title,
      creator: "Colo",
      styles: this.styles(),
      numbering: { config: this.numberingConfig() },
      comments: { children: comments },
      sections: [
        {
          properties: {
            page: {
              size: {
                width: mmToTwips(sheet.width),
                height: mmToTwips(sheet.height),
                orientation: settings.orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
              },
              margin: {
                top: mmToTwips(settings.margins.top),
                bottom: mmToTwips(settings.margins.bottom),
                left: mmToTwips(settings.margins.left),
                right: mmToTwips(settings.margins.right),
              },
            },
          },
          headers: hasText(settings.header) ? { default: new Header({ children: [this.headerFooter(settings.header)] }) } : undefined,
          footers: hasText(settings.footer) ? { default: new Footer({ children: [this.headerFooter(settings.footer)] }) } : undefined,
          children: children.length ? children : [new Paragraph({})],
        },
      ],
    });
    return new Uint8Array(await Packer.toArrayBuffer(document));
  }

  // ---- blocks ------------------------------------------------------------------------------

  private blocks(nodes: JSONContent[], listLevel: number): Block[] {
    return nodes.flatMap((node) => this.block(node, listLevel));
  }

  private block(node: JSONContent, listLevel: number): Block[] {
    switch (node.type) {
      case "paragraph":
        return [this.paragraph(node, {})];
      case "heading": {
        const level = Math.min(4, Math.max(1, Number(node.attrs?.level) || 1));
        return [this.paragraph(node, { heading: HEADINGS[level - 1] }, level)];
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        return this.list(node, listLevel);
      case "blockquote":
        return (node.content ?? []).flatMap((child) =>
          child.type === "paragraph" ? [this.paragraph(child, { style: "Quote" }, null, [], true)] : this.block(child, listLevel),
        );
      case "codeBlock":
        return plain(node)
          .split("\n")
          .map((line) => new Paragraph({ style: "Code", children: [new TextRun({ text: line })] }));
      case "horizontalRule":
        return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } } })];
      case "pageBreak":
        return [new Paragraph({ children: [new PageBreak()] })];
      case "image":
        return this.image(node);
      case "table":
        return [this.table(node)];
      default:
        return node.content ? this.blocks(node.content, listLevel) : [];
    }
  }

  private paragraph(node: JSONContent, options: IParagraphOptions, heading: number | null = null, prefix: ParagraphChild[] = [], quote = false): Paragraph {
    const indent = Number(node.attrs?.indent) || 0;
    const anchors = this.detachedAnchors;
    this.detachedAnchors = [];
    return new Paragraph({
      ...options,
      alignment: ALIGNMENTS[node.attrs?.textAlign as string] ?? options.alignment,
      indent: options.indent ?? (indent ? { left: indent * INDENT_STEP_TWIPS } : undefined),
      children: [...anchors, ...prefix, ...this.inline(node.content ?? [], textLook(heading, quote))],
    });
  }

  private list(list: JSONContent, level: number): Block[] {
    const task = list.type === "taskList";
    const ordered = list.type === "orderedList";
    const start = Math.max(1, Number(list.attrs?.start) || 1);
    if (ordered) this.orderedStarts.add(start);
    const instance = ++this.listInstance;
    const reference = ordered ? `colo-ordered-${start}` : "colo-bullet";
    const depth = Math.min(level, LIST_LEVELS - 1);
    return (list.content ?? []).flatMap((item) => {
      const [first, ...rest] = item.content ?? [];
      const firstBlock =
        first?.type === "paragraph"
          ? task
            ? this.paragraph(first, { indent: { left: LIST_INDENT * (depth + 1) } }, null, [
                new CheckBox({ checked: item.attrs?.checked === true }),
                new TextRun(" "),
              ])
            : this.paragraph(first, { numbering: { reference, level: depth, instance } })
          : null;
      const others = rest.flatMap((child) =>
        child.type === "paragraph" ? [this.paragraph(child, { indent: { left: LIST_INDENT * (depth + 1) } })] : this.block(child, level + 1),
      );
      return [...(firstBlock ? [firstBlock] : first ? this.block(first, level + 1) : []), ...others];
    });
  }

  private image(node: JSONContent): Block[] {
    const image = this.source.images.get(String(node.attrs?.src ?? ""));
    if (!image) return [];
    let width = Number(node.attrs?.width) || 0;
    let height = Number(node.attrs?.height) || 0;
    if (!width || !height) [width, height] = [this.contentWidthPx, this.contentWidthPx * 0.66];
    // Colo shows an image no wider than the text column; Word would let it overflow.
    if (width > this.contentWidthPx) [width, height] = [this.contentWidthPx, (height * this.contentWidthPx) / width];
    return [
      new Paragraph({
        alignment: ALIGNMENTS[node.attrs?.textAlign as string],
        children: [
          new ImageRun({
            type: image.type,
            data: image.data,
            transformation: { width: Math.round(width), height: Math.round(height) },
            altText: node.attrs?.alt ? { name: String(node.attrs.alt), description: String(node.attrs.alt), title: String(node.attrs.alt) } : undefined,
          }),
        ],
      }),
    ];
  }

  private table(node: JSONContent): Table {
    const rows = node.content ?? [];
    const columnWidths = columnWidthsOf(rows[0]);
    return new Table({
      width: columnWidths.every((w) => w > 0) ? { size: columnWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA } : { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: columnWidths.every((w) => w > 0) ? columnWidths : undefined,
      rows: rows.map(
        (row) =>
          new TableRow({
            tableHeader: (row.content ?? []).every((cell) => cell.type === "tableHeader"),
            children: (row.content ?? []).map((cell) => {
              const widths = (cell.attrs?.colwidth as number[] | null) ?? null;
              const blocks = this.blocks(cell.content ?? [], 0);
              return new TableCell({
                columnSpan: Number(cell.attrs?.colspan) || 1,
                rowSpan: Number(cell.attrs?.rowspan) || 1,
                width: widths ? { size: pxToTwips(widths.reduce((a, b) => a + b, 0)), type: WidthType.DXA } : undefined,
                children: blocks.length ? blocks : [new Paragraph({})],
              });
            }),
          }),
      ),
    });
  }

  // ---- inline ------------------------------------------------------------------------------

  private inline(nodes: JSONContent[], look: TextLook): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    for (const node of nodes) {
      if (node.type === "hardBreak") {
        out.push(new TextRun({ break: 1 }));
        continue;
      }
      if (node.type !== "text" || !node.text) continue;
      const index = this.textIndex++;
      const marks = node.marks ?? [];
      const threads = marks.filter((m) => m.type === "comment").map((m) => String(m.attrs?.threadId));
      for (const thread of threads) {
        if (this.anchors.get(thread)?.first === index) out.push(...(this.commentIds.get(thread) ?? []).map((id) => new CommentRangeStart(id)));
      }
      const link = marks.find((m) => m.type === "link")?.attrs?.href as string | undefined;
      const runs = splitTabs(node.text).map((part) => (part === "\t" ? new TextRun({ ...this.runOptions(marks, look, !!link), children: [new Tab()] }) : new TextRun({ ...this.runOptions(marks, look, !!link), text: part })));
      if (link) out.push(new ExternalHyperlink({ link, children: runs }));
      else out.push(...runs);
      for (const thread of threads) {
        if (this.anchors.get(thread)?.last !== index) continue;
        for (const id of this.commentIds.get(thread) ?? []) out.push(new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] }));
      }
    }
    return out;
  }

  private runOptions(marks: Mark[], look: TextLook, link: boolean): IRunOptions {
    const has = (type: string) => marks.some((m) => m.type === type);
    const style = marks.find((m) => m.type === "textStyle")?.attrs ?? {};
    const highlight = marks.find((m) => m.type === "highlight")?.attrs?.color as string | undefined;
    const font = style.fontFamily ? cssFontToOffice(String(style.fontFamily)) : null;
    const size = points(style.fontSize as string | undefined);
    const color = hex(style.color as string | undefined);
    const fill = hex(highlight) ?? (highlight ? "FFFF00" : undefined);
    return {
      style: link ? "Hyperlink" : undefined,
      bold: has("bold") || undefined,
      italics: has("italic") || undefined,
      underline: has("underline") ? {} : undefined,
      strike: has("strike") || undefined,
      subScript: has("subscript") || undefined,
      superScript: has("superscript") || undefined,
      font: font && font !== look.font ? font : undefined,
      size: size && size !== look.size ? size * 2 : undefined,
      color: color && `#${color.toLowerCase()}` !== look.color ? color : undefined,
      shading: fill ? { type: ShadingType.CLEAR, fill, color: "auto" } : undefined,
    };
  }

  // ---- header and footer ---------------------------------------------------------------------

  private headerFooter(text: HeaderFooterText): Paragraph {
    const width = pxToTwips(this.contentWidthPx);
    return new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: width }],
      children: [...fieldRuns(text.left), new TextRun({ children: [new Tab()] }), ...fieldRuns(text.right)],
    });
  }

  // ---- comments -------------------------------------------------------------------------------

  /** Finds where each thread's anchor starts and ends, in the same order `inline` visits text. */
  private indexAnchors(node: JSONContent) {
    let index = 0;
    const visit = (current: JSONContent) => {
      if (current.type === "text" && current.text) {
        for (const mark of current.marks ?? []) {
          if (mark.type !== "comment") continue;
          const id = String(mark.attrs?.threadId);
          const anchor = this.anchors.get(id);
          if (anchor) anchor.last = index;
          else this.anchors.set(id, { first: index, last: index });
        }
        index++;
        return;
      }
      // Code blocks are written as plain text, without anchors.
      if (current.type === "codeBlock") return;
      for (const child of current.content ?? []) visit(child);
    };
    visit(node);
  }

  private commentOptions() {
    let next = 1;
    return this.source.threads.flatMap((thread) => {
      const comments = thread.comments.filter((c) => c.body.trim());
      if (!comments.length) return [];
      const ids = comments.map(() => next++);
      this.commentIds.set(thread.id, ids);
      return comments.map((comment, i) => {
        const detached = !this.anchors.has(thread.id) && i === 0 && thread.quote;
        const body = detached ? `(On deleted text “${thread.quote}”) ${comment.body}` : comment.body;
        return {
          id: ids[i],
          author: comment.author,
          initials: initials(comment.author),
          date: comment.date ? new Date(comment.date) : undefined,
          parentId: i > 0 ? ids[0] : undefined,
          resolved: i === 0 && thread.resolved ? true : undefined,
          children: body.split("\n").map((line) => new Paragraph({ children: [new TextRun(line)] })),
        };
      });
    });
  }

  /** Threads whose text was deleted get an empty range at the start of the document. */
  private detachedThreadAnchors(): ParagraphChild[] {
    const detached = [...this.commentIds.entries()].filter(([thread]) => !this.anchors.has(thread)).flatMap(([, ids]) => ids);
    return detached.flatMap((id) => [new CommentRangeStart(id), new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] })]);
  }

  // ---- styles and numbering -----------------------------------------------------------------

  private styles() {
    const run = (look: TextLook) => ({ font: look.font, size: look.size * 2, color: look.color.slice(1) });
    const spacing = { after: Math.round(PARAGRAPH_AFTER_PT * 20), line: Math.round(LINE_SPACING * 240) };
    const heading = (level: 1 | 2 | 3 | 4) => ({
      run: { ...run(HEADING_TEXT[level]), bold: false },
      paragraph: { spacing: { before: Math.round(HEADING_TEXT[level].size * 20), after: 120 }, keepNext: true },
    });
    return {
      default: {
        document: { run: run(BODY_TEXT), paragraph: { spacing } },
        heading1: heading(1),
        heading2: heading(2),
        heading3: heading(3),
        heading4: heading(4),
      },
      paragraphStyles: [
        {
          id: "Quote",
          name: "Quote",
          basedOn: "Normal",
          next: "Normal",
          run: { color: QUOTE_TEXT.color.slice(1).toUpperCase() },
          paragraph: { indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: "DADCE0", space: 8 } } },
        },
        {
          id: "Code",
          name: "Code",
          basedOn: "Normal",
          run: { font: "Courier New", size: 20 },
          paragraph: { spacing: { after: 0, line: 240 }, shading: { type: ShadingType.CLEAR, fill: "F1F3F4", color: "auto" } },
        },
      ],
    };
  }

  private numberingConfig() {
    const level = (i: number, format: (typeof LevelFormat)[keyof typeof LevelFormat], text: string, start = 1) => ({
      level: i,
      format,
      text,
      start,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: LIST_INDENT * (i + 1), hanging: LIST_INDENT } } },
    });
    const bullets = {
      reference: "colo-bullet",
      levels: Array.from({ length: LIST_LEVELS }, (_, i) => level(i, LevelFormat.BULLET, BULLETS[i % BULLETS.length])),
    };
    const ordered = [...this.orderedStarts, 1].map((start) => ({
      reference: `colo-ordered-${start}`,
      levels: Array.from({ length: LIST_LEVELS }, (_, i) => level(i, ORDERED_FORMATS[i % ORDERED_FORMATS.length], `%${i + 1}.`, i === 0 ? start : 1)),
    }));
    return [bullets, ...ordered.filter((config, i) => ordered.findIndex((c) => c.reference === config.reference) === i)];
  }
}

// ---- helpers ------------------------------------------------------------------------------

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];

const ALIGNMENTS: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

function hasText(text: HeaderFooterText): boolean {
  return !!(text.left.trim() || text.right.trim());
}

/** Header/footer text with `{page}` and `{total}` as Word page-number fields. */
function fieldRuns(text: string): TextRun[] {
  return text
    .split(/(\{page\}|\{total\})/)
    .filter(Boolean)
    .map((part) =>
      part === "{page}"
        ? new TextRun({ children: [PageNumber.CURRENT] })
        : part === "{total}"
          ? new TextRun({ children: [PageNumber.TOTAL_PAGES] })
          : new TextRun(part),
    );
}

function splitTabs(text: string): string[] {
  return text.split(/(\t)/).filter(Boolean);
}

function plain(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(plain).join("");
}

/** Column widths (twips) from a table's first row, expanding merged cells. */
function columnWidthsOf(row: JSONContent | undefined): number[] {
  return (row?.content ?? []).flatMap((cell) => {
    const span = Number(cell.attrs?.colspan) || 1;
    const widths = cell.attrs?.colwidth as number[] | null | undefined;
    return Array.from({ length: span }, (_, i) => (widths?.[i] ? pxToTwips(widths[i]) : 0));
  });
}

/** "14pt" → 14; "16px" → 12; anything else → null. */
function points(size: string | undefined): number | null {
  const match = size ? /^([\d.]+)(pt|px)$/.exec(size.trim()) : null;
  if (!match) return null;
  return match[2] === "pt" ? Number(match[1]) : Number(match[1]) * 0.75;
}

/** A CSS colour (#rgb, #rrggbb, rgb()) as Word's RRGGBB. */
function hex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const value = color.trim().toLowerCase();
  let match = /^#([0-9a-f]{6})$/.exec(value);
  if (match) return match[1].toUpperCase();
  match = /^#([0-9a-f]{3})$/.exec(value);
  if (match) return match[1].replace(/./g, (c) => c + c).toUpperCase();
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (rgb) return rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
  return undefined;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
