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
    // 不翻译：代码块、按钮、emoji、图片、头像/提及标记等
    clone
      .querySelectorAll(
        'pre, code, [class*="button"], [class*="emoji"], img, svg, a[class*="mention"], [class*="actionRow"]'
      )
      .forEach((n) => n.remove());
    let text = (clone.textContent || "").replace(/\u00a0/g, " ").trim();
    // 压缩空白但不破坏换行
    text = text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    return text;
  }

  function shouldTranslate(text) {
    if (!text) return false;
    if (text.length < (settings ? settings.minLength : 3)) return false;
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

  function renderTranslation(row, contentEl, translated) {
    let inset = row.querySelector(":scope > .dt-tl, .dt-tl");
    if (!inset || !row.contains(inset)) {
      inset = document.createElement("div");
      inset.className = "dt-tl";
      if (contentEl.nextSibling) {
        contentEl.parentNode.insertBefore(inset, contentEl.nextSibling);
      } else {
        contentEl.parentNode.appendChild(inset);
      }
    }
    const h = hashStr(translated);
    if (inset.dataset.dt === h) return;
    inset.dataset.dt = h;
    inset.dataset.tag = "译文";
    inset.textContent = translated;
    inset.classList.remove("dt-tl-pending", "dt-tl-error");
    applyDisplayMode(row);
  }

  function ensurePending(row, contentEl) {
    let inset = row.querySelector(".dt-tl");
    if (!inset || !row.contains(inset)) {
      inset = document.createElement("div");
      inset.className = "dt-tl dt-tl-pending";
      if (contentEl.nextSibling) {
        contentEl.parentNode.insertBefore(inset, contentEl.nextSibling);
      } else {
        contentEl.parentNode.appendChild(inset);
      }
    }
    inset.dataset.dt = "pending";
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

    const key = (contentEl.id || row.getAttribute("data-list-item-id") || "") + "|" + text;
    const hash = hashStr(key);
    const cached = CACHE.get(hash);
    if (cached !== undefined) {
      renderTranslation(row, contentEl, cached);
      return;
    }
    if (INFLIGHT.has(hash)) return;
    INFLIGHT.add(hash);
    ensurePending(row, contentEl);

    chrome.runtime.sendMessage({ type: "TRANSLATE", text }, (r) => {
      INFLIGHT.delete(hash);
      if (chrome.runtime.lastError) {
        applyDisplayMode(row);
        return;
      }
      if (r && r.ok && r.text) {
        CACHE.set(hash, r.text);
        renderAllWithHash(hash, r.text);
      } else {
        const inset = row.querySelector(".dt-tl");
        if (inset) {
          inset.classList.remove("dt-tl-pending");
          inset.classList.add("dt-tl-error");
          inset.textContent = "⚠ 翻译失败" + (r && r.error ? "：请检查设置" : "");
        }
      }
    });
  }

  // 翻译完成后，把结果渲染到所有当前匹配该条消息的行（兼容虚拟滚动重建）
  function renderAllWithHash(hash, translated) {
    document.querySelectorAll(CONTENT_SELECTOR).forEach((ce) => {
      const row = ce.closest(MESSAGE_SELECTOR);
      if (!row) return;
      const key =
        (ce.id || row.getAttribute("data-list-item-id") || "") + "|" + extractText(ce);
      if (hashStr(key) === hash) renderTranslation(row, ce, translated);
    });
  }

  /* ---------- 扫描 & 观察者 ---------- */

  function scan() {
    scanTimer = null;
    if (!settings || !settings.enabled || !settings.translateIncoming) return;
    document.querySelectorAll(MESSAGE_SELECTOR).forEach((row) => {
      if (!row.__dtScanned) {
        row.__dtScanned = true;
        processRow(row);
      }
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
    return document.querySelector('[role="textbox"][contenteditable="true"]');
  }

  async function translateDraft(btn) {
    const tb = findTextbox();
    if (!tb) return toast("未找到输入框", true);
    const raw = (tb.innerText || tb.textContent || "").trim();
    if (!raw) return toast("输入框是空的", true);
    if (btn) btn.classList.add("dt-busy");
    try {
      const r = await chrome.runtime.sendMessage({ type: "TRANSLATE", text: raw });
      if (r && r.ok && r.text) {
        tb.innerText = r.text;
        toast("已填入译文，确认后发送");
      } else {
        toast("翻译失败：" + (r && r.error ? r.error : "未知错误"), true);
      }
    } catch (e) {
      toast("翻译失败：" + e.message, true);
    } finally {
      if (btn) btn.classList.remove("dt-busy");
    }
  }

  function injectOutboxButton() {
    if (outboxInjected || !settings || !settings.outboxButton) return;
    const area =
      document.querySelector('form[class*="chat"] [class*="channelTextArea"]') ||
      document.querySelector('[class*="channelTextArea"]');
    if (!area) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dt-outbox-btn";
    btn.title = "翻译输入框内容为目标语言（快捷键 Alt+T）";
    btn.textContent = "🌐";
    btn.addEventListener("click", () => translateDraft(btn));
    area.appendChild(btn);
    outboxInjected = true;

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

  function startOutboxRetry() {
    const probe = () => {
      if (!outboxInjected) injectOutboxButton();
      if (!outboxInjected && settings && settings.outboxButton) setTimeout(probe, 1200);
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
