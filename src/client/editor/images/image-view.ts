import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

const MIN_WIDTH = 24;
type Side = "left" | "right";

/**
 * An image on the page: a frame sized from the node's width and height (so its space is
 * reserved before it loads), aligned by the node's text alignment, with resize handles at the
 * bottom corners while it is selected. Every attribute change, local or remote, re-renders it.
 *
 * The frame's CSS width is also capped by the text column and by the page's text height
 * (index.css), so an image never overflows a page.
 */
export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly img: HTMLImageElement;
  private node: ProseMirrorNode;
  private endResize: (() => void) | null = null;

  constructor(
    node: ProseMirrorNode,
    private readonly editor: Editor,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom = element("div", "colo-image");
    this.frame = element("span", "colo-image-frame");
    this.img = document.createElement("img");
    this.img.addEventListener("load", () => {
      // An image without a stored size (from pasted HTML) takes its natural size.
      if (!this.node.attrs.width) this.setSize(this.img.naturalWidth, this.img.naturalHeight);
    });
    this.frame.append(this.img, this.handle("left"), this.handle("right"));
    this.dom.append(this.frame);
    this.render(node);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.render(node);
    return true;
  }

  /** Resizing is handled here, not by ProseMirror. */
  stopEvent(event: Event): boolean {
    return event.target instanceof HTMLElement && event.target.classList.contains("colo-image-handle");
  }

  /** The DOM belongs to this view; ProseMirror need not re-read it. */
  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.endResize?.();
  }

  private render(node: ProseMirrorNode) {
    this.node = node;
    const { src, alt, width, height, textAlign } = node.attrs as Record<string, string | number | null>;
    if (typeof src === "string" && this.img.getAttribute("src") !== src) this.img.src = src;
    this.img.alt = typeof alt === "string" ? alt : "";
    this.dom.dataset.align = textAlign === "center" || textAlign === "right" ? textAlign : "left";
    if (typeof width === "number" && typeof height === "number") this.setSize(width, height);
  }

  private setSize(width: number, height: number) {
    if (!(width > 0 && height > 0)) return;
    this.frame.style.setProperty("--colo-image-width", `${width}px`);
    this.frame.style.setProperty("--colo-image-ratio", String(width / height));
    this.img.style.aspectRatio = `${width} / ${height}`;
  }

  private handle(side: Side): HTMLElement {
    const handle = element("span", `colo-image-handle colo-image-handle-${side}`);
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => this.startResize(event, side));
    return handle;
  }

  /** Drags a corner: the image keeps its proportions; the new width is committed on release. */
  private startResize(event: PointerEvent, side: Side) {
    if (!this.editor.isEditable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startWidth = this.frame.offsetWidth;
    // Page zoom is CSS zoom: pointer movement is in screen pixels, widths are not.
    const zoom = this.frame.getBoundingClientRect().width / startWidth || 1;
    // A centred image grows on both sides, so each pixel of movement adds two.
    const factor = (side === "right" ? 1 : -1) * (this.dom.dataset.align === "center" ? 2 : 1);
    const maxWidth = this.dom.clientWidth;
    const ratio = this.ratio();
    let width = startWidth;

    const move = (moveEvent: PointerEvent) => {
      width = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + (factor * (moveEvent.clientX - startX)) / zoom));
      this.setSize(width, width / ratio);
    };
    const end = (commit: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      this.endResize = null;
      if (commit && Math.round(width) !== Math.round(startWidth)) this.commit(Math.round(width), Math.round(width / ratio));
      else this.render(this.node);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    this.endResize = () => end(false);
  }

  private ratio(): number {
    const { width, height } = this.node.attrs as { width: number | null; height: number | null };
    if (width && height) return width / height;
    return this.img.naturalWidth && this.img.naturalHeight ? this.img.naturalWidth / this.img.naturalHeight : 1;
  }

  private commit(width: number, height: number) {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { view } = this.editor;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width, height }));
  }
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
