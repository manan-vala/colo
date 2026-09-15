/** Shared helpers for browser smoke tests: local Chrome + a virtual passkey authenticator. */
import { execFileSync } from "node:child_process";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

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
