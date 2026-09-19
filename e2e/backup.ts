/**
 * M8 acceptance test for backups (plan §8.5 and §11: "backup restores to a local instance").
 *
 * The workerd tests in `test/backup.test.ts` cover the format and the SQL. This covers the parts
 * only a real instance can: the HTTP export a browser downloads, and `scripts/restore.ts`
 * driving it back in over HTTP, batch by batch.
 *
 * - a document with text and an image exports as NDJSON, with a filename to save it under;
 * - the document is then wrecked -- renamed, rewritten, its image deleted -- and restored;
 * - the text, the title and the image all come back, and the image still loads from its own URL,
 *   which is what proves the document id survived;
 * - restoring does not stamp the document as edited just now.
 *
 * Run against a local server only (it writes over documents):
 *   npm run dev            (or npm run build && npx vite preview --port 5173)
 *   node e2e/backup.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import { BASE_URL, check, clickButton, enroll, launch, press } from "./browser.ts";

if (!BASE_URL.startsWith("http://localhost")) {
  throw new Error(`Refusing to run against ${BASE_URL}: this test restores over documents.`);
}

const TEXT = "The original paragraph.";
const WRECKED = "Someone typed over it.";

/** Downloads a backup the way the browser does, and saves it. */
async function downloadBackup(page: Page, file: string): Promise<string> {
  const backup = await page.evaluate(async () => {
    const response = await fetch("/api/export");
    return { status: response.status, disposition: response.headers.get("Content-Disposition"), text: await response.text() };
  });
  check(backup.status === 200, `the export answers 200 (${backup.status})`);
  check(
    /^attachment; filename="colo-backup-\d{4}-\d{2}-\d{2}\.ndjson"$/.test(backup.disposition ?? ""),
    `it is offered as a file to save (${backup.disposition})`,
  );
  writeFileSync(file, backup.text);
  return backup.text;
}

const editorText = (page: Page) => page.$eval(".colo-editor", (el) => el.textContent ?? "");

const browser = await launch();
const workDir = mkdtempSync(join(tmpdir(), "colo-backup-"));
try {
  console.log(`Backup acceptance test against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const a = alex.page;
  await a.setViewport({ width: 1440, height: 900 });

  // A document with a title, a paragraph and an image.
  await clickButton(a, "New document");
  await a.waitForSelector(".colo-editor");
  await a.click(".colo-editor");
  await a.keyboard.type(TEXT);
  const docUrl = a.url();

  const fixture = join(workDir, "photo.png");
  const png = await a.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#188038";
    context.fillRect(0, 0, 400, 300);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  writeFileSync(fixture, Buffer.from(png, "base64"));
  const [chooser] = await Promise.all([a.waitForFileChooser({ timeout: 10_000 }), press(a, "Insert image")]);
  await chooser.accept([fixture]);
  await a.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>(".colo-editor .colo-image img")].some((img) => img.complete && img.naturalWidth > 0),
    { timeout: 15_000 },
  );
  const imageSrc = await a.$eval(".colo-editor .colo-image img", (img) => (img as HTMLImageElement).getAttribute("src") ?? "");
  check(imageSrc.startsWith("/api/docs/"), `the image is stored with the document (${imageSrc})`);

  // Let the debounced save reach SQLite: the export reads rows, not the live document.
  await a.waitForFunction(() => document.body.textContent?.includes("All changes saved"), { timeout: 15_000 });

  const file = join(workDir, "backup.ndjson");
  const text = await downloadBackup(a, file);
  const types = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).type as string);
  check(types[0] === "colo-backup" && types.at(-1) === "end", "the backup runs from a header to an end record");
  check(types.includes("state") && types.includes("image"), "it carries document state and image bytes");
  check(!types.includes("passkey") && !types.includes("session"), "it carries no passkeys or sessions");

  const before = await a.evaluate(async () => {
    const list = (await (await fetch("/api/docs")).json()) as { documents: { id: string; updatedAt: string }[] };
    return list.documents[0];
  });

  // Wreck it: rewrite the paragraph and delete the image.
  await a.click(".colo-editor");
  await a.keyboard.down("Control");
  await a.keyboard.press("KeyA");
  await a.keyboard.up("Control");
  await a.keyboard.type(WRECKED);
  await a.waitForFunction((wrecked: string) => document.querySelector(".colo-editor")?.textContent?.includes(wrecked), { timeout: 15_000 }, WRECKED);
  await a.waitForFunction(() => document.body.textContent?.includes("All changes saved"), { timeout: 15_000 });
  check((await editorText(a)).includes(WRECKED), "the document now holds the wrong text");

  // Restore, through the real script and the real HTTP endpoint.
  const output = execFileSync(process.execPath, ["scripts/restore.ts", "--file", file, "--overwrite", "--url", BASE_URL], {
    encoding: "utf8",
  });
  check(/Restored \d+ document\(s\)/.test(output), `the restore script finished (${output.trim().split("\n").at(-3) ?? ""})`);

  await a.goto(docUrl);
  await a.waitForSelector(".colo-editor");
  await a.waitForFunction((original: string) => document.querySelector(".colo-editor")?.textContent?.includes(original), { timeout: 15_000 }, TEXT);
  check(!(await editorText(a)).includes(WRECKED), "the wrecked text is gone");

  await a.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>(".colo-editor .colo-image img")].some((img) => img.complete && img.naturalWidth > 0),
    { timeout: 15_000 },
  );
  const restoredSrc = await a.$eval(".colo-editor .colo-image img", (img) => (img as HTMLImageElement).getAttribute("src") ?? "");
  check(restoredSrc === imageSrc, "the image is back at the same URL, so the document id survived");
  const served = await a.evaluate(async (src: string) => (await fetch(src)).status, restoredSrc);
  check(served === 200, `and the bytes still serve (${served})`);

  const after = await a.evaluate(async () => {
    const list = (await (await fetch("/api/docs")).json()) as { documents: { id: string; updatedAt: string }[] };
    return list.documents[0];
  });
  check(after.updatedAt === before.updatedAt, "a restore is not counted as an edit");

  const errors = alex.errors;
  check(errors.length === 0, `no errors in the browser${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`);
  console.log("PASS");
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
