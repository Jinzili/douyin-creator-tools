#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import {
  DEFAULT_COMMENT_PAGE_URL,
  DEFAULT_USER_DATA_DIR,
  launchPersistentPage,
  promptForEnter
} from "./douyin-browser.mjs";
import { getEffectiveTimeout } from "./lib/common.mjs";
import { ensureCommentPageReady } from "./lib/comment-page.mjs";
import { findTargetWorkWithRetry, getSelectedWorkOutput } from "./lib/works-panel.mjs";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 60000;
const DEFAULT_UI_TIMEOUT_MS = 30000;
const DEFAULT_WORKS_TIMEOUT_MS = 45000;
const DEFAULT_WORKS_IDLE_MS = 5000;
const VERIFY_CODE_WAIT_FILE = path.resolve("verify-code-waiting.txt");
const VERIFY_CODE_FILE = path.resolve("verify-code.txt");

/**
 * 检测并处理短信验证码弹窗
 * 1. 检测到验证码弹窗 → 自动点"获取验证码"
 * 2. 等待用户在 verify-code.txt 写入验证码
 * 3. 读取验证码并填入，点"验证"
 * @returns {Promise<boolean>} true=处理了验证码，false=没有验证码弹窗
 */
async function handleVerificationCode(page) {
  // 等待验证码弹窗出现
  await page.waitForTimeout(2000);

  // 截图诊断
  await page.screenshot({ path: "verify-check.png" });

  // 尝试多种方式查找验证码弹窗
  const dialogMethods = [
    page.locator('text="接收短信验证"').first(),
    page.locator('text="短信验证"').first(),
    page.locator('[class*="verify"]').first(),
    page.locator('[class*="dialog"]').first(),
    page.locator('[class*="modal"]').first(),
  ];

  let dialogFound = false;
  for (const dialog of dialogMethods) {
    if (await dialog.isVisible().catch(() => false)) {
      dialogFound = true;
      console.log(`检测到验证码相关元素`);
      break;
    }
  }

  if (!dialogFound) {
    console.log("未检测到验证码弹窗");
    return false;
  }

  console.log("检测到验证码弹窗，准备自动处理...");

  // 点"接收短信验证"按钮
  const buttonSelectors = [
    page.getByText("接收短信验证", { exact: true }),
    page.getByText("接收短信验证"),
    page.locator("button").filter({ hasText: /接收短信/ }).first(),
    page.locator("button").filter({ hasText: /短信验证/ }).first(),
    page.locator('[class*="verify"] button'),
    page.locator("button").filter({ hasText: /验证码/ }).first(),
  ];

  let buttonClicked = false;
  for (const btn of buttonSelectors) {
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      console.log(`已点击接收短信验证按钮`);
      buttonClicked = true;
      break;
    }
  }

  if (!buttonClicked) {
    console.log("未找到验证码按钮，截图诊断");
    await page.screenshot({ path: "verify-no-button.png" });
    console.log("请手动处理验证码");
    return false;
  }

  // 等待弹窗变化，然后点击"获取验证码"
  await page.waitForTimeout(2000);
  const getCodeSelectors = [
    page.getByText("获取验证码", { exact: true }),
    page.getByText("获取验证码"),
    page.locator("button").filter({ hasText: /获取验证码/ }).first(),
    page.locator("button").filter({ hasText: /发送验证码/ }).first(),
  ];

  for (const btn of getCodeSelectors) {
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      console.log(`已点击获取验证码，请查收短信`);
      break;
    }
  }

  // 通知外部：我在等验证码
  fs.writeFileSync(VERIFY_CODE_WAIT_FILE, String(Date.now()), "utf8");
  console.log(`等待验证码写入文件：${VERIFY_CODE_FILE}`);

  // 轮询等待验证码文件，直到收到
  while (true) {
    await page.waitForTimeout(3000);
    if (fs.existsSync(VERIFY_CODE_FILE)) {
      const code = fs.readFileSync(VERIFY_CODE_FILE, "utf8").trim();
      if (code && code.length >= 4) {
        console.log(`收到验证码：${code}`);

        // 填入验证码输入框
        const codeInput = page.locator('input[placeholder*="验证码"], input[placeholder*="短信"]').first();
        await codeInput.fill(code);
        await page.waitForTimeout(500);

        // 点"验证"按钮（用多种方式查找，更健壮）
        const verifyButton = page.locator("button").filter({ hasText: "验证" }).first();
        if (!(await verifyButton.isVisible().catch(() => false))) {
          const textButton = page.getByText("验证", { exact: true }).first();
          if (await textButton.isVisible().catch(() => false)) {
            await textButton.click();
          } else {
            const anyVerify = page.locator("[class*='button'], [class*='btn']").filter({ hasText: "验证" }).first();
            await anyVerify.click().catch(() => {});
          }
        } else {
          await verifyButton.click();
        }
        await page.waitForTimeout(2000);

        // 清理标记文件
        try { fs.unlinkSync(VERIFY_CODE_FILE); } catch (_) {}
        try { fs.unlinkSync(VERIFY_CODE_WAIT_FILE); } catch (_) {}
        console.log("验证码已提交");
        return true;
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.commentText) {
    throw new Error("Missing comment text. Usage: npm run comments:publish -- \"评论内容\" \"作品标题\"");
  }

  const { context, page } = await launchPersistentPage({
    userDataDir: args.profileDir || DEFAULT_USER_DATA_DIR,
    headless: false
  });

  try {
    console.log(`打开评论区：${args.pageUrl || DEFAULT_COMMENT_PAGE_URL}`);
    await ensureCommentPageReady(page, args.pageUrl || DEFAULT_COMMENT_PAGE_URL, {
      navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
      uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
    });

    // 选择作品
    if (args.workTitle) {
      console.log(`选择作品：${args.workTitle}`);
      await findTargetWorkWithRetry(page, {
        workTitle: args.workTitle,
        selectWhenMatched: true,
        timeoutMs: DEFAULT_WORKS_TIMEOUT_MS,
        idleMs: DEFAULT_WORKS_IDLE_MS,
        uiTimeoutMs: DEFAULT_UI_TIMEOUT_MS
      });
      console.log(`已选中作品：${args.workTitle}`);
    } else {
      // 选择最新作品
      console.log(`选择最新作品`);
      await selectLatestWork(page);
    }

    await page.waitForTimeout(2000);

    // 填写评论
    console.log(`填写评论：${args.commentText}`);
    const commentInput = page.locator('div[contenteditable="true"]').last();
    await commentInput.waitFor({ state: "visible", timeout: 10000 });
    await commentInput.click();
    await page.waitForTimeout(300);
    await commentInput.type(args.commentText, { delay: 100 });
    await page.waitForTimeout(500);

    // 点击发送
    if (args.dryRun) {
      console.log(`[Dry-Run] 跳过实际发送`);
      await page.screenshot({ path: "comment-dryrun.png" });
      console.log(`评论内容已填写完成，截图保存为 comment-dryrun.png`);
      await promptForEnter("按 Enter 关闭浏览器");
      return;
    }

    console.log(`点击发送`);
    const sendButton = page.getByRole("button", { name: "发送" }).first();
    await sendButton.waitFor({ state: "visible", timeout: 5000 });
    await sendButton.click();
    await page.waitForTimeout(5000);  // 等待验证码弹窗出现

    // 检测验证码弹窗
    const hasVerification = await handleVerificationCode(page);

    if (hasVerification) {
      await page.waitForTimeout(3000);
    }

    console.log(`评论发布流程完成！`);
    await promptForEnter("按 Enter 关闭浏览器");

  } finally {
    await context.close();
  }
}

async function selectLatestWork(page) {
  // 打开选择作品面板
  const trigger = page.locator('button:has-text("选择作品"), [role="button"]:has-text("选择作品")').first();
  await trigger.click();
  await page.waitForTimeout(2000);

  // 选择第一个作品
  const firstWork = page.locator(".douyin-creator-interactive-sidesheet-body [class*='work-card']").first();
  await firstWork.click();
  await page.waitForTimeout(1000);
}

function parseArgs(argv) {
  const args = {
    commentText: "",
    workTitle: "",
    pageUrl: DEFAULT_COMMENT_PAGE_URL,
    profileDir: DEFAULT_USER_DATA_DIR,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--profile" && argv[i + 1]) {
      args.profileDir = argv[i + 1];
      i++;
    } else if (arg === "--work" && argv[i + 1]) {
      args.workTitle = argv[i + 1];
      i++;
    } else if (!arg.startsWith("-") && !args.commentText) {
      args.commentText = arg;
    } else if (!arg.startsWith("-") && args.commentText && !args.workTitle) {
      args.workTitle = arg;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  npm run comments:publish -- "评论内容"
  npm run comments:publish -- "评论内容" "作品标题"
  npm run comments:publish -- "评论内容" "作品标题" --dry-run
  npm run comments:publish -- "评论内容" "作品标题" --profile <path>

Options:
  --dry-run          测试模式，不实际发送
  --profile <path>   Playwright profile path
  --work <title>     作品标题
  --help             Print this help
  `);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
