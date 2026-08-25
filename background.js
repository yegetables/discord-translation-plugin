// background service worker：设置缓存 + 翻译请求转发
import { translate as doTranslate } from "./lib/translator.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  provider: "google-web", // google-web | deepl | openai-compatible
  targetLang: "zh-CN",
  showOriginal: true, // true=双语对照, false=仅译文(隐藏原文)
  translateIncoming: true,
  outboxButton: true, // 在输入框显示"翻译草稿"按钮
  outboxTargetLang: "en", // 发送框草稿翻译的目标语言（与接收翻译的 targetLang 相互独立）
  minLen: 2, // 低于此长度不翻译（v0.1.1 由 minLength:3 改名并调低，旧值自动失效）
  // deepl
  deeplApiKey: "",
  deeplPlan: "free", // free | pro
  // openai compatible
  oaBaseUrl: "http://localhost:1234/v1",
  oaModel: "gpt-4o-mini",
  oaApiKey: ""
};

let settings = null;

async function getSettings() {
  if (settings) return settings;
  const stored = await chrome.storage.sync.get("dtSettings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.dtSettings || {}) };
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.dtSettings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.dtSettings.newValue || {}) };
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "GET_SETTINGS": {
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        }
        case "SET_SETTINGS": {
          const cur = await getSettings();
          settings = { ...cur, ...(msg.patch || {}) };
          await chrome.storage.sync.set({ dtSettings: settings });
          sendResponse({ ok: true, settings });
          break;
        }
        case "RESET_SETTINGS": {
          settings = { ...DEFAULT_SETTINGS };
          await chrome.storage.sync.set({ dtSettings: settings });
          sendResponse({ ok: true, settings });
          break;
        }
        case "TRANSLATE": {
          const s = await getSettings();
          if (!s.enabled) {
            sendResponse({ ok: false, error: "扩展未启用" });
            break;
          }
          // msg.targetLang 可选覆盖：发送框草稿用独立目标语言
          const eff = msg.targetLang ? { ...s, targetLang: msg.targetLang } : s;
          const r = await doTranslate(msg.text, eff);
          sendResponse(r);
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message: " + (msg && msg.type) });
      }
    } catch (e) {
      console.error("[DT] bg err", e);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步响应
});
