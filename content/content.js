// Discord 翻译 · content script（注入 discord.com）
// 职责：监听消息流 → 提取文本 → 请求 background 翻译 → 注入译文；输入框草稿翻译按钮。
(function () {
  "use strict";

  if (window.__DT_INJECTED__) return;
  window.__DT_INJECTED__ = true;

  const MESSAGE_SELECTOR =
    '[data-list-item-id^="chat-messages-"], [id^="chat-messages-"]';
  const CONTENT_SELECTOR = '[id^="message-content-"]';

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
    const contentEl = row.querySelector(CONTENT_SELECTOR);
    if (!contentEl) return; // 系统消息等无正文
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

  function replaceComposerText(tb, text) {
    tb.focus();
    selectAllInComposer(tb);
    // 走 paste 事件路径：Slate/React 以"用户输入"方式同步内部状态，编辑器保持可编辑
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
    } catch (_) {
      selectAllInComposer(tb);
      document.execCommand("insertText", false, text);
      return;
    }
    // Slate 渲染是异步的：稍后校验是否真的替换成功
    setTimeout(() => {
      const now = tb.innerText || "";
      if (!now.includes(text.slice(0, Math.min(20, text.length)))) {
        toast("自动替换未生效，译文已复制到剪贴板，请 Ctrl+V 粘贴", true);
      }
    }, 80);
  }

  async function translateDraft(btn) {
    const tb = findTextbox();
    if (!tb) return toast("未找到输入框", true);
    const raw = (tb.innerText || tb.textContent || "").trim();
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
        replaceComposerText(tb, r.text);
        toast("✓ 输入框已替换为译文，可继续编辑后发送");
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
