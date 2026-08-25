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

  function extractText(contentEl) {
    const clone = contentEl.cloneNode(true);
    // 不翻译：回复引用、代码块、按钮、emoji、图片、提及等
    clone
      .querySelectorAll(
        '[class*="repliedMessage"], pre, code, [class*="button"], [class*="emoji"], img, svg, a[class*="mention"], [class*="actionRow"]'
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
    return text;
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

  function applyDisplayMode(row) {
    if (!settings) return;
    row.classList.toggle("dt-replace", settings.showOriginal === false);
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

  function renderTranslation(row, contentEl, translated, rowHash) {
    if (!translated || !translated.trim().length) {
      const inset = insertInset(row, contentEl);
      inset.classList.add("dt-tl-error");
      inset.textContent = "⚠ 翻译结果为空";
      return;
    }
    const inset = insertInset(row, contentEl);
    inset.dataset.dt = hashStr(translated);
    inset.dataset.tag = "译文";
    inset.textContent = translated;
    if (rowHash) row.dataset.dtHash = rowHash;
    applyDisplayMode(row);
  }

  function ensurePending(row, contentEl) {
    const inset = insertInset(row, contentEl);
    inset.classList.add("dt-tl-pending");
    inset.textContent = "…";
    return inset;
  }

  /* ---------- 单条消息处理 ---------- */

  function processRow(row) {
    if (!settings || !settings.enabled || !settings.translateIncoming) return;
    const contentEl = findMainContent(row);
    if (!contentEl) return; // 系统消息/纯引用等无正文
    const text = extractText(contentEl);
    if (!shouldTranslate(text)) return;

    // 关键：以"行内当前内容"为 key。虚拟列表复用 DOM 节点渲染新消息、
    // 或消息被编辑时，hash 变化会触发重新翻译，不再漏翻。
    const key = (contentEl.id || row.getAttribute("data-list-item-id") || "") + "|" + text;
    const hash = hashStr(key);
    if (row.dataset.dtHash === hash && row.querySelector(".dt-tl")) return;

    const cached = CACHE.get(hash);
    if (cached !== undefined) {
      renderTranslation(row, contentEl, cached, hash);
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
        }
      });
    };
    attempt(false);
  }

  // 翻译完成后，把结果渲染到所有当前匹配该条消息的行（兼容虚拟滚动重建）
  function renderAllWithHash(hash, translated) {
    document.querySelectorAll(CONTENT_SELECTOR).forEach((ce) => {
      if (ce.closest(REPLY_CONTAINER)) return; // 跳过回复引用条内的预览元素
      const row = ce.closest(MESSAGE_SELECTOR);
      if (!row) return;
      const key =
        (ce.id || row.getAttribute("data-list-item-id") || "") + "|" + extractText(ce);
      if (hashStr(key) === hash) renderTranslation(row, ce, translated, hash);
    });
  }

  /* ---------- 扫描 & 观察者 ---------- */

  function scan() {
    scanTimer = null;
    if (!settings || !settings.enabled || !settings.translateIncoming) return;
    document.querySelectorAll(MESSAGE_SELECTOR).forEach((row) => {
      processRow(row);
    });
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

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (_) {}
    // 兜底：隐藏 textarea + execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function selectAllInComposer(tb) {
    // 精确选中 Slate 首个→最后一个非空文本节点（避开零宽占位节点）
    const sel = window.getSelection();
    const range = document.createRange();
    const walker = document.createTreeWalker(tb, NodeFilter.SHOW_TEXT);
    let first = null,
      last = null,
      n;
    while ((n = walker.nextNode())) {
      if (n.textContent && n.textContent.trim().length) {
        if (!first) first = n;
        last = n;
      }
    }
    if (first && last) {
      range.setStart(first, 0);
      range.setEnd(last, last.textContent.length);
    } else {
      range.selectNodeContents(tb);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 从 React fiber 定位 Discord 的 Slate editor 实例
  // （诊断确认：fiber 上溯数层内 props.editor 即编辑器，含 children/selection/insertText）
  function findSlateEditor(tb) {
    const fiberKey = Object.keys(tb).find((k) => k.startsWith("__reactFiber$"));
    if (!fiberKey) return null;
    let f = tb[fiberKey];
    for (let i = 0; i < 20 && f; i++) {
      const e = f.memoizedProps && f.memoizedProps.editor;
      if (e && typeof e.insertText === "function" && "children" in e && "selection" in e) {
        return e;
      }
      f = f.return;
    }
    return null;
  }

  // Slate 原生 API：全选并替换（状态天然同步，编辑器保持可编辑）
  function slateReplaceAll(editor, text) {
    const findFirst = (node, path) => {
      if (typeof node.text === "string") return { path, offset: 0 };
      for (let i = 0; i < node.children.length; i++) {
        const r = findFirst(node.children[i], path.concat(i));
        if (r) return r;
      }
      return null;
    };
    const findLast = (node, path) => {
      if (typeof node.text === "string") return { path, offset: node.text.length };
      for (let i = node.children.length - 1; i >= 0; i--) {
        const r = findLast(node.children[i], path.concat(i));
        if (r) return r;
      }
      return null;
    };
    if (!editor.children || !editor.children.length) return false;
    const first = findFirst(editor.children[0], [0]);
    const last = findLast(editor.children[editor.children.length - 1], [editor.children.length - 1]);
    if (!first || !last) return false;
    editor.selection = {
      anchor: { path: first.path, offset: first.offset },
      focus: { path: last.path, offset: last.offset }
    };
    editor.deleteFragment();
    editor.insertText(text);
    return true;
  }

  function pasteIntoComposer(tb, text) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      tb.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        })
      );
      return true;
    } catch (_) {
      return false;
    }
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

  // 任何路径失败都不能丢用户文本：恢复原文
  async function restoreComposer(tb, raw) {
    selectAllInComposer(tb);
    await sleep(0);
    if (!pasteIntoComposer(tb, raw)) {
      document.execCommand("insertText", false, raw);
    }
    await sleep(80);
    if (!composerText(tb).includes(raw.slice(0, Math.min(20, raw.length)))) {
      tb.innerText = raw; // 最后兜底
    }
  }

  async function replaceComposerText(tb, raw, text) {
    tb.focus();
    // 首选：Slate editor 原生 API（Discord 同款编辑通道，状态天然同步）
    const editor = findSlateEditor(tb);
    if (editor) {
      try {
        if (slateReplaceAll(editor, text)) {
          await sleep(60);
          if (composerIsPure(tb, raw, text)) return { ok: true };
        }
      } catch (_) { /* 落入降级链 */ }
    }

    // 降级 1：选中全部 → 等一拍让 selectionchange 派发、Slate 同步内部选区 → paste 替换
    selectAllInComposer(tb);
    await sleep(0);
    if (!pasteIntoComposer(tb, text)) {
      selectAllInComposer(tb);
      document.execCommand("insertText", false, text);
      return composerIsPure(tb, raw, text) ? { ok: true } : (await restoreComposer(tb, raw), { ok: false });
    }
    // 校验：应为纯译文（含译文开头、不再含原文开头）
    await sleep(80);
    if (composerIsPure(tb, raw, text)) return { ok: true };

    // 降级 2：显式"全选 → 删除 → 粘贴"，确保只剩译文
    selectAllInComposer(tb);
    await sleep(0);
    document.execCommand("delete");
    await sleep(0);
    if (!pasteIntoComposer(tb, text)) {
      document.execCommand("insertText", false, text);
    }
    await sleep(80);
    if (composerIsPure(tb, raw, text)) return { ok: true };

    // 全部失败：恢复原文，绝不留空框
    await restoreComposer(tb, raw);
    return { ok: false };
  }

  async function translateDraft(btn) {
    const tb = findTextbox();
    if (!tb) return toast("未找到输入框", true);
    const raw = composerText(tb);
    if (!raw) return toast("输入框是空的", true);
    if (btn) btn.classList.add("dt-busy");
    try {
      const r = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: raw,
        targetLang: settings && settings.outboxTargetLang
      });
      if (r && r.ok && r.text) {
        await copyText(r.text); // 静默安全网：万一替换失败可直接 Ctrl+V
        const res = await replaceComposerText(tb, raw, r.text);
        if (res.ok) toast("✓ 输入框已替换为译文，可继续编辑后发送");
        else toast("自动替换未生效（已恢复原文）。译文已复制，可 Ctrl+V 粘贴", true);
      } else {
        toast("翻译失败：" + (r && r.error ? r.error : "未知错误"), true);
      }
    } catch (e) {
      toast("翻译失败：" + e.message, true);
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
    document.querySelectorAll(MESSAGE_SELECTOR).forEach(applyDisplayMode);
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
