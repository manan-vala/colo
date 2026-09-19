/**
 * M4 acceptance test (plan §11): real pages shared by two people.
 *
 * - page setup (paper, margins, headers and footers with "Page X of Y") reaches the other browser;
 * - a 50-page document with tables: no line of text or table row overlaps a margin band, tables
 *   split between rows, both browsers draw the same pages;
 * - typing stays under 16 ms of layout per keystroke;
 * - a page break inserted by one person reflows the other's pages, and undo reverses it;
 * - printing produces one sheet per on-screen page;
 * - Letter paper and continuous (pageless) mode.
 *
 *   npm run dev   (or: npm run build && npx vite preview --port 5173)
 *   PDF_PATH=out.pdf SCREENSHOT_DIR=... node e2e/pages.ts
 */
import type { Page } from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { BASE_URL, check, chooseMenuItem, clickButton, enroll, launch, openMenubar } from "./browser.ts";

const SCREENSHOTS = process.env.SCREENSHOT_DIR;
const KEYSTROKE_BUDGET_MS = 16;

interface Report {
  pages: number;
  width: number;
  overlaps: string[];
  headers: string[];
  footers: string[];
  tablePages: number[];
}

/** Page count, width, and every text line or table row that overlaps a margin band. */
function report(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const editor = document.querySelector(".colo-editor") as HTMLElement;
    const bands = [...editor.querySelectorAll(".colo-page-band")].map((band) => band.getBoundingClientRect());
    const overlaps: string[] = [];
    const hits = (rect: DOMRect) => rect.height > 0 && bands.some((b) => rect.bottom > b.top + 0.5 && rect.top < b.bottom - 0.5);
    // Line boxes of every text node (element boxes may legitimately span a band).
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (text.parentElement?.closest(".colo-pages, .collaboration-carets__caret")) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      if ([...range.getClientRects()].some(hits)) overlaps.push(`"${text.textContent?.slice(0, 24)}"`);
    }
    for (const row of editor.querySelectorAll("tr")) if (hits(row.getBoundingClientRect())) overlaps.push(`TR "${row.textContent?.slice(0, 24)}"`);

    // Which page each table's rows are on (to prove tables split between pages).
    const editorTop = editor.getBoundingClientRect().top;
    const stride = parseFloat(editor.style.getPropertyValue("--colo-page-height")) + parseFloat(editor.style.getPropertyValue("--colo-page-gap"));
    const firstTable = editor.querySelector(".colo-table");
    const tablePages = firstTable
      ? [...new Set([...firstTable.querySelectorAll("tr")].map((row) => Math.floor((row.getBoundingClientRect().top - editorTop) / stride) + 1))]
      : [];
    return {
      pages: editor.querySelectorAll(".colo-page-spacer").length,
      width: editor.getBoundingClientRect().width,
      overlaps,
      headers: [...editor.querySelectorAll(".colo-page-header")].map((h) => h.textContent ?? ""),
      footers: [...editor.querySelectorAll(".colo-page-footer")].map((f) => f.textContent ?? ""),
      tablePages,
    };
  });
}

const pages = (page: Page) => page.$$eval(".colo-page-spacer", (spacers) => spacers.length);

async function waitForPages(page: Page, expected: number, timeout = 15_000) {
  await page.waitForFunction((n) => document.querySelectorAll(".colo-page-spacer").length === n, { timeout }, expected);
}

/** Sets page settings through File → Page setup, the way a person would. */
async function pageSetup(page: Page, change: (form: { fill: (index: number, value: string) => Promise<void> }) => Promise<void>) {
  await openMenubar(page, "File");
  await chooseMenuItem(page, "Page setup");
  await page.waitForSelector('form[aria-label="Page setup"]', { visible: true });
  const fill = async (index: number, value: string) => {
    const inputs = await page.$$('form[aria-label="Page setup"] input[data-slot="input"]');
    await inputs[index].click({ count: 3 });
    await inputs[index].type(value);
  };
  await change({ fill });
  await clickButton(page, "OK");
  await page.waitForFunction(() => !document.querySelector('form[aria-label="Page setup"]'), { timeout: 10_000 });
}
// Input order in the form: margins top, bottom, left, right; header left, right; footer left, right.
const HEADER_LEFT = 4;
const FOOTER_RIGHT = 7;

