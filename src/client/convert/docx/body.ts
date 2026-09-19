import type { JSONContent } from "@tiptap/core";
import { isSafeLink } from "../../editor/links";
import { DEFAULT_FONT, DEFAULT_FONT_SIZE } from "../../editor/font-list";
import type { NoteList } from "../model";
import { groupBlocks, type Block, type ListKind } from "./blocks";
import type { Drawings } from "./drawings";
import { genericFor, officeFontToCss } from "./fonts";
import type { Numbering } from "./numbering";
import type { DocxPackage } from "./package";
import { readParaProps, type ParaProps, type RunProps, type Styles } from "./styles";
import { INDENT_STEP_TWIPS, twipsToPx } from "./units";
import { NS, attr, child, children, descendants, intAttr, is, onOff, val } from "./xml";

/**
 * Walks WordprocessingML body content (the document, table cells, text boxes, notes) and emits
 * Colo blocks: paragraphs and headings with their runs as marked text, tables with merged
 * cells, images, page breaks and lines. Lists and quotes come out flat and are grouped by
 * `groupBlocks`.
 */

export const BODY_NOTES = {
  tracked: "Tracked changes were accepted",
  notes: "Footnotes and endnotes were moved to a numbered Notes list at the end",
  equations: "Equations were left out",
  objects: "Embedded objects were left out",
  bookmarks: "Links to places inside the document kept only their text",
  sections: "Section breaks were removed (Colo documents have one page setup)",
} as const;

const MAX_LEVEL = 8;
/** Word's list indent step, used when a single-level list is nested only by indentation. */
const LIST_INDENT_STEP = 360;

export interface BodyContext {
  pkg: DocxPackage;
  styles: Styles;
  numbering: Numbering;
  drawings: Drawings;
  notes: NoteList;
  /** Word comment ID → Colo thread ID. */
  threadOf: Map<string, string>;
  /** Font name → CSS generic family, from the font table. */
  fontClass: (name: string) => string | null;
}

/** Callbacks a paragraph's inline walk reports to. */
interface InlineSink {
  text: (node: JSONContent) => void;
  pageBreak: () => void;
  image: (node: JSONContent) => void;
  textBox: (content: Element) => void;
  checkbox: (checked: boolean) => void;
}

interface Field {
  instruction: string;
  inResult: boolean;
  link: string | null;
}

interface NoteRef {
  number: number;
  kind: "footnote" | "endnote";
  id: string;
}

export class BodyReader {
  /** Comment threads whose range is open at this point of the walk (ranges cross paragraphs). */
  private readonly activeThreads = new Set<string>();
  /** Text covered by each thread, for its quote. */
  readonly quotes = new Map<string, string>();
  private readonly noteRefs: NoteRef[] = [];
  /** numId → counters per level, so a list interrupted by other paragraphs keeps counting. */
  private readonly counters = new Map<string, number[]>();
  /** Ranges still open per thread: a reply repeats its root's range, so a thread can have several. */
  private readonly openRanges = new Map<string, number>();
  private sections = 0;

  constructor(private readonly ctx: BodyContext) {}

  /** The whole body: blocks, grouped, with the notes list appended. */
  document(body: Element): JSONContent[] {
    const blocks = this.blocks(body, this.ctx.pkg.mainPart);
    if (this.sections > 0) this.ctx.notes.add("converted", BODY_NOTES.sections, this.sections);
    const content = groupBlocks(blocks);
    content.push(...this.notesList());
    return content.length ? content : [{ type: "paragraph" }];
  }

  /** Block-level children of a container (body, cell, text box, note). */
  blocks(container: Element, part: string): Block[] {
    const out: Block[] = [];
    for (const element of children(container)) {
      if (is(element, NS.w, "p")) out.push(...this.paragraph(element, part));
      else if (is(element, NS.w, "tbl")) out.push(this.table(element, part));
      else if (is(element, NS.w, "sdt")) {
        const content = child(element, NS.w, "sdtContent");
        if (content) out.push(...this.blocks(content, part));
      } else if (is(element, NS.w, "customXml")) out.push(...this.blocks(element, part));
    }
    return out;
  }

  // ---- paragraphs ------------------------------------------------------------------------

