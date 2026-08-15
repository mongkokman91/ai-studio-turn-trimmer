const STATE_KEY = "trimmerState";
const ALARM_NAME = "aiStudioTurnTrimmerWake";
const SCHEMA_VERSION = 12;

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  active: false,
  mode: "keep-newest",
  keepCount: 100,
  limitMode: "tokens",
  targetTokens: 100000,
  batchSize: 20,
  speedMode: "turbo",
  boundaryIndexHint: null,
  boundaryPreview: null,
  beforeCount: null,
  beforeTokenCount: null,
  pendingBatch: false,
  locallyDeleted: 0,
  verifiedDeleted: 0,
  zeroProgressBatches: 0,
  status: "Idle",
  conversationKey: null,
  conversationPath: null,
  conversationUrl: null,
  tabId: null,
  updatedAt: null,
  lastKickAt: null
};

async function getState() {
  const result = await chrome.storage.local.get(STATE_KEY);
  const stored = result[STATE_KEY];
  if (!stored || stored.schemaVersion !== SCHEMA_VERSION) return { ...DEFAULT_STATE };
  return { ...DEFAULT_STATE, ...stored };
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  await syncAlarm(next);
  return next;
}

async function resetState() {
  const next = { ...DEFAULT_STATE, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  await chrome.alarms.clear(ALARM_NAME);
  return next;
}

async function syncAlarm(state) {
  if (state.active) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
}

function isAiStudioUrl(url) {
  return typeof url === "string" && url.startsWith("https://aistudio.google.com/");
}

function conversationKeyFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/prompts\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_) {
    return null;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch (_) {}

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (error) {
    return false;
  }
}

async function findTargetTab(state) {
  if (Number.isInteger(state.tabId)) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab && isAiStudioUrl(tab.url)) return tab;
    } catch (_) {}
  }

  const tabs = await chrome.tabs.query({ url: "https://aistudio.google.com/*" });
  if (!tabs.length) return null;

  if (state.conversationKey) {
    const byKey = tabs.find((tab) => conversationKeyFromUrl(tab.url) === state.conversationKey);
    if (byKey) return byKey;
  }

  if (state.conversationUrl) {
    const exact = tabs.find((tab) => tab.url === state.conversationUrl);
    if (exact) return exact;
  }

  return tabs[0];
}

async function kickJob(reason = "background wake") {
  const state = await getState();
  if (!state.active) return { ok: false, reason: "inactive" };

  const tab = await findTargetTab(state);
  if (!tab?.id) {
    await setState({ status: "Paused: open the target AI Studio conversation to resume" });
    return { ok: false, reason: "tab not found" };
  }

  await setState({
    tabId: tab.id,
    conversationUrl: tab.url,
    lastKickAt: Date.now(),
    status: state.status || `Resuming after ${reason}`
  });

  if (tab.discarded) {
    try {
      await chrome.tabs.reload(tab.id);
      return { ok: true, reloaded: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  }

  const injected = await ensureContentScript(tab.id);
  if (!injected) return { ok: false, reason: "content injection failed" };

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "RESUME_TRIM", reason });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  await chrome.storage.local.set({ [STATE_KEY]: state });
  await syncAlarm(state);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  await syncAlarm(state);
  if (state.active) await kickJob("browser startup");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await kickJob("scheduled background wake");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isAiStudioUrl(tab.url)) return;
  const state = await getState();
  if (!state.active) return;
  if (state.tabId === tabId || conversationKeyFromUrl(tab.url) === state.conversationKey) {
    await setState({ tabId, conversationUrl: tab.url });
    await kickJob("tab reload");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "GET_STATE") {
      sendResponse({ ok: true, state: await getState() });
      return;
    }
    if (message?.type === "SET_STATE") {
      sendResponse({ ok: true, state: await setState(message.patch || {}) });
      return;
    }
    if (message?.type === "RESET_STATE") {
      sendResponse({ ok: true, state: await resetState() });
      return;
    }
    if (message?.type === "REGISTER_TARGET") {
      const tabId = sender.tab?.id ?? message.tabId ?? null;
      const url = sender.tab?.url ?? message.url ?? null;
      sendResponse({
        ok: true,
        state: await setState({
          tabId,
          conversationUrl: url,
          conversationPath: message.path || null,
          conversationKey: message.conversationKey || conversationKeyFromUrl(url)
        })
      });
      return;
    }
    if (message?.type === "KICK_JOB") {
      sendResponse(await kickJob(message.reason || "manual kick"));
      return;
    }
    if (message?.type === "JOB_COMPLETE") {
      const state = await setState({
        active: false,
        pendingBatch: false,
        status: message.status || "Complete"
      });
      try {
        await chrome.notifications.create({
          type: "basic",
          iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9WQAAAAASUVORK5CYII=",
          title: "AI Studio Turn Trimmer",
          message: state.status
        });
      } catch (_) {}
      sendResponse({ ok: true, state });
      return;
    }
    sendResponse({ ok: false, error: "Unknown message" });
  })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
