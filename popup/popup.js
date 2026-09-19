// popup：设置面板逻辑（MV3 module）
import { LANGS, DEFAULT_TARGET, sortedLangEntries } from "../lib/lang.js";

const $ = (id) => document.getElementById(id);

let state = null; // 当前内存态（未保存前用户编辑的合并值）

/* ---------- 读取初始设置 ---------- */
const initResult = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
state = initResult && initResult.ok ? initResult.settings : {};

/* ---------- 语言下拉 ---------- */
function fillLangSelect(sel, includeAuto) {
  sel.innerHTML = "";
  for (const [code, [zh, en]] of sortedLangEntries()) {
    if (!includeAuto && code === "auto") continue; // 草稿翻译目标不能是"自动检测"
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = zh + " · " + en;
    sel.appendChild(opt);
  }
}

function fillLangs() {
  fillLangSelect($("targetLang"), true);
  $("targetLang").value = state.targetLang || DEFAULT_TARGET;
  fillLangSelect($("outboxTargetLang"), false);
  $("outboxTargetLang").value = state.outboxTargetLang || "en";
}

/* ---------- 后端下拉 ---------- */
const PROVIDERS = [
  { id: "google-web", label: "Google 免费接口（免 key）" },
  { id: "deepl", label: "DeepL API（需 key）" },
  { id: "openai-compatible", label: "本地/自定义大模型" }
];

function fillProviders() {
  const sel = $("provider");
  sel.innerHTML = "";
  for (const p of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  sel.value = state.provider || "google-web";
  showProviderCfg();
}

function showProviderCfg() {
  const cur = $("provider").value;
  for (const p of PROVIDERS) {
    $(`cfg-${p.id}`)?.classList.toggle("hidden", p.id !== cur);
  }
}

// 并发输入框 placeholder：显示当前后端的自动推荐值
function updateConcurrencyPlaceholder() {
  const rec = { "google-web": 4, "deepl": 4, "openai-compatible": 16 };
  const v = rec[state.provider || "google-web"] || 4;
  $("maxConcurrent").placeholder = `留空 = 自动（当前后端推荐 ${v}）`;
}

/* ---- 提示词方案 ---- */
function fillPromptProfiles() {
  if (!Array.isArray(state.promptProfiles) || !state.promptProfiles.length) {
    state.promptProfiles = [
      { name: "沉浸式翻译", content: "Translate the text into {{to}}." }
    ];
    state.promptActive = 0;
  }
  if (
    typeof state.promptActive !== "number" ||
    state.promptActive < 0 ||
    state.promptActive >= state.promptProfiles.length
  ) {
    state.promptActive = 0;
  }
  const sel = $("promptProfile");
  sel.innerHTML = "";
  state.promptProfiles.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = p.name || "方案 " + (i + 1);
    sel.appendChild(opt);
  });
  sel.value = String(state.promptActive);
  loadPromptEditor();
}

function loadPromptEditor() {
  const n = (state.promptProfiles || []).length;
  let i = parseInt($("promptProfile").value, 10);
  if (isNaN(i) || i < 0 || i >= n) i = 0;
  const p = state.promptProfiles[i];
  $("promptName").value = p ? p.name || "" : "";
  $("promptContent").value = p ? p.content || "" : "";
}