const browser = await launch();
let failurePages: Page[] = [];
try {
  console.log(`Pages acceptance test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const sam = await enroll(browser, "Sam");
  const [a, s] = [alex.page, sam.page];
  failurePages = [a, s];

  await clickButton(a, "New document");
  await a.waitForSelector(".colo-editor.colo-paged");
  await s.goto(a.url());
  await s.waitForSelector(".colo-editor.colo-paged");
  let r = await report(s);
  check(r.pages === 1 && Math.abs(r.width - 793.7) < 1, `new documents are one A4 page (${r.width.toFixed(1)}px wide)`);

  // Page setup: header and "Page X of Y" footer, shared with the other browser
  await pageSetup(a, async ({ fill }) => {
    await fill(HEADER_LEFT, "Colo e2e <b>not bold</b>");
    await fill(FOOTER_RIGHT, "Page {page} of {total}");
  });
  await s.waitForFunction(() => document.querySelector(".colo-page-footer")?.textContent === "Page 1 of 1", { timeout: 10_000 });
  check(true, 'footer "Page {page} of {total}" shows "Page 1 of 1" in the other browser');
  const headerHtml = await s.$eval(".colo-page-header", (h) => h.innerHTML);
  check(!headerHtml.includes("<b>"), "header text is rendered as text, not HTML");

  // A 50-page document with tables
  await a.evaluate(() => {
    const editor = (document.querySelector(".colo-editor") as HTMLElement & { editor: any }).editor;
    const sentence = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
    const table = (id: number, rows: number) =>
      `<table><tbody>${Array.from({ length: rows }, (_, row) => `<tr><td><p>T${id} row ${row}</p></td><td><p>${sentence.slice(0, 40 + (row % 3) * 30)}</p></td><td><p>${row * id}</p></td></tr>`).join("")}</tbody></table>`;
    let html = "<h1>Pagination test</h1>";
    for (let i = 0; i < 360; i++) {
      html += i % 40 === 5 ? `<h2>Section ${Math.floor(i / 40) + 1}</h2>` : "";
      html += `<p>Paragraph ${i}. ${sentence.repeat(1 + (i % 4))}</p>`;
      if (i % 45 === 20) html += table(i, 40);
      if (i % 30 === 15) html += `<ul><li><p>First point of ${i}</p></li><li><p>Second point of ${i}</p></li></ul>`;
    }
    editor.commands.setContent(html);
  });
  await a.waitForFunction(() => document.querySelectorAll(".colo-page-spacer").length >= 50, { timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const ra = await report(a);
  await waitForPages(s, ra.pages, 30_000);
  r = await report(s);
  check(r.pages >= 50, `a long document lays out as ${r.pages} pages`);
  check(ra.pages === r.pages, "both browsers draw the same number of pages");
  check(ra.overlaps.length === 0 && r.overlaps.length === 0, `no text line or table row overlaps a margin band${[...ra.overlaps, ...r.overlaps].slice(0, 3).join(", ")}`);
  check(r.tablePages.length >= 2, `a 40-row table splits across pages ${r.tablePages.join(", ")}`);
  const expectedFooters = Array.from({ length: r.pages }, (_, i) => `Page ${i + 1} of ${r.pages}`);
  check(JSON.stringify(r.footers) === JSON.stringify(expectedFooters), `every footer reads "Page k of ${r.pages}"`);
  check(r.headers.length === r.pages && r.headers.every((h) => h.startsWith("Colo e2e")), "every page has the header");
  if (SCREENSHOTS) {
    await s.evaluate(() => document.querySelectorAll(".colo-page-band")[2]?.scrollIntoView({ block: "center" }));
    await s.screenshot({ path: `${SCREENSHOTS}/m4-pages.png` });
  }

  // Layout cost per keystroke near the top of a 50-page document (everything below reflows)
  const timings = await a.evaluate(async () => {
    const view = (document.querySelector(".colo-editor") as HTMLElement & { editor: any }).editor.view;
    const times: number[] = [];
    let pos = 0;
    view.state.doc.descendants((node: any, p: number) => {
      if (!pos && node.type.name === "paragraph") pos = p + 5;
      return !pos;
    });
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      view.dispatch(view.state.tr.insertText(i % 6 === 5 ? " " : "x", pos + i));
      void document.body.offsetHeight; // style and layout, as the next frame would do
      times.push(performance.now() - start);
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    }
    return times.sort((x, y) => x - y);
  });
  const median = timings[Math.floor(timings.length / 2)];
  const p95 = timings[Math.floor(timings.length * 0.95)];
  check(median < KEYSTROKE_BUDGET_MS, `keystroke + layout: median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (budget ${KEYSTROKE_BUDGET_MS} ms)`);

  // A page break from one person reflows the other's pages
  const before = await pages(s);
  await a.evaluate(() => (document.querySelector(".colo-editor") as HTMLElement & { editor: any }).editor.commands.focus(1));
  await a.keyboard.down("Control");
  await a.keyboard.press("Enter");
  await a.keyboard.up("Control");
  await waitForPages(s, before + 1);
  const headingTop = await s.evaluate(() => {
    const editor = document.querySelector(".colo-editor") as HTMLElement;
    const heading = editor.querySelector(":scope > h1")!;
    const range = document.createRange();
    range.selectNodeContents(heading);
    const style = editor.style;
    const expected = parseFloat(style.getPropertyValue("--colo-margin-top")) + parseFloat(style.getPropertyValue("--colo-page-height")) + parseFloat(style.getPropertyValue("--colo-page-gap"));
    return { actual: range.getClientRects()[0].top - editor.getBoundingClientRect().top, expected };
  });
  check(Math.abs(headingTop.actual - headingTop.expected) < 3, `after Ctrl+Enter at the start, the heading starts page 2 in the other browser (${headingTop.actual.toFixed(1)} vs ${headingTop.expected.toFixed(1)})`);
  await a.keyboard.down("Control");
  await a.keyboard.press("z");
  await a.keyboard.up("Control");
  await waitForPages(s, before);
  check(true, "undo removes the page break for both people");

  // Vertically merged cells: the table cannot split between rows. It keeps table layout, and even
  // one taller than a page must not send pagination into a loop.
  await a.evaluate(() => {
    const editor = (document.querySelector(".colo-editor") as HTMLElement & { editor: any }).editor;
    const cells: number[] = [];
    editor.state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === "tableCell" && cells.length < 4) cells.push(pos);
      return cells.length < 4;
    });
    // First cell of row 0 and first cell of row 1 (three cells per row).
    editor.chain().focus().setCellSelection({ anchorCell: cells[0], headCell: cells[3] }).mergeCells().run();
  });
  await s.waitForSelector(".colo-table[data-merged-rows]", { timeout: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const settled = await pages(s);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  check((await pages(s)) === settled && settled <= before + 2, `a table with merged rows moves as a whole and pagination settles (${settled} pages)`);
  await a.keyboard.down("Control");
  await a.keyboard.press("z");
  await a.keyboard.up("Control");
  await s.waitForFunction(() => !document.querySelector(".colo-table[data-merged-rows]"), { timeout: 10_000 });
  await waitForPages(s, before);
  check(true, "unmerging restores the split table and the original pages");

  // Zoom does not change pagination
  await s.click('[aria-label="Zoom"]');
  await chooseMenuItem(s, "150%");
  await new Promise((resolve) => setTimeout(resolve, 800));
  check((await pages(s)) === before, "zooming to 150% keeps the same pages");
  await s.click('[aria-label="Zoom"]');
  await chooseMenuItem(s, "100%");

  // Print: one sheet per page
  const pdf = await a.pdf({ preferCSSPageSize: true, printBackground: true });
  if (process.env.PDF_PATH) writeFileSync(process.env.PDF_PATH, pdf);
  const sheets = (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check(sheets === before, `printing produces ${sheets} sheets for ${before} pages`);

  // Letter paper, then a continuous document
  await pageSetup(a, async () => {
    await a.click('form[aria-label="Page setup"] button[role="radio"][value="LETTER"]');
  });
  await s.waitForFunction(() => Math.abs((document.querySelector(".colo-editor") as HTMLElement).getBoundingClientRect().width - 816) < 1, { timeout: 10_000 });
  check(true, "Letter paper reaches the other browser (816px pages)");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  r = await report(s);
  check(r.overlaps.length === 0, `Letter pages reflow without overlaps (${r.pages} pages)`);

  await pageSetup(a, async () => {
    await a.click("#page-setup-pages");
  });
  await s.waitForFunction(() => !document.querySelector(".colo-editor.colo-paged") && !document.querySelector(".colo-pages"), { timeout: 10_000 });
  check(true, "turning pages off gives both people a continuous document");

  const errors = [...alex.errors, ...sam.errors];
  check(errors.length === 0, `no console or CSP errors${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`);
  console.log("PASS");
} catch (error) {
  if (SCREENSHOTS) await Promise.all(failurePages.map((page, i) => page.screenshot({ path: `${SCREENSHOTS}/m4-failure-${i}.png` })));
  throw error;
} finally {
  await browser.close();
}
