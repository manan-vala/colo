/** Shared helpers for browser smoke tests: local Chrome + a virtual passkey authenticator. */
import { execFileSync } from "node:child_process";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";

export const BASE_URL = process.env.COLO_URL ?? "http://localhost:5173";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

export async function launch(): Promise<Browser> {
  const { existsSync } = await import("node:fs");
  const executablePath = CHROME_CANDIDATES.find((path) => path && existsSync(path));
  if (!executablePath) throw new Error("Chrome not found; set CHROME_PATH");
  return puppeteer.launch({ executablePath, headless: process.env.HEADFUL ? false : true, protocolTimeout: 30_000 });
}

/** A fresh browser context with its own cookies and a platform authenticator that auto-approves. */
export async function newUser(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors: string[] = [];
  page.on("console", (message) => {
    // Expected 4xx API responses are logged by Chrome as resource errors; those are not app errors.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error instanceof Error ? error.message : String(error)));
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { page, errors };
}

/** Runs scripts/invite.ts and returns the link. */
export function createInvite(email: string, name: string): string {
  const args = ["scripts/invite.ts", "--email", email, "--name", name];
  if (BASE_URL.startsWith("http://localhost")) args.push("--local");
  else args.push("--url", BASE_URL);
  const output = execFileSync(process.execPath, args, { encoding: "utf8" });
  const link = output.split(/\s+/).find((word) => word.includes("/invite#"));
  if (!link) throw new Error(`No invite link in output:\n${output}`);
  return link;
}

export async function clickButton(page: Page, text: string) {
  const handle = await page.waitForFunction(
    (label) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(label) && !b.disabled),
    { timeout: 15_000 },
    text,
  );
  await (handle as unknown as { click(): Promise<void> }).click();
}

export async function waitForText(page: Page, text: string, timeout = 15_000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

/**
 * Invites a new member, registers their passkey in a fresh browser context and waits for the
 * document list. Focus is emulated so headless editors publish cursors and selections.
 */
export async function enroll(browser: Browser, name: string) {
  const user = await newUser(browser);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await user.page.goto(createInvite(`${name.toLowerCase().replace(/\W+/g, "-")}-${stamp}@example.com`, name));
  await clickButton(user.page, "Create passkey");
  await waitForText(user.page, "Documents");
  const cdp = await user.page.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return { ...user, cdp };
}

/** Clicks a control by its accessible label (aria-label). */
export async function press(page: Page, label: string) {
  const handle = await page.waitForSelector(`[aria-label="${label}"]:not([disabled])`, { visible: true, timeout: 10_000 });
  await handle!.click();
}

/** Clicks a control by its data-testid, for controls whose accessible name is not a fixed word. */
export async function pressTestId(page: Page, testId: string) {
  const handle = await page.waitForSelector(`[data-testid="${testId}"]:not([disabled])`, { visible: true, timeout: 10_000 });
  await handle!.click();
}

/** Opens a menu in the document's menu bar (File, Edit, …). */
export async function openMenubar(page: Page, name: string) {
  const handle = (await page.waitForFunction(
    (label) => [...document.querySelectorAll('[role="menubar"] [role="menuitem"]')].find((item) => item.textContent?.trim() === label),
    { timeout: 10_000 },
    name,
  )) as ElementHandle<Element>;
  await handle.click();
}

/** Clicks a Radix menu item by its visible text; for leaf items, waits until the menu has closed. */
export async function chooseMenuItem(page: Page, text: string, { submenu = false } = {}) {
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

/** Document text without the other person's cursor labels, which render inline. */
export const editorText = (page: Page) =>
  page.$eval(".colo-editor", (el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".collaboration-carets__caret, .colo-pages").forEach((node) => node.remove());
    return copy.textContent?.trim() ?? "";
  });

/** The editor element; Tiptap exposes its editor on it, which tests use to read and set state. */
export type EditorElement = HTMLElement & { editor: any };

/** Selects the first occurrence of `text` in the document, like a person dragging over it. */
export async function selectText(page: Page, text: string) {
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
