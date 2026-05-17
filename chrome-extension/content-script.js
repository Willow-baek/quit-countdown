const PAGE_SOURCE = "clinical-memory-assistant";
const BRIDGE_SOURCE = "clinical-memory-bridge";

document.documentElement.dataset.clinicalMemoryBridge = "ready";
window.postMessage({ source: BRIDGE_SOURCE, type: "BRIDGE_READY" }, "*");

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE || data.type !== "CHATGPT_BRIDGE_REQUEST") return;

  chrome.runtime.sendMessage(
    {
      source: PAGE_SOURCE,
      type: "CHATGPT_BRIDGE",
      action: data.action,
      payload: data.payload || {},
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          type: "CHATGPT_BRIDGE_RESPONSE",
          requestId: data.requestId,
          ok: !runtimeError && response?.ok !== false,
          response: response || null,
          error: runtimeError?.message || response?.error || "",
        },
        "*"
      );
    }
  );
});