  private paragraph(p: Element, part: string): Block[] {
    const pPr = child(p, NS.w, "pPr");
    if (child(pPr, NS.w, "sectPr")) this.sections++;
    const styleId = val(pPr, "pStyle");
    const props = this.ctx.styles.resolvePara(styleId, readParaProps(pPr));
    const styleName = this.ctx.styles.paragraphStyleName(styleId).toLowerCase();
    const heading = headingLevel(styleName, props);
    const group = heading ? undefined : groupOf(styleName);

    const out: Block[] = [];
    const after: Block[] = [];
    let inline: JSONContent[] = [];
    let checked: boolean | undefined;
    const flush = () => {
      if (!inline.length) return;
      out.push(this.paragraphBlock(mergeText(inline), props, heading, group, styleName, checked));
      inline = [];
    };

    if (props.pageBreakBefore) out.push({ node: { type: "pageBreak" } });
    this.inline(p, part, styleId, {
      text: (node) => inline.push(node),
      pageBreak: () => {
        flush();
        out.push({ node: { type: "pageBreak" } });
      },
      image: (node) => {
        flush();
        const align = props.align === "center" || props.align === "right" ? props.align : null;
        out.push({ node: { ...node, attrs: { ...node.attrs, textAlign: align } } });
      },
      textBox: (content) => after.push(...this.blocks(content, part)),
      checkbox: (value) => (checked = value),
    });
    flush();
    // An empty paragraph is kept (it is a blank line); one that held only a page break, an
    // image or a text box is that break, image or text.
    if (!out.length && !after.length) out.push(this.paragraphBlock([], props, heading, group, styleName, checked));

    // An empty paragraph with a bottom border is Word's horizontal line.
    if (props.borderBottom && out.length === 1 && out[0].node.type === "paragraph" && !out[0].node.content?.length) {
      return [{ node: { type: "horizontalRule" } }, ...after];
    }
    return [...out, ...after];
  }

  private paragraphBlock(
    content: JSONContent[],
    props: ParaProps,
    heading: number | null,
    group: Block["group"],
    styleName: string,
    checked: boolean | undefined,
  ): Block {
    const align = props.align && props.align !== "left" ? props.align : null;
    const list = heading ? null : this.listOf(props, styleName, checked);
    const indent = list || group ? 0 : Math.min(MAX_LEVEL, Math.max(0, Math.round((props.indentLeft ?? 0) / INDENT_STEP_TWIPS)));
    const node: JSONContent = heading
      ? { type: "heading", attrs: { level: heading, textAlign: align, indent } }
      : { type: "paragraph", attrs: { textAlign: align, indent } };
    // Word puts a space between a checkbox and its text; the checklist item has its own box.
    if (list?.kind === "task") content = trimStart(content);
    if (content.length) node.content = content;
    return { node, ...(list ? { list } : {}), ...(group ? { group } : {}) };
  }

  /** Which list (if any) a paragraph belongs to, at which level, and its number. */
  private listOf(props: ParaProps, styleName: string, checked: boolean | undefined): Block["list"] | undefined {
    if (checked !== undefined) return { kind: "task", level: this.indentLevel(props), start: 1, checked };
    const level = this.ctx.numbering.level(props.numId, props.ilvl ?? 0);
    if (!level || props.numId === undefined) return undefined;
    let depth = props.ilvl ?? 0;
    if (level.singleLevel) {
      const byStyle = /^list (?:bullet|number)(?: (\d))?$/.exec(styleName);
      depth = byStyle ? Number(byStyle[1] ?? 1) - 1 : this.indentLevel(props);
    }
    depth = Math.min(MAX_LEVEL, Math.max(0, depth));
    const counters = this.counters.get(props.numId) ?? [];
    counters[depth] = (counters[depth] ?? level.start - 1) + 1;
    counters.length = depth + 1;
    this.counters.set(props.numId, counters);
    const kind: ListKind = level.kind === "bullet" ? "bullet" : "ordered";
    return { kind, level: depth, start: counters[depth] };
  }

  private indentLevel(props: ParaProps): number {
    return Math.max(0, Math.round((props.indentLeft ?? 0) / LIST_INDENT_STEP) - 1);
  }

  // ---- runs --------------------------------------------------------------------------------

