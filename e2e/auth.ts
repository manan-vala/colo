/**
 * M9 smoke test: the owner adds a member in the dashboard → the member signs in with workspace ID,
 * email and password → wrong passwords are refused → sign out → change password → sign in again.
 *
 *   npm run build && npx vite preview --port 5173   (in another terminal)
 *   node e2e/auth.ts
 */
import {
  BASE_URL,
  check,
  chooseMenuItem,
  clickButton,
  launch,
  newUser,
  ownerSession,
  pressTestId,
  signIn,
  waitForText,
} from "./browser.ts";

const stamp = Date.now().toString(36);
const name = `E2E ${stamp}`;
const email = `e2e-${stamp}@example.com`;
console.log(`Auth smoke test against ${BASE_URL}`);

const browser = await launch();
try {
  // ---- the owner adds a member in the dashboard --------------------------------
  const owner = await ownerSession(browser);
  const ownerCookies = await owner.page.browserContext().cookies();
  const adminCookie = ownerCookies.find((c) => c.name === "__Host-colo_admin");
  check(adminCookie?.httpOnly && adminCookie.secure && adminCookie.sameSite === "Strict", "owner cookie is HttpOnly, Secure, SameSite=Strict");

  await owner.page.goto(`${BASE_URL}/admin/w/${owner.workspace}`);
  await clickButton(owner.page, "Add member");
  await owner.page.locator("#member-name").fill(name);
  await owner.page.locator("#member-email").fill(email);
  await owner.page.locator('[role="dialog"] button[type="submit"]').click();
  const reveal = await owner.page.waitForSelector('[data-testid="password-reveal"]');
  const details = (await reveal!.evaluate((el) => el.textContent ?? "")).trim();
  const password = /Password: (\S+)/.exec(details)?.[1];
  check(password && details.includes(`Workspace ID: ${owner.workspace}`), "the dashboard shows the new member's sign-in details once");
  await clickButton(owner.page, "Done");
  await owner.page.waitForSelector('[role="dialog"]', { hidden: true });
  await waitForText(owner.page, email);
  check(true, "the member is listed in the workspace");

  // ---- the member signs in -------------------------------------------------------
  const { page, errors } = await newUser(browser);
  const credentials = { workspace: owner.workspace, email, password: password! };

  await signIn(page, { ...credentials, password: "not the password at all" });
  await waitForText(page, "Wrong workspace ID, email or password");
  check(true, "a wrong password is refused");

  await signIn(page, credentials);
  await waitForText(page, "Documents");
  const session = (await page.browserContext().cookies()).find((c) => c.name === "__Host-colo_session");
  check(session?.httpOnly && session.secure && session.sameSite === "Strict", "session cookie is HttpOnly, Secure, SameSite=Strict");

  await pressTestId(page, "account-menu");
  await waitForText(page, owner.workspace);
  check(true, "the account menu names the workspace");

  // ---- change password -------------------------------------------------------------
  await chooseMenuItem(page, "Change password");
  const next = `new-password-${stamp}`;
  await page.locator("#password-current").fill(password!);
  await page.locator("#password-next").fill(next);
  await page.locator("#password-confirm").fill(next);
  await page.locator('[role="dialog"] button[type="submit"]').click();
  await waitForText(page, "Your password is changed");
  await clickButton(page, "Done");
  await page.waitForSelector('[role="dialog"]', { hidden: true });
  check(true, "the member changes their own password");

  await pressTestId(page, "account-menu");
  await chooseMenuItem(page, "Sign out");
  await waitForText(page, "Workspace ID");
  check((await (await page.goto(`${BASE_URL}/api/me`))!.status()) === 401, "signed out: /api/me returns 401");

  await signIn(page, credentials);
  await waitForText(page, "Wrong workspace ID, email or password");
  check(true, "the old password no longer works");

  await signIn(page, { ...credentials, password: next });
  await waitForText(page, "Documents");
  check(true, "signed back in with the new password");

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
}
