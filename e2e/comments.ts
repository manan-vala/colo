/**
 * M5 acceptance test (plan §11): comments shared by two people.
 *
 * - a comment on selected text reaches the other browser, highlighted, with its card level
 *   with the text; replies, edits and deletes sync both ways;
 * - overlapping comments; margin cards never overlap;
 * - resolve hides a thread and reopen brings it back; resolved threads are listed;
 * - deleting the commented text detaches the thread; undo re-attaches it; undo of typing never
 *   removes a comment; pasting commented text does not copy the comment;
 * - a comment being written keeps its text while the other person edits;
 * - on a phone comments open in a panel; highlights do not print.
 *
 *   npm run dev   (or: npm run build && npx vite preview --port 5173)
 *   SCREENSHOT_DIR=... node e2e/comments.ts
 */
import type { KeyInput, Page } from "puppeteer-core";
import { BASE_URL, check, clickButton, editorText, enroll, launch, press } from "./browser.ts";

const SCREENSHOTS = process.env.SCREENSHOT_DIR;
const TEXT = "The quick brown fox jumps over the lazy dog.";

type EditorElement = HTMLElement & { editor: any };

/** Selects the first occurrence of `text` in the document, like a person dragging over it. */
async function selectText(page: Page, text: string) {
  const found = await page.evaluate((needle) => {
    const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
    let range: { from: number; to: number } | null = null;
    // Search whole paragraphs: marks split text into several nodes.
    editor.state.doc.descendants((node: any, pos: number) => {
      if (range || !node.isTextblock) return !range;
      const index = node.textContent.indexOf(needle);
      if (index >= 0) range = { from: pos + 1 + index, to: pos + 1 + index + needle.length };
      return false;
    });
    if (range) editor.chain().focus().setTextSelection(range).run();
    return range !== null;
  }, text);
  if (!found) throw new Error(`text not found: ${text}`);
  // Tiptap focuses on the next frame; keys pressed before that would go elsewhere.
  await page.waitForFunction(() => document.activeElement?.classList.contains("colo-editor"), { timeout: 5_000 });
}

/** Text covered by each thread's highlight, keyed by thread ID. */
const highlights = (page: Page) =>
  page.$$eval(".colo-editor [data-comment-id]", (spans) => {
    const byThread: Record<string, string> = {};
    for (const span of spans) {
      const id = span.getAttribute("data-comment-id")!;
      byThread[id] = (byThread[id] ?? "") + span.textContent;
    }
    return byThread;
  });

/** A thread's card in the margin (or the panel), by a phrase in it. */
const card = (page: Page, phrase: string) =>
  page.waitForFunction(
    (p) => [...document.querySelectorAll("article[data-thread-id]")].find((a) => a.textContent?.includes(p)),
    { timeout: 10_000 },
    phrase,
  );

async function waitForCardText(page: Page, phrase: string) {
  await card(page, phrase);
}

async function typeInto(page: Page, selector: string, text: string) {
  const box = await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
  await box!.click();
  await box!.type(text);
}

/** Clicks a button inside the card containing `phrase`. */
async function clickInCard(page: Page, phrase: string, label: string) {
  const handle = await page.waitForFunction(
    (p, l) => {
      const article = [...document.querySelectorAll("article[data-thread-id]")].find((a) => a.textContent?.includes(p));
      return [...(article?.querySelectorAll("button") ?? [])].find(
        (b) => (b.getAttribute("aria-label") === l || b.textContent?.trim() === l) && !b.disabled,
      );
    },
    { timeout: 10_000 },
    phrase,
    label,
  );
  await (handle as unknown as { click(): Promise<void> }).click();
}

/** Opens the options menu of a thread's last comment (or its first, with `which`). */
async function openOptions(page: Page, threadId: string, which: "first" | "last" = "last") {
  const buttons = await page.$$(`article[data-thread-id="${threadId}"] button[aria-label="More options"]`);
  await buttons[which === "first" ? 0 : buttons.length - 1].click();
}

