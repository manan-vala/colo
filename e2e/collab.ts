/**
 * M2 smoke test: two members co-edit one document in separate browser contexts.
 *
 *   npm run build && npx vite preview --port 5173    (or npm run dev)
 *   node e2e/collab.ts
 */
import type { Page } from "puppeteer-core";
import { BASE_URL, check, clickButton, editorText, enroll, launch, waitForText } from "./browser.ts";

async function waitForEditorText(page: Page, expected: string, timeout = 10_000) {
  await page.waitForFunction(
    (text) => (document.querySelector(".colo-editor") as HTMLElement | null)?.innerText.includes(text),
    { timeout },
    expected,
  );
}

const browser = await launch();
try {
  console.log(`Collaboration smoke test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const sam = await enroll(browser, "Sam");

  // Count WebSocket frames Alex sends, to check the cost model's "one message per edit".
  let framesSent = 0;
  await alex.cdp.send("Network.enable");
  alex.cdp.on("Network.webSocketFrameSent", () => framesSent++);

  await clickButton(alex.page, "New document");
  await alex.page.waitForSelector(".colo-editor");
  const docUrl = alex.page.url();
  check(/\/d\/[0-9A-Z]{26}$/.test(docUrl), "Alex created a document and opened it");

  await sam.page.goto(docUrl);
  await sam.page.waitForSelector(".colo-editor");
  await alex.page.waitForFunction(() => document.querySelectorAll('[aria-label="People in this document"] li').length === 2, { timeout: 15_000 });
  check(true, "both people appear in the presence avatars");

  await alex.page.click(".colo-editor");
  const before = framesSent;
  const alexLine = "Alex typing in the shared document.";
  await alex.page.keyboard.type(alexLine, { delay: 15 });
  await waitForEditorText(sam.page, alexLine);
  check(true, "Sam sees Alex's text");
  const perKey = (framesSent - before) / alexLine.length;
  console.log(`    (${framesSent - before} WebSocket frames for ${alexLine.length} keystrokes = ${perKey.toFixed(2)} per keystroke, including cursor updates)`);

  await sam.page.click(".colo-editor");
  await sam.page.keyboard.press("End");
  await sam.page.keyboard.press("Enter");
  await sam.page.keyboard.type("Sam replies at the same time.", { delay: 15 });
  await alex.page.keyboard.type(" More from Alex.", { delay: 15 });
  await waitForEditorText(alex.page, "Sam replies at the same time.");
  await waitForEditorText(sam.page, "More from Alex.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  check((await editorText(alex.page)) === (await editorText(sam.page)), "simultaneous typing converges to the same text in both browsers");

  await alex.page.waitForFunction(() => document.querySelectorAll(".collaboration-carets__caret").length > 0, { timeout: 10_000 });
  const label = await alex.page.$eval(".collaboration-carets__label", (el) => el.textContent);
  check(label === "Sam", `Alex sees Sam's cursor labelled "${label}"`);

  const title = alex.page.locator('input[aria-label="Document title"]');
  await title.click({ count: 3 });
  await alex.page.keyboard.type("Trip plan");
  await sam.page.waitForFunction(
    () => (document.querySelector('input[aria-label="Document title"]') as HTMLInputElement).value === "Trip plan",
    { timeout: 10_000 },
  );
  check(true, "title edits sync to Sam");

  await alex.page.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent?.startsWith("All changes saved"), { timeout: 15_000 });
  check(true, 'save status reaches "All changes saved"');

  await sam.page.reload();
  await sam.page.waitForSelector(".colo-editor");
  await waitForEditorText(sam.page, "Sam replies at the same time.");
  check(true, "content is still there after Sam reloads");

  await sam.page.goto(BASE_URL);
  await waitForText(sam.page, "Trip plan", 15_000);
  check(true, "the document list shows the new title");

  const errors = [...alex.errors, ...sam.errors];
  check(errors.length === 0, `no console or CSP errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
}
