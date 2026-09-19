/**
 * M7 acceptance test (plan §11): importing and exporting documents, with two people.
 *
 * - a Word file made in Word is imported from the list page: both browsers see its headings,
 *   formatting, table, image, comments, page setup and header; the import report lists what
 *   was converted;
 * - File → Download → Word gives a file that imports back to the same text, and (on Windows with
 *   Word installed) opens in Word with its tables, picture, comments, header and page setup;
 * - Markdown, web page and text downloads hold the document;
 * - File → Replace with file keeps the previous version as a restore point.
 *
 *   npm run build && npx vite preview --port 5173   (or npm run dev)
 *   node e2e/convert.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { BASE_URL, check, chooseMenuItem, clickButton, enroll, launch, openMenubar, press, type EditorElement } from "./browser.ts";

const FIXTURE = resolve("test/convert/fixtures/word-features.docx");
const WORD = "C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE";

const editorText = (page: Page) => page.evaluate(() => (document.querySelector(".colo-editor") as EditorElement).editor.getText());

/** Lets a page save downloads into `dir` (headless Chrome refuses them by default). */
async function allowDownloads(page: Page, dir: string) {
  const session = await page.browser().target().createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, browserContextId: page.browserContext().id });
}

async function waitForDownload(dir: string, extension: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const file = readdirSync(dir).find((name) => name.endsWith(extension));
    if (file) return join(dir, file);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${extension} download`);
}

async function download(page: Page, dir: string, label: string, extension: string): Promise<string> {
  await openMenubar(page, "File");
  await chooseMenuItem(page, "Download", { submenu: true });
  await chooseMenuItem(page, label);
  return waitForDownload(dir, extension);
}

/** Chooses a file for the next file picker opened by `open`. */
async function pickFile(page: Page, path: string, open: () => Promise<void>) {
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), open()]);
  await chooser.accept([path]);
}

async function closeReport(page: Page): Promise<string> {
  const dialog = await page.waitForSelector('[role="dialog"]', { visible: true, timeout: 30_000 });
  const text = await dialog!.evaluate((el) => el.textContent ?? "");
  await clickButton(page, "OK");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  return text;
}

const browser = await launch();
const dir = mkdtempSync(join(tmpdir(), "colo-convert-"));
try {
  console.log(`Import and export acceptance test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const bea = await enroll(browser, "Bea");
  const [a, b] = [alex.page, bea.page];
  for (const page of [a, b]) await page.setViewport({ width: 1440, height: 900 });
  await allowDownloads(a, dir);

  // Import the Word file from the list page.
  await pickFile(a, FIXTURE, () => clickButton(a, "Import file"));
  await a.waitForSelector(".colo-editor", { timeout: 30_000 });
  const report = await closeReport(a);
  check(report.includes("Imported “word-features.docx”") && report.includes("Tracked changes were accepted"), "the import report lists what was converted");
  const imported = await editorText(a);
  check(imported.includes("Quarterly report") && imported.includes("Spans rows") && imported.includes("Footnote text."), "Alex sees the imported text");

  await b.goto(a.url());
  await b.waitForFunction((t) => document.querySelector(".colo-editor")?.textContent?.includes(t), { timeout: 15_000 }, "Spans rows");
  const seen = await b.evaluate(() => ({
    title: (document.getElementById("document-title") as HTMLInputElement).value,
    headings: document.querySelectorAll(".colo-editor h1, .colo-editor h2, .colo-editor h3").length,
    merged: document.querySelector('.colo-editor td[rowspan="2"]') !== null,
    header: document.querySelector(".colo-page-header")?.textContent,
    width: getComputedStyle(document.querySelector(".colo-editor")!).getPropertyValue("--colo-page-width"),
  }));
  check(seen.title === "Quarterly report", `the title comes from the file (${seen.title})`);
  check(seen.headings === 5 && seen.merged, "Bea sees the headings and the merged table cells");
  check(seen.header?.startsWith("Colo fixture") && seen.header.includes("Page 1 of"), `the header keeps its text and page numbers (${seen.header})`);
  check(seen.width.trim() === "1056px", `the page is Letter landscape (${seen.width.trim()} wide)`);
  await b.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".colo-editor .colo-image img");
    return img?.complete && img.naturalWidth > 0;
  }, { timeout: 15_000 });
  check(true, "Bea sees the image, uploaded to the document");
  // A landscape Letter page leaves no room for the comment margin here, so comments are in the panel.
  await press(b, "Comments (1 open)");
  await b.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Added a citation."), { timeout: 10_000 });
  check(true, "Bea sees the comment thread with its reply, and it counts one open thread (the other is resolved)");
  await b.keyboard.press("Escape");

  // Download as Word, then import that file again: the text survives the round trip.
  const docxPath = await download(a, dir, "Microsoft Word", ".docx");
  check(readFileSync(docxPath).subarray(0, 2).toString() === "PK", `File → Download → Word saves ${docxPath.split(/[\\/]/).pop()}`);
  await openMenubar(a, "File");
  await pickFile(a, docxPath, () => chooseMenuItem(a, "Open file"));
  await a.waitForFunction((url) => location.href !== url, { timeout: 30_000 }, b.url());
  await closeReport(a);
  const again = await editorText(a);
  check(again === imported, "the downloaded Word file imports back to the same text");

  if (process.platform === "win32" && existsSync(WORD)) {
    const script = resolve("scripts/check-docx-in-word.ps1");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", docxPath], {
      encoding: "utf8",
      timeout: 90_000,
    });
    const word = JSON.parse(output.trim());
    check(word.tables === 1 && word.pictures === 1, `Word opens the export: ${word.tables} table, ${word.pictures} picture`);
    check(word.comments === 3 && word.replies === 1 && word.resolved === 1, `Word sees the comments: ${word.comments}, ${word.replies} reply, ${word.resolved} resolved`);
    check(word.header.startsWith("Colo fixture") && word.footer === "Confidential", `Word shows the header and footer (${JSON.stringify(word.header)})`);
    check(word.orientation === 1 && word.pageWidth === 792, `Word shows Letter landscape (${word.pageWidth} × ${word.pageHeight} pt)`);
  } else {
    console.log("  – Word is not installed here; skipped opening the export in Word");
  }

  // The other download formats.
  const markdown = readFileSync(await download(a, dir, "Markdown", ".md"), "utf8");
  check(markdown.includes("# Quarterly report") && markdown.includes("| **Name** | **Role** | **Notes** |"), "Markdown download has the headings and table");
  const html = readFileSync(await download(a, dir, "Web page", ".html"), "utf8");
  check(html.includes("<h1") && html.includes('src="data:image/'), "web page download embeds its image");
  const text = readFileSync(await download(a, dir, "Plain text", ".txt"), "utf8");
  check(text.includes("Quarterly report") && text.includes("Name\tRole\tNotes"), "plain text download has the text and table");

  // Replace the document with a Markdown file; the old version stays as a restore point.
  const notes = join(dir, "notes.md");
  writeFileSync(notes, "# Meeting notes\n\n- [x] Agenda\n- [ ] Minutes\n\n| A | B |\n| - | - |\n| 1 | 2 |\n");
  await openMenubar(a, "File");
  await pickFile(a, notes, () => chooseMenuItem(a, "Replace with file"));
  const replaced = await closeReport(a);
  check(replaced.includes("previous version is saved"), "the report says the previous version was kept");
  const content = await a.evaluate(() => {
    const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
    const json = JSON.stringify(editor.getJSON());
    return { text: editor.getText(), tasks: json.split('"type":"taskItem"').length - 1, tables: document.querySelectorAll(".colo-editor table").length };
  });
  check(content.text.startsWith("Meeting notes") && content.tasks === 2 && content.tables === 1, "the Markdown file replaced the content, with its checklist and table");
  await openMenubar(a, "File");
  await chooseMenuItem(a, "Restore points");
  await a.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Before importing “notes.md”"), { timeout: 10_000 });
  check(true, "File → Restore points lists the version from before the import");

  const errors = [...alex.errors, ...bea.errors];
  check(errors.length === 0, `no errors in either browser${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
