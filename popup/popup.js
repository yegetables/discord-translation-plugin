// popup：设置面板逻辑（MV3 module）
import { LANGS, DEFAULT_TARGET, sortedLangEntries } from "../lib/lang.js";

const $ = (id) => document.getElementById(id);

let state = null; // 当前内存态（未保存前用户编辑的合并值）

/* ---------- 读取初始设置 ---------- */
const initResult = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
state = initResult && initResult.ok ? initResult.settings : {};

/* ---------- 语言下拉 ---------- */
function fillLangs() {
  const sel = $("targetLang");
  sel.innerHTML = "";
  for (const [code, [zh, en]] of sortedLangEntries()) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = zh + " · " + en;
    sel.appendChild(opt);
  }
  sel.value = state.targetLang || DEFAULT_TARGET;
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

/* ---------- 通用控件绑定（change 时只改内存态，Save 时统一提交） ---------- */
function bind() {
  $("sw-enabled").checked = !!state.enabled;

  $("targetLang").addEventListener("change", (e) => {
    state.targetLang = e.target.value;
    markDirty();
  });
  $("provider").addEventListener("change", (e) => {
    state.provider = e.target.value;
    showProviderCfg();
    markDirty();
  });
  document.querySelectorAll('input[name="showOriginal"]').forEach((r) => {
    r.addEventListener("change", () => {
      state.showOriginal = document.querySelector('input[name="showOriginal"]:checked').value === "1";
      markDirty();
    });
  });
  $("chk-incoming").addEventListener("change", (e) => {
    state.translateIncoming = e.target.checked;
    markDirty();
  });
  $("chk-outbox").addEventListener("change", (e) => {
    state.outboxButton = e.target.checked;
    markDirty();
  });

  $("deeplApiKey").addEventListener("input", (e) => {
    state.deeplApiKey = e.target.value;
    markDirty();
  });
  document.querySelectorAll('input[name="deeplPlan"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.deeplPlan = document.querySelector('input[name="deeplPlan"]:checked').value;
      markDirty();
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

  document.querySelectorAll(".btn-group .mini").forEach((b) =>
    b.addEventListener("click", () => {
      $("oaBaseUrl").value = b.dataset.base;
      $("oaModel").value = b.dataset.model;
      state.oaBaseUrl = b.dataset.base;
      state.oaModel = b.dataset.model;
      markDirty();
    })
  );

  $("btn-test").addEventListener("click", testTranslate);
  $("btn-reset").addEventListener("click", resetAll);
}

function markDirty() {
  $("saveState").textContent = "未保存";
  $("saveState").style.color = "var(--err)";
  scheduleSave();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

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