  private inline(container: Element, part: string, styleId: string | null, sink: InlineSink) {
    const fields: Field[] = [];
    const links: (string | null)[] = [];

    const emit = (text: string, props: RunProps, extra: Partial<RunProps> = {}) => {
      if (!text) return;
      if (fields.some((field) => !field.inResult)) return;
      const link = links.findLast((l) => l !== null) ?? fields.findLast((f) => f.link)?.link ?? null;
      const threads = [...this.activeThreads];
      for (const thread of threads) this.quotes.set(thread, (this.quotes.get(thread) ?? "") + text);
      sink.text({ type: "text", text, marks: this.marks({ ...props, ...extra }, link, threads) });
    };

    const run = (r: Element) => {
      const rPr = child(r, NS.w, "rPr");
      const props = this.ctx.styles.resolveRun(styleId, val(rPr, "rStyle"), this.ctx.styles.runProps(rPr));
      runChildren(r, props);
    };

    const runChildren = (parent: Element, props: RunProps) => {
      for (const node of children(parent)) {
        if (node.namespaceURI === NS.w) {
          switch (node.localName) {
            case "t":
              emit(node.textContent ?? "", props);
              break;
            case "tab":
            case "ptab":
              emit("\t", props);
              break;
            case "br": {
              const type = attr(node, NS.w, "type");
              if (type === "page") sink.pageBreak();
              else if (!fields.some((f) => !f.inResult)) sink.text({ type: "hardBreak" });
              break;
            }
            case "cr":
              sink.text({ type: "hardBreak" });
              break;
            case "noBreakHyphen":
              emit("-", props);
              break;
            case "sym": {
              const code = Number.parseInt(attr(node, NS.w, "char") ?? "", 16);
              const font = attr(node, NS.w, "font") ?? "";
              // Symbol-font characters live in the private use area; only real ones are kept.
              if (Number.isFinite(code) && !/symbol|wingdings|webdings/i.test(font) && code < 0xf000) emit(String.fromCodePoint(code), props);
              break;
            }
            case "fldChar": {
              const type = attr(node, NS.w, "fldCharType");
              if (type === "begin") fields.push({ instruction: "", inResult: false, link: null });
              else if (type === "separate" && fields.length) {
                const field = fields[fields.length - 1];
                field.inResult = true;
                field.link = hyperlinkTarget(field.instruction);
              } else if (type === "end") fields.pop();
              break;
            }
            case "instrText":
              if (fields.length) fields[fields.length - 1].instruction += node.textContent ?? "";
              break;
            case "drawing": {
              const image = this.ctx.drawings.drawing(node, part, sink.textBox);
              if (image) sink.image(image);
              break;
            }
            case "pict": {
              const image = this.ctx.drawings.pict(node, part, sink.textBox);
              if (image) sink.image(image);
              break;
            }
            case "footnoteReference":
            case "endnoteReference": {
              const id = attr(node, NS.w, "id");
              if (id === null) break;
              const number = this.noteRefs.length + 1;
              this.noteRefs.push({ number, kind: node.localName === "footnoteReference" ? "footnote" : "endnote", id });
              emit(String(number), props, { vertAlign: "super" });
              break;
            }
            case "object":
              this.ctx.notes.add("dropped", BODY_NOTES.objects);
              break;
          }
        } else if (is(node, NS.mc, "AlternateContent")) {
          // The first choice is the modern form; the fallback repeats it for old readers.
          const choice = child(node, NS.mc, "Choice") ?? child(node, NS.mc, "Fallback");
          if (choice) runChildren(choice, props);
        }
      }
    };

    const walk = (parent: Element) => {
      for (const node of children(parent)) {
        if (node.namespaceURI === NS.m) {
          if (node.localName === "oMath" || node.localName === "oMathPara") this.ctx.notes.add("dropped", BODY_NOTES.equations);
          continue;
        }
        if (is(node, NS.mc, "AlternateContent")) {
          const choice = child(node, NS.mc, "Choice") ?? child(node, NS.mc, "Fallback");
          if (choice) walk(choice);
          continue;
        }
        if (node.namespaceURI !== NS.w) continue;
        switch (node.localName) {
          case "r":
            run(node);
            break;
          case "hyperlink": {
            const id = attr(node, NS.r, "id");
            const rel = id ? this.ctx.pkg.relationships(part).get(id) : undefined;
            const href = rel?.external && isSafeLink(rel.target) ? rel.target : null;
            if (!href && attr(node, NS.w, "anchor")) this.ctx.notes.add("converted", BODY_NOTES.bookmarks);
            links.push(href);
            walk(node);
            links.pop();
            break;
          }
          case "fldSimple": {
            const href = hyperlinkTarget(attr(node, NS.w, "instr") ?? "");
            links.push(href);
            walk(node);
            links.pop();
            break;
          }
          case "ins":
          case "moveTo":
            this.ctx.notes.add("converted", BODY_NOTES.tracked);
            walk(node);
            break;
          case "del":
          case "moveFrom":
            this.ctx.notes.add("converted", BODY_NOTES.tracked);
            break;
          case "sdt": {
            const checkbox = descendants(child(node, NS.w, "sdtPr") ?? node, NS.w14, "checkbox")[0];
            if (checkbox) {
              sink.checkbox(attr(child(checkbox, NS.w14, "checked"), NS.w14, "val") === "1");
              break;
            }
            const content = child(node, NS.w, "sdtContent");
            if (content) walk(content);
            break;
          }
          case "smartTag":
          case "customXml":
          case "dir":
          case "bdo":
            walk(node);
            break;
          case "commentRangeStart": {
            const thread = this.ctx.threadOf.get(attr(node, NS.w, "id") ?? "");
            if (thread) this.activeThreads.add(thread);
            break;
          }
          case "commentRangeEnd": {
            const thread = this.ctx.threadOf.get(attr(node, NS.w, "id") ?? "");
            // A reply's range ends where its root's does; the root's end closes the thread.
            if (thread && this.closesThread(thread, node)) this.activeThreads.delete(thread);
            break;
          }
        }
      }
    };

    walk(container);
  }

