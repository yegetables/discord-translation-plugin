// 测试 LLM 翻译时能否原样保留代码块
// 用法: node scripts/test-llm-preserve.mjs [baseUrl] [model] [targetLang] [prompt]
// prompt: default | strict | imt（沉浸式翻译风格，%% 段落协议）

const base = process.argv[2] || "http://localhost:11434/v1";
const model = process.argv[3] || "kaelri/hy-mt2:1.8b";
const target = process.argv[4] || "简体中文";
const mode = process.argv[5] || "default";

// 与用户报 bug 的真实消息同构：说明文字 + 代码块 + 结尾一句
const MESSAGE = [
  "I found the optimal solution for my 5060ti 16g running the qwen3.8-27B quantization model, especially when using a 64k/128k context. You can try mine; I can guarantee the token generation speed will be at least 30t/s.",
  "",
  "```",
  '.\\llama-server.exe -m "D:\\models\\Huihui-Qwen3.8-27B-abliterated-GGUF\\Huihui-Qwen3.8-27B-abliterated-UD-IQ3_XXS.gguf" -ngl 999 --flash-attn on --cache-type-k q4_0 --cache-type-v q4_0 --host 0.0.0.0 --port 18380 -c 65536 --metrics',
  "```",
  "",
  "Let me know if it works for you."
].join("\n");

const PROMPTS = {
  default:
    "你是专业翻译。把用户文本翻译成「" +
    target +
    "」。只输出译文，保留原文的换行、列表、代码块等格式，代码块内容必须原样保留不要翻译，不要额外解释。",
  strict: [
    "你是专业翻译。把用户文本翻译成「" + target + "」。格式规则（必须遵守）：",
    "1. 用户文本中的 ``` 代码块必须连同 ``` 围栏一起原样输出，围栏不能省略；",
    "2. 代码块内部内容一字不改、不翻译；",
    "3. 只翻译代码块之外的文字；",
    "4. 只输出译文，不要任何解释。"
  ].join("\n"),
  imt: `You are a professional ${target} native translator who needs to fluently translate text into ${target}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. If input contains %%, use %% in your output, if input has no %%, don't use %% in your output

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input** → Use %% as paragraph separator between translations

## Examples
### Multi-paragraph Input:
Paragraph A

%%

Paragraph B

%%

Paragraph C

%%

Paragraph D

### Multi-paragraph Output:
Translation A

%%

Translation B

%%

Translation C

%%

Translation D

### Single paragraph Input:
Single paragraph content

### Single paragraph Output:
Direct translation without separators`
};

const SYSTEM = PROMPTS[mode] || PROMPTS.default;

const res = await fetch(base.replace(/\/+$/, "") + "/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: MESSAGE }
    ],
    temperature: 0.2
  })
});
if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const raw = data.choices?.[0]?.message?.content || "";
console.log(`=== LLM 输出（prompt=${mode}）===`);
console.log(raw);

// ---- 校验 ----
const extract = (s) =>
  [...s.matchAll(/```(?:[a-zA-Z0-9]*\n)?([\s\S]*?)```/g)].map((m) => m[1]);
const srcFences = extract(MESSAGE);
const gotFences = extract(raw);
console.log("\n=== 校验 ===");
console.log("围栏数: 原文", srcFences.length, "| 返回", gotFences.length);
srcFences.forEach((s, i) => {
  const g = gotFences[i];
  if (g === undefined) console.log(`代码块#${i}: ❌ 缺失`);
  else if (g.trim() === s.trim()) console.log(`代码块#${i}: ✅ 原样保留（trim 后逐字符一致）`);
  else {
    console.log(`代码块#${i}: ⚠ 内容不一致`);
    console.log("  原文:", JSON.stringify(s.slice(0, 100)));
    console.log("  返回:", JSON.stringify(g.slice(0, 100)));
  }
});
console.log("说明部分翻译:", /[\u4e00-\u9fff]/.test(raw) ? "✅ 已翻译" : "⚠ 未检测到中文");
console.log("%% 泄漏:", raw.includes("%%") ? "⚠ 输出含 %%（输入无 %% 时不应出现）" : "✅ 无");
// 段落数（非空行块）
const paras = (s) => s.split(/\n\s*\n/).filter((p) => p.trim()).length;
console.log("段落数: 原文", paras(MESSAGE), "| 返回", paras(raw));
