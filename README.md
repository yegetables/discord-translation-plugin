# Discord 翻译 · open source 浏览器扩展

对标 Chrome Web Store 上两个闭源收费扩展（*Automatic Discord Translator* 与 *Discord™ Translator*）的**开源自实现**。仅作用于 **discord.com 网页版**，非官方、与 Discord Inc. 无关。

- Manifest V3（Chrome 111+），原生 JS + ESM，免构建
- **可插拔翻译后端**：Google 免费接口（默认，免 key）/ DeepL API / 本地或自定义大模型（OpenAI 兼容：LM Studio / Ollama）
- 接收消息自动翻译 + 发送框草稿翻译（独立目标语言，Slate 原生 API 写入，编辑器零损伤）
- 双语对照 / 仅译文两种显示；仅译文模式下**引用条同步替换为被引消息译文**（无缓存时自动按需翻译）
- 代码块不参与翻译：小模型/在线接口走占位符回插，本地 LLM 走原样 markdown（模型按提示词自行保留）
- **提示词方案管理**：多方案在线编辑 / 新建 / 重命名 / 删除 / 随时切换
- 翻译并发上限可调（留空 = 按后端自动：在线 4 / 本地 LLM 16）
- 译文缓存持久化（storage.local），刷新页面/跳转旧消息秒出译文
- 批量加载检测：跳转旧消息时暂停渲染避免与虚拟列表竞争，稳定后批量出译文

## 安装（开发者模式）

1. 下载/克隆本仓库
2. Chrome 打开 `chrome://extensions/`，右上角开启**开发者模式**
3. 点**加载已解压的扩展程序**，选择本项目文件夹
4. 打开 https://discord.com 刷新页面；点工具栏扩展图标进行设置

## 使用

| 能力 | 操作 |
|---|---|
| 翻译收到的消息 | 自动在消息下方显示「译文 ·」，双语对照 / 仅译文可切换 |
| 查看原文 | 双语模式直接看；仅译文模式悬停译文（title 提示） |
| 翻译要发的消息 | 输入框右上角地球图标（或 `Alt+T`）→ 草稿被替换为译文，可继续编辑后发送 |
| 引用条翻译 | 仅译文模式下自动替换为被引消息译文；无缓存时自动按需翻译 |
| 切换设置 | 扩展图标打开面板，修改自动保存 |

## 设置面板

| 分组 | 项 |
|---|---|
| 常规 | 目标语言（100+）/ 发送框草稿目标语言（独立设置）/ 显示方式 / 接收翻译开关 / 草稿按钮开关 / 翻译并发上限（留空 = 按后端自动：在线 4、本地 LLM 16） |
| 后端 | Google 免费接口（默认）/ DeepL（key + 免费专业版）/ 本地大模型（Base URL + 模型名 + LM Studio/Ollama 快捷填充） |
| 提示词 | 多方案管理（默认「沉浸式翻译」模板），`{{to}}` 运行时替换为目标语言；编辑自动保存，切换立即生效 |

## 架构

```
manifest.json
├─ background.js            Service Worker（ESM）：设置缓存 + 翻译请求路由
├─ content/page-slate.js    【MAIN world】Slate editor 定位与草稿替换
│                            （React fiber 只在页面世界可见）
├─ content/content.js       【ISOLATED】消息监听/提取/渲染、引用条翻译、
│                            草稿按钮、缓存持久化；与 page-slate 通过
│                            DOM CustomEvent（DT_REPLACE_DRAFT/RESULT）通信
├─ lib/translator.js        后端路由
├─ lib/providers/           google-web / deepl / openai-compatible
├─ lib/lang.js              语言表（100+）
└─ popup/                   设置面板
```

关键设计：

- **草稿替换**：从 React fiber 定位 Discord 的 Slate editor 实例，走
  `editor.apply(set_selection) → deleteFragment() → insertText()` 官方操作流，
  状态天然同步（直接赋值 selection 或改 DOM 会冻结编辑器/污染草稿存储，勿改）
- **批量加载检测**：2 秒窗口内新增消息行 > 15 判定为跳转/滚动加载，
  暂停渲染避免与虚拟列表测量竞争；翻译照常进行并入缓存，窗口结束后统一渲染
- **代码块**：占位符 `[[DTn]]` 参译（在线后端）/ 原样 markdown（LLM 后端），
  两种方式都保证代码内容不进翻译引擎、不丢失

## 翻译后端

| 后端 | 需要 | 说明 |
|---|---|---|
| `google-web`（默认） | 无 | translate.googleapis.com 免费接口，开箱即用；**原文会发送给 Google** |
| `deepl` | DeepL API Key | 免费版 50 万字/月，支持免费/专业端点切换 |
| `openai-compatible` | 本地模型或兼容服务 | 默认 `http://localhost:1234/v1`（LM Studio）/ `:11434/v1`（Ollama），消息不出本机；远程服务需在 `manifest.json` 的 `host_permissions` 加域名 |

### 新增一个后端

1. `lib/providers/` 新建 `xxx.js`，导出 `META`（id/label/desc）与 `translate({ text, targetLang, config, langName })`
2. `lib/translator.js` 的 `PROVIDERS` 注册
3. 按需在 `manifest.json` 的 `host_permissions` 加域名、`popup/` 加配置项

## 开发

```powershell
npm run check    # 全部 JS 语法检查
npm run icons    # 重新生成图标
npm run package  # 打包 dist/discord-translation-plugin-<版本>.zip
node scripts/test-llm-preserve.mjs http://localhost:11434/v1 <模型名> 简体中文 imt
                 # 测试本地 LLM 能否原样保留代码块（default/strict/imt 三种提示词）
```

## 已知边界

- Discord 是重前端 SPA，改版可能需要更新选择器；失效时面板测试会给出精确错误
- 消息编辑后内容变化会自动重译（内容 hash 对比）；引用条预览不跟随被引消息的后续编辑
- 引用条按需翻译失败不自动重试（切换一次显示模式可重置）
- Google 免费接口无 SLA，重度使用建议本地 LLM 或 DeepL

## 隐私

- 仅存储你的设置与译文缓存（chrome.storage），不收集任何数据
- 翻译内容去向取决于所选后端：Google / DeepL 为云端处理，本地大模型完全不出本机

## License

MIT（见 [LICENSE](LICENSE)）
