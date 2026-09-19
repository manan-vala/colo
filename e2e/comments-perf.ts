/**
 * Performance check for comments: a 50-page document with many open threads in the margin.
 * Measures a keystroke (transaction + layout) and the frame work after it (pagination, the
 * comment margin and React), which together must fit in one 16 ms frame.
 *
 * Run it against the production build; development React is several times slower:
 *
 *   npm run build && npx vite preview --port 5173
 *   THREADS=100 node e2e/comments-perf.ts      (default 50)
 */
import { BASE_URL, check, clickButton, enroll, launch } from "./browser.ts";

const BUDGET_MS = 16;
const THREADS = Number(process.env.THREADS ?? 50);

type EditorElement = HTMLElement & { editor: any };

const browser = await launch();
try {
  console.log(`Comments performance check against ${BASE_URL}`);
  const alex = await enroll(browser, "Alex");
  const page = alex.page;
  await page.setViewport({ width: 1440, height: 900 });
  await clickButton(page, "New document");
  await page.waitForSelector(".colo-editor.colo-paged");

  await page.evaluate(() => {
    const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
    const sentence = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
    let html = "";
    for (let i = 0; i < 640; i++) html += `<p>Paragraph ${i}. ${sentence.repeat(1 + (i % 4))}</p>`;
    editor.commands.setContent(html);
  });
  await page.waitForFunction(() => document.querySelectorAll(".colo-page-spacer").length >= 50, { timeout: 30_000 });

  // Threads are added through the UI's own path: select, Add comment, post.
  for (let i = 0; i < THREADS; i++) {
    await page.evaluate((n) => {
      const editor = (document.querySelector(".colo-editor") as EditorElement).editor;
      let target = 0;
      editor.state.doc.descendants((node: any, pos: number) => {
        if (!target && node.isTextblock && node.textContent.startsWith(`Paragraph ${n * 4}.`)) target = pos + 1;
        return !target;
      });
      editor.chain().focus().setTextSelection({ from: target, to: target + 9 }).run();
    }, i);
    await page.waitForFunction(() => document.activeElement?.classList.contains("colo-editor"));
    await page.click('[aria-label="Add comment"]');
    const box = await page.waitForSelector('article[aria-label="New comment"] textarea', { visible: true });
    await box!.type(`Comment ${i}`);
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await page.waitForFunction((n) => document.querySelectorAll('[role="complementary"] article[data-thread-id]').length === n, { timeout: 10_000 }, i + 1);
  }
  check(true, `${THREADS} comment threads in the margin of a 50-page document`);

  const result = await page.evaluate(async () => {
    const view = (document.querySelector(".colo-editor") as EditorElement).editor.view;
    const sync: number[] = [];
    const frame: number[] = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      view.dispatch(view.state.tr.insertText("x", 3 + i));
      void document.body.offsetHeight;
      sync.push(performance.now() - start);
      // Registered after the paginator's and the margin's frame callbacks, so it runs last:
      // the time since the frame began is the work they did.
      frame.push(await new Promise<number>((resolve) => requestAnimationFrame((t) => resolve(performance.now() - t))));
      // One more frame so React has rendered; timers are throttled in headless Chrome.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const stats = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] };
    };
    return { sync: stats(sync), frame: stats(frame) };
  });
  console.log(`  keystroke: median ${result.sync.median.toFixed(1)} ms, p95 ${result.sync.p95.toFixed(1)} ms`);
  console.log(`  frame work after it: median ${result.frame.median.toFixed(1)} ms, p95 ${result.frame.p95.toFixed(1)} ms`);
  check(result.sync.median + result.frame.median < BUDGET_MS, `keystroke plus frame work stays under ${BUDGET_MS} ms (median)`);
  console.log("PASS");
} finally {
  await browser.close();
}
