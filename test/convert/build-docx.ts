import { strToU8, zipSync } from "fflate";

/** Builds a minimal .docx around some body XML, for reader edge cases Word fixtures cannot pin down. */

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
].join(" ");

const REL_TYPES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface DocxParts {
  /** Extra relationships from the document part: id → [type suffix, target, external?]. */
  rels?: Record<string, [string, string, boolean?]>;
  /** Extra package parts by path. */
  parts?: Record<string, string | Uint8Array>;
}

export function buildDocx(body: string, extra: DocxParts = {}): Uint8Array {
  const rels = Object.entries(extra.rels ?? {})
    .map(
      ([id, [type, target, external]]) =>
        `<Relationship Id="${id}" Type="${REL_TYPES}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`,
    )
    .join("");
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_TYPES}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    ),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`),
  };
  for (const [path, content] of Object.entries(extra.parts ?? {})) files[path] = typeof content === "string" ? strToU8(content) : content;
  return zipSync(files);
}

/** A paragraph with plain runs. */
export const p = (...runs: string[]) => `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join("")}</w:p>`;
