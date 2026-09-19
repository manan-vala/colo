import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_TITLE, SETTINGS_KEYS, SETTINGS_MAP, readPageSettings } from "../../shared/doc-schema";
import { LIMITS } from "../../shared/protocol";
import { api } from "../api";
import type { Collaboration } from "../collab/useCollaboration";
import { readThreads, type Author } from "../comments/model";
import { IMPORT_ACCEPT, type ExportKind } from "../convert/formats";
import { takePendingImport } from "../convert/pending";
import { navigate } from "../router";
import type { ImportReport } from "./ImportReportDialog";
import { describeImportError, importAsNewDocument, saveDownload } from "./imports";

/**
 * Files in and out of an open document (plan F10): applying a file imported from the list page,
 * File → Open file (a new document), File → Replace with file (after an "import" restore point)
 * and File → Download. Converters load only when used.
 */
export function useFileTransfers({
  editor,
  collab,
  author,
  onError,
}: {
  editor: Editor;
  collab: Collaboration;
  author: Author;
  onError: (message: string) => void;
}) {
  const [report, setReport] = useState<ImportReport | null>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);

  // A file imported from the list page arrives once the document has connected.
  useEffect(() => {
    const pending = takePendingImport(collab.docId);
    if (!pending) return;
    void import("../convert/apply").then(({ applyImport }) => {
      applyImport(editor, collab.doc, pending.document, author);
      setReport({ fileName: pending.fileName, notes: pending.document.notes, replaced: false });
    });
  }, [editor, collab.docId, collab.doc, author]);

  const openFile = async (file: File) => {
    onError(`Importing “${file.name}”…`);
    try {
      navigate(`/d/${await importAsNewDocument(file)}`);
    } catch (error) {
      onError(describeImportError(error));
    }
  };

  const replaceWithFile = async (file: File) => {
    onError(`Importing “${file.name}”…`);
    try {
      const { readImport } = await import("../convert");
      const imported = await readImport(file);
      // The current version stays available as a restore point.
      const label = `Before importing “${file.name}”`.slice(0, LIMITS.restorePointLabelLength);
      await api(`/api/docs/${collab.docId}/restore-points`, { body: { label, kind: "import" } });
      const { applyImport, uploadImportedImages } = await import("../convert/apply");
      const ready = await uploadImportedImages(collab.docId, imported);
      applyImport(editor, collab.doc, ready, author);
      setReport({ fileName: file.name, notes: ready.notes, replaced: true });
    } catch (error) {
      onError(describeImportError(error));
    }
  };

  const download = async (kind: ExportKind | "pdf") => {
    if (kind === "pdf") {
      // Printing draws the pages exactly as on screen; the print dialog saves them as PDF.
      window.print();
      return;
    }
    try {
      const { exportDocument } = await import("../convert");
      const settings = collab.doc.getMap(SETTINGS_MAP);
      const title = settings.get(SETTINGS_KEYS.title);
      const { blob, fileName } = await exportDocument(kind, {
        title: typeof title === "string" && title.trim() ? title.trim() : DEFAULT_TITLE,
        content: editor.getJSON(),
        settings: readPageSettings((key) => settings.get(key)),
        threads: readThreads(collab.doc),
      });
      saveDownload(blob, fileName);
    } catch {
      onError("The document could not be downloaded.");
    }
  };

  const fileInput = (ref: React.RefObject<HTMLInputElement | null>, label: string, onFile: (file: File) => void) => (
    <input
      ref={ref}
      type="file"
      accept={IMPORT_ACCEPT}
      hidden
      aria-label={label}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onFile(file);
      }}
    />
  );

  const inputs: ReactNode = (
    <>
      {fileInput(openInput, "Choose a file to open", (file) => void openFile(file))}
      {fileInput(replaceInput, "Choose a file to replace this document", (file) => void replaceWithFile(file))}
    </>
  );

  return {
    report,
    closeReport: () => setReport(null),
    openFile: () => openInput.current?.click(),
    replaceWithFile: () => replaceInput.current?.click(),
    download: (kind: ExportKind | "pdf") => void download(kind),
    inputs,
  };
}
