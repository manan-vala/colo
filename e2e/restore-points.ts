/**
 * M6 acceptance test for restore points (plan §11), with two people in one document:
 *
 * - a named version is saved from File → Restore points;
 * - after the other person rewrites the text and comments on it, restoring the version brings
 *   back the text and its comment and removes the newer comment, in both browsers, and tells
 *   the other person who restored it;
 * - undo does not revert a restore; restoring the "Before a restore" copy brings the newer
 *   version back.
 *
 *   npm run build && npx vite preview --port 5173   (or npm run dev)
 *   node e2e/restore-points.ts
 */
import type { Page } from "puppeteer-core";
import { BASE_URL, check, chooseMenuItem, clickButton, editorText, enroll, launch, openMenubar, press, selectText } from "./browser.ts";

const ORIGINAL = "Original text for the record.";
const REWRITTEN = "Rewritten by Bea.";

/** Comments shown in the margin, by their text. */
const marginCards = (page: Page) =>
  page.$$eval('[role="complementary"] article[data-thread-id]', (cards) => cards.map((card) => card.textContent ?? ""));

async function addComment(page: Page, text: string, body: string) {
  await selectText(page, text);
  await press(page, "Add comment");
  const box = await page.waitForSelector('article[aria-label="New comment"] textarea', { visible: true });
  await box!.type(body);
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await page.waitForFunction((b) => [...document.querySelectorAll("article[data-thread-id]")].some((a) => a.textContent?.includes(b)), {}, body);
}

async function openRestorePoints(page: Page) {
  await openMenubar(page, "File");
  await chooseMenuItem(page, "Restore points");
  await page.waitForSelector('[role="dialog"] ul[aria-label="Restore points"], [role="dialog"] p.text-center', { visible: true });
}

/** Restores the list row whose text includes `text`, confirming when asked. */
async function restoreRow(page: Page, text: string) {
  const clickInRow = async (label: string) => {
    const button = await page.waitForFunction(
      (t, l) => {
        const row = [...document.querySelectorAll('[role="dialog"] li[data-point-id]')].find((li) => li.textContent?.includes(t));
        return [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === l && !b.disabled);
      },
      { timeout: 10_000 },
      text,
      label,
    );
    await (button as unknown as { click(): Promise<void> }).click();
  };
  await clickInRow("Restore");
  await clickInRow("Confirm restore");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 });
}

const waitForText = (page: Page, text: string) =>
  page.waitForFunction((t) => document.querySelector(".colo-editor")?.textContent?.includes(t), { timeout: 15_000 }, text);

const browser = await launch();
try {
  console.log(`Restore points acceptance test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const bea = await enroll(browser, "Bea");
  const [a, b] = [alex.page, bea.page];
  for (const page of [a, b]) await page.setViewport({ width: 1440, height: 900 });

  await clickButton(a, "New document");
  await a.waitForSelector(".colo-editor");
  await a.click(".colo-editor");
  await a.keyboard.type(ORIGINAL);
  await b.goto(a.url());
  await waitForText(b, ORIGINAL);
  await addComment(a, "Original", "C1 keep this");
  await b.waitForFunction(() => document.querySelector('[role="complementary"] article[data-thread-id]'), { timeout: 10_000 });

  // Save a named version.
  await openRestorePoints(a);
  await a.type('[aria-label="Restore point name"]', "Draft 1");
  await clickButton(a, "Save version");
  await a.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] li[data-point-id]')].some((li) => li.textContent?.includes("Draft 1")), {
    timeout: 10_000,
  });
  check(true, "Alex saves the named version “Draft 1”");
  await a.keyboard.press("Escape");
  await a.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // Bea rewrites the text (Alex's comment loses its text) and comments on the new text.
  await selectText(b, ORIGINAL);
  await b.keyboard.type(REWRITTEN);
  await addComment(b, "Rewritten", "C2 newer");
  await waitForText(a, REWRITTEN);
  await a.waitForFunction(() => [...document.querySelectorAll("article[data-thread-id]")].some((c) => c.textContent?.includes("C2 newer")), {
    timeout: 10_000,
  });

  // Alex restores Draft 1.
  await openRestorePoints(a);
  await restoreRow(a, "Draft 1");
  for (const [name, page] of [
    ["Alex", a],
    ["Bea", b],
  ] as const) {
    await waitForText(page, ORIGINAL);
    await page.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll('[role="complementary"] article[data-thread-id]')].map((c) => c.textContent ?? "");
        return cards.length === 1 && cards[0].includes("C1 keep this");
      },
      { timeout: 10_000 },
    );
    const text = await editorText(page);
    check(text.includes(ORIGINAL) && !text.includes(REWRITTEN), `${name} sees Draft 1's text again`);
    const cards = await marginCards(page);
    check(cards.length === 1 && cards[0].includes("C1 keep this"), `${name} sees Draft 1's comment beside its text, and not the newer one`);
    const count = await page.$eval('[aria-label^="Comments ("]', (button) => button.getAttribute("aria-label"));
    check(count === "Comments (1 open)", `${name}'s comment count is back to one (${count})`);
  }
  await b.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("Alex restored an earlier version"), { timeout: 10_000 });
  check(true, "Bea is told that Alex restored an earlier version");

  // Undo covers one's own typing only; it does not revert the restore.
  await a.click(".colo-editor");
  await a.keyboard.down("Control");
  await a.keyboard.press("z");
  await a.keyboard.up("Control");
  await new Promise((resolve) => setTimeout(resolve, 800));
  check((await editorText(a)).includes(ORIGINAL), "Ctrl+Z does not undo the restore");

  // The version before the restore was kept, and restoring it brings Bea's text back.
  await openRestorePoints(a);
  const rows = await a.$$eval('[role="dialog"] li[data-point-id]', (items) => items.map((li) => li.textContent ?? ""));
  check(rows[0].includes("Before restoring “Draft 1”") && rows[0].includes("Before a restore"), "the list starts with the copy kept before the restore");
  await restoreRow(a, "Before restoring");
  for (const page of [a, b]) {
    await waitForText(page, REWRITTEN);
    await page.waitForFunction(() => [...document.querySelectorAll("article[data-thread-id]")].some((c) => c.textContent?.includes("C2 newer")), {
      timeout: 10_000,
    });
  }
  check(true, "restoring that copy brings Bea's rewrite and comment back in both browsers");

  const errors = [...alex.errors, ...bea.errors];
  check(errors.length === 0, `no errors in either browser${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
}
