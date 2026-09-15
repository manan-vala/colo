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
import { BASE_URL, check, clickButton, createInvite, launch, newUser, waitForText } from "./browser.ts";

const IDLE_SECONDS = Number(process.env.IDLE_SECONDS ?? 180);
const TYPE_THROUGH_DEPLOY_SECONDS = Number(process.env.TYPE_SECONDS ?? 90);

if (BASE_URL.startsWith("http://localhost")) console.warn("Warning: the gate is meant for a deployed Worker.");

async function enroll(browser: Awaited<ReturnType<typeof launch>>, name: string) {
  const user = await newUser(browser);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await user.page.goto(createInvite(`gate-${name.toLowerCase()}-${stamp}@example.com`, `Gate ${name}`));
  await clickButton(user.page, "Create passkey");
  await waitForText(user.page, "Documents");
  const cdp = await user.page.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return user;
}

const text = (page: Page) =>
  page.$eval(".colo-editor", (el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".collaboration-carets__caret").forEach((caret) => caret.remove());
    return copy.textContent?.trim() ?? "";
  });

async function waitForEqualText(a: Page, b: Page, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [ta, tb] = await Promise.all([text(a), text(b)]);
    if (ta === tb) return ta;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("texts did not converge");
}

const browser = await launch();
try {
  console.log(`M2 gate against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const sam = await enroll(browser, "Sam");

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
  check(finalText.includes(`${typed - 1} `), `all ${typed} tokens typed through the deploy reached both browsers`);

  await alex.page.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent?.startsWith("All changes saved"), { timeout: 30_000 });
  await sam.page.reload();
  await sam.page.waitForSelector(".colo-editor");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  check((await text(sam.page)) === finalText, "the saved document matches after a reload");
  console.log("PASS — now check the Durable Objects duration graph in the dashboard stays near zero while idle.");
} finally {
  await browser.close();
}
