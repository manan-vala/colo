import { DEFAULT_TITLE } from "../../../shared/doc-schema";
import { ImportError, NoteList, type ImportedDocument } from "../model";
import { BodyReader } from "./body";
import { readComments } from "./comments";
import { Drawings } from "./drawings";
import { Numbering } from "./numbering";
import { DOCX_LIMITS, openPackage, partOfType } from "./package";
import { readHeaderFooter, readPageSettings } from "./sections";
import { Styles, readThemeFonts } from "./styles";
import { NS, attr, child, children, descendants, val, type XmlParser } from "./xml";

export interface ReadDocxOptions {
  /** DOMParser in the browser; @xmldom/xmldom in tests. */
  parseXml: XmlParser;
  /** Used for the title when the file has none. */
  fileName?: string;
  /** Thread IDs; crypto.randomUUID by default. */
  newId?: () => string;
  /** Size limits; tests lower them. */
  limits?: typeof DOCX_LIMITS;
}

/**
 * Reads a .docx into Colo's document model (plan F10, ADR 0005): content with formatting,
 * lists, tables, images, links and comment anchors; page setup; header and footer text; comment
 * threads; and notes on anything converted or left out. Throws ImportError for files that cannot
 * be read at all.
 */
export function readDocx(data: Uint8Array, options: ReadDocxOptions): ImportedDocument {
  const pkg = openPackage(data, options.parseXml, options.limits);
  const notes = new NoteList();
  const main = pkg.mainPart;
  const part = (type: string) => {
    const path = partOfType(pkg, main, type);
    return path ? pkg.xml(path) : null;
  };

  const theme = readThemeFonts(part("/theme"));
  const styles = new Styles(part("/styles"), theme);
  const numbering = new Numbering(part("/numbering"));
  const fontClasses = new Map<string, string | null>();
  const fontTable = part("/fontTable");
  for (const font of fontTable ? children(fontTable.documentElement, NS.w, "font") : []) {
    const name = attr(font, NS.w, "name");
    if (name) fontClasses.set(name, val(font, "family"));
  }

  const comments = readComments(pkg, options.newId ?? (() => crypto.randomUUID()));
  const images = new Map<string, Blob>();
  const reader = new BodyReader({
    pkg,
    styles,
    numbering,
    drawings: new Drawings(pkg, images, notes),
    notes,
    threadOf: comments.threadOf,
    fontClass: (name) => fontClasses.get(name) ?? null,
  });

  const body = child(pkg.xml(main)?.documentElement, NS.w, "body");
  if (!body) throw new ImportError("The file has no document body.");
  const content = reader.document(body);

  const sections = descendants(body, NS.w, "sectPr");
  const sectPr = child(body, NS.w, "sectPr") ?? sections[sections.length - 1] ?? null;
  const settings = { ...readPageSettings(sectPr, notes), ...readHeaderFooter(pkg, sectPr, notes) };

  const threads = comments.threads.map((thread) => ({ ...thread, quote: reader.quotes.get(thread.id)?.trim() ?? "" }));

  return {
    title: documentTitle(pkg, options.fileName),
    content: { type: "doc", content },
    settings,
    threads,
    images,
    notes: notes.list(),
  };
}

/** The title in the file's properties, else the file name without its extension. */
function documentTitle(pkg: ReturnType<typeof openPackage>, fileName: string | undefined): string {
  const corePath = partOfType(pkg, "", "/metadata/core-properties");
  const core = corePath ? pkg.xml(corePath) : null;
  const title = core ? descendants(core, NS.dc, "title")[0]?.textContent?.trim() : "";
  const fromName = fileName?.replace(/\.[^.]+$/, "").trim();
  return title || fromName || DEFAULT_TITLE;
}
