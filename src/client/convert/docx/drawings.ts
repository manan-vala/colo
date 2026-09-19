import type { JSONContent } from "@tiptap/core";
import { PENDING_IMAGE, type NoteList } from "../model";
import type { DocxPackage } from "./package";
import { NS, attr, child, descendants } from "./xml";
import { emuToPx } from "./units";

/**
 * Pictures in a Word document: DrawingML (`w:drawing`) and legacy VML (`w:pict`). Pictures
 * become image nodes whose bytes wait in `images` for upload; text boxes hand their content
 * back to the body reader; charts and diagrams are listed as left out.
 */

export const DRAWING_NOTES = {
  floating: "Floating images were placed in line with the text",
  unsupported: "Images in formats browsers cannot show (EMF, WMF, TIFF) were left out",
  linked: "Images linked from outside the file were left out",
  charts: "Charts, diagrams and shapes were left out",
  textBoxes: "Text boxes became ordinary paragraphs",
} as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

const PICTURE = "http://schemas.openxmlformats.org/drawingml/2006/picture";

export class Drawings {
  /** Package path → image key, so a picture used twice is uploaded once. */
  private readonly keys = new Map<string, string>();

  constructor(
    private readonly pkg: DocxPackage,
    private readonly images: Map<string, Blob>,
    private readonly notes: NoteList,
  ) {}

  /**
   * A DrawingML object. Returns an image node, or null; text box content is passed to
   * `textBox` (the caller turns it into paragraphs).
   */
  drawing(drawing: Element, part: string, textBox: (content: Element) => void): JSONContent | null {
    const frame = child(drawing, NS.wp, "inline") ?? child(drawing, NS.wp, "anchor");
    if (!frame) return null;
    const boxes = descendants(frame, NS.wps, "txbx").map((box) => child(box, NS.w, "txbxContent")).filter((c): c is Element => !!c);
    if (boxes.length) {
      this.notes.add("converted", DRAWING_NOTES.textBoxes);
      boxes.forEach(textBox);
      return null;
    }
    const data = descendants(frame, NS.a, "graphicData")[0];
    if (!data || data.getAttribute("uri") !== PICTURE) {
      this.notes.add("dropped", DRAWING_NOTES.charts);
      return null;
    }
    if (frame.localName === "anchor") this.notes.add("converted", DRAWING_NOTES.floating);
    const extent = child(frame, NS.wp, "extent");
    // cx/cy are unqualified attributes, in EMU.
    const width = emuToPx(Number(extent?.getAttribute("cx")) || 0);
    const height = emuToPx(Number(extent?.getAttribute("cy")) || 0);
    const docPr = child(frame, NS.wp, "docPr");
    const alt = docPr?.getAttribute("descr") || docPr?.getAttribute("title") || null;
    const blip = descendants(data, NS.a, "blip")[0];
    const embed = attr(blip, NS.r, "embed");
    if (!embed) {
      if (attr(blip, NS.r, "link")) this.notes.add("dropped", DRAWING_NOTES.linked);
      return null;
    }
    return this.picture(part, embed, width, height, alt);
  }

  /** A VML picture (`w:pict`): an image or a text box. */
  pict(pict: Element, part: string, textBox: (content: Element) => void): JSONContent | null {
    const boxes = descendants(pict, NS.w, "txbxContent");
    if (boxes.length) {
      this.notes.add("converted", DRAWING_NOTES.textBoxes);
      boxes.forEach(textBox);
      return null;
    }
    const imageData = descendants(pict, NS.v, "imagedata")[0];
    const id = attr(imageData, NS.r, "id");
    if (!imageData || !id) return null;
    const shape = imageData.parentNode as Element | null;
    const style = shape?.getAttribute?.("style") ?? "";
    const points = (name: string) => {
      const match = new RegExp(`${name}:\\s*([\\d.]+)pt`).exec(style);
      return match ? (Number(match[1]) * 96) / 72 : 0;
    };
    return this.picture(part, id, points("width"), points("height"), null);
  }

  private picture(part: string, relId: string, width: number, height: number, alt: string | null): JSONContent | null {
    const rel = this.pkg.relationships(part).get(relId);
    if (!rel || rel.external) {
      this.notes.add("dropped", DRAWING_NOTES.linked);
      return null;
    }
    const mime = MIME_BY_EXTENSION[rel.target.split(".").pop()?.toLowerCase() ?? ""];
    const bytes = this.pkg.bytes(rel.target);
    if (!mime || !bytes) {
      this.notes.add("dropped", DRAWING_NOTES.unsupported);
      return null;
    }
    let key = this.keys.get(rel.target);
    if (!key) {
      key = `image${this.keys.size + 1}`;
      this.keys.set(rel.target, key);
      // fflate's output is backed by a plain ArrayBuffer.
      this.images.set(key, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    }
    const size = width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : { width: null, height: null };
    return { type: "image", attrs: { src: `${PENDING_IMAGE}${key}`, alt, ...size } };
  }
}
