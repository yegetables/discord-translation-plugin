// OpenAI 兼容接口后端：本地 LM Studio / Ollama，或任意 OpenAI 兼容服务
// 默认 base: http://localhost:1234/v1（LM Studio）；Ollama 为 http://localhost:11434/v1

export const META = {
  id: "openai-compatible",
  label: "本地/自定义大模型（OpenAI 兼容）",
  desc: "私有部署，消息不出本机。默认 LM Studio:1234 或 Ollama:11434。"
};

const PROVIDERS = [
  { name: "LM Studio", base: "http://localhost:1234/v1", model: "" },
  { name: "Ollama", base: "http://localhost:11434/v1", model: "" }
];

function dropCodeFence(s) {
  return String(s || "").replace(/^```[a-zA-Z0-9_-]*\s*|\s*```$/g, "").trim();
}

export async function translate({ text, targetLang, config = {}, langName }) {
  const base = (config.oaBaseUrl && config.oaBaseUrl.trim()) || "http://localhost:1234/v1";
  const model = (config.oaModel && config.oaModel.trim()) || "gpt-4o-mini";
  const apiKey = (config.oaApiKey || "").trim();

  const url = base.replace(/\/+$/, "") + "/chat/completions";
  const tl =
    config.oaLangName ||
    langName ||
    (targetLang && targetLang !== "auto" ? targetLang : "简体中文");

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "你是专业翻译。把用户文本翻译成「" + tl + "」。只输出译文，保留原文的换行、列表、代码块等格式，不要额外解释。"
      },
      { role: "user", content: text }
    ],
    temperature: 0.2
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("OpenAI 兼容接口 HTTP " + res.status);
  const data = await res.json();
  const out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  if (!out) throw new Error("OpenAI 兼容接口返回为空（请检查 model 名称）");
  return dropCodeFence(out);
}

export function suggestedDefaults() {
  // 供 popup 的快捷填充按钮使用
  return PROVIDERS;
}
