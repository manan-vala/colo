import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { TableView } from "@tiptap/extension-table";
import { gridColumns } from "./layout";

/**
 * Tiptap's table view plus what pagination needs. On paged screens each row is laid out as its
 * own CSS grid (see `.colo-paged .colo-table` in index.css), so rows are separate blocks and a
 * page's margin band can fall between them; the table itself keeps Tiptap's schema and its
 * `colwidth` column sizes. This view turns those sizes into `--colo-columns` for the grid.
 *
 * A table with vertically merged cells cannot be split between rows, so it is marked
 * `data-merged-rows` and keeps ordinary table layout (it moves to the next page as a whole).
 */
export class PagedTableView extends TableView {
  private readonly observer: MutationObserver;

  constructor(node: ProseMirrorNode, cellMinWidth: number, view?: EditorView, HTMLAttributes?: Record<string, unknown>) {
    super(node, cellMinWidth, view, HTMLAttributes);
    this.dom.classList.add("colo-table");
    this.syncLayout(node);
    // Column resizing previews a drag by editing the colgroup directly; mirror it into the grid.
    this.observer = new MutationObserver(() => this.syncColumns());
    this.observer.observe(this.colgroup, { attributes: true, childList: true, subtree: true });
  }

  update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    this.syncLayout(node);
    return true;
  }

  destroy() {
    this.observer.disconnect();
  }

  private syncLayout(node: ProseMirrorNode) {
    let mergedRows = false;
    node.descendants((child) => {
      if ((child.attrs.rowspan as number | undefined) && child.attrs.rowspan > 1) mergedRows = true;
      return !mergedRows && child.type.spec.tableRole !== "cell" && child.type.spec.tableRole !== "header_cell";
    });
    this.dom.toggleAttribute("data-merged-rows", mergedRows);
    this.syncColumns();
  }

  private syncColumns() {
    const widths = Array.from(this.colgroup.children, (col) => parseFloat((col as HTMLElement).style.width) || null);
    this.dom.style.setProperty("--colo-columns", gridColumns(widths));
  }
}