  /** True when this range end is the thread's last open range (replies repeat the root's). */
  private closesThread(thread: string, end: Element): boolean {
    if (!this.openRanges.has(thread)) {
      const starts = descendants(end.ownerDocument, NS.w, "commentRangeStart");
      this.openRanges.set(thread, starts.filter((start) => this.ctx.threadOf.get(attr(start, NS.w, "id") ?? "") === thread).length);
    }
    const left = (this.openRanges.get(thread) ?? 1) - 1;
    this.openRanges.set(thread, left);
    return left <= 0;
  }

  private marks(props: RunProps, link: string | null, threads: string[]): JSONContent["marks"] {
    const marks: NonNullable<JSONContent["marks"]> = [];
    if (props.bold) marks.push({ type: "bold" });
    if (props.italic) marks.push({ type: "italic" });
    if (props.underline && !link) marks.push({ type: "underline" });
    if (props.strike) marks.push({ type: "strike" });
    if (props.vertAlign === "sub") marks.push({ type: "subscript" });
    if (props.vertAlign === "super") marks.push({ type: "superscript" });
    const style: Record<string, string> = {};
    if (props.font) {
      const family = officeFontToCss(props.font, genericFor(this.ctx.fontClass(props.font)));
      if (family !== DEFAULT_FONT.family) style.fontFamily = family;
    }
    if (props.size && props.size !== DEFAULT_FONT_SIZE) style.fontSize = `${props.size}pt`;
    if (props.color && props.color !== "#000000" && !link) style.color = props.color;
    if (Object.keys(style).length) marks.push({ type: "textStyle", attrs: style });
    if (props.highlight) marks.push({ type: "highlight", attrs: { color: props.highlight } });
    if (link) marks.push({ type: "link", attrs: { href: link } });
    for (const threadId of threads) marks.push({ type: "comment", attrs: { threadId } });
    return marks.length ? marks : undefined;
  }

  // ---- tables ------------------------------------------------------------------------------

  private table(tbl: Element, part: string): Block {
    const grid = children(child(tbl, NS.w, "tblGrid") ?? tbl, NS.w, "gridCol").map((col) => Math.round(twipsToPx(intAttr(col, NS.w, "w") ?? 0)));
    const rows: JSONContent[] = [];
    // The cell each grid column's vertical merge continues from.
    const mergeFrom = new Map<number, JSONContent>();
    for (const tr of children(tbl, NS.w, "tr")) {
      const trPr = child(tr, NS.w, "trPr");
      const header = onOff(trPr, "tblHeader") === true;
      let column = intAttr(child(trPr, NS.w, "gridBefore"), NS.w, "val") ?? 0;
      const cells: JSONContent[] = [];
      for (const tc of children(tr, NS.w, "tc")) {
        const tcPr = child(tc, NS.w, "tcPr");
        const span = Math.max(1, intAttr(child(tcPr, NS.w, "gridSpan"), NS.w, "val") ?? 1);
        const vMerge = child(tcPr, NS.w, "vMerge");
        const continues = vMerge && attr(vMerge, NS.w, "val") !== "restart";
        const above = continues ? mergeFrom.get(column) : undefined;
        if (above) {
          above.attrs!.rowspan = (above.attrs!.rowspan as number) + 1;
          column += span;
          continue;
        }
        const widths = grid.slice(column, column + span);
        const content = groupBlocks(this.blocks(tc, part));
        const cell: JSONContent = {
          type: header ? "tableHeader" : "tableCell",
          attrs: { colspan: span, rowspan: 1, colwidth: widths.length === span && widths.every((w) => w > 0) ? widths : null },
          content: content.length ? content : [{ type: "paragraph" }],
        };
        for (let c = column; c < column + span; c++) {
          if (vMerge) mergeFrom.set(c, cell);
          else mergeFrom.delete(c);
        }
        cells.push(cell);
        column += span;
      }
      if (cells.length) rows.push({ type: "tableRow", content: cells });
    }
    return rows.length ? { node: { type: "table", content: rows } } : { node: { type: "paragraph" } };
  }

