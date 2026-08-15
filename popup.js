const limitModeInput = document.getElementById("limitMode");
const targetTokensInput = document.getElementById("targetTokens");
const targetTokensRow = document.getElementById("targetTokensRow");
const keepInput = document.getElementById("keepCount");
const keepCountRow = document.getElementById("keepCountRow");
const batchInput = document.getElementById("batchSize");
const speedInput = document.getElementById("speedMode");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const resetButton = document.getElementById("reset");
const statusBox = document.getElementById("status");

let initialized = false;
let settingsDirty = false;
let saveTimer = null;

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function ensureContentScript(tab) {
  try { await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }); } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
}

async function sendToTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url?.startsWith("https://aistudio.google.com/")) throw new Error("Open an AI Studio conversation first");
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    const text = String(error?.message || error);
    if (!text.includes("Receiving end does not exist") && !text.includes("Could not establish connection")) throw error;
    await ensureContentScript(tab);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) throw new Error(response?.error || "Could not read state");
  return response.state;
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "unknown";
}

function updateConditionalFields() {
  const tokenMode = limitModeInput.value === "tokens";
  targetTokensRow.hidden = !tokenMode;
  keepCountRow.hidden = tokenMode;
  startButton.textContent = tokenMode ? "Trim to token target" : "Trim from beginning";
}

function render(state, page = null) {
  if (!initialized || !settingsDirty) {
    limitModeInput.value = state.limitMode === "turns" ? "turns" : "tokens";
    targetTokensInput.value = state.targetTokens ?? 100000;
    keepInput.value = state.keepCount ?? 100;
    batchInput.value = state.batchSize ?? 20;
    speedInput.value = state.speedMode || "turbo";
    initialized = true;
    updateConditionalFields();
  }

  startButton.disabled = Boolean(state.active);
  stopButton.disabled = !state.active;

  const modeText = state.mode === "delete-above"
    ? "Direct: deleting above clicked turn"
    : state.mode === "delete-below"
      ? "Direct: deleting below clicked turn"
      : "From beginning";

  const limitText = state.limitMode === "turns"
    ? (state.mode === "keep-newest" ? `Keep newest ${state.keepCount ?? 100} turns` : "Full selected side")
    : `Stop at ${formatNumber(state.targetTokens ?? 100000)} tokens`;

  statusBox.textContent = [
    `Status: ${state.status || "Idle"}`,
    `Active: ${state.active ? "Yes" : "No"}`,
    `Mode: ${modeText}`,
    `Stop condition: ${limitText}`,
    state.mode !== "keep-newest" && state.boundaryPreview ? `Clicked turn: ${state.boundaryPreview}` : null,
    `Current page turns: ${page?.turnCount ?? "unknown"}`,
    `Current page tokens: ${page?.tokenCount != null ? formatNumber(page.tokenCount) : "not detected"}`,
    `Token detector: ${page?.tokenInfo?.method || "unknown"}${page?.tokenInfo?.text ? ` | ${page.tokenInfo.text}` : ""}`,
    `Verified deleted: ${state.verifiedDeleted || 0}`,
    `Pending verification: ${state.pendingBatch ? "Yes" : "No"}`,
    `Speed mode: ${state.speedMode || "turbo"}`,
    `Background wake: ${state.lastKickAt ? new Date(state.lastKickAt).toLocaleTimeString() : "not yet"}`
  ].filter(Boolean).join("\n");
}

async function refresh() {
  try {
    const state = await readState();
    let page = null;
    try { page = await sendToTab({ type: "PAGE_STATUS" }); } catch (_) {}
    render(state, page?.ok ? page : null);
  } catch (error) {
    statusBox.textContent = error.message || String(error);
  }
}

async function persistSettings() {
  const limitMode = limitModeInput.value === "turns" ? "turns" : "tokens";
  const targetTokens = Math.max(1000, Math.min(10000000, Number(targetTokensInput.value) || 100000));
  const keepCount = Math.max(1, Number(keepInput.value) || 100);
  const batchSize = Math.max(1, Math.min(50, Number(batchInput.value) || 20));
  const speedMode = ["turbo", "balanced", "safe"].includes(speedInput.value) ? speedInput.value : "turbo";
  const response = await chrome.runtime.sendMessage({
    type: "SET_STATE",
    patch: { limitMode, targetTokens, keepCount, batchSize, speedMode }
  });
  if (!response?.ok) throw new Error(response?.error || "Could not save settings");
  settingsDirty = false;
}

function markDirty() {
  settingsDirty = true;
  updateConditionalFields();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistSettings().catch((error) => { statusBox.textContent = error.message || String(error); });
  }, 150);
}

limitModeInput.addEventListener("change", markDirty);
targetTokensInput.addEventListener("input", markDirty);
keepInput.addEventListener("input", markDirty);
batchInput.addEventListener("input", markDirty);
speedInput.addEventListener("change", markDirty);

startButton.addEventListener("click", async () => {
  try {
    await persistSettings();
    const limitMode = limitModeInput.value === "turns" ? "turns" : "tokens";
    const targetTokens = Math.max(1000, Math.min(10000000, Number(targetTokensInput.value) || 100000));
    const keepCount = Math.max(1, Number(keepInput.value) || 100);
    const batchSize = Math.max(1, Math.min(50, Number(batchInput.value) || 20));
    const speedMode = ["turbo", "balanced", "safe"].includes(speedInput.value) ? speedInput.value : "turbo";
    const response = await sendToTab({ type: "START_TRIM", limitMode, targetTokens, keepCount, batchSize, speedMode });
    if (!response?.ok) throw new Error(response?.error || "Could not start");
    await chrome.runtime.sendMessage({ type: "KICK_JOB", reason: "popup start" });
    await refresh();
    window.close();
  } catch (error) {
    statusBox.textContent = error.message || String(error);
  }
});

stopButton.addEventListener("click", async () => {
  try {
    let response;
    try { response = await sendToTab({ type: "STOP_TRIM" }); }
    catch (_) { response = await chrome.runtime.sendMessage({ type: "SET_STATE", patch: { active: false, pendingBatch: false, status: "Stopped by user" } }); }
    if (!response?.ok) throw new Error(response?.error || "Could not stop");
    await refresh();
  } catch (error) {
    statusBox.textContent = error.message || String(error);
  }
});

resetButton.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "RESET_STATE" });
    await refresh();
  } catch (error) {
    statusBox.textContent = error.message || String(error);
  }
});

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await refresh();
  }, 120);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.trimmerState) scheduleRefresh();
});

setInterval(refresh, 1000);
updateConditionalFields();
refresh();
