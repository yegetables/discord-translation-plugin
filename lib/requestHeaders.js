// 按域名移除 Origin 请求头（网络层实现）
// Origin 属于 Fetch 规范的 forbidden header，JS 层设置/删除均无效；
// 参照 FluentRead PR #778 的做法，用 declarativeNetRequest 动态规则在网络层移除，
// 并用 initiatorDomains 限定为扩展自身发出的请求，网页的请求不受影响。

const RULE_ID = 2763000; // 本插件专用编号段，避免与其他动态规则冲突

// match pattern / DNR 域名均不含端口，返回 hostname 后任意端口都匹配
function normalizeHost(value) {
  try {
    const u = new URL(String(value || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch {
    return null;
  }
}

// 把当前配置同步成一条动态规则；baseUrl 无效或 removeOrigin 关闭时等价于清空规则
export async function syncOriginHeaderRule(baseUrl, removeOrigin) {
  const host = removeOrigin ? normalizeHost(baseUrl) : null;
  const addRules = host
    ? [
        {
          id: RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Origin", operation: "remove" }]
          },
          condition: {
            regexFilter:
              "^https?://" +
              host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "(?::[0-9]+)?/",
            initiatorDomains: [new URL(chrome.runtime.getURL("")).hostname],
            resourceTypes: ["xmlhttprequest"]
          }
        }
      ]
    : [];
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = (current.rules || []).map((r) => r.id).filter((id) => id === RULE_ID);
  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}
