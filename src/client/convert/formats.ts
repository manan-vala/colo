/**
 * The formats Colo imports and exports, as data only, so menus can list them without loading
 * the converters.
 */

export type ImportKind = "docx" | "markdown" | "html" | "text";
export type ExportKind = "docx" | "html" | "markdown" | "text";

/** For the file picker's `accept`. */
export const IMPORT_ACCEPT = ".docx,.md,.markdown,.html,.htm,.txt";

/** File → Download, in menu order ("pdf" prints, as Save as PDF). */
export const DOWNLOAD_FORMATS: { kind: ExportKind | "pdf"; label: string }[] = [
  { kind: "docx", label: "Microsoft Word (.docx)" },
  { kind: "pdf", label: "PDF document (.pdf)" },
  { kind: "html", label: "Web page (.html)" },
  { kind: "markdown", label: "Markdown (.md)" },
  { kind: "text", label: "Plain text (.txt)" },
];