function bind() {
  $("sw-enabled").checked = !!state.enabled;
  // 总开关：必须绑事件，否则只改变勾选外观、设置从未写入
  $("sw-enabled").addEventListener("change", (e) => {
    state.enabled = e.target.checked;
    markDirty(true); // 离散控件立即保存（关弹窗不丢）
  });

  $("targetLang").addEventListener("change", (e) => {
    state.targetLang = e.target.value;
    markDirty(true);
  });
  $("outboxTargetLang").addEventListener("change", (e) => {
    state.outboxTargetLang = e.target.value;
    markDirty(true);
  });
  $("provider").addEventListener("change", (e) => {
    state.provider = e.target.value;
    updateConcurrencyPlaceholder();
    showProviderCfg();
    markDirty(true);
  });
  $("maxConcurrent").addEventListener("input", (e) => {
    const raw = e.target.value.trim();
    if (raw === "") {
      state.maxConcurrent = ""; // 留空 = 自动跟随当前后端推荐
    } else {
      let v = parseInt(raw, 10);
      if (isNaN(v)) return;
      v = Math.max(1, Math.min(32, v));
      state.maxConcurrent = v;
      e.target.value = String(v);
    }
    markDirty();
  });
  document.querySelectorAll('input[name="showOriginal"]').forEach((r) => {
    r.addEventListener("change", () => {
      state.showOriginal = document.querySelector('input[name="showOriginal"]:checked').value === "1";
      markDirty(true);
    });
  });
  $("chk-incoming").addEventListener("change", (e) => {
    state.translateIncoming = e.target.checked;
    markDirty(true);
  });
  $("chk-outbox").addEventListener("change", (e) => {
    state.outboxButton = e.target.checked;
    markDirty(true);
  });

  $("deeplApiKey").addEventListener("input", (e) => {
    state.deeplApiKey = e.target.value;
    markDirty();
  });
  document.querySelectorAll('input[name="deeplPlan"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.deeplPlan = document.querySelector('input[name="deeplPlan"]:checked').value;
      markDirty(true);
    })
  );

  $("oaBaseUrl").addEventListener("input", (e) => {
    state.oaBaseUrl = e.target.value;
    markDirty();
  });
  $("oaModel").addEventListener("input", (e) => {
    state.oaModel = e.target.value;
    markDirty();
  });
  $("oaApiKey").addEventListener("input", (e) => {
    state.oaApiKey = e.target.value;
    markDirty();
  });

  /* ---- 提示词方案管理 ---- */
  function activeProfileIdx() {
    const n = (state.promptProfiles || []).length;
    let i = parseInt($("promptProfile").value, 10);
    if (isNaN(i) || i < 0 || i >= n) i = 0;
    return i;
  }
  $("promptProfile").addEventListener("change", () => {
    state.promptActive = activeProfileIdx();
    loadPromptEditor();
    markDirty(true);
  });
  $("promptName").addEventListener("input", (e) => {
    const p = state.promptProfiles[activeProfileIdx()];
    if (p) {
      p.name = e.target.value;
      $("promptProfile").selectedOptions[0].textContent =
        p.name || "方案 " + (activeProfileIdx() + 1);
      markDirty();
    }
  });
  $("promptContent").addEventListener("input", (e) => {
    const p = state.promptProfiles[activeProfileIdx()];
    if (p) {
      p.content = e.target.value;
      markDirty();
    }
  });
  $("promptNew").addEventListener("click", () => {
    const cur = state.promptProfiles[activeProfileIdx()] || { name: "", content: "" };
    state.promptProfiles.push({
      name: (cur.name || "方案") + " 副本",
      content: cur.content || ""
    });
    state.promptActive = state.promptProfiles.length - 1;
    fillPromptProfiles();
    markDirty(true);
  });
  $("promptDel").addEventListener("click", () => {
    if (state.promptProfiles.length <= 1) {
      $("saveState").textContent = "至少保留一个方案";
      $("saveState").style.color = "var(--err)";
      return;
    }
    state.promptProfiles.splice(activeProfileIdx(), 1);
    state.promptActive = 0;
    fillPromptProfiles();
    markDirty(true);
  });

  document.querySelectorAll(".btn-group .mini").forEach((b) =>
    b.addEventListener("click", () => {
      $("oaBaseUrl").value = b.dataset.base;
      $("oaModel").value = b.dataset.model;
      state.oaBaseUrl = b.dataset.base;
      state.oaModel = b.dataset.model;
      markDirty(true);
    })
  );

  $("btn-test").addEventListener("click", testTranslate);
  $("btn-reset").addEventListener("click", resetAll);
}

let saveTimer = null;
let dirty = false;

// immediate=true 用于离散控件（开关/下拉/单选/按钮）：立刻落盘，避免
// 用户改完马上关掉弹窗导致延迟保存被取消（历史 bug：总开关失效）
function markDirty(immediate) {
  dirty = true;
  $("saveState").textContent = "未保存";
  $("saveState").style.color = "var(--err)";
  if (immediate) return void flush();
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 600);
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  return save();
}

// 弹窗关闭前兜底落盘；输入框失焦（focusout 会冒泡）也立即落盘
window.addEventListener("pagehide", () => {
  void flush();
});
document.addEventListener("focusout", () => {
  void flush();
});

async function save() {
  const r = await chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch: state });
  if (r && r.ok) {
    $("saveState").textContent = "✓ 已保存";
    $("saveState").style.color = "var(--ok)";
  }
}

async function resetAll() {
  const r = await chrome.runtime.sendMessage({ type: "RESET_SETTINGS" });
  if (r && r.ok) {
    state = r.settings;
    renderAll();
  }
}

function renderAll() {
  $("sw-enabled").checked = !!state.enabled;
  $("targetLang").value = state.targetLang || DEFAULT_TARGET;
  $("outboxTargetLang").value = state.outboxTargetLang || "en";
  $("maxConcurrent").value = state.maxConcurrent ?? "";
  updateConcurrencyPlaceholder();
  const ro = state.showOriginal !== false ? "1" : "0";
  document.querySelector(`input[name="showOriginal"][value="${ro}"]`).checked = true;
  $("chk-incoming").checked = !!state.translateIncoming;
  $("chk-outbox").checked = !!state.outboxButton;
  $("provider").value = state.provider || "google-web";
  showProviderCfg();
  $("deeplApiKey").value = state.deeplApiKey || "";
  document.querySelector(`input[name="deeplPlan"][value="${state.deeplPlan || "free"}"]`).checked = true;
  $("oaBaseUrl").value = state.oaBaseUrl || "";
  $("oaModel").value = state.oaModel || "";
  $("oaApiKey").value = state.oaApiKey || "";
  fillPromptProfiles();
  $("saveState").textContent = "";
}

/* ---------- 测试翻译 ---------- */
async function testTranslate() {
  const btn = $("btn-test");
  const out = $("testResult");
  btn.disabled = true;
  out.textContent = "翻译中…";
  out.className = "test-result";
  const r = await chrome.runtime.sendMessage({ type: "TRANSLATE", text: "Hello world. Nice to meet you! 👋" });
  btn.disabled = false;
  if (r && r.ok) {
    out.textContent = r.text;
    out.classList.add("ok");
  } else {
    out.textContent = "失败：" + (r && r.error ? r.error : "未知");
    out.classList.add("err");
  }
}

/* ---------- 启动 ---------- */
fillLangs();
fillProviders();
renderAll();
bind();
