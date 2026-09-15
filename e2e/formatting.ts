/**
 * M3 acceptance test: every toolbar and menu action applied by one person shows up for the other,
 * without CSP violations, and the document screen is usable at phone width.
 *
 *   npm run build && npx vite preview --port 5173
 *   SCREENSHOT_DIR=... node e2e/formatting.ts
 */
import type { ElementHandle, Page } from "puppeteer-core";
import { BASE_URL, check, clickButton, createInvite, launch, newUser, waitForText } from "./browser.ts";

const SCREENSHOTS = process.env.SCREENSHOT_DIR;

async function enroll(browser: Awaited<ReturnType<typeof launch>>, name: string) {
  const user = await newUser(browser);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await user.page.goto(createInvite(`${name.toLowerCase()}-${stamp}@example.com`, name));
  await clickButton(user.page, "Create passkey");
  await waitForText(user.page, "Documents");
  return user;
}

/** Clicks a control by its accessible label (aria-label). */
async function press(page: Page, label: string) {
  const handle = await page.waitForSelector(`[aria-label="${label}"]:not([disabled])`, { visible: true, timeout: 10_000 });
  await handle!.click();
}

/** Clicks a Radix menu item by its visible text; for leaf items, waits until the menu has closed. */
async function chooseMenuItem(page: Page, text: string, { submenu = false } = {}) {
  const handle = (await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].find(
        (item) => item.textContent?.trim().startsWith(label),
      ),
    { timeout: 10_000 },
    text,
  )) as ElementHandle<Element>;
  await handle.click();
  if (!submenu) {
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.closest(".colo-editor"), { timeout: 10_000 }).catch(() => undefined);
  }
}

async function openMenubar(page: Page, name: string) {
  const handle = (await page.waitForFunction(
    (label) => [...document.querySelectorAll('[role="menubar"] [role="menuitem"]')].find((item) => item.textContent?.trim() === label),
    { timeout: 10_000 },
    name,
  )) as ElementHandle<Element>;
  await handle.click();
}

/** Waits until the other browser's editor matches a selector (optionally with some text). */
async function seen(page: Page, selector: string, description: string, text?: string) {
  await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(`.colo-editor ${sel}`)].some((el) => (t ? el.textContent?.includes(t) : true)),
    { timeout: 10_000 },
    selector,
    text ?? "",
  );
  check(true, description);
}

