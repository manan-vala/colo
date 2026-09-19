import {
  DEFAULT_PAGE_SETTINGS,
  HEADER_FOOTER_MAX_LENGTH,
  MARGIN_LIMITS,
  PAGE_SIZES,
  fitsPage,
  type HeaderFooterText,
  type PageSettings,
  type PageSizeName,
} from "../../../shared/doc-schema";
import type { NoteList } from "../model";
import type { DocxPackage } from "./package";
import { NS, attr, child, children, intAttr, is, isElement, val } from "./xml";
import { round1, twipsToMm } from "./units";

/**
 * Page setup and header/footer text from the document's last section (Colo documents have one).
 * Headers become Colo's left/right text: tabs separate the parts, and PAGE / NUMPAGES fields
 * become `{page}` / `{total}`.
 */

/** How far (mm) a page size may be from A4 or Letter and still count as it. */
const SIZE_TOLERANCE = 3;

export function readPageSettings(sectPr: Element | null, notes: NoteList): Partial<PageSettings> {
  if (!sectPr) return {};
  const settings: Partial<PageSettings> = {};
  const size = child(sectPr, NS.w, "pgSz");
  const width = intAttr(size, NS.w, "w");
  const height = intAttr(size, NS.w, "h");
  if (width && height) {
    const landscape = attr(size, NS.w, "orient") === "landscape" || width > height;
    settings.orientation = landscape ? "landscape" : "portrait";
    const short = twipsToMm(Math.min(width, height));
    const long = twipsToMm(Math.max(width, height));
    const match = (Object.keys(PAGE_SIZES) as PageSizeName[]).find(
      (name) => Math.abs(PAGE_SIZES[name].width - short) <= SIZE_TOLERANCE && Math.abs(PAGE_SIZES[name].height - long) <= SIZE_TOLERANCE,
    );
    settings.pageSize = match ?? nearestSize(short, long);
    if (!match) notes.add("converted", `The page size (${Math.round(short)} × ${Math.round(long)} mm) became ${PAGE_SIZES[settings.pageSize].label}`);
  }
  const margins = child(sectPr, NS.w, "pgMar");
  if (margins) {
    const mm = (side: string) => {
      const twips = Math.abs(intAttr(margins, NS.w, side) ?? 0);
      return Math.min(MARGIN_LIMITS.max, round1(twipsToMm(twips)));
    };
    const candidate = { top: mm("top"), bottom: mm("bottom"), left: mm("left"), right: mm("right") };
    const page = { pageSize: settings.pageSize ?? DEFAULT_PAGE_SETTINGS.pageSize, orientation: settings.orientation ?? DEFAULT_PAGE_SETTINGS.orientation };
    if (fitsPage({ ...page, margins: candidate })) settings.margins = candidate;
    else notes.add("converted", "The margins left too little room for text, so Colo's default margins are used");
  }
  if ((intAttr(child(sectPr, NS.w, "cols"), NS.w, "num") ?? 1) > 1) notes.add("dropped", "Text columns were not kept");
  return settings;
}

function nearestSize(short: number, long: number): PageSizeName {
  const distance = (name: PageSizeName) => Math.abs(PAGE_SIZES[name].width - short) + Math.abs(PAGE_SIZES[name].height - long);
  return (Object.keys(PAGE_SIZES) as PageSizeName[]).reduce((best, name) => (distance(name) < distance(best) ? name : best));
}

/** The default header and footer of a section, as Colo's one-line left/right text. */
export function readHeaderFooter(pkg: DocxPackage, sectPr: Element | null, notes: NoteList): Pick<PageSettings, "header" | "footer"> | Record<string, never> {
  if (!sectPr) return {};
  const part = (kind: "header" | "footer", type: string) => {
    const ref = children(sectPr, NS.w, `${kind}Reference`).find((r) => attr(r, NS.w, "type") === type);
    const id = ref ? attr(ref, NS.r, "id") : null;
    const rel = id ? pkg.relationships(pkg.mainPart).get(id) : undefined;
    return rel && !rel.external ? pkg.xml(rel.target) : null;
  };
  const text = (kind: "header" | "footer") => {
    const doc = part(kind, "default") ?? part(kind, "first");
    if (!doc) return { left: "", right: "" };
    for (const type of ["first", "even"]) {
      const other = part(kind, type);
      if (other && other !== doc && lineText(other).trim()) {
        notes.add("dropped", "Different first-page or even-page headers and footers were not kept");
      }
    }
    return splitLeftRight(doc, notes);
  };
  return { header: text("header"), footer: text("footer") };
}

/** A header's text on one line, with fields as Colo's placeholders and tabs kept. */
function lineText(doc: Document): string {
  return children(doc.documentElement, NS.w, "p")
    .map((p) => paragraphText(p))
    .filter((line) => line.trim())
    .join(" ");
}

function splitLeftRight(doc: Document, notes: NoteList): HeaderFooterText {
  const paragraphs = children(doc.documentElement, NS.w, "p");
  const line = lineText(doc);
  const parts = line
    .split("\t")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length > 1 && paragraphs.filter((p) => paragraphText(p).trim()).length > 1) {
    notes.add("converted", "Headers and footers with several lines were joined into one line");
  }
  const clip = (text: string) => text.slice(0, HEADER_FOOTER_MAX_LENGTH);
  if (parts.length === 0) return { left: "", right: "" };
  if (parts.length === 1) {
    const right = paragraphs.some((p) => val(child(p, NS.w, "pPr"), "jc") === "right");
    return right ? { left: "", right: clip(parts[0]) } : { left: clip(parts[0]), right: "" };
  }
  if (parts.length > 2) notes.add("dropped", "Centred header and footer text was not kept (Colo has left and right parts)");
  return { left: clip(parts[0]), right: clip(parts[parts.length - 1]) };
}

/** Text of a header paragraph, following simple and complex fields. */
function paragraphText(p: Element): string {
  let out = "";
  let field: { instruction: string; showResult: boolean } | null = null;
  const token = (instruction: string) => {
    const name = instruction.trim().split(/\s+/)[0]?.toUpperCase();
    if (name === "PAGE") return "{page}";
    if (name === "NUMPAGES" || name === "SECTIONPAGES") return "{total}";
    return null;
  };
  const walk = (element: Element) => {
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (!isElement(node)) continue;
      if (is(node, NS.w, "fldSimple")) {
        const t = token(attr(node, NS.w, "instr") ?? "");
        if (t) out += t;
        else walk(node);
      } else if (is(node, NS.w, "fldChar")) {
        const type = attr(node, NS.w, "fldCharType");
        if (type === "begin") field = { instruction: "", showResult: true };
        else if (type === "separate" && field) {
          const t = token(field.instruction);
          if (t) {
            out += t;
            field.showResult = false;
          }
        } else if (type === "end") field = null;
      } else if (is(node, NS.w, "instrText")) {
        if (field) field.instruction += node.textContent ?? "";
      } else if (is(node, NS.w, "t")) {
        if (!field || field.showResult) out += node.textContent ?? "";
      } else if (is(node, NS.w, "tab") || is(node, NS.w, "ptab")) {
        out += "\t";
      } else if (!is(node, NS.w, "del") && !is(node, NS.w, "rPr") && !is(node, NS.w, "pPr")) {
        walk(node);
      }
    }
  };
  walk(p);
  return out;
}
