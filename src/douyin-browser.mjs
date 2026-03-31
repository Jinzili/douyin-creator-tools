import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";

export const DEFAULT_COMMENT_PAGE_URL =
  "https://creator.douyin.com/creator-micro/interactive/comment";
export const DEFAULT_USER_DATA_DIR = path.resolve(".playwright/douyin-profile");

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

export async function promptForEnter(message) {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    await terminal.question(`${message}\n`);
  } finally {
    terminal.close();
  }
}

export async function launchPersistentPage(options = {}) {
  const {
    userDataDir = DEFAULT_USER_DATA_DIR,
    headless = false,
    viewport = DEFAULT_VIEWPORT,
    alwaysNewPage = false
  } = options;

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport
  });
  const page = alwaysNewPage
    ? await context.newPage()
    : context.pages()[0] ?? (await context.newPage());

  await page.bringToFront().catch(() => {});

  return { context, page };
}

export async function gotoPage(page, pageUrl, navigationTimeoutMs = 60000) {
  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs
  });
  await page.bringToFront().catch(() => {});
}