async function newLine(page: Page, text: string) {
  await page.keyboard.press("End");
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

async function selectLine(page: Page) {
  await page.keyboard.press("End");
  await page.keyboard.down("Shift");
  await page.keyboard.press("Home");
  await page.keyboard.up("Shift");
}

const browser = await launch();
try {
  console.log(`Formatting acceptance test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const sam = await enroll(browser, "Sam");
  const a = alex.page;
  const s = sam.page;

  await clickButton(a, "New document");
  await a.waitForSelector(".colo-editor");
  await s.goto(a.url());
  await s.waitForSelector(".colo-editor");
  check(true, "both people have the document open");

  // Paragraph styles
  await a.click(".colo-editor");
  await a.keyboard.type("Project plan");
  await press(a, "Styles");
  await chooseMenuItem(a, "Heading 1");
  await seen(s, "h1", "Styles → Heading 1", "Project plan");

  // Character formatting on one line
  await newLine(a, "Formatted words");
  await press(a, "Styles");
  await chooseMenuItem(a, "Normal text");
  await selectLine(a);
  await press(a, "Bold");
  await seen(s, "strong", "Bold", "Formatted words");
  await press(a, "Italic");
  await seen(s, "em", "Italic", "Formatted words");
  await press(a, "Underline");
  await seen(s, "u", "Underline", "Formatted words");
  await press(a, "Strikethrough");
  await seen(s, "s", "Strikethrough", "Formatted words");
  await press(a, "Font");
  await chooseMenuItem(a, "Times New Roman");
  await seen(s, 'span[style*="Tinos"]', "Font → Times New Roman");
  await press(a, "Increase font size");
  await seen(s, 'span[style*="font-size: 12pt"]', "Increase font size (11 → 12 pt)");
  await press(a, "Text colour");
  await press(a, "#ff0000");
  await seen(s, 'span[style*="color: rgb(255, 0, 0)"], span[style*="color: #ff0000"]', "Text colour → red");
  await press(a, "Highlight colour");
  await press(a, "#ffff00");
  await seen(s, "mark[data-color]", "Highlight colour → yellow");
  await press(a, "Align");
  await chooseMenuItem(a, "Centre align");
  await seen(s, 'p[style*="text-align: center"]', "Align → centre");

  // Clear formatting keeps the text but removes marks and alignment
  await selectLine(a);
  await press(a, "Clear formatting");
  const clearedParagraph = () => {
    const p = [...document.querySelectorAll(".colo-editor p")].find((el) => el.textContent?.includes("Formatted words"));
    if (!p) return "missing";
    const copy = p.cloneNode(true) as HTMLElement;
    // The other person's cursor and selection render as styled spans; they are not formatting.
    copy.querySelectorAll(".collaboration-carets__caret").forEach((n) => n.remove());
      copy.querySelectorAll(".ProseMirror-yjs-selection").forEach((n) => n.replaceWith(...n.childNodes));
    return copy.outerHTML;
  };
  const cleared = await s
    .waitForFunction(() => {
      const p = [...document.querySelectorAll(".colo-editor p")].find((el) => el.textContent?.includes("Formatted words"));
      if (!p) return false;
      const copy = p.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".collaboration-carets__caret").forEach((n) => n.remove());
      copy.querySelectorAll(".ProseMirror-yjs-selection").forEach((n) => n.replaceWith(...n.childNodes));
      return !copy.querySelector("strong, em, u, s, mark, span[style]") && !copy.getAttribute("style")?.includes("center");
    }, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!cleared) console.log(`    paragraph after clear: ${await s.evaluate(clearedParagraph)}`);
  check(cleared, "Clear formatting");

  // Undo restores the formatting
  await press(a, "Undo");
  await seen(s, "strong", "Undo", "Formatted words");

  // Superscript through the menu bar
  await newLine(a, "E = mc2");
  await a.keyboard.down("Shift");
  await a.keyboard.press("ArrowLeft");
  await a.keyboard.up("Shift");
  await openMenubar(a, "Format");
  await chooseMenuItem(a, "Text", { submenu: true });
  await chooseMenuItem(a, "Superscript");
  await seen(s, "sup", "Format → Text → Superscript", "2");

  // Links, including a rejected javascript: URL
  await newLine(a, "");
  await a.keyboard.down("Control");
  await a.keyboard.press("k");
  await a.keyboard.up("Control");
  await a.waitForSelector('input[aria-label="Link address"]', { visible: true });
  await a.type('input[aria-label="Link text"]', "Example site");
  await a.type('input[aria-label="Link address"]', "javascript:alert(1)");
  await clickButton(a, "Apply");
  await waitForText(a, "Only web, email and phone links are allowed.");
  check(true, "javascript: links are rejected");
  const address = (await a.$('input[aria-label="Link address"]'))!;
  await address.click({ count: 3 });
  await a.keyboard.type("example.com");
  await clickButton(a, "Apply");
  await seen(s, 'a[href="https://example.com"]', "Insert link (Ctrl+K) → https://example.com", "Example site");

  // Lists and indentation
  await newLine(a, "First bullet");
  await press(a, "Bulleted list");
  await seen(s, "ul li", "Bulleted list", "First bullet");
  await newLine(a, "First step");
  await press(a, "Numbered list");
  await seen(s, "ol li", "Numbered list", "First step");
  await newLine(a, "Buy tickets");
  await press(a, "Checklist");
  await seen(s, 'ul[data-type="taskList"] li', "Checklist", "Buy tickets");
  await press(a, "Checklist");
  await press(a, "Increase indent");
  await seen(s, 'p[data-indent="1"]', "Increase indent", "Buy tickets");

  // Tables
  await newLine(a, "");
  await press(a, "Insert table");
  await press(a, "2 by 3");
  await s.waitForFunction(() => {
    const table = document.querySelector(".colo-editor table");
    return table && table.querySelectorAll("tr").length === 2 && table.querySelectorAll("tr:first-child > *").length === 3;
  }, { timeout: 10_000 });
  check(true, "Insert table → 2 × 3");
  await a.keyboard.type("Cell A1");
  await clickButton(a, "Table");
  await chooseMenuItem(a, "Insert row below");
  await s.waitForFunction(() => document.querySelectorAll(".colo-editor table tr").length === 3, { timeout: 10_000 });
  check(true, "Table → Insert row below");

  // Horizontal line through the menu bar (cursor leaves the table first)
  await a.keyboard.down("Control");
  await a.keyboard.press("End");
  await a.keyboard.up("Control");
  await openMenubar(a, "Insert");
  await chooseMenuItem(a, "Horizontal line");
  await seen(s, "hr", "Insert → Horizontal line");

  // Outline
  await a.waitForFunction(() => document.querySelector('nav[aria-label="Document outline"]')?.textContent?.includes("Project plan"), { timeout: 10_000 });
  check(true, "outline lists the heading");

  // Zoom
  await press(a, "Zoom");
  await chooseMenuItem(a, "150%");
  const zoom = await a.$eval(".colo-page-zoom", (el) => (el as HTMLElement).style.zoom);
  check(zoom === "1.5", `zoom 150% applied (${zoom})`);

  // Both editors converge to the same content
  await new Promise((resolve) => setTimeout(resolve, 1000));
  /** Editor DOM without view-only decorations (cursors, selections, resize handles). */
  const html = (page: Page) =>
    page.$eval(".colo-editor", (el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".collaboration-carets__caret, .column-resize-handle, .ProseMirror-gapcursor, .ProseMirror-separator, .ProseMirror-trailingBreak").forEach((n) => n.remove());
      copy.querySelectorAll(".ProseMirror-yjs-selection").forEach((n) => n.replaceWith(...n.childNodes));
      copy.querySelectorAll("[data-placeholder]").forEach((n) => n.removeAttribute("data-placeholder"));
      copy.querySelectorAll("[class], [contenteditable], [draggable]").forEach((n) => {
        n.removeAttribute("class");
        n.removeAttribute("contenteditable");
        n.removeAttribute("draggable");
      });
      copy.normalize();
      return copy.innerHTML;
    });
  const [htmlA, htmlS] = [await html(a), await html(s)];
  if (htmlA !== htmlS) {
    let i = 0;
    while (i < htmlA.length && htmlA[i] === htmlS[i]) i++;
    console.log(`    first difference at ${i}:
      alex: …${htmlA.slice(Math.max(0, i - 80), i + 120)}
      sam:  …${htmlS.slice(Math.max(0, i - 80), i + 120)}`);
  }
  check(htmlA === htmlS, "both editors hold identical content");

  if (SCREENSHOTS) await a.screenshot({ path: `${SCREENSHOTS}/m3-desktop.png` });

  // Phone width
  await s.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await s.reload();
  await s.waitForSelector(".colo-editor");
  const overflow = await s.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no horizontal page scroll at 390px (overflow ${overflow}px)`);
  const toolbarScrolls = await s.$eval('[role="toolbar"]', (el) => el.scrollWidth > el.clientWidth);
  check(toolbarScrolls, "toolbar scrolls horizontally on a phone");
  if (SCREENSHOTS) await s.screenshot({ path: `${SCREENSHOTS}/m3-phone.png` });
  await press(s, "Show outline");
  await s.waitForSelector('[role="dialog"] nav[aria-label="Document outline"]', { visible: true });
  check(true, "outline opens as a sheet on a phone");
  if (SCREENSHOTS) await s.screenshot({ path: `${SCREENSHOTS}/m3-phone-outline.png` });

  const errors = [...alex.errors, ...sam.errors];
  check(errors.length === 0, `no console or CSP errors${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
}
