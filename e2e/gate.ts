/**
 * M2 go/no-go gate on a deployed Worker (plan §11): co-edit, go idle long enough for
 * Durable Objects to hibernate, resume editing, then keep typing through a redeploy.
 *
 *   COLO_URL=https://colo-staging.<subdomain>.workers.dev COLO_ADMIN_TOKEN=... node e2e/gate.ts
 *
 * In another terminal, watch hibernation wake-ups:
 *   npx wrangler tail <worker-name> --format pretty | grep document-load
 *
 * When the script prints "DEPLOY NOW", run `npm run deploy` (or the staging deploy) while it types.
 */
import type { Page } from "puppeteer-core";
import { BASE_URL, check, clickButton, editorText, enroll, launch } from "./browser.ts";

const IDLE_SECONDS = Number(process.env.IDLE_SECONDS ?? 180);
const TYPE_THROUGH_DEPLOY_SECONDS = Number(process.env.TYPE_SECONDS ?? 90);

if (BASE_URL.startsWith("http://localhost")) console.warn("Warning: the gate is meant for a deployed Worker.");

async function waitForEqualText(a: Page, b: Page, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [ta, tb] = await Promise.all([editorText(a), editorText(b)]);
    if (ta === tb) return ta;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("texts did not converge");
}

const browser = await launch();
try {
  console.log(`M2 gate against ${BASE_URL}`);
  const alex = await enroll(browser, "Gate Alex");
  const sam = await enroll(browser, "Gate Sam");

  await clickButton(alex.page, "New document");
  await alex.page.waitForSelector(".colo-editor");
  await sam.page.goto(alex.page.url());
  await sam.page.waitForSelector(".colo-editor");

  await alex.page.click(".colo-editor");
  await alex.page.keyboard.type("Before idle.", { delay: 20 });
  await waitForEqualText(alex.page, sam.page);
  check(true, "co-editing works on the deployed Worker");

  console.log(`  … idling ${IDLE_SECONDS}s with both tabs open (objects should hibernate; watch the tail for document-load)`);
  await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));

  await alex.page.keyboard.type(" After idle.", { delay: 20 });
  const afterIdle = await waitForEqualText(alex.page, sam.page);
  check(afterIdle.includes("After idle."), "editing resumes after idle (object woke from hibernation and reloaded state)");

  console.log(`DEPLOY NOW — typing for ${TYPE_THROUGH_DEPLOY_SECONDS}s`);
  const stop = Date.now() + TYPE_THROUGH_DEPLOY_SECONDS * 1000;
  let typed = 0;
  while (Date.now() < stop) {
    await alex.page.keyboard.type(`${typed++} `);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const finalText = await waitForEqualText(alex.page, sam.page, 90_000);
  // Every token 0…typed-1 must be present, in order (the text is trimmed, so no trailing space on the last one).
  const expected = Array.from({ length: typed }, (_, i) => String(i)).join(" ");
  if (!finalText.includes(expected)) {
    const present = new Set(finalText.split(/s+/));
    const missing = Array.from({ length: typed }, (_, i) => String(i)).filter((token) => !present.has(token));
    console.log(`    missing tokens (${missing.length}): ${missing.slice(0, 40).join(" ")}`);
    console.log(`    tail of text: …${finalText.slice(-200)}`);
  }
  check(finalText.includes(expected), `all ${typed} tokens typed through the deploy reached both browsers, in order`);

  await alex.page.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent?.startsWith("All changes saved"), { timeout: 30_000 });
  await sam.page.reload();
  await sam.page.waitForSelector(".colo-editor");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  check((await editorText(sam.page)) === finalText, "the saved document matches after a reload");
  console.log("PASS — now check the Durable Objects duration graph in the dashboard stays near zero while idle.");
} finally {
  await browser.close();
}
