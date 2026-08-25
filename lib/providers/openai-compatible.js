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

// 内置提示词方案（可在设置面板编辑/新建/重命名/切换）
// {{to}} 运行时替换为目标语言名
export const DEFAULT_PROMPT_PROFILES = [
  {
    name: "沉浸式翻译",
    content: `You are a professional {{to}} native translator who needs to fluently translate text into {{to}}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. If input contains %%, use %% in your output, if input has no %%, don't use %% in your output

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input** → Use %% as paragraph separator between translations`
  },
  {
    name: "简洁中文",
    content:
      "你是专业翻译。把用户文本翻译成「{{to}}」。只输出译文，保留原文的换行、列表、代码块等格式，代码块内容必须原样保留不要翻译，不要额外解释。"
  }
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

  // 提示词：使用激活的方案（可在设置面板管理），{{to}} 替换为目标语言名
  const profiles =
    Array.isArray(config.promptProfiles) && config.promptProfiles.length
      ? config.promptProfiles
      : DEFAULT_PROMPT_PROFILES;
  const profile = profiles[config.promptActive] || profiles[0];
  let sys = (profile && profile.content) || "";
  if (!sys.includes("{{to}}")) {
    sys += "\n\nTranslate the text into " + tl + ".";
  }
  sys = sys.replace(/\{\{to\}\}/g, tl);

  const body = {
    model,
    messages: [
      { role: "system", content: sys },
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
