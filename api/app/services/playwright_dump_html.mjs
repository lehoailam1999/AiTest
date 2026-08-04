/**

 * Dump rendered HTML for AITest Inspect (SPA).

 *

 * Usage:

 *   node dump-html.mjs <url>

 *   node dump-html.mjs <url> --storage <storageState.json> --feature </path>

 *   E2E_USERNAME / E2E_PASSWORD → optional UI login before feature goto

 *

 * Dùng domcontentloaded — tránh networkidle (SPA/websocket có thể treo rất lâu).

 */

import { chromium } from "playwright";

import fs from "node:fs";



function argValue(flag) {

  const i = process.argv.indexOf(flag);

  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];

  return "";

}



const url = process.argv[2];

if (!url || url.startsWith("--")) {

  console.error(

    "usage: node dump-html.mjs <url> [--storage path.json] [--feature /route]"

  );

  process.exit(2);

}



const storagePath =

  argValue("--storage") || (process.env.E2E_STORAGE_STATE_ABS || "").trim();

const featurePath =

  argValue("--feature") || (process.env.E2E_FEATURE_PATH || "").trim();

const user = (process.env.E2E_USERNAME || "").trim();

const pass = (process.env.E2E_PASSWORD || "").trim();



function joinUrl(base, path) {

  if (!path) return base;

  if (/^https?:\/\//i.test(path)) return path;

  const b = base.replace(/\/$/, "");

  const p = path.startsWith("/") ? path : `/${path}`;

  return `${b}${p}`;

}



async function tryUiLogin(page) {

  if (!user || !pass) return false;

  const password = page.locator('input[type="password"]').first();

  const visible = await password.isVisible().catch(() => false);

  if (!visible) return false;

  const email = page

    .locator(

      'input[type="email"], input[name*="user" i], input[name*="email" i], input[type="text"]'

    )

    .first();

  await email.fill(user).catch(() => undefined);

  await password.fill(pass).catch(() => undefined);

  const btn = page

    .getByRole("button", { name: /log\s*in|sign\s*in|đăng\s*nhập/i })

    .or(page.locator('button[type="submit"]'))

    .first();

  await btn.click().catch(() => undefined);

  await page.waitForTimeout(1500);

  return true;

}



const browser = await chromium.launch({ headless: true });

try {

  const contextOpts = {};

  if (storagePath && fs.existsSync(storagePath)) {

    contextOpts.storageState = storagePath;

  }

  const context = await browser.newContext(contextOpts);

  const page = await context.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

  await page.waitForTimeout(800);



  if (!contextOpts.storageState) {

    await tryUiLogin(page);

  }



  if (featurePath) {

    const dest = joinUrl(url, featurePath);

    await page.goto(dest, { waitUntil: "domcontentloaded", timeout: 20000 });

    await page.waitForTimeout(1200);

  } else {

    await page.waitForTimeout(400);

  }



  const html = await page.content();

  process.stdout.write(html);

  await context.close();

} finally {

  await browser.close();

}


