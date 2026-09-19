/**
 * M6 acceptance test for images (plan §11), with two people in one document:
 *
 * - an image added with the file picker, and a large one pasted from the clipboard, reach the
 *   other browser; the pasted one is compressed to WebP, at most 1 MB and 2048 px;
 * - resizing (dragging a corner) and centring sync;
 * - an image-heavy document keeps small shared state and no image crosses a page edge;
 * - pasted HTML keeps only Colo's own images; images print.
 *
 *   npm run build && npx vite preview --port 5173   (or npm run dev)
 *   node e2e/images.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import { BASE_URL, check, clickButton, enroll, launch, press, type EditorElement } from "./browser.ts";

/** The document's images as the editor holds them, in order. */
const imageNodes = (page: Page) =>
  page.evaluate(() => {
    const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
    const images: { src: string; width: number | null; height: number | null; textAlign: string | null }[] = [];
    editor.state.doc.descendants((node: any) => {
      if (node.type.name === "image") images.push({ ...node.attrs });
    });
    return images;
  });

/** Waits until `count` images are in the page and loaded. */
const waitForLoadedImages = (page: Page, count: number) =>
  page.waitForFunction(
    (n) => {
      const images = [...document.querySelectorAll<HTMLImageElement>(".colo-editor .colo-image img")];
      return images.length === n && images.every((img) => img.complete && img.naturalWidth > 0);
    },
    { timeout: 60_000 },
    count,
  );

/** Pastes files, as copying images in another app and pressing Ctrl+V does. */
async function pasteNoiseImages(page: Page, sizes: [number, number][]) {
  await page.evaluate(async (list) => {
    const transfer = new DataTransfer();
    for (const [i, [width, height]] of list.entries()) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      // Random pixels barely compress: the worst case for the 1 MB limit.
      const pixels = context.createImageData(width, height);
      const bytes = new Uint32Array(pixels.data.buffer);
      for (let p = 0; p < bytes.length; p++) bytes[p] = (Math.random() * 0xffffff) | 0xff000000;
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      transfer.items.add(new File([blob], `noise-${i}.png`, { type: "image/png" }));
    }
    const editor = document.querySelector(".colo-editor")!;
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, sizes);
}

