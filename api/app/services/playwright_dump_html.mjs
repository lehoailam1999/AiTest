/**
 * Dump rendered HTML for AITest Inspect (SPA).
 * Usage: node dump-html.mjs <url>
 *
 * Dùng domcontentloaded — tránh networkidle (SPA/websocket có thể treo rất lâu).
 */
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) {
  console.error("usage: node dump-html.mjs <url>");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  // SPA: chờ ngắn để hydrate (không dùng networkidle)
  await page.waitForTimeout(1200);
  const html = await page.content();
  process.stdout.write(html);
} finally {
  await browser.close();
}
