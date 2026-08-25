// Discord 翻译 · content script（注入 discord.com）
// 职责：监听消息流 → 提取文本 → 请求 background 翻译 → 注入译文；输入框草稿翻译按钮。
(function () {
  "use strict";

  if (window.__DT_INJECTED__) return;
  window.__DT_INJECTED__ = true;

  const MESSAGE_SELECTOR =
    '[data-list-item-id^="chat-messages-"], [id^="chat-messages-"]';
  const CONTENT_SELECTOR = '[id^="message-content-"]';
  const REPLY_CONTAINER = '[class*="repliedMessage"]';

  let settings = null;
  const CACHE = new Map(); // hash(text) -> 译文
  const REPLY_CACHE = new Map(); // 消息id -> 译文（供引用条替换，仅译文模式）
  const INFLIGHT = new Set(); // hash(text) 正在翻译
  const RETRIED = new Set(); // 已重试过的 hash（每条最多自动重试一次）
  let scanTimer = null;
  let outboxInjected = false;

  /* ---------- 工具 ---------- */

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return "h" + (h >>> 0).toString(36);
  }

  async function getSettings() {
    try {
      const r = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      if (r && r.ok) settings = r.settings;
    } catch (e) {
      /* 扩展上下文失效等 */
    }
    return settings;
  }

  function toast(msg, isErr) {
    let el = document.querySelector(".dt-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "dt-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("dt-toast-err", !!isErr);
    el.classList.toggle("dt-toast-ok", !isErr);
    el.classList.remove("dt-toast-fadeout");
    clearTimeout(el.__t);
    setTimeout(() => el.classList.add("dt-toast-fadeout"), 2200);
    setTimeout(() => el.remove(), 2600);
  }

  /* ---------- 消息提取 ---------- */

  // 关键：回复引用条里的预览元素 id 也是 "message-content-<被引消息id>"
  // （class 含 repliedTextContent），且在 DOM 中排在正文之前。
  // 必须排除所有位于 repliedMessage 容器内的匹配，否则译文会插进引用条。
  function findMainContent(root) {
    const list = root.querySelectorAll(CONTENT_SELECTOR);
    for (const el of list) {
      if (!el.closest(REPLY_CONTAINER)) return el;
    }
    return null;
  }

  // 提取正文文本 + 代码块。代码块不参与翻译（翻译引擎会破坏代码），
  // 以占位符 [[DTn]] 参与翻译保持位置，渲染时替换回原代码块 DOM 克隆。
  function extractContent(contentEl) {
    const clone = contentEl.cloneNode(true);
    clone
      .querySelectorAll('[class*="repliedMessage"]')
      .forEach((n) => n.remove());
    // 代码块 → 占位符（pre 内嵌套的 code 跳过，避免重复占位）
    const codes = [];
    clone.querySelectorAll("pre, code").forEach((n) => {
      if (n.tagName === "CODE" && n.closest("pre")) return;
      const ph = document.createElement("span");
      ph.textContent = "[[DT" + codes.length + "]]";
      n.replaceWith(ph);
      codes.push(n);
    });
    // 不翻译：按钮、emoji、图片、提及等
    clone
      .querySelectorAll(
        '[class*="button"], [class*="emoji"], img, svg, a[class*="mention"], [class*="actionRow"]'
      )
      .forEach((n) => n.remove());
    let text = (clone.textContent || "").replace(/\u00a0/g, " ").trim();
    // 压缩空白但不破坏换行；丢弃空行
    text = text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    return { text, codes };
  }

  // DOM → 原样 markdown 文本（代码块 → ``` 围栏，inline code → `...`）。
  // 供 openai-compatible 本地模型后端"原样发送"使用（LLM 按提示词保代码）。
  function extractMarkdown(contentEl) {
    const clone = contentEl.cloneNode(true);
    clone.querySelectorAll('[class*="repliedMessage"]').forEach((n) => n.remove());
    clone.querySelectorAll("pre").forEach((pre) => {
      const fence = document.createElement("span");
      fence.textContent = "\n```\n" + (pre.textContent || "") + "\n```\n";
      pre.replaceWith(fence);
    });
    clone.querySelectorAll("code").forEach((c) => {
      if (c.closest("pre")) return;
      const fence = document.createElement("span");
      fence.textContent = "`" + (c.textContent || "") + "`";
      c.replaceWith(fence);
    });
    clone
      .querySelectorAll('[class*="button"], [class*="emoji"], img, svg, [class*="actionRow"]')
      .forEach((n) => n.remove());
    // 克隆节点未入文档（innerText 不可用），递归重建文本并在块级元素间补换行
    const domToText = (node) => {
      let out = "";
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) out += n.textContent;
        else if (n.nodeType === 1) {
          const tag = n.tagName;
          if (tag === "BR") out += "\n";
          else if (tag === "DIV" || tag === "P") out += "\n" + domToText(n) + "\n";
          else out += domToText(n);
        }
      });
      return out;
    };
    let text = domToText(clone).replace(/\u00a0/g, " ");
    return text
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function shouldTranslate(text) {
    if (!text) return false;
    const minLen = (settings && settings.minLen) || 2;
    if (text.length < minLen) return false;
    if (!/[\p{L}\p{N}]/u.test(text)) return false;
    if (/^\s*(?:https?:\/\/\S+|discord(?:\.gg|app)?\.com\S*)\s*$/i.test(text))
      return false;
    return true;
  }

  /* ---------- 渲染 ---------- */

  function applyDisplayMode(row, hasTranslation) {
    if (!settings) return;
    // 仅译文模式只对"已有成功译文"的行隐藏原文；
    // 翻译中/失败/未翻译的行必须保持原文可见
    row.classList.toggle(
      "dt-replace",
      settings.showOriginal === false && !!hasTranslation
    );
  }

  // 插入锚点：优先放在 messageContent 包装层之后（避免进入 flex 容器被挤压变形）
  function insertInset(row, contentEl) {
    // 清掉本行所有旧译文框（可能错位或内容过期）
    row.querySelectorAll(".dt-tl").forEach((n) => n.remove());
    const anchor = contentEl.closest('[class*="messageContent"]') || contentEl;
    const inset = document.createElement("div");
    inset.className = "dt-tl";
    if (anchor.nextSibling) anchor.parentNode.insertBefore(inset, anchor.nextSibling);
    else anchor.parentNode.appendChild(inset);
    return inset;
  }

  // 译文写入 inset：按占位符位置插回原代码块 DOM 克隆（保留高亮/格式）；
  // 占位符被翻译引擎改坏时，未放置的代码块追加到译文末尾
  function renderTranslatedInto(inset, translated, codes) {
    inset.textContent = "";
    const re = /\[\[\s*DT(\d+)\s*\]\]/gi;
    const placed = new Set();
    let lastIdx = 0;
    let m;
    while ((m = re.exec(translated)) !== null) {
      if (m.index > lastIdx) {
        inset.appendChild(
          document.createTextNode(translated.slice(lastIdx, m.index))
        );
      }
      const idx = parseInt(m[1], 10);
      if (codes[idx]) {
        inset.appendChild(codes[idx].cloneNode(true));
        placed.add(idx);
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < translated.length) {
      inset.appendChild(document.createTextNode(translated.slice(lastIdx)));
    }
    codes.forEach((c, i) => {
      if (!placed.has(i)) inset.appendChild(c.cloneNode(true));
    });
  }

  // LLM 原样模式：返回的译文含 ``` 代码块，分段渲染（文字 + 自绘代码块）
  function renderMarkdownInto(inset, translated) {
    inset.textContent = "";
    const parts = translated.split(/```[a-zA-Z0-9_-]*\n?/);
    parts.forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = part.replace(/\n$/, "");
        pre.appendChild(code);
        inset.appendChild(pre);
      } else {
        inset.appendChild(document.createTextNode(part));
      }
    });
  }

  function renderTranslation(row, contentEl, translated, rowHash, rawText, codes) {
    if (!translated || !translated.trim().length) {
      const inset = insertInset(row, contentEl);
      inset.classList.add("dt-tl-error");
      inset.textContent = "⚠ 翻译结果为空";
      applyDisplayMode(row, false);
      return;
    }
    const inset = insertInset(row, contentEl);
    inset.dataset.dt = hashStr(translated);
    inset.dataset.tag = "译文";
    if (codes) {
      // 占位符模式（Google/DeepL）：按占位符回插原代码 DOM 克隆
      renderTranslatedInto(inset, translated, codes);
    } else if (translated.includes("```")) {
      // LLM 原样模式：解析 ``` 围栏渲染代码块
      renderMarkdownInto(inset, translated);
    } else {
      inset.textContent = translated;
    }
    if (rawText) {
      inset.title =
        "原文：" + rawText.replace(/\[\[\s*DT\d+\s*\]\]/gi, "〔代码〕");
    }
    if (rowHash) row.dataset.dtHash = rowHash;
    // 记录 消息id -> 译文：引用条预览与正文共用同一消息 id，
    // 仅译文模式下引用条可据此替换为译文
    const mid = (contentEl.id || "").replace("message-content-", "");
    if (mid) REPLY_CACHE.set(mid, translated);
    applyDisplayMode(row, true);
  }

  function ensurePending(row, contentEl) {
    const inset = insertInset(row, contentEl);
    inset.classList.add("dt-tl-pending");
    inset.textContent = "…";
    applyDisplayMode(row, false);
    return inset;
  }

  /* ---------- 单条消息处理 ---------- */

  function processRow(row) {
    if (!settings || !settings.enabled || !settings.translateIncoming) return;
    const contentEl = findMainContent(row);
    if (!contentEl) return; // 系统消息/纯引用等无正文
    // LLM 后端：原样 markdown 发送（代码块转 ``` 围栏），由模型自行判断保留；
    // 其他后端（无提示词能力）：占位符方案防代码被翻坏
    let text, codes;
    if (settings.provider === "openai-compatible") {
      text = extractMarkdown(contentEl);
      codes = null;
    } else {
      const r = extractContent(contentEl);
      text = r.text;
      codes = r.codes;
    }
    if (!shouldTranslate(text)) return;

    // 关键：以"行内当前内容"为 key。虚拟列表复用 DOM 节点渲染新消息、
    // 或消息被编辑时，hash 变化会触发重新翻译，不再漏翻。
    const key = (contentEl.id || row.getAttribute("data-list-item-id") || "") + "|" + text;
    const hash = hashStr(key);
    if (row.dataset.dtHash === hash && row.querySelector(".dt-tl")) return;

    const cached = CACHE.get(hash);
    if (cached !== undefined) {
      renderTranslation(row, contentEl, cached, hash, text, codes);
      return;
    }
    if (INFLIGHT.has(hash)) return;
    INFLIGHT.add(hash);
    ensurePending(row, contentEl);

    const attempt = (isRetry) => {
      chrome.runtime.sendMessage({ type: "TRANSLATE", text }, (r) => {
        INFLIGHT.delete(hash);
        if (chrome.runtime.lastError) return;
        if (r && r.ok && r.text) {
          CACHE.set(hash, r.text);
          renderAllWithHash(hash, r.text);
        } else if (!isRetry && !RETRIED.has(hash)) {
          // 失败自动重试一次
          RETRIED.add(hash);
          setTimeout(() => attempt(true), 1200);
        } else {
          const inset = row.querySelector(".dt-tl");
          if (inset && row.contains(inset)) {
            inset.classList.remove("dt-tl-pending");
            inset.classList.add("dt-tl-error");
            inset.textContent =
              "⚠ 翻译失败" + (r && r.error ? "：" + r.error : "");
          }
          applyDisplayMode(row, false); // 失败时必须显示原文
        }
      });
    };
    attempt(false);
  }

  // 翻译完成后，把结果渲染到所有当前匹配该条消息的行（兼容虚拟滚动重建）
  function renderAllWithHash(hash, translated) {
    const useRaw = settings && settings.provider === "openai-compatible";
    document.querySelectorAll(CONTENT_SELECTOR).forEach((ce) => {
      if (ce.closest(REPLY_CONTAINER)) return; // 跳过回复引用条内的预览元素
      const row = ce.closest(MESSAGE_SELECTOR);
      if (!row) return;
      let ceText, ceCodes;
      if (useRaw) {
        ceText = extractMarkdown(ce);
        ceCodes = null;
      } else {
        const r = extractContent(ce);
        ceText = r.text;
        ceCodes = r.codes;
      }
      const key =
        (ce.id || row.getAttribute("data-list-item-id") || "") + "|" + ceText;
      if (hashStr(key) === hash)
        renderTranslation(row, ce, translated, hash, ceText, ceCodes);
    });
  }

  // 仅译文模式：引用条预览替换为被引消息的译文。
  // 有缓存（正文翻译过）→ 直接替换；无缓存 → 按需单独翻译该引用条。
  // 双语模式或翻译失败时恢复原文。
  const REPLY_INFLIGHT = new Set(); // 消息id：引用条翻译进行中
  const REPLY_FAILED = new Set(); // 消息id：按需翻译失败（不自动重试）

  function restoreReplyBar(el) {
    if (el.dataset.dtOriginal) {
      el.textContent = el.dataset.dtOriginal;
      el.removeAttribute("title");
      delete el.dataset.dtOriginal;
    }
  }

  function requestReplyTranslation(el) {
    const mid = (el.id || "").replace("message-content-", "");
    if (!mid) return;
    if (REPLY_CACHE.has(mid) || REPLY_INFLIGHT.has(mid) || REPLY_FAILED.has(mid))
      return;
    const text = (el.textContent || "").trim();
    if (!shouldTranslate(text)) return;
    REPLY_INFLIGHT.add(mid);
    chrome.runtime.sendMessage(
      { type: "TRANSLATE", text, targetLang: settings && settings.targetLang },
      (r) => {
        REPLY_INFLIGHT.delete(mid);
        if (chrome.runtime.lastError) return;
        if (r && r.ok && r.text) {
          REPLY_CACHE.set(mid, r.text);
          applyReplyTranslations();
        } else {
          REPLY_FAILED.add(mid);
        }
      }
    );
  }

  function applyReplyTranslations() {
    const replaceMode =
      settings && settings.enabled && settings.showOriginal === false;
    document
      .querySelectorAll('[class*="repliedMessage"] [id^="message-content-"]')
      .forEach((el) => {
        if (!replaceMode) {
          restoreReplyBar(el);
          return;
        }
        const mid = (el.id || "").replace("message-content-", "");
        const translatedRaw = mid ? REPLY_CACHE.get(mid) : undefined;
        // 引用条是单行预览：LLM 译文里的 ``` 围栏剥掉只留内容
        const translated = translatedRaw
          ? translatedRaw
              .replace(/```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g, "$1")
              .replace(/`/g, "")
              .trim()
          : undefined;
        if (translated) {
          if (!el.dataset.dtOriginal) el.dataset.dtOriginal = el.textContent;
          if (el.textContent !== translated) {
            el.textContent = translated;
            el.title = "原文：" + el.dataset.dtOriginal;
          }
        } else {
          restoreReplyBar(el);
          if (mid && !REPLY_FAILED.has(mid)) requestReplyTranslation(el);
        }
      });
  }

  /* ---------- 扫描 & 观察者 ---------- */

  function scan() {
    scanTimer = null;
    if (!settings || !settings.enabled || !settings.translateIncoming) return;
    document.querySelectorAll(MESSAGE_SELECTOR).forEach((row) => {
      processRow(row);
    });
    applyReplyTranslations();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 150);
  }

  function startObserver() {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList" || m.type === "characterData") {
          const t = m.target;
          if (
            t.closest &&
            (t.closest(MESSAGE_SELECTOR) || t.nodeType === 3 || t.nodeType === 1)
          ) {
            scheduleScan();
            break;
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* ---------- 输入框草稿翻译 ---------- */

  function findTextbox() {
    return document.querySelector('div[role="textbox"][contenteditable="true"]');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // React fiber 只在页面世界可见（content script 隔离世界看不到 expando 属性），
  // Slate 定位/替换由 MAIN world 的 page-slate.js 执行，这里通过 DOM 事件通信。
  function requestDraftReplace(text) {
    return new Promise((resolve) => {
      const reqId = "dt" + Date.now() + Math.random().toString(36).slice(2);
      const onResult = (e) => {
        if (!e.detail || e.detail.reqId !== reqId) return;
        document.removeEventListener(RES_EVENT, onResult);
        resolve(e.detail);
      };
      const RES_EVENT = "DT_REPLACE_RESULT";
      document.addEventListener(RES_EVENT, onResult);
      document.dispatchEvent(
        new CustomEvent("DT_REPLACE_DRAFT", { detail: { text, reqId } })
      );
      // 页面脚本未注入/无响应保护
      setTimeout(() => {
        document.removeEventListener(RES_EVENT, onResult);
        resolve({ ok: false, error: "页面脚本无响应（请刷新页面重试）" });
      }, 3000);
    });
  }

  function composerText(tb) {
    return (tb.innerText || tb.textContent || "").trim();
  }

  function composerIsPure(tb, raw, text) {
    const now = composerText(tb);
    const textHead = text.slice(0, Math.min(20, text.length));
    const rawHead = raw.slice(0, Math.min(15, raw.length));
    return now.includes(textHead) && !now.includes(rawHead);
  }

  async function translateDraft(btn) {
    const tb = findTextbox();
    if (!tb) return toast("未找到 Discord 输入框", true);
    const raw = composerText(tb);
    if (!raw) return toast("输入框是空的", true);
    if (btn) btn.classList.add("dt-busy");
    try {
      const r = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: raw,
        targetLang: settings && settings.outboxTargetLang
      });
      if (!(r && r.ok && r.text)) {
        return toast("翻译失败：" + ((r && r.error) || "未知错误"), true);
      }

      const res = await requestDraftReplace(r.text);
      if (!res.ok) {
        return toast("替换失败：" + (res.error || "未知原因"), true);
      }

      await sleep(60);
      if (!composerIsPure(tb, raw, r.text)) {
        return toast("替换后校验未通过，请检查输入框内容", true);
      }
      toast("✓ 已替换为译文，可继续编辑后发送");
    } catch (e) {
      toast("翻译失败：" + ((e && e.message) || e), true);
    } finally {
      if (btn) btn.classList.remove("dt-busy");
    }
  }

  let outboxKeybound = false;
  let outboxProbeStarted = false;

  // Feather "globe" 线性图标（MIT），与 Discord 原生 gift/gif/贴纸图标风格一致
  const GLOBE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

  function injectOutboxButton() {
    if (!settings || !settings.outboxButton) return;
    if (document.querySelector(".dt-outbox-btn")) {
      outboxInjected = true;
      return;
    }
    // 锚定输入框本身（最稳定的选择器），宿主优先 channelTextArea，否则用 textbox 祖先
    const tb = findTextbox();
    if (!tb) return;
    const host =
      tb.closest('[class*="channelTextArea"]') ||
      (tb.parentElement && tb.parentElement.parentElement) ||
      tb.parentElement;
    if (!host) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dt-outbox-btn";
    btn.title = "翻译输入框内容（快捷键 Alt+T）";
    btn.innerHTML = GLOBE_SVG;
    btn.addEventListener("click", () => translateDraft(btn));

    // 优先并入原生图标按钮组（gift/gif/贴纸/emoji…），观感与原生完全一致
    const group = host.querySelector('[class*="buttons"]');
    if (group && !tb.contains(group)) {
      group.insertBefore(btn, group.firstChild);
    } else {
      host.classList.add("dt-composer-host");
      host.appendChild(btn);
    }
    outboxInjected = true;

    // 快捷键只注册一次（频道切换重注入时不能叠加监听器）
    if (!outboxKeybound) {
      outboxKeybound = true;
      document.addEventListener("keydown", (e) => {
        if (
          e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.key === "t" || e.key === "T") &&
          e.target &&
          e.target.isContentEditable
        ) {
          e.preventDefault();
          translateDraft(document.querySelector(".dt-outbox-btn"));
        }
      });
    }
  }

  // 自愈式探测：频道切换/重渲染导致按钮随宿主被移除时，自动补回
  function startOutboxRetry() {
    if (outboxProbeStarted) return;
    outboxProbeStarted = true;
    const probe = () => {
      try {
        if (settings && settings.outboxButton && !document.querySelector(".dt-outbox-btn")) {
          outboxInjected = false;
          injectOutboxButton();
        }
      } catch (_) {}
      setTimeout(probe, 1500);
    };
    probe();
  }

  /* ---------- 设置热更新 ---------- */

  function applySettingsAll() {
    // 仅对"已有成功译文"的行应用仅译文模式；其余行显示原文
    document.querySelectorAll(MESSAGE_SELECTOR).forEach((row) => {
      const inset = row.querySelector(".dt-tl");
      const hasTranslation =
        !!inset &&
        !inset.classList.contains("dt-tl-error") &&
        !inset.classList.contains("dt-tl-pending");
      applyDisplayMode(row, hasTranslation);
    });
    applyReplyTranslations();
    if (settings) {
      if (!settings.outboxButton && outboxInjected) {
        const btn = document.querySelector(".dt-outbox-btn");
        if (btn) btn.remove();
        outboxInjected = false;
      } else if (settings.outboxButton && !outboxInjected) {
        startOutboxRetry();
      }
    }
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.dtSettings) {
        settings = { ...settings, ...(changes.dtSettings.newValue || {}) };
        applySettingsAll();
      }
    });
  }

  /* ---------- 启动 ---------- */

  (async function init() {
    await getSettings();
    startObserver();
    applySettingsAll();
    scan();
    startOutboxRetry();

    // Discord SPA 路由切换后重新挂载
    setInterval(scan, 4000);
  })();
})();