async function pasteHtml(page: Page, html: string) {
  await page.evaluate((markup) => {
    const transfer = new DataTransfer();
    transfer.setData("text/html", markup);
    transfer.setData("text/plain", "pasted");
    document.querySelector(".colo-editor")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, html);
}

/** Selects the nth image the way a person does: by clicking it. */
async function clickImage(page: Page, index: number) {
  const images = await page.$$(".colo-editor .colo-image img");
  await images[index].click();
  await page.waitForSelector(".colo-image.ProseMirror-selectednode", { timeout: 5_000 });
}

const browser = await launch();
const fixtureDir = mkdtempSync(join(tmpdir(), "colo-images-"));
try {
  console.log(`Images acceptance test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const bea = await enroll(browser, "Bea");
  const [a, b] = [alex.page, bea.page];
  for (const page of [a, b]) await page.setViewport({ width: 1440, height: 900 });

  await clickButton(a, "New document");
  await a.waitForSelector(".colo-editor.colo-paged");
  await a.click(".colo-editor");
  await a.keyboard.type("A photo from the trip:");
  await a.keyboard.press("Enter");
  await b.goto(a.url());
  await b.waitForFunction(() => document.querySelector(".colo-editor")?.textContent?.includes("trip"), { timeout: 15_000 });

  // File picker: a 1200×800 PNG that already fits is uploaded as it is.
  // The browser reads a picked file lazily, so it is removed only at the end.
  const fixture = join(fixtureDir, "photo.png");
  const png = await a.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    // Flat shapes, like a diagram or screenshot: a small PNG.
    context.fillStyle = "#1a73e8";
    context.fillRect(0, 0, 1200, 800);
    context.fillStyle = "#fbbc04";
    context.fillRect(300, 200, 600, 400);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  writeFileSync(fixture, Buffer.from(png, "base64"));
  const [chooser] = await Promise.all([a.waitForFileChooser({ timeout: 10_000 }), press(a, "Insert image")]);
  await chooser.accept([fixture]);
  await waitForLoadedImages(a, 1);
  await waitForLoadedImages(b, 1);
  let nodes = await imageNodes(a);
  check(nodes[0].width === 1200 && nodes[0].height === 800, `the picked image keeps its size (${nodes[0].width}×${nodes[0].height})`);
  const picked = await a.evaluate(async (src) => (await fetch(src)).headers.get("Content-Type"), nodes[0].src);
  check(picked === "image/png", `an image that already fits is uploaded untouched (${picked})`);
  check(true, "Bea sees the picked image");

  // Paste: a 4000×3000 noise PNG (tens of MB) is scaled and compressed before upload.
  await a.click(".colo-editor p");
  await pasteNoiseImages(a, [[4000, 3000]]);
  await waitForLoadedImages(a, 2);
  await waitForLoadedImages(b, 2);
  const pickedSrc = nodes[0].src;
  nodes = await imageNodes(a);
  const pastedSrc = nodes.find((node) => node.src !== pickedSrc)!.src;
  const pasted = await a.evaluate(async (src) => {
    const response = await fetch(src);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    return { type: response.headers.get("Content-Type"), bytes: blob.size, width: bitmap.width, height: bitmap.height };
  }, pastedSrc);
  check(
    pasted.type === "image/webp" && pasted.bytes <= 1_000_000 && Math.max(pasted.width, pasted.height) <= 2048,
    `the pasted image is stored as WebP, ${(pasted.bytes / 1e6).toFixed(2)} MB, ${pasted.width}×${pasted.height}`,
  );
  check(true, "Bea sees the pasted image");

  // Resize by dragging the right-hand corner of the picked image 300 px to the left.
  const pickedIndex = nodes.findIndex((node) => node.src === pickedSrc);
  await clickImage(a, pickedIndex);
  const handle = await a.$(".colo-image.ProseMirror-selectednode .colo-image-handle-right");
  const box = (await handle!.boundingBox())!;
  const before = await a.$eval(".colo-image.ProseMirror-selectednode .colo-image-frame", (el) => (el as HTMLElement).offsetWidth);
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.mouse.down();
  for (let step = 1; step <= 10; step++) await a.mouse.move(box.x + box.width / 2 - step * 30, box.y + box.height / 2);
  await a.mouse.up();
  nodes = await imageNodes(a);
  const resized = nodes[pickedIndex];
  check(Math.abs(resized.width! - (before - 300)) <= 2, `dragging a corner resizes the image (${before} → ${resized.width} px)`);
  check(Math.abs(resized.width! / resized.height! - 1.5) < 0.01, "resizing keeps the proportions");
  await b.waitForFunction(
    (index, width) => Math.abs(document.querySelectorAll<HTMLElement>(".colo-editor .colo-image-frame")[index].offsetWidth - width) <= 1,
    { timeout: 10_000 },
    pickedIndex,
    resized.width!,
  );
  check(true, "Bea sees the new size");

  // Centre it with the toolbar's alignment control (Ctrl+Shift+E is the same command).
  await clickImage(a, pickedIndex);
  await press(a, "Align");
  await a.waitForSelector('[role="menuitem"]', { visible: true });
  await a.evaluate(() => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.includes("Centre align"));
    item!.click();
  });
  await b.waitForSelector('.colo-editor .colo-image[data-align="center"]', { timeout: 10_000 });
  const centred = await b.$eval('.colo-editor .colo-image[data-align="center"] .colo-image-frame', (frame) => {
    const own = frame.getBoundingClientRect();
    const column = frame.parentElement!.getBoundingClientRect();
    return Math.abs(own.left - column.left - (column.right - own.right));
  });
  check(centred <= 2, "Bea sees the image centred");

  // A comment needs text: Ctrl+Alt+M on a selected image explains that instead of starting a
  // thread that could never be anchored.
  await clickImage(a, pickedIndex);
  await a.keyboard.down("Control");
  await a.keyboard.down("Alt");
  await a.keyboard.press("m");
  await a.keyboard.up("Alt");
  await a.keyboard.up("Control");
  await a.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("Select some text"), { timeout: 5_000 });
  check(!(await a.$('article[aria-label="New comment"]')), "commenting on a selected image asks for text instead");

  // Image-heavy: six more pasted images, each over 1 MB as PNG.
  await a.click(".colo-editor p");
  await pasteNoiseImages(a, Array.from({ length: 6 }, (_, i) => [1200 + i * 20, 900] as [number, number]));
  await waitForLoadedImages(a, 8);
  await waitForLoadedImages(b, 8);
  const shared = await a.evaluate(() => JSON.stringify((document.querySelector(".colo-editor") as EditorElement).editor.getJSON()).length);
  check(shared < 5_000, `eight images add only their addresses to the shared document (${shared} characters)`);

  // No image crosses a page edge: none overlaps a margin band.
  await a.waitForFunction(() => document.querySelectorAll(".colo-page-spacer").length >= 3, { timeout: 15_000 });
  const crossing = await a.evaluate(() => {
    const bands = [...document.querySelectorAll(".colo-page-band")].map((band) => band.getBoundingClientRect());
    return [...document.querySelectorAll(".colo-editor .colo-image-frame")].filter((frame) => {
      const r = frame.getBoundingClientRect();
      return bands.some((band) => r.top < band.bottom - 1 && r.bottom > band.top + 1);
    }).length;
  });
  check(crossing === 0, "no image overlaps a page's margins; pages break around them");

  // Pasted HTML keeps only Colo's own images.
  const own = pastedSrc;
  // Into the last paragraph (clicking could land on an image after the pastes scrolled the page).
  await a.evaluate(() => {
    const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
    editor.chain().focus().setTextSelection(editor.state.doc.content.size - 1).run();
  });
  await pasteHtml(a, `<p>copied</p><img src="https://example.com/tracker.png"><img src="${own}" width="200" height="150">`);
  nodes = await imageNodes(a);
  check(nodes.length === 9 && nodes.every((node) => !node.src.startsWith("http")), "pasted HTML drops outside images and keeps Colo's own");

  // Images print.
  const pdf = Buffer.from(await a.pdf({ preferCSSPageSize: true, printBackground: true })).toString("latin1");
  const printed = (pdf.match(/\/Subtype\s*\/Image/g) ?? []).length;
  check(printed >= 2, `images appear in the printed PDF (${printed} image objects)`);

  const errors = [...alex.errors, ...bea.errors];
  check(errors.length === 0, `no errors in either browser${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
  rmSync(fixtureDir, { recursive: true, force: true });
}
