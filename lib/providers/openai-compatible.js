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

// 沉浸式翻译风格系统提示词（实测 hy-mt2:1.8b 可完整保留 ``` 代码块围栏与内容）
function systemPrompt(tl) {
  return `You are a professional ${tl} native translator who needs to fluently translate text into ${tl}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. If input contains %%, use %% in your output, if input has no %%, don't use %% in your output

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input** → Use %% as paragraph separator between translations`;
}

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
        content: systemPrompt(tl)
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
  let out =
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  if (!out) throw new Error("OpenAI 兼容接口返回为空（请检查 model 名称）");
  // 防御：模型若按多段落协议输出 %% 分隔符，还原为段落换行
  if (out.includes("%%")) out = out.split(/\s*%%\s*/).join("\n\n");
  return dropCodeFence(out);
}

export function suggestedDefaults() {
  // 供 popup 的快捷填充按钮使用
  return PROVIDERS;
}
