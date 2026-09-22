/** Shared helpers for browser smoke tests: local Chrome + a virtual passkey authenticator (the owner's). */
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

/** Runs scripts/admin-enroll.ts and returns the owner's one-time passkey link. */
export function ownerEnrollLink(): string {
  const args = ["scripts/admin-enroll.ts"];
  if (BASE_URL.startsWith("http://localhost")) args.push("--local");
  else args.push("--url", BASE_URL);
  const output = execFileSync(process.execPath, args, { encoding: "utf8" });
  const link = output.split(/\s+/).find((word) => word.includes("/admin/enroll#"));
  if (!link) throw new Error(`No enrollment link in output:
${output}`);
  return link;
}

/** A JSON call from inside a page, so it carries that page's cookies and origin. */
export async function pageApi<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const result = await page.evaluate(
    async (method, path, body) => {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    method,
    path,
    body,
  );
  if (result.status >= 400) throw new Error(`${method} ${path} failed: ${result.status} ${result.text}`);
  return (result.text ? JSON.parse(result.text) : undefined) as T;
}

const runStamp = Date.now().toString(36);
let owner: Promise<{ page: Page; workspace: string }> | undefined;

/**
 * The owner, signed in to the dashboard in a browser context of its own, and a workspace made
 * for this run (M9). A fresh workspace each run keeps repeated local runs clear of member caps.
 */
export function ownerSession(browser: Browser): Promise<{ page: Page; workspace: string }> {
  owner ??= (async () => {
    const user = await newUser(browser);
    await user.page.goto(ownerEnrollLink());
    await clickButton(user.page, "Create passkey");
    await waitForText(user.page, "Workspaces");
    const workspace = `e2e-${runStamp}`;
    await pageApi(user.page, "POST", "/api/admin/workspaces", { slug: workspace, name: `E2E ${runStamp}`, maxMembers: 100 });
    return { page: user.page, workspace };
  })();
  return owner;
}

export interface Credentials {
  workspace: string;
  email: string;
  password: string;
}

/** Adds a member to this run's workspace through the owner's API and returns how they sign in. */
export async function addMember(browser: Browser, name: string): Promise<Credentials> {
  const { page, workspace } = await ownerSession(browser);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${stamp}@example.com`;
  const { password } = await pageApi<{ password: string }>(page, "POST", `/api/admin/workspaces/${workspace}/members`, {
    email,
    name,
  });
  return { workspace, email, password };
}

/** Fills in the sign-in form; the caller waits for whatever should follow. */
export async function signIn(page: Page, { workspace, email, password }: Credentials) {
  await page.goto(BASE_URL);
  await page.locator("#sign-in-workspace").fill(workspace);
  await page.locator("#sign-in-email").fill(email);
  await page.locator("#sign-in-password").fill(password);
  await clickButton(page, "Sign in");
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
 * Adds a new member, signs them in with their password in a fresh browser context and waits for
 * the document list. Focus is emulated so headless editors publish cursors and selections.
 */
export async function enroll(browser: Browser, name: string) {
  const credentials = await addMember(browser, name);
  const user = await newUser(browser);
  await signIn(user.page, credentials);
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
