// Discord 翻译 · MAIN world 页面脚本
// React fiber（__reactFiber$*）只存在于页面世界，content script 隔离世界看不到，
// 因此 Slate editor 的定位与替换必须在这里执行。
// 与扩展通信：CustomEvent（DOM 共享，事件跨世界可达）。
(function () {
  "use strict";

  if (window.__DT_PAGE_INJECTED__) return;
  window.__DT_PAGE_INJECTED__ = true;

  const REQ_EVENT = "DT_REPLACE_DRAFT";
  const RES_EVENT = "DT_REPLACE_RESULT";

  function findSlateEditor(tb) {
    const fiberKey = Object.keys(tb).find((k) => k.startsWith("__reactFiber$"));
    if (!fiberKey) return null;
    let f = tb[fiberKey];
    for (let i = 0; i < 20 && f; i++) {
      const e = f.memoizedProps && f.memoizedProps.editor;
      if (e && typeof e.insertText === "function" && "children" in e && "selection" in e) {
        return e;
      }
      f = f.return;
    }
    return null;
  }

  // Slate 原生替换（控制台人工验证通过的通道）：
  // apply(set_selection) → deleteFragment → insertText
  // 选区必须走 editor.apply() 操作流；直接赋值 editor.selection 会绕过
  // Discord 的状态管理，导致编辑器冻结 + 草稿存储污染。
  function slateReplaceAll(editor, text) {
    const leaves = [];
    const walk = (node, path = []) => {
      if (typeof node.text === "string") {
        leaves.push({ path, text: node.text });
        return;
      }
      (node.children || []).forEach((c, i) => walk(c, path.concat(i)));
    };
    (editor.children || []).forEach((c, i) => walk(c, [i]));
    if (!leaves.length) return false;
    const first = leaves[0];
    const last = leaves[leaves.length - 1];
    editor.apply({
      type: "set_selection",
      properties: editor.selection,
      newProperties: {
        anchor: { path: first.path, offset: 0 },
        focus: { path: last.path, offset: last.text.length }
      }
    });
    if (last.text.length > 0) editor.deleteFragment();
    editor.insertText(text);
    return true;
  }

  document.addEventListener(REQ_EVENT, (e) => {
    const detail = e.detail || {};
    const { text, reqId } = detail;
    const respond = (payload) =>
      document.dispatchEvent(
        new CustomEvent(RES_EVENT, { detail: { reqId, ...payload } })
      );

    const tb = document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (!tb) return respond({ ok: false, error: "未找到 Discord 输入框" });
    const editor = findSlateEditor(tb);
    if (!editor) {
      return respond({ ok: false, error: "未定位到 Discord 编辑器实例（界面结构可能已更新）" });
    }
    try {
      if (!slateReplaceAll(editor, String(text))) {
        return respond({ ok: false, error: "编辑器无文本内容" });
      }
      respond({ ok: true });
    } catch (err) {
      respond({ ok: false, error: String((err && err.message) || err) });
    }
  });
})();
