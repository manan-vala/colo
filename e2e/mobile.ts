/**
 * M8 phone pass (plan §11, F13). One walk through the whole app at 390×844 with touch, which is
 * the screen the M3 and M4 rows were never checked on.
 *
 * - the document list, the account menu and the editor all fit with no horizontal page scroll;
 * - the save and connection status is visible on a phone (it used to be hidden below 768px, so
 *   going offline said nothing at all);
 * - typing, formatting, the outline sheet, the comments panel and inserting a table all work by
 *   tap, and the table picker's preview follows a finger;
 * - an image can be inserted and its resize handle is big enough to hit.
 *
 *   npm run build && npx vite preview --port 5173   (or npm run dev)
 *   node e2e/mobile.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import { BASE_URL, check, clickButton, enroll, launch, press, pressTestId, waitForText } from "./browser.ts";

const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function checkNoOverflow(page: Page, where: string): Promise<void> {
  const extra = await overflow(page);
  check(extra <= 0, `no horizontal page scroll on ${where} (overflow ${extra}px)`);
}

/** Taps rather than clicks, so the app sees a touch the way a phone sends one. */
async function tap(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
  await page.tap(selector);
}

const browser = await launch();
const workDir = mkdtempSync(join(tmpdir(), "colo-mobile-"));
try {
  console.log(`Phone pass against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const a = alex.page;
  await a.setViewport(PHONE);
  await a.goto(BASE_URL);
  await waitForText(a, "Documents");
  await checkNoOverflow(a, "the document list");

  // The account menu carries the address and the backup, and has to open on a phone.
  await pressTestId(a, "account-menu");
  await a.waitForSelector('[role="menu"]', { visible: true, timeout: 5_000 });
  const items = await a.$$eval('[role="menu"] [role="menuitem"]', (nodes) => nodes.map((node) => node.textContent ?? ""));
  check(
    items.some((item) => item.includes("Download backup")) && items.some((item) => item.includes("Sign out")),
    `the account menu opens on a phone (${items.length} items)`,
  );
  await a.keyboard.press("Escape");

  await clickButton(a, "New document");
  await a.waitForSelector(".colo-editor");
  await checkNoOverflow(a, "a new document");

  // Pagination is off below 640px, so the page is continuous and never scrolls sideways.
  const paged = await a.$(".colo-editor.colo-paged");
  check(paged === null, "a phone gets a continuous page, not A4 bands");

  await a.tap(".colo-editor");
  await a.keyboard.type("Typed on a phone.");
  await a.waitForFunction(() => document.querySelector(".colo-editor")?.textContent?.includes("phone"), { timeout: 15_000 });

  // The status used to be `hidden md:inline`, so a phone showed nothing -- including "Offline".
  const status = await a.$eval('[data-testid="save-status"]', (el) => {
    // The sr-only span carries the full sentence; the visible one is what a phone actually shows.
    const shown = [...el.querySelectorAll("span")].find(
      (span) => !span.className.includes("sr-only") && (span as HTMLElement).offsetParent !== null,
    );
    return { text: shown?.textContent ?? "", announced: el.querySelector(".sr-only")?.textContent ?? "" };
  });
  check(status.text.trim().length > 0, `the save status is visible on a phone ("${status.text.trim()}")`);
  check(status.announced.trim().length > 0, "and the full sentence is still there for a screen reader");

  // Formatting by tap.
  await a.keyboard.type(" bold?");
  await a.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await a.keyboard.press("ArrowLeft");
  await a.keyboard.up("Shift");
  await press(a, "Bold");
  const bold = await a.evaluate(() => document.querySelector('[aria-label="Bold"]')?.getAttribute("aria-pressed"));
  check(bold === "true", `bold toggles by tap (aria-pressed=${bold})`);
  await press(a, "Bold");

  await press(a, "Show outline");
  await a.waitForSelector('[role="dialog"] nav[aria-label="Document outline"]', { visible: true, timeout: 10_000 });
  check(true, "the outline opens as a sheet");
  await a.keyboard.press("Escape");
  // Radix keeps the rest of the page inert until the sheet has finished closing, so a tap sent
  // too early lands on nothing.
  await a.waitForSelector('[role="dialog"]', { hidden: true, timeout: 10_000 });

  // The table picker's preview is driven by pointer events; with onMouseEnter it never moved.
  await press(a, "Insert table");
  await a.waitForSelector('[role="grid"][aria-label="Table size"]', { visible: true, timeout: 10_000 });
  const cell = '[role="grid"][aria-label="Table size"] button[aria-label="3 by 4"]';
  const box = (await (await a.waitForSelector(cell, { timeout: 5_000 }))!.boundingBox())!;
  // A real touch: the finger goes down on the cell, and the preview must light up before it
  // lifts. With the old onMouseEnter nothing happened until the tap had already inserted.
  await a.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
  const preview = await a.$eval('[role="grid"][aria-label="Table size"]', (grid) =>
    [...grid.querySelectorAll('[data-selected="true"]')].length,
  );
  check(preview === 12, `the table picker preview follows a finger (${preview} cells lit for 3×4)`);
  await a.touchscreen.touchEnd();

  await a.waitForSelector(".colo-editor table", { timeout: 10_000 });
  const size = await a.$eval(".colo-editor table", (table) => ({
    rows: table.querySelectorAll("tr").length,
    cols: table.querySelectorAll("tr")[0]?.children.length ?? 0,
  }));
  check(size.rows === 3 && size.cols === 4, `and the tap inserts that table (${size.rows}×${size.cols})`);
  await checkNoOverflow(a, "a document with a table");

  // An image, and a resize handle a finger can actually hit.
  const fixture = join(workDir, "photo.png");
  const png = await a.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#9334e6";
    context.fillRect(0, 0, 600, 400);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  writeFileSync(fixture, Buffer.from(png, "base64"));
  const [chooser] = await Promise.all([a.waitForFileChooser({ timeout: 10_000 }), press(a, "Insert image")]);
  await chooser.accept([fixture]);
  await a.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>(".colo-editor .colo-image img")].some((img) => img.complete && img.naturalWidth > 0),
    { timeout: 15_000 },
  );
  await checkNoOverflow(a, "a document with an image");

  await tap(a, ".colo-editor .colo-image img");
  await a.waitForSelector(".colo-image.ProseMirror-selectednode .colo-image-handle-right", { visible: true, timeout: 10_000 });
  const touchTarget = await a.evaluate(() => {
    const handle = document.querySelector(".colo-image.ProseMirror-selectednode .colo-image-handle-right") as HTMLElement;
    const before = getComputedStyle(handle, "::before");
    const grown = Number.parseFloat(before.inset || "0");
    const box = handle.getBoundingClientRect();
    // The dot stays small; @media (pointer: coarse) grows the area around it.
    return { dot: Math.round(box.width), reach: Math.round(box.width + Math.abs(grown) * 2) };
  });
  check(touchTarget.reach >= 40, `the image resize handle is ${touchTarget.reach}px to a finger (dot is ${touchTarget.dot}px)`);

  // Comments live in a panel when there is no room for margin cards.
  await a.tap(".colo-editor");
  await a.keyboard.down("Control");
  await a.keyboard.press("KeyA");
  await a.keyboard.up("Control");
  await press(a, "Add comment");
  await a.waitForSelector('[role="dialog"]', { visible: true, timeout: 10_000 });
  const rail = await a.$('[role="complementary"]');
  check(rail === null, "comments open in a panel, with no margin rail on a phone");
  await a.keyboard.press("Escape");

  await checkNoOverflow(a, "the finished document");
  const errors = alex.errors;
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
