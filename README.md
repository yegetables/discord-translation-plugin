# Discord 翻译 · open source 浏览器扩展

对标 Chrome Web Store 上两个闭源收费扩展（[*Automatic Discord Translator*](https://chromewebstore.google.com/detail/automatic-discord-transla/bfebcppdnkhhknpcmnpdkgcmkimohlkc) 与 [*Discord™ Translator*](https://chromewebstore.google.com/detail/discord-translator-auto-t/nenhidhfpjbccpbikiceenfnchkhljmd)）的开源自实现版。**仅作用于 discord.com 网页版**，非官方、与 Discord Inc. 无关。

- Manifest V3，TypeScript 免编译（原生 JS + ESM）
- **可插拔翻译后端**：Google 免费接口（默认，免 key）/ DeepL API / 本地或自定义大模型（OpenAI 兼容：LM Studio / Ollama）
- 自动翻译接收到的消息 + "翻译草稿"按钮（发消息前把输入内容翻译成目标语言，Alt+T 快捷触发）
- 100+ 语言目标任选，自动检测源语言；双语对照 / 仅译文两种显示
- 译文跟随 Discord 深浅色主题

## 安装（开发者模式）

1. 下载/克隆本仓库
2. Chrome 打开 `chrome://extensions/`
3. 右上角开启 **开发者模式**
4. 点 **加载已解压的扩展程序**，选择本项目文件夹
5. 打开 https://discord.com 刷新页面；点击工具栏扩展图标进行设置

> 图标可用 `pwsh scripts/make-icons.ps1` 重新生成。

## 使用

| 能力 | 操作 |
|---|---|
| 翻译收到的消息 | 开启后自动在每条消息下方显示译文（「译文 ·」前缀），可关、可切换仅译文 |
| 翻译自己要发的消息 | 输入框右上角 🌐 按钮（或按 `Alt+T`）→ 输入内容被替换为译文，确认后发送 |
| 切换目标语言 / 显示方式 / 后端 | 点击扩展图标打开设置面板，修改自动保存 |
| 测试连通性 | 设置面板底部「测试翻译」 |

## 目录结构

```
manifest.json            # MV3 清单
background.js            # Service Worker：设置缓存 + 翻译请求路由（ESM）
content/content.js       # Discord 页面注入：消息监听/提取/渲染、草稿翻译按钮
content/content.css      # 译文样式（跟随 Discord 主题变量）
popup/popup.html/css/js  # 设置面板
lib/lang.js              # 语言表（100+）
lib/translator.js        # 后端路由
lib/providers/           # 各翻译后端实现
scripts/make-icons.ps1   # 图标生成
```

## 翻译后端配置

| 后端 | 需要 | 说明 |
|---|---|---|
| `google-web`（默认） | 无 | free 的 translate.googleapis.com Web 接口，开箱即用；**原文会发送给 Google** |
| `deepl` | DeepL API Key | 官网申请（免费 50 万字/月），支持免费/专业版端点切换，质量高 |
| `openai-compatible` | 本地模型或任意兼容服务 | 默认 `http://localhost:1234/v1`（LM Studio）或 `:11434/v1`（Ollama），消息不出本机；远程自定义服务需在 `manifest.json` 的 `host_permissions` 中加上对应域名 |

### 新增一个后端（扩展指南）

1. 在 `lib/providers/` 新建 `xxx.js`，导出 `META`（id/label）和 `translate({ text, targetLang, config, langName })`
2. 在 `lib/translator.js` 的 `PROVIDERS` 注册
3. （可选）在 `manifest.json` 的 `host_permissions` 添加该后端域名
4.（可选）在 `popup/*` 添加配置项

## 说明与限制（v0.1）

- **非官方且脆弱**：Discord 是重前端 SPA，DOM 结构变化可能导致需更新选择器；本插件的选择器基于 2026 年中的 web 版 DOM
- 收到消息的**编辑后内容暂不自动重译**（刷新/重进频道会重试）
- 消息长度 >1400 字符时按行分批翻译后合并
- 隐私：Google 后端会发送原文；DeepL 发送给 DeepL；本地后端完全不出本机。仅存储你的设置（chrome.storage.sync），不收集任何数据
- 本项目仅自用/学习用途，不用于规避任何平台的 ToS

## License

MIT（见 [LICENSE](LICENSE)）
