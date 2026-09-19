import { strFromU8, unzipSync } from "fflate";
import { ImportError } from "../model";
import { NS, children, parsePart, type XmlParser } from "./xml";

/**
 * A .docx is a zip of XML parts linked by relationship files (Open Packaging Conventions). This
 * opens one with limits that keep a hostile file from exhausting the browser: the compressed
 * size, and the declared size of everything inside, checked before anything is inflated.
 */

export const DOCX_LIMITS: { fileBytes: number; unzippedBytes: number; parts: number } = {
  fileBytes: 50_000_000,
  unzippedBytes: 200_000_000,
  parts: 5_000,
};

export interface Relationship {
  type: string;
  /** Package path for internal targets; the URL for external ones. */
  target: string;
  external: boolean;
}

export interface DocxPackage {
  /** A part's text, or null if it does not exist. */
  text(path: string): string | null;
  bytes(path: string): Uint8Array | null;
  xml(path: string): Document | null;
  /** Relationships of a part, by ID. */
  relationships(partPath: string): Map<string, Relationship>;
  /** The main document part (usually word/document.xml). */
  mainPart: string;
}

const OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

export function openPackage(data: Uint8Array, parse: XmlParser, limits: typeof DOCX_LIMITS = DOCX_LIMITS): DocxPackage {
  if (data.byteLength > limits.fileBytes) throw new ImportError("The file is larger than 50 MB.");
  if (data[0] === 0xd0 && data[1] === 0xcf) {
    throw new ImportError("This is an old Word 97–2003 .doc file. Save it as .docx in Word and import that.");
  }
  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new ImportError("This file is not a Word document (.docx).");

  let declared = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        declared += file.originalSize;
        count += 1;
        if (declared > limits.unzippedBytes || count > limits.parts) {
          throw new ImportError("The file expands to more than Colo can open (200 MB).");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("The file is damaged or is not a Word document.");
  }

  const parts = new Map(Object.entries(files).map(([name, bytes]) => [name.replace(/^\//, ""), bytes]));
  const xmlCache = new Map<string, Document | null>();
  const relsCache = new Map<string, Map<string, Relationship>>();

  const text = (path: string) => {
    const bytes = parts.get(path);
    return bytes ? strFromU8(bytes) : null;
  };
  const xml = (path: string) => {
    if (!xmlCache.has(path)) xmlCache.set(path, parsePart(parse, text(path)));
    return xmlCache.get(path) ?? null;
  };
  const relationships = (partPath: string) => {
    let rels = relsCache.get(partPath);
    if (!rels) {
      rels = new Map();
      const slash = partPath.lastIndexOf("/");
      const dir = slash >= 0 ? partPath.slice(0, slash) : "";
      const doc = xml(`${dir ? `${dir}/` : ""}_rels/${partPath.slice(slash + 1)}.rels`);
      for (const rel of doc ? children(doc.documentElement, NS.rel, "Relationship") : []) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (!id || !target) continue;
        const external = rel.getAttribute("TargetMode") === "External";
        rels.set(id, { type: rel.getAttribute("Type") ?? "", target: external ? target : resolvePath(dir, target), external });
      }
      relsCache.set(partPath, rels);
    }
    return rels;
  };

  const main = [...relationships("").values()].find((rel) => rel.type === OFFICE_DOCUMENT && !rel.external)?.target ?? "word/document.xml";
  if (!parts.has(main) || !xml(main)) throw new ImportError("The file has no readable document inside.");

  return { text, bytes: (path) => parts.get(path) ?? null, xml, relationships, mainPart: main };
}

/** Resolves a relationship target against the directory of its source part. */
export function resolvePath(dir: string, target: string): string {
  const segments = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const segment of target.replace(/^\//, "").split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.join("/");
}

/** The first relationship of a type from a part, as a package path. */
export function partOfType(pkg: DocxPackage, from: string, typeSuffix: string): string | null {
  for (const rel of pkg.relationships(from).values()) {
    if (!rel.external && rel.type.endsWith(typeSuffix)) return rel.target;
  }
  return null;
}
