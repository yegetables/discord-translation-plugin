// DeepL API 后端（需用户在设置中填入自己的 API key；免费版 50 万字/月）
// 端点：api-free.deepl.com / api.deepl.com（按 plan 切换）

export const META = {
  id: "deepl",
  label: "DeepL API（需自己申请 key）",
  desc: "翻译质量高，需注册 DeepL API 获取 key。免费版每月 50 万字符。"
};

function normToDeepL(code) {
  if (!code || code === "auto") return null;
  const c = String(code).toLowerCase();
  const map = {
    "zh-cn": "ZH",
    "zh-hans": "ZH",
    "zh-tw": "ZH-HANT",
    "zh-hant": "ZH-HANT",
    en: "EN-GB" // 等价 EN；DeepL 接受 EN
  };
  if (map[c]) return map[c];
  return String(code).toUpperCase();
}

function chunkText(text, max = 10000) {
  if (text.length <= max) return [text];
  const parts = text.split(/(\r?\n)+/);
  const chunks = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      chunks.push(cur);
      cur = p;
    } else cur += p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export async function translate({ text, targetLang, config = {} }) {
  const key = (config.deeplApiKey || "").trim();
  if (!key) throw new Error("未配置 DeepL API Key");
  const base =
    config.deeplPlan === "pro"
      ? "https://api.deepl.com/v2/translate"
      : "https://api-free.deepl.com/v2/translate";
  const tl = normToDeepL(targetLang) || "ZH";
  const out = [];
  for (const c of chunkText(text)) {
    const body = new URLSearchParams();
    body.set("auth_key", key);
    body.set("text", c);
    body.set("target_lang", tl);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j.message) msg = j.message;
      } catch (_) {}
      throw new Error("DeepL: " + msg);
    }
    const data = await res.json();
    out.push((data.translations || []).map((t) => t.text).join(""));
  }
  return out.join("\n");
}