  // ---- footnotes and endnotes --------------------------------------------------------------

  /** The notes referenced in the text, as a "Notes" heading and a numbered list. */
  private notesList(): JSONContent[] {
    if (!this.noteRefs.length) return [];
    this.ctx.notes.add("converted", BODY_NOTES.notes, this.noteRefs.length);
    const items = this.noteRefs.map((ref) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: this.noteContent(ref) }],
    }));
    return [
      { type: "horizontalRule" },
      { type: "paragraph", content: [{ type: "text", text: "Notes", marks: [{ type: "bold" }] }] },
      { type: "orderedList", content: items },
    ];
  }

  private noteContent(ref: NoteRef): JSONContent[] | undefined {
    const { pkg } = this.ctx;
    const part = [...pkg.relationships(pkg.mainPart).values()].find((rel) => rel.type.endsWith(`/${ref.kind}s`))?.target;
    const doc = part ? pkg.xml(part) : null;
    const note = doc ? children(doc.documentElement, NS.w, ref.kind).find((n) => attr(n, NS.w, "id") === ref.id) : undefined;
    if (!note || !part) return undefined;
    // Note text only: its paragraphs joined with line breaks, the note mark itself skipped.
    const text = this.blocks(note, part)
      .map((block) => block.node)
      .flatMap((node, i) => (i === 0 ? node.content ?? [] : [{ type: "hardBreak" }, ...(node.content ?? [])]))
      .filter((node) => node.type === "text" || node.type === "hardBreak");
    const trimmed = text.length && text[0].type === "text" ? [{ ...text[0], text: text[0].text!.replace(/^\s+/, "") }, ...text.slice(1)] : text;
    const result = trimmed.filter((node) => node.type !== "text" || node.text);
    return result.length ? result : undefined;
  }
}

// ---- helpers ------------------------------------------------------------------------------

/** Colo heading level (1–4) for Word's Title, Subtitle and Heading 1–9 styles. */
function headingLevel(styleName: string, props: ParaProps): number | null {
  if (styleName === "title") return 1;
  if (styleName === "subtitle") return 2;
  const named = /^heading (\d)$/.exec(styleName);
  const level = named ? Number(named[1]) : props.outlineLevel !== undefined && props.outlineLevel < 9 ? props.outlineLevel + 1 : null;
  return level ? Math.min(4, level) : null;
}

function groupOf(styleName: string): Block["group"] {
  if (/quote/.test(styleName)) return "quote";
  if (/^(code|html preformatted|source code|macro text|plain text)/.test(styleName)) return "code";
  return undefined;
}

/** The URL of a HYPERLINK field, if it is a safe external link. */
function hyperlinkTarget(instruction: string): string | null {
  const match = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(instruction);
  return match && !/\\l/.test(instruction.slice(match[0].length)) && isSafeLink(match[1]) ? match[1] : null;
}

function trimStart(content: JSONContent[]): JSONContent[] {
  const [first, ...rest] = content;
  if (first?.type !== "text") return content;
  const text = (first.text ?? "").replace(/^\s+/, "");
  return text ? [{ ...first, text }, ...rest] : rest;
}

/** Joins neighbouring text nodes that carry the same marks. */
function mergeText(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last?.type === "text" && node.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      last.text = (last.text ?? "") + (node.text ?? "");
    } else {
      out.push({ ...node });
    }
  }
  return out;
}

