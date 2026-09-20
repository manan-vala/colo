/**
 * M1 smoke test: invite → create passkey → signed in → sign out → sign in with passkey.
 *
 *   npm run dev            (in another terminal)
 *   node e2e/auth.ts
 */
import { BASE_URL, check, chooseMenuItem, clickButton, createInvite, launch, newUser, pressTestId, waitForText } from "./browser.ts";

const stamp = Date.now().toString(36);
const name = `E2E ${stamp}`;
const link = createInvite(`e2e-${stamp}@example.com`, name);
console.log(`Auth smoke test against ${BASE_URL}`);

const browser = await launch();
try {
  const { page, errors } = await newUser(browser);

  await page.goto(link);
  await clickButton(page, "Create passkey");
  await waitForText(page, name);
  check(new URL(page.url()).hash === "", "invite token is removed from the URL after registration");

  const cookies = await page.browserContext().cookies();
  const session = cookies.find((c) => c.name === "__Host-colo_session");
  check(session?.httpOnly && session.secure && session.sameSite === "Strict", "session cookie is HttpOnly, Secure, SameSite=Strict");

  await page.goto(link);
  await clickButton(page, "Create passkey");
  await waitForText(page, "already used");
  check(true, "a used invite link is rejected");

  await page.goto(BASE_URL);
  // Sign out lives in the account menu on the document list (M8 put it there with the backup).
  await pressTestId(page, "account-menu");
  await chooseMenuItem(page, "Sign out");
  await waitForText(page, "Sign in with passkey");
  check((await (await page.goto(`${BASE_URL}/api/me`))!.status()) === 401, "signed out: /api/me returns 401");

  await page.goto(BASE_URL);
  await clickButton(page, "Sign in with passkey");
  await waitForText(page, name);
  check(true, "signed back in with the passkey (discoverable credential, no username)");

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
}
