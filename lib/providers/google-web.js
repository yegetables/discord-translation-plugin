// Google Translate 免费 Web 接口（无需 API key，对标商店扩展的默认后端）
// 端点：translate.googleapis.com/translate_a/single, client=gtx, POST
// 说明：原文会发送给 Google。详情见 README「翻译后端」。

export const META = {
  id: "google-web",
  label: "Google 翻译（免费 Web 接口）",
  desc: "开箱即用，无需注册。发送的消息会经 Google 云翻译处理。"
};

function normalizeLang(code) {
  if (!code || code === "auto") return "auto";
  // Google 使用 zh-CN / zh-TW / zh-Hant 等；把 zh-Hans -> zh-CN
  let c = String(code);
  if (c === "zh-Hans") c = "zh-CN";
  if (c === "zh-Hant") c = "zh-TW";
  return c;
}

function chunkText(text, max = 1400) {
  if (text.length <= max) return [text];
  // 优先按换行拆分，避免切断句子；其次按 max 硬切
  const parts = text.split(/(\r?\n)+/);
  const chunks = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      chunks.push(cur);
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function callGoogle(text, tl) {
  const body = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl,
    dt: "t",
    dj: "1",
    q: text
  });
  // 备用端点：translate.google.com/translate_a/single（同样免 key、POST）
  const urls = [
    "https://translate.googleapis.com/translate_a/single",
    "https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(tl) + "&dt=t&dj=1"
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data && data.sentences && data.sentences.length) {
        return data.sentences.map((s) => s.trans).join("");
      }
      // dj=1 情况下空结果
      throw new Error("empty result");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("google translate failed");
}

export async function translate({ text, targetLang }) {
  const tl = normalizeLang(targetLang || "zh-CN");
  if (!text || !text.trim().length) return "";
  const out = [];
  for (const c of chunkText(text)) {
    out.push(await callGoogle(c, tl));
  }
  return out.join("\n");
}
