// 翻译路由器：按设置分发到不同后端
import * as googleWeb from "./providers/google-web.js";
import * as deepl from "./providers/deepl.js";
import * as openai from "./providers/openai-compatible.js";
import { langName, DEFAULT_TARGET } from "./lang.js";

const PROVIDERS = {
  "google-web": googleWeb,
  deepl,
  "openai-compatible": openai
};

export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.META.id,
    label: p.META.label,
    desc: p.META.desc
  }));
}

export async function translate(text, settings) {
  if (!settings || !settings.enabled) return { ok: false, error: "扩展未启用" };
  if (!text || !String(text).trim()) return { ok: true, text: "" };

  const providerId = settings.provider || "google-web";
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error("未知翻译后端: " + providerId);

  try {
    const target = settings.targetLang || DEFAULT_TARGET;
    const out = await provider.translate({
      text: String(text),
      targetLang: target,
      config: settings || {},
      langName: target === "auto" ? "简体中文" : langName(target, "简体中文")
    });
    return { ok: true, text: out, provider: providerId };
  } catch (e) {
    console.error("[DT] translate error", e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
