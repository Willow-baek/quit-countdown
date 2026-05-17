const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_RECT = {
  left: 0,
  top: 0,
  width: 360,
  height: 900,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "clinical-memory-assistant" || message.type !== "CHATGPT_BRIDGE") {
    return false;
  }

  handleBridgeMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        status: "error",
        error: error?.message || "Unknown bridge error",
      });
    });

  return true;
});

async function handleBridgeMessage(message) {
  const action = message.action;
  const layout = message.payload?.layout || {};

  if (action === "FOCUS_CHATGPT") {
    return focusExistingChatGPT();
  }

  if (action === "OPEN_OR_FOCUS_CHATGPT") {
    const focused = await focusExistingChatGPT();
    if (focused.status === "focused") return focused;
    return openChatGPTWindow(layout.gpt);
  }

  return {
    ok: false,
    status: "unknown_action",
    error: `Unsupported action: ${action}`,
  };
}

async function findChatGPTTabs() {
  const groups = await Promise.all(CHATGPT_URL_PATTERNS.map((url) => chrome.tabs.query({ url })));
  const tabs = groups.flat().filter((tab) => typeof tab.id === "number" && typeof tab.windowId === "number");
  return tabs.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
}

async function focusExistingChatGPT() {
  const [tab] = await findChatGPTTabs();
  if (!tab) {
    return {
      ok: true,
      status: "not_found",
    };
  }

  await chrome.tabs.update(tab.id, { active: true });
  await normalizeAndFocusWindow(tab.windowId);

  return {
    ok: true,
    status: "focused",
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || "",
  };
}

async function normalizeAndFocusWindow(windowId) {
  const currentWindow = await chrome.windows.get(windowId);
  if (currentWindow.state === "minimized") {
    await chrome.windows.update(windowId, { state: "normal" });
  }
  await chrome.windows.update(windowId, { focused: true });
}

async function openChatGPTWindow(rect = DEFAULT_RECT) {
  const safeRect = sanitizeRect(rect);
  const createdWindow = await chrome.windows.create({
    url: DEFAULT_CHATGPT_URL,
    type: "popup",
    focused: true,
    left: safeRect.left,
    top: safeRect.top,
    width: safeRect.width,
    height: safeRect.height,
  });

  return {
    ok: true,
    status: "opened",
    windowId: createdWindow?.id,
  };
}

function sanitizeRect(rect = DEFAULT_RECT) {
  return {
    left: finiteNumber(rect.left, DEFAULT_RECT.left),
    top: finiteNumber(rect.top, DEFAULT_RECT.top),
    width: Math.max(280, finiteNumber(rect.width, DEFAULT_RECT.width)),
    height: Math.max(480, finiteNumber(rect.height, DEFAULT_RECT.height)),
  };
}

function finiteNumber(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : fallback;
}