/** Clicks an item in the open dropdown menu. */
async function chooseMenu(page: Page, text: string) {
  const item = await page.waitForFunction(
    (t) => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((i) => i.textContent?.trim() === t),
    { timeout: 10_000 },
    text,
  );
  await (item as unknown as { click(): Promise<void> }).click();
}

async function ctrl(page: Page, key: KeyInput) {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
}

const browser = await launch();
let pages: Page[] = [];
try {
  console.log(`Comments acceptance test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const sam = await enroll(browser, "Sam");
  const [a, s] = [alex.page, sam.page];
  pages = [a, s];
  for (const page of pages) await page.setViewport({ width: 1440, height: 900 });

  await clickButton(a, "New document");
  await a.waitForSelector(".colo-editor");
  await a.click(".colo-editor");
  await a.keyboard.type(TEXT);
  await a.keyboard.press("Enter");
  await a.keyboard.type("A second paragraph to edit around.");
  await s.goto(a.url());
  await s.waitForFunction((t) => document.querySelector(".colo-editor")?.textContent?.includes(t), { timeout: 15_000 }, TEXT);

  // Add a comment from the toolbar
  await selectText(a, "quick brown");
  await press(a, "Add comment");
  await typeInto(a, 'article[aria-label="New comment"] textarea', "Needs a source");
  await clickInCard(a, "Needs a source", "Comment");
  await s.waitForFunction(() => document.querySelector(".colo-editor [data-comment-id]"), { timeout: 10_000 });
  let marks = await highlights(s);
  const first = Object.keys(marks)[0];
  check(marks[first] === "quick brown", `Sam sees "quick brown" highlighted (${JSON.stringify(marks)})`);
  await waitForCardText(s, "Needs a source");
  check(true, "Sam sees Alex's comment in the margin");
  await s.waitForSelector('[aria-label="Comments (1 open)"]', { timeout: 10_000 });
  check(true, "the title bar counts one open comment");
  const offset = await s.evaluate((id) => {
    const span = document.querySelector(`.colo-editor [data-comment-id="${id}"]`)!;
    const article = document.querySelector(`article[data-thread-id="${id}"]`)!.parentElement!;
    return Math.abs(article.getBoundingClientRect().top - span.getBoundingClientRect().top);
  }, first);
  check(offset < 2, `the card is level with its text (${offset.toFixed(1)}px apart)`);
  const background = await s.$eval(`.colo-editor [data-comment-id="${first}"]`, (el) => getComputedStyle(el).backgroundColor);
  check(background !== "rgba(0, 0, 0, 0)", `commented text is highlighted (${background})`);

  // Sam clicks the text, replies, then edits the reply
  await s.click(`.colo-editor [data-comment-id="${first}"]`);
  await s.waitForSelector(`article[data-thread-id="${first}"][data-active]`, { timeout: 10_000 });
  check(true, "clicking commented text activates its card");
  await typeInto(s, `article[data-thread-id="${first}"] textarea[aria-label="Reply"]`, "Added one");
  await clickInCard(s, "Needs a source", "Reply");
  await waitForCardText(a, "Added one");
  check(true, "Sam's reply reaches Alex");
  await openOptions(s, first);
  await chooseMenu(s, "Edit");
  // Choosing Edit puts the cursor in the edit box, so the person can type straight away.
  await s.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Edit comment", { timeout: 10_000 });
  await ctrl(s, "a");
  await s.keyboard.type("Added a citation");
  await ctrl(s, "Enter");
  await waitForCardText(a, "Added a citation");
  await a.waitForFunction(() => document.body.innerText.includes("edited"), { timeout: 10_000 });
  check(true, "editing a reply shows the new text and 'edited' to Alex");

  // An overlapping comment with the keyboard shortcut
  await selectText(a, "brown fox");
  await a.keyboard.down("Control");
  await a.keyboard.down("Alt");
  await a.keyboard.press("m");
  await a.keyboard.up("Alt");
  await a.keyboard.up("Control");
  await typeInto(a, 'article[aria-label="New comment"] textarea', "Which fox?");
  await ctrl(a, "Enter");
  await s.waitForFunction(() => new Set([...document.querySelectorAll(".colo-editor [data-comment-id]")].map((e) => e.getAttribute("data-comment-id"))).size === 2, { timeout: 10_000 });
  marks = await highlights(s);
  const second = Object.keys(marks).find((id) => id !== first)!;
  check(marks[first] === "quick brown" && marks[second] === "brown fox", `overlapping comments keep their own text (${JSON.stringify(marks)})`);
  await waitForCardText(s, "Which fox?");
  const overlap = await s.evaluate(() => {
    const boxes = [...document.querySelectorAll('[role="complementary"] > div')].map((d) => d.getBoundingClientRect());
    return boxes.some((x, i) => boxes.some((y, j) => i < j && x.bottom > y.top + 1 && y.bottom > x.top + 1));
  });
  check(!overlap, "margin cards do not overlap");
  if (SCREENSHOTS) await s.screenshot({ path: `${SCREENSHOTS}/m5-margin.png` });

  // Resolve, find it under Resolved, reopen
  await clickInCard(a, "Needs a source", "Resolve");
  await s.waitForFunction((id) => !document.querySelector(`article[data-thread-id="${id}"]`), { timeout: 10_000 }, first);
  const resolvedBackground = await s.$eval(`.colo-editor [data-comment-id="${first}"]`, (el) => getComputedStyle(el).backgroundColor);
  check(true, "resolving removes the card from Sam's margin");
  await s.waitForSelector('[aria-label="Comments (1 open)"]');
  await s.click('[aria-label="Comments (1 open)"]');
  await clickButton(s, "Resolved (1)");
  await waitForCardText(s, "Resolved by Alex");
  check(true, "the resolved thread is listed under Resolved, with who resolved it");
  await clickInCard(s, "Needs a source", "Reopen");
  await clickButton(s, "Open (2)");
  check(true, "Sam reopens it");
  await s.keyboard.press("Escape");
  await a.waitForSelector(`article[data-thread-id="${first}"]`, { timeout: 10_000 });
  check(resolvedBackground.includes("0, 0, 0, 0") || resolvedBackground === "transparent", `resolved text was not highlighted (${resolvedBackground})`);

  // Deleting the commented text detaches the thread; undo brings the text and the anchor back
  await selectText(a, "brown fox jumps");
  await a.keyboard.press("Backspace");
  await s.waitForFunction((id) => !document.querySelector(`.colo-editor [data-comment-id="${id}"]`), { timeout: 10_000 }, second);
  await s.click('[aria-label="Comments (2 open)"]');
  await waitForCardText(s, "The commented text was deleted.");
  check(true, "a thread whose text was deleted is listed as detached");
  await s.keyboard.press("Escape");
  await ctrl(a, "z");
  await s.waitForFunction((id) => document.querySelector(`.colo-editor [data-comment-id="${id}"]`), { timeout: 10_000 }, second);
  check(true, "undoing the deletion re-attaches the thread");

  // Undo of typing never removes a comment
  await a.evaluate(() => (document.querySelector(".colo-editor") as EditorElement).editor.commands.focus("end"));
  await a.keyboard.type(" More");
  await new Promise((resolve) => setTimeout(resolve, 700));
  await selectText(a, "lazy dog");
  await press(a, "Add comment");
  await typeInto(a, 'article[aria-label="New comment"] textarea', "Rephrase");
  await clickInCard(a, "Rephrase", "Comment");
  await ctrl(a, "z");
  await new Promise((resolve) => setTimeout(resolve, 800));
  marks = await highlights(a);
  check(Object.values(marks).includes("lazy dog"), "undo after commenting keeps the comment");

  // Pasting commented text does not copy the comment
  const before = Object.keys(await highlights(a)).length;
  await a.evaluate((id) => {
    const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
    editor.commands.focus("end");
    editor.view.pasteHTML(`<p>Pasted <span data-comment-id="${id}">quick brown</span> copy</p>`);
  }, first);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterPaste = await highlights(a);
  check(Object.keys(afterPaste).length === before && afterPaste[first] === "quick brown", "pasted text does not bring comments with it");

  // A comment being written keeps its text while the other person types before it
  await selectText(a, "second paragraph");
  await press(a, "Add comment");
  await typeInto(a, 'article[aria-label="New comment"] textarea', "Draft during edits");
  await s.evaluate(() => {
    const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
    let start = 0;
    editor.state.doc.descendants((node: any, pos: number) => {
      if (!start && node.isText && node.text.startsWith("A second")) start = pos;
      return !start;
    });
    editor.chain().insertContentAt(start, "Sam was here. ").run();
  });
  await a.waitForFunction(() => document.querySelector(".colo-editor")?.textContent?.includes("Sam was here."), { timeout: 10_000 });
  await clickInCard(a, "Draft during edits", "Comment");
  await s.waitForFunction(() => [...document.querySelectorAll(".colo-editor [data-comment-id]")].some((e) => e.textContent === "second paragraph"), { timeout: 10_000 });
  check(true, "the comment lands on the selected text despite Sam's edit before it");

  // Delete a reply, then the whole thread
  await s.click(`.colo-editor [data-comment-id="${first}"]`);
  await s.waitForSelector(`article[data-thread-id="${first}"][data-active]`);
  await openOptions(s, first);
  await chooseMenu(s, "Delete");
  await a.click(`.colo-editor [data-comment-id="${first}"]`); // expand the thread
  await waitForCardText(a, "Comment deleted");
  check(true, "Sam deletes his reply; Alex sees 'Comment deleted'");
  await a.click(`.colo-editor [data-comment-id="${first}"]`);
  await a.waitForSelector(`article[data-thread-id="${first}"][data-active]`);
  await openOptions(a, first, "first");
  await chooseMenu(a, "Delete thread");
  await s.waitForFunction((id) => !document.querySelector(`[data-comment-id="${id}"], article[data-thread-id="${id}"]`), { timeout: 10_000 }, first);
  check(true, "deleting the first comment removes the thread and its highlight for both");

  // Print: no highlights
  await s.emulateMediaType("print");
  const printed = await s.$eval(".colo-editor [data-comment-id]", (el) => getComputedStyle(el).backgroundColor);
  await s.emulateMediaType();
  check(printed === "rgba(0, 0, 0, 0)", "comment highlights are not printed");

  // Phone: no margin; tapping commented text offers the comment in a panel
  await s.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await s.reload();
  await s.waitForSelector(".colo-editor [data-comment-id]");
  check(!(await s.$('[role="complementary"][aria-label="Comments"]')), "no comment margin on a phone");
  await s.tap(".colo-editor [data-comment-id]");
  await clickButton(s, "Show comment");
  await s.waitForSelector('[role="dialog"] article[data-thread-id]', { visible: true });
  check(true, "tapping commented text offers the comment in a panel");
  const overflow = await s.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no horizontal page scroll at 390px (${overflow}px)`);
  if (SCREENSHOTS) {
    await new Promise((resolve) => setTimeout(resolve, 600)); // let the panel finish sliding in
    await s.screenshot({ path: `${SCREENSHOTS}/m5-phone.png` });
  }

  check((await editorText(a)) === (await editorText(s)), "both documents hold the same text");
  const errors = [...alex.errors, ...sam.errors];
  check(errors.length === 0, `no console or CSP errors${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`);
  console.log("PASS");
} catch (error) {
  if (SCREENSHOTS) await Promise.all(pages.map((page, i) => page.screenshot({ path: `${SCREENSHOTS}/m5-failure-${i}.png` })));
  throw error;
} finally {
  await browser.close();
}
