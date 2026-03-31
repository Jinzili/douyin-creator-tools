# 抖音创作者中心工具

基于 Playwright，复用同一份本地登录态处理抖音创作者中心里的几类操作：

- `npm run auth`
- `npm run view`
- `npm run works`
- `npm run comments:export`
- `npm run comments:reply`
- `npm run comments:publish`
- `npm run article:publish`

## 安装

```bash
npm install
npx playwright install chromium
```

## 公共参数

- `--profile <path>`：指定 Playwright profile 目录
- `--timeout <ms>`：整次运行或关键步骤的最大等待时间
- `--headless`：无头模式，在后台运行浏览器但不显示窗口
- `--debug`：打印调试日志

## 登录

首次使用先执行：

```bash
npm run auth
```

默认会把登录态保存在 `.playwright/douyin-profile`。后续所有命令都会复用这份鉴权。

## 手动打开页面

```bash
npm run view
npm run view -- https://creator.douyin.com/
```

## 获取作品列表

```bash
npm run works
```

默认输出到 `comments-output/list-works.json` 可通过 `--out <path>` 指定路径

输出示例：

```json
{
  "count": 2,
  "works": [
    {
      "title": "作品标题短键",
      "publishText": "发布于 2026-03-18"
    }
  ]
}
```

`title` 会先去掉空白字符，再截取前 `15` 个字符。后续导出评论、回复评论都用这个短标题匹配作品。

## 导出未回复评论

```bash
npm run comments:export -- "作品标题短键"
```

默认输出到 `comments-output/unreplied-comments.json`, 可通过 `--out <path>` 指定路径

输出示例：

```json
{
  "selectedWork": {
    "title": "作品标题短键",
    "publishText": "发布于 2026-03-18"
  },
  "count": 1,
  "comments": [
    {
      "username": "用户A",
      "commentText": "评论内容",
      "replyMessage": ""
    }
  ]
}
```

脚本会强制切到页面原生"未回复"过滤，然后向下滚动，直到出现：

- `没有更多评论`
- `暂无符合条件的评论`

## 回复评论

先编辑 `comments-output/unreplied-comments.json`，为需要回复的评论填上 `replyMessage`，然后执行：

```bash
npm run comments:reply -- comments-output/unreplied-comments.json
```

默认输出到 `comments-output/reply-comments-result.json`。

专属参数：

- `--limit <n>`
- `--dry-run`
- `--keep-open`
- `--out <path>`

说明：

- `--dry-run`：只输入回复内容，不点发送
- `--keep-open`：流程结束后保留浏览器，按 Enter 再关闭
- **匹配规则**：默认按 `username` 匹配；只有同一用户名在当前待处理或当前可见评论里出现多条时，才额外校验 `commentText`，避免同一人多条评论时匹配错乱
- 回复发送后不等待列表刷新确认，视为成功，避免因抖音评论列表更新时序问题导致的误判

## 发布评论

给指定作品（或最新作品）发送一条评论：

```bash
npm run comments:publish -- "评论内容"
npm run comments:publish -- "评论内容" "作品标题"
npm run comments:publish -- "评论内容" "作品标题" --dry-run
```

**位置参数：**

- 第一个：评论内容（必填）
- 第二个：作品标题（可选，不填则选择最新作品）

**选项：**

- `--dry-run`：只填写评论内容，不点发送
- `--work <title>`：指定作品标题（也可直接作为第二个位置参数）
- `--profile <path>`：Playwright profile 路径
- `--help`：打印帮助

**验证码处理：**

与文章发布相同，检测到短信验证码弹窗会自动处理，等待写入 `verify-code.txt` 后提交。

**调试截图：**

- `verify-check.png`：验证码检测截图
- `verify-no-button.png`：未找到验证码按钮时的诊断截图
- `comment-dryrun.png`：dry-run 模式下的截图

## 发布文章

准备一个 JSON 文件，例如 `article.json`：

```json
{
  "title": "文章标题",
  "subtitle": "文章摘要",
  "content": "正文内容",
  "imagePath": "./cover.png",
  "music": "观点类",
  "musicCategory": "",
  "tags": ["标签1", "标签2"]
}
```

执行：

```bash
npm run article:publish -- article.json
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `title` | 是 | 文章标题 |
| `subtitle` | 否 | 文章摘要 |
| `content` | 是 | 正文内容 |
| `imagePath` | 否 | 配图路径，传空或不传则使用AI生成配图；传本地路径则使用该图片 |
| `music` | 否 | 配乐，可以是具体音乐名（如"星际穿越"），也可以是分类名（如"观点类"），传分类名则从该分类随机选一首 |
| `musicCategory` | 否 | 配乐分类，与 music 二选一，优先使用 music 字段 |
| `tags` | 否 | 话题标签，最多5个，不传则自动从正文中提炼 |

### 配乐逻辑

配乐文件为 `候选BGM.txt.txt`，按以下优先级选择：

1. `music` 字段值匹配到某个分类名 → 从该分类随机选一首
2. `music` 字段是具体音乐名 → 直接使用
3. `musicCategory` 字段指定了分类 → 从该分类随机选一首
4. 默认使用"观点类"随机选一首

### 配图逻辑

- `imagePath` 为空 → 自动生成AI配图
- `imagePath` 有值 → 使用本地图片，并**有50%概率触发AI换图**
- 换图后会点击"同步头图为封面"

### 话题标签

- 用户指定 `tags` → 直接使用
- 未指定 → 自动从正文内容提炼最多5个话题标签
- 话题会同时填入正文末尾和发布页的话题输入框

### 验证码处理

发布流程会自动检测短信验证码弹窗：

- 检测到弹窗 → 自动点击"获取验证码"
- 等待用户在 `verify-code.txt` 文件中写入验证码（6位数字）
- 自动填入验证码并提交

### 调试截图

发布流程会在关键节点截图，方便排查问题：

- `after-topics.png`：话题填写完成后
- `before-publish.png`：点击发布按钮前
- `after-publish.png`：发布完成后

### 专属参数

- `--dry-run`：只填写内容，不点发布
- `--keep-open`：发布完成后保留浏览器窗口

示例：

```bash
npm run article:publish -- --dry-run article.json
npm run article:publish -- --keep-open article.json
```

## 说明

- 不绕过登录、验证码或平台限制。
- 所有自动化都复用 `.playwright/douyin-profile`。
- 首次登录不要用 `--headless`。
- 如果页面结构变化，优先用 `npm run view` 先人工确认页面状态。
- 验证码等待文件：`verify-code.txt`（需手动写入验证码）和 `verify-code-waiting.txt`（自动生成，标记等待状态）
