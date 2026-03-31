import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use launchPersistentContext (same as douyin-browser.mjs)
const context = await chromium.launchPersistentContext(
  path.resolve(__dirname, '.playwright/douyin-profile'),
  { headless: false, viewport: { width: 1280, height: 900 } }
);
const page = context.pages()[0] ?? (await context.newPage());
await page.bringToFront().catch(() => {});

await page.goto('https://creator.douyin.com/creator-micro/content/post/article');
await page.waitForTimeout(8000);

await page.screenshot({ path: 'debug3-article-page.png' });

// 点击话题触发区
const trigger = page.getByText('点击添加话题').first();
const triggerVisible = await trigger.isVisible().catch(() => false);
console.log('话题触发区 visible:', triggerVisible);

if (triggerVisible) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'debug3-dialog-open.png' });

  // 查找所有 input
  const inputs = await page.evaluate(() => {
    const ins = document.querySelectorAll('input');
    return Array.from(ins).map(i => ({
      placeholder: i.placeholder,
      type: i.type,
      visible: i.offsetParent !== null,
      value: i.value
    }));
  });
  console.log('所有input:', JSON.stringify(inputs, null, 2));

  // 找输入框并输入
  const input = page.locator('input[placeholder*="搜索"], input[placeholder="#"]').first();
  const inputVisible = await input.isVisible().catch(() => false);
  console.log('搜索框visible:', inputVisible);

  if (inputVisible) {
    await input.click();
    await input.fill('AI');
    await page.waitForTimeout(3000);

    await page.screenshot({ path: 'debug3-after-input.png' });

    // 全面搜索DOM中含"AI"的可见元素
    const aiNodes = await page.evaluate(() => {
      const results = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        if (node.offsetParent === null) continue;
        const text = node.innerText || '';
        if (text.includes('AI') && text.trim().length < 80) {
          results.push({
            tag: node.tagName,
            class: node.className,
            text: text.trim().slice(0, 80)
          });
        }
      }
      return results;
    });
    console.log('含AI的DOM节点:', JSON.stringify(aiNodes, null, 2));

    // 尝试打印所有弹层
    const dialogInfo = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[class*="dialog"], [class*="modal"], [class*="popup"], [class*="layer"], [role="dialog"], [role="listbox"]');
      return Array.from(dialogs).map(d => ({
        tag: d.tagName,
        role: d.getAttribute('role'),
        class: d.className,
        visible: d.offsetParent !== null,
        childCount: d.children.length,
        innerHTML: d.innerHTML.slice(0, 500)
      }));
    });
    console.log('弹层元素:', JSON.stringify(dialogInfo, null, 2));
  }
}

await context.close();
