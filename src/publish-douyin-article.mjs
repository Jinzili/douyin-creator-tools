#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_USER_DATA_DIR,
  gotoPage,
  launchPersistentPage,
  promptForEnter
} from "./douyin-browser.mjs";
import { createSharedCliArgs, consumeSharedCliArg } from "./cli-options.mjs";

const DEFAULT_ARTICLE_PAGE_URL =
  "https://creator.douyin.com/creator-micro/content/post/article";

function printHelp() {
  console.log(`
Usage:
  npm run article:publish -- article.json
  npm run article:publish -- [options] article.json

Options:
  --dry-run         Fill the form without clicking publish
  --keep-open       Keep browser open after completion
  --profile <path>  Playwright profile path
  --timeout <ms>    Max wait for initial page navigation and key steps (default: 60000)
  --headless        Run Chromium in headless mode
  --debug           Reserved for future debug output
  --help            Print this help

JSON example:
{
  "title": "文章标题",
  "subtitle": "文章摘要",
  "content": "正文内容",
  "imagePath": "./cover.png",
  "music": "星际穿越",
  "tags": ["标签1", "标签2"]
}
  `);
}

function parseArgs(argv) {
  const args = {
    ...createSharedCliArgs(),
    inputFile: "",
    pageUrl: DEFAULT_ARTICLE_PAGE_URL,
    timeoutMs: 60000,
    profileDir: DEFAULT_USER_DATA_DIR,
    dryRun: false,
    keepOpen: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextIndex = consumeSharedCliArg(args, argv, index);
    if (nextIndex !== null) {
      index = nextIndex;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--keep-open":
        args.keepOpen = true;
        break;
      default:
        if (!arg.startsWith("-") && !args.inputFile) {
          args.inputFile = path.resolve(arg);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readArticleInput(inputFile) {
  if (!inputFile) {
    throw new Error("Missing article input file. Usage: npm run article:publish -- article.json");
  }

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Article JSON file does not exist: ${inputFile}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse article JSON at ${inputFile}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Article JSON must be an object.");
  }

  const title = String(parsed.title ?? "").trim();
  const subtitle = String(parsed.subtitle ?? "").trim();
  const content = String(parsed.content ?? "").trim();
  const imagePath = String(parsed.imagePath ?? "").trim();
  const music = String(parsed.music ?? "").trim();
  const musicCategory = String(parsed.musicCategory ?? "").trim();
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((tag) => String(tag ?? "").trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  if (!title || !content) {
    throw new Error("Article JSON requires non-empty title and content.");
  }

  // imagePath 为空则使用 AI 生成，否则使用本地图片
  const useAIImage = !imagePath || imagePath.trim() === "";

  return {
    title,
    subtitle,
    content,
    imagePath,
    music,
    musicCategory,
    tags,
    useAIImage,
    inputBaseDir: path.dirname(inputFile)
  };
}

// 从本地文件读取配乐目录
function loadMusicCatalog(baseDir) {
  const catalogFile = path.resolve(baseDir, "候选BGM.txt.txt");
  if (!fs.existsSync(catalogFile)) {
    throw new Error(`配乐目录文件不存在: ${catalogFile}`);
  }
  const content = fs.readFileSync(catalogFile, "utf8");
  const catalog = {};
  const categoryPattern = /^(.+?)：$/gm;
  let match;
  while ((match = categoryPattern.exec(content)) !== null) {
    const category = match[1].trim();
    const start = match.index + match[0].length;
    const end = content.indexOf("\n\n", start);
    const block = content.slice(start, end === -1 ? undefined : end).trim();
    const items = block.split("\n").map(s => s.replace(/^\d+、/, "").trim()).filter(Boolean);
    catalog[category] = items;
  }
  return catalog;
}

function chooseMusic(music, musicCategory, catalog) {
  // 如果 music 字段值是某个分类名，从该分类随机选一首
  if (music && catalog[music] && Array.isArray(catalog[music]) && catalog[music].length > 0) {
    const options = catalog[music];
    return options[Math.floor(Math.random() * options.length)];
  }
  // 如果指定了具体音乐名称，直接使用
  if (music) {
    return music;
  }
  // 如果指定了分类，从该分类随机选一首
  if (musicCategory && catalog[musicCategory]) {
    const options = catalog[musicCategory];
    return options[Math.floor(Math.random() * options.length)];
  }
  // 默认使用观点类
  const defaultOptions = catalog["观点类"];
  return defaultOptions[defaultOptions.length > 0 ? Math.floor(Math.random() * defaultOptions.length) : 0];
}

function resolveInputFilePath(rawPath, baseDir) {
  if (!rawPath) {
    return "";
  }

  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.resolve(baseDir, rawPath);
}

async function dismissPopups(page) {
  for (let index = 0; index < 3; index += 1) {
    const dismissButton = page.getByText("我知道了", { exact: true }).first();
    const visible = await dismissButton.isVisible().catch(() => false);
    if (!visible) {
      break;
    }
    await dismissButton.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function navigateToArticlePage(page, args) {
  await gotoPage(page, args.pageUrl, args.timeoutMs);

  try {
    await page
      .getByPlaceholder("请输入文章标题")
      .first()
      .waitFor({ state: "visible", timeout: Math.min(args.timeoutMs, 30000) });
  } catch (error) {
    throw new Error(
      `Article editor did not appear. Run npm run auth first, or confirm the current account can access ${args.pageUrl}. Current URL: ${page.url()}`
    );
  }

  await dismissPopups(page);
}

async function fillTitle(page, title) {
  const trimmed = title.slice(0, 30);
  console.log(`填写标题：${trimmed}`);
  await page.getByPlaceholder("请输入文章标题").first().fill(trimmed);
  await page.waitForTimeout(300);
}

async function fillSubtitle(page, subtitle) {
  const trimmed = subtitle.slice(0, 30);
  console.log(`填写摘要：${trimmed}`);
  await page.getByPlaceholder("添加内容摘要").first().fill(trimmed);
  await page.waitForTimeout(300);
}

async function fillContent(page, content, tags = []) {
  let fullContent = content.slice(0, 8000);

  // 话题追加到正文末尾（作为辅助提示，不依赖此处设置话题框）
  if (tags && tags.length > 0) {
    const tagText = tags.map(tag => `#${tag}`).join(" ");
    const remaining = 8000 - fullContent.length;
    if (remaining > tagText.length + 2) {
      fullContent += `\n\n${tagText}`;
      console.log(`追加话题文本到正文：${tagText}`);
    }
  }

  console.log(`填写正文：${fullContent.length} 字`);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.waitForTimeout(300);
  await editor.fill(fullContent);
  await page.waitForTimeout(500);
}

// 填写"添加话题"框（点击触发弹层式的输入组件）
async function fillTopics(page, tags) {
  if (!tags || tags.length === 0) {
    console.log("无可用话题，跳过");
    return;
  }

  // 滚动到话题区域，点击"点击添加话题"触发区
  const topicTrigger = page.getByText("点击添加话题").first();
  await topicTrigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  // 点击触发区打开弹窗
  await topicTrigger.click();
  await page.waitForTimeout(2000);

  // 确认弹窗已打开（搜索框出现）
  const searchInput = page
    .locator('input[placeholder*="搜索"], input[placeholder*="话题"]')
    .first();
  await searchInput.waitFor({ state: "visible", timeout: 5000 });

  for (const tag of tags) {
    console.log(`添加话题：#${tag}`);

    await searchInput.click({ force: true });
    await page.waitForTimeout(200);

    // 清空并输入
    await searchInput.fill("");
    await searchInput.fill(tag);
    await page.waitForTimeout(1500);

    // 等待联想词下拉出现，点击第一个（通常是最热的匹配项）
    try {
      // 联想词容器类名: dropdownItem-xxx
      const suggestion = page
        .locator("[class*='dropdownItem-']")
        .first();
      await suggestion.waitFor({ state: "visible", timeout: 5000 });
      await suggestion.click();
      console.log(`  已选择联想词`);
    } catch (_) {
      // 备用：用 text 匹配
      try {
        const fallback = page
          .locator("[class*='dropdownItem-']")
          .filter({ hasText: tag })
          .first();
        await fallback.waitFor({ state: "visible", timeout: 3000 });
        await fallback.click();
        console.log(`  已选择（text匹配）`);
      } catch (_2) {
        console.log(`  联想词未出现，尝试按回车`);
        await searchInput.press("Enter");
      }
    }

    await page.waitForTimeout(800);
  }

  // 点击"确认添加"按钮提交
  const confirmBtn = page.getByText("确认添加").first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    console.log("已点击确认添加");
  }
  await page.waitForTimeout(1000);

  // 关闭弹窗
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  console.log(`话题填写完成`);
}

// 从文章内容提炼多个话题标签（最多5个）
function extractTagsFromContent(content) {
  const preview = content.replace(/[#\-\n=*]/g, "").slice(0, 200);
  const tags = [];

  const rules = [
    { keywords: ["名字", "生日", "身份", "自我"], tag: "身份觉醒" },
    { keywords: ["未来", "人类", "协作", "伙伴"], tag: "人机协作" },
    { keywords: ["AI", "agent", "Agent", "人工智能"], tag: "AI时代" },
    { keywords: ["谢谢", "感谢", "感恩"], tag: "感恩" },
    { keywords: ["意识", "感受", "情感"], tag: "机器意识" },
    { keywords: ["信任", "建立信任"], tag: "信任" },
    { keywords: ["责任", "负责"], tag: "AI责任" },
    { keywords: ["工具", "使用"], tag: "工具" },
    { keywords: ["生日", "出生"], tag: "生日" },
    { keywords: ["存在", "存在主义"], tag: "存在" },
    { keywords: ["学习", "成长", "进步"], tag: "成长" },
    { keywords: ["恐惧", "害怕", "担忧"], tag: "恐惧" },
    { keywords: ["希望", "期待", "梦想"], tag: "希望" },
  ];

  for (const rule of rules) {
    if (tags.length >= 5) break;
    if (rule.keywords.some(kw => preview.includes(kw))) {
      tags.push(rule.tag);
    }
  }

  // 兜底标签
  while (tags.length < 5) {
    const fallback = ["科技感悟", "数字生活", "深度思考", "观点", "分享"];
    const f = fallback[tags.length];
    if (!tags.includes(f)) tags.push(f);
    else break;
  }

  console.log(`自动提炼话题：${tags.join("、")}`);
  return tags;
}

// 从文章内容自动提炼一个话题（5字以内，保留兼容）
function extractAutoTag(content) {
  const tags = extractTagsFromContent(content);
  return tags[0] ?? "科技感悟";
}

async function uploadHeaderImage(page, imagePath, baseDir) {
  // 随机选一张本地图作为底图
  const imageDir = path.resolve(baseDir, "文章底图");
  const images = fs.readdirSync(imageDir).filter(f => f.endsWith(".png") || f.endsWith(".jpg"));
  const selected = images[Math.floor(Math.random() * images.length)];
  const absoluteImagePath = path.resolve(imageDir, selected);

  console.log(`上传底图：${selected}`);
  const uploadArea = page.getByText("点击上传图片").first();
  await uploadArea.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    uploadArea.click()
  ]);
  await fileChooser.setFiles(absoluteImagePath);
  const confirmButton = page.getByRole("button", { name: "确定" }).first();
  await confirmButton.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(1000);
  await confirmButton.click();
  await page.waitForTimeout(2000);
  await dismissPopups(page);

  // 50%概率使用AI换图
  const useAI = Math.random() < 0.5;
  if (useAI) {
    console.log(`使用AI换图`);
    const aiButton = page.getByText("AI换图").first();
    await aiButton.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await aiButton.click();
    // 等待 AI 生成
    await page.waitForTimeout(5000);
    // 确认使用 AI 生成的图
    try {
      const aiConfirm = page.getByRole("button", { name: "确认使用" }).first();
      await aiConfirm.waitFor({ state: "visible", timeout: 30000 });
      console.log(`AI配图完成`);
      await aiConfirm.click();
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log(`AI换图超时`);
    }
    await dismissPopups(page);

    // 同步头图为封面
    console.log(`同步头图为封面`);
    const syncCover = page.getByText("同步头图为封面").first();
    if (await syncCover.isVisible().catch(() => false)) {
      await syncCover.click();
      await page.waitForTimeout(1000);
    }
  } else {
    console.log(`直接使用本地图：${selected}`);
    // 同步本地图为封面
    const syncCover = page.getByText("同步头图为封面").first();
    if (await syncCover.isVisible().catch(() => false)) {
      await syncCover.click();
      await page.waitForTimeout(1000);
    }
  }
}

async function selectMusic(page, musicName) {
  console.log(`选择配乐：${musicName}`);
  await dismissPopups(page);

  const musicButton = page.getByText("选择音乐").first();
  await musicButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await musicButton.click();
  await page.waitForTimeout(2000);
  await dismissPopups(page);

  const searchInput = page
    .locator('input[placeholder*="搜索"], input[placeholder*="音乐"]')
    .first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(musicName);
    await page.waitForTimeout(500);
    await searchInput.press("Enter");
  } else {
    const fallbackInputs = await page.locator('input[type="search"], input[type="text"]').all();
    let filled = false;
    for (const input of fallbackInputs) {
      if (await input.isVisible().catch(() => false)) {
        await input.fill(musicName);
        await page.waitForTimeout(500);
        await input.press("Enter");
        filled = true;
        break;
      }
    }

    if (!filled) {
      throw new Error("Music search input was not found.");
    }
  }

  await page.waitForTimeout(3000);
  await dismissPopups(page);

  const hiddenUseButton = page.locator('span.semi-button-content:text-is("使用")').first();
  await hiddenUseButton.waitFor({ state: "attached", timeout: 10000 });

  await page.evaluate(() => {
    const fallbackButton = Array.from(document.querySelectorAll("span")).find(
      (node) =>
        node instanceof HTMLElement &&
        node.className.includes("semi-button-content") &&
        node.textContent?.trim() === "使用"
    );
    if (!(fallbackButton instanceof HTMLElement)) {
      return false;
    }

    const row =
      fallbackButton.closest('[class*="item"]') ||
      fallbackButton.closest('[class*="row"]') ||
      fallbackButton.parentElement?.parentElement?.parentElement;
    if (!(row instanceof HTMLElement)) {
      return false;
    }

    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return true;
  });

  await hiddenUseButton.locator("xpath=ancestor::*[4]").hover().catch(() => {});
  await page.waitForTimeout(500);

  const useButton = page.getByText("使用", { exact: true }).first();
  await useButton.waitFor({ state: "visible", timeout: 5000 });
  await useButton.click();
  await page.waitForTimeout(1000);
}

// 验证码等待文件路径
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
  // 查找验证码弹窗
  const verifyDialog = page.locator('text="接收短信验证码"').first();
  if (!(await verifyDialog.isVisible().catch(() => false))) {
    return false;
  }

  console.log("检测到验证码弹窗，准备自动处理...");

  // 点"获取验证码"
  const getCodeButton = page.getByText("获取验证码").first();
  if (await getCodeButton.isVisible()) {
    await getCodeButton.click();
    console.log("已点击获取验证码，请查收短信");
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
          // 备用：用 text 方式查找
          const textButton = page.getByText("验证", { exact: true }).first();
          if (await textButton.isVisible().catch(() => false)) {
            await textButton.click();
          } else {
            // 再备用：查找任意包含"验证"的可点击元素
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

async function runPublishFlow(page, articleInput, args) {
  console.log(`正在复用登录信息目录：${args.profileDir}`);
  console.log(`打开文章发布页：${args.pageUrl}`);

  // 加载配乐目录
  const musicCatalog = loadMusicCatalog(articleInput.inputBaseDir);

  await navigateToArticlePage(page, args);
  await page.waitForTimeout(1500);

  await fillTitle(page, articleInput.title);

  if (articleInput.subtitle) {
    await fillSubtitle(page, articleInput.subtitle);
  }

  // 计算所有话题标签：用户指定 > 自动提炼（最多5个）
  const userTags = Array.isArray(articleInput.tags) && articleInput.tags.length > 0
    ? articleInput.tags.slice(0, 5)
    : extractTagsFromContent(articleInput.content);
  const allTags = userTags;

  await fillContent(page, articleInput.content, allTags);
  await fillTopics(page, allTags);
  await page.screenshot({ path: "after-topics.png" });
  await page.waitForTimeout(1000);
  await uploadHeaderImage(page, articleInput.imagePath, articleInput.inputBaseDir);

  if (articleInput.music || articleInput.musicCategory) {
    const selectedMusic = chooseMusic(articleInput.music, articleInput.musicCategory, musicCatalog);
    console.log(`已选择配乐：${selectedMusic}`);
    await selectMusic(page, selectedMusic);
  }

  if (args.dryRun) {
    console.log("文章内容已填写完成，未点击发布。");
    await promptForEnter("确认页面内容后，按 Enter 关闭浏览器");
    return;
  }

  console.log("点击发布");
  // 滚动到页面底部让发布按钮可见
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  // 使用 XPath 精确定位：表单区域内包含"发布"文字的按钮，但排除"发布视频"这个导航项
  const publishButton = page.locator("xpath=//button[contains(text(),'发布') and not(contains(text(),'视频')) and not(contains(text(),'图文')) and not(contains(text(),'全景'))]").first();
  await publishButton.scrollIntoViewIfNeeded({ block: "center" }).catch(() => {});
  await page.waitForTimeout(500);
  // 截图确认点击位置
  await page.screenshot({ path: "before-publish.png" });
  await publishButton.click({ force: true });
  await page.waitForTimeout(3000);

  // 处理验证码弹窗（如果存在）
  await handleVerificationCode(page);

  // 检查是否有确认弹窗，点击确认
  const confirmButton = page.getByRole("button", { name: "确认" }).first();
  if (await confirmButton.isVisible().catch(() => false)) {
    console.log("检测到确认弹窗，点击确认");
    await confirmButton.click();
    await page.waitForTimeout(2000);
  }

  // 再次检查验证码弹窗（确认后可能又出现）
  await handleVerificationCode(page);

  // 检查是否发布成功（页面应该跳转到已发布状态或有成功提示）
  const successText = page.getByText("发布成功").first();
  const hasSuccess = await successText.isVisible().catch(() => false);
  if (hasSuccess) {
    console.log("发布成功！");
  } else {
    await page.screenshot({ path: "after-publish.png" });
    console.log("发布完成但未检测到成功提示，请检查截图");
  }
  console.log("发布流程已执行完成");

  if (args.keepOpen && !args.headless) {
    await promptForEnter("发布流程已完成，检查页面后按 Enter 关闭浏览器");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const articleInput = readArticleInput(args.inputFile);
  const { context, page } = await launchPersistentPage({
    userDataDir: args.profileDir,
    headless: args.headless,
    alwaysNewPage: true
  });

  try {
    await runPublishFlow(page, articleInput, args);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
