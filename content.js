(() => {
  "use strict";

  if (window.__AI_STUDIO_TURN_TRIMMER_V12_LOADED__) return;
  window.__AI_STUDIO_TURN_TRIMMER_V12_LOADED__ = true;

  const OVERLAY_ID = "ai-studio-turn-trimmer-overlay";
  const ACTIONS_CLASS = "ai-studio-turn-trimmer-direct-actions";
  const MAX_ZERO_PROGRESS_BATCHES = 3;
  const FIRST_TURN_TIMEOUT_MS = 12000;

  const SPEED_PROFILES = {
    turbo: {
      stableIntervalMs: 75,
      requiredStableReadings: 1,
      maxStabilizeMs: 650,
      menuTimeoutMs: 1800,
      confirmGraceMs: 120,
      removalTimeoutMs: 3500,
      betweenDeletionsMs: 60,
      saveWaitMs: 1800,
      scrollSettleMs: 35,
      overlaySettleMs: 25,
      tokenUpdateTimeoutMs: 10000
    },
    balanced: {
      stableIntervalMs: 100,
      requiredStableReadings: 2,
      maxStabilizeMs: 1200,
      menuTimeoutMs: 2500,
      confirmGraceMs: 300,
      removalTimeoutMs: 5000,
      betweenDeletionsMs: 140,
      saveWaitMs: 3000,
      scrollSettleMs: 70,
      overlaySettleMs: 50,
      tokenUpdateTimeoutMs: 12000
    },
    safe: {
      stableIntervalMs: 150,
      requiredStableReadings: 2,
      maxStabilizeMs: 2000,
      menuTimeoutMs: 3500,
      confirmGraceMs: 900,
      removalTimeoutMs: 7000,
      betweenDeletionsMs: 300,
      saveWaitMs: 5000,
      scrollSettleMs: 120,
      overlaySettleMs: 90,
      tokenUpdateTimeoutMs: 15000
    }
  };

  let currentProfile = SPEED_PROFILES.turbo;
  let loopRunning = false;
  let stopRequested = false;
  let actionObserverTimer = null;
  let tokenCounterElement = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getTurns = () => Array.from(document.querySelectorAll("ms-chat-session ms-chat-turn"));
  const getTurnCount = () => document.querySelectorAll("ms-chat-session ms-chat-turn").length;

  function currentConversationKey() {
    const match = location.pathname.match(/^\/prompts\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : location.pathname;
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function parseTokenCount(text) {
    const normalized = String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[\u2000-\u200b\u202f\u205f\u3000]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const patterns = [
      /(?:^|\b)([0-9]{1,3}(?:[,\s][0-9]{3})+|[0-9]+)\s*tokens?\b/i,
      /\btokens?\s*[:=]?\s*([0-9]{1,3}(?:[,\s][0-9]{3})+|[0-9]+)\b/i,
      /(?:^|\b)([0-9]+(?:\.\d+)?)\s*([km])\s*tokens?\b/i
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;
      let value = Number(String(match[1]).replace(/[,\s]/g, ""));
      if (match[2]) value *= match[2].toLowerCase() === "m" ? 1000000 : 1000;
      if (Number.isFinite(value) && value >= 0) return Math.round(value);
    }
    return null;
  }

  function allOpenRoots(root = document) {
    const roots = [];
    const queue = [root];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      roots.push(current);
      let elements = [];
      try { elements = current.querySelectorAll ? Array.from(current.querySelectorAll("*")) : []; } catch (_) {}
      for (const element of elements) {
        if (element.shadowRoot && !seen.has(element.shadowRoot)) queue.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function tokenCounterCandidate(element, exactOnly = false, method = "dom") {
    if (!visible(element)) return null;
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 180) return null;
    if (exactOnly && !/^(?:[0-9]{1,3}(?:[,\s][0-9]{3})+|[0-9]+|[0-9]+(?:\.\d+)?[km])\s*tokens?$/i.test(text)) return null;
    const value = parseTokenCount(text);
    if (value == null) return null;
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/^(?:[0-9]{1,3}(?:[,\s][0-9]{3})+|[0-9]+|[0-9]+(?:\.\d+)?[km])\s*tokens?$/i.test(text)) score += 100;
    if (rect.top >= 0 && rect.top <= 220) score += 60;
    if (rect.left >= 250 && rect.left <= window.innerWidth - 250) score += 20;
    if (text.length <= 24) score += 20;
    if (/token/i.test(element.getAttribute?.("aria-label") || "")) score += 30;
    if (/token/i.test(String(element.className || ""))) score += 15;
    return { element, value, text, method, score, top: rect.top, left: rect.left };
  }

  function findTokenCounter() {
    const matches = [];
    const roots = allOpenRoots(document);
    const selectors = [
      "ms-prompt-header *",
      "ms-toolbar *",
      "header *",
      "[class*='token' i]",
      "[aria-label*='token' i]",
      "[title*='token' i]",
      "span",
      "div"
    ];

    for (const root of roots) {
      for (const selector of selectors) {
        let elements = [];
        try { elements = Array.from(root.querySelectorAll(selector)); } catch (_) {}
        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          if (rect.top < -10 || rect.top > 260 || rect.width <= 0 || rect.height <= 0) continue;
          const candidate = tokenCounterCandidate(element, false, root === document ? "document" : "shadow-dom");
          if (candidate) matches.push(candidate);
        }
      }
    }

    const unique = [];
    const seen = new Set();
    for (const match of matches) {
      const key = `${match.value}|${match.text}|${Math.round(match.top)}|${Math.round(match.left)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(match);
    }
    unique.sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.top - b.top);
    return unique[0] || null;
  }

  function getDisplayedTokenInfo() {
    if (tokenCounterElement?.isConnected) {
      const text = (tokenCounterElement.innerText || tokenCounterElement.textContent || "").replace(/\s+/g, " ").trim();
      const value = parseTokenCount(text);
      if (value != null && visible(tokenCounterElement)) {
        return { value, text, method: tokenCounterElement.getRootNode() === document ? "cached-document" : "cached-shadow-dom" };
      }
    }

    const match = findTokenCounter();
    tokenCounterElement = match?.element || null;
    return match ? { value: match.value, text: match.text, method: match.method } : { value: null, text: null, method: "not-found" };
  }

  function getDisplayedTokenCount() {
    return getDisplayedTokenInfo().value;
  }

  function formatNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "unknown";
  }

  async function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload });
  }

  async function getState() {
    const response = await send("GET_STATE");
    if (!response?.ok) throw new Error(response?.error || "Could not read extension state");
    return response.state;
  }

  async function setState(patch) {
    const response = await send("SET_STATE", { patch });
    if (!response?.ok) throw new Error(response?.error || "Could not save extension state");
    updateOverlay(response.state);
    refreshActionButtons(response.state);
    return response.state;
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.dataset.hidden = "true";
      document.documentElement.appendChild(overlay);
    }
    return overlay;
  }

  function modeLabel(mode) {
    if (mode === "delete-above") return "Delete above selected turn";
    if (mode === "delete-below") return "Delete below selected turn";
    return "From beginning, keep newest N";
  }

  function updateOverlay(state) {
    const overlay = ensureOverlay();
    overlay.dataset.hidden = state.active ? "false" : "true";
    const limitText = state.limitMode === "tokens"
      ? `Token target: ${formatNumber(state.targetTokens ?? 100000)}\nCurrent tokens: ${formatNumber(getDisplayedTokenCount())}\n`
      : (state.mode === "keep-newest" ? `Keep newest turns: ${state.keepCount}\n` : "Stop at clicked boundary\n");
    overlay.textContent = state.active
      ? `AI Studio Turn Trimmer\n\n${state.status || "Working..."}\n\nMode: ${modeLabel(state.mode)}\n${state.mode === "keep-newest" ? "" : `Selected turn: ${state.boundaryPreview || `turn ${(state.boundaryIndexHint ?? 0) + 1}`}\n`}${limitText}Batch: ${state.batchSize}\nSpeed: ${state.speedMode || "turbo"}\nVerified deleted: ${state.verifiedDeleted || 0}\n\nThe clicked turn is kept.`
      : "";
  }

  function cleanTurnPreview(turn) {
    const clone = turn.cloneNode(true);
    clone.querySelectorAll(`.${ACTIONS_CLASS}, .ai-studio-turn-trimmer-boundary-button, ms-chat-turn-options, button, mat-icon, .material-symbols-outlined, [role='button'], time`).forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || "")
      .replace(/Expand to view model thoughts/gi, " ")
      .replace(/\bThoughts\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220) || "[Turn has no readable text]";
  }

  function refreshActionButtons(state) {
    const turns = getTurns();
    for (let index = 0; index < turns.length; index += 1) {
      const actions = turns[index].querySelector(`.${ACTIONS_CLASS}`);
      if (!actions) continue;
      const above = actions.querySelector("[data-direction='above']");
      const below = actions.querySelector("[data-direction='below']");
      const disabled = Boolean(state.active);
      if (above) above.disabled = disabled || index === 0;
      if (below) below.disabled = disabled || index === turns.length - 1;
    }
  }

  async function startDirectionalTrim(turn, mode) {
    const turns = getTurns();
    const index = turns.indexOf(turn);
    if (index < 0) throw new Error("The clicked turn is no longer present");

    const deleteCount = mode === "delete-above" ? index : turns.length - index - 1;
    if (deleteCount <= 0) {
      alert(mode === "delete-above" ? "There are no turns above this turn." : "There are no turns below this turn.");
      return;
    }

    const state = await getState();
    const limitMode = state.limitMode === "turns" ? "turns" : "tokens";
    const targetTokens = Math.max(1000, Number(state.targetTokens) || 100000);
    const currentTokens = getDisplayedTokenCount();

    if (limitMode === "tokens" && currentTokens == null) {
      throw new Error("AI Studio's displayed token counter could not be detected. Open the popup and use Turn-based mode, or reload the conversation.");
    }
    if (limitMode === "tokens" && currentTokens <= targetTokens) {
      alert(`This conversation is already at ${formatNumber(currentTokens)} tokens, which is at or below the ${formatNumber(targetTokens)} target.`);
      return;
    }

    const direction = mode === "delete-above" ? "above" : "below";
    const preview = cleanTurnPreview(turn);
    const stoppingText = limitMode === "tokens"
      ? `Stop when the conversation reaches ${formatNumber(targetTokens)} tokens or the clicked turn is reached, whichever comes first.`
      : `Delete all ${deleteCount} turns ${direction} this turn.`;
    const approved = confirm(
      `${stoppingText}\n\nThe clicked turn will be kept.\n\nSelected turn begins:\n${preview}\n\nProceed?`
    );
    if (!approved) return;

    stopRequested = false;
    await setState({
      active: true,
      mode,
      limitMode,
      targetTokens,
      boundaryIndexHint: index,
      boundaryPreview: preview,
      beforeCount: null,
      beforeTokenCount: null,
      pendingBatch: false,
      locallyDeleted: 0,
      verifiedDeleted: 0,
      zeroProgressBatches: 0,
      conversationKey: currentConversationKey(),
      conversationPath: location.pathname,
      conversationUrl: location.href,
      status: `Starting direct trim: delete ${direction} clicked turn`,
      batchSize: Math.max(1, Math.min(50, Number(state.batchSize) || 20)),
      speedMode: ["turbo", "balanced", "safe"].includes(state.speedMode) ? state.speedMode : "turbo"
    });
    await send("REGISTER_TARGET", {
      path: location.pathname,
      url: location.href,
      conversationKey: currentConversationKey()
    });
    runLoop();
  }

  function addDirectActionButtons() {
    const turns = getTurns();
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const existing = turn.querySelector(`.${ACTIONS_CLASS}`);
      if (existing?.dataset.version === "12") continue;
      if (existing) existing.remove();

      const actions = document.createElement("div");
      actions.className = ACTIONS_CLASS;
      actions.dataset.version = "12";

      const above = document.createElement("button");
      above.type = "button";
      above.dataset.direction = "above";
      above.textContent = "Trim ↑";
      above.title = "Keep this turn and delete every older turn above it";
      above.disabled = index === 0;
      above.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startDirectionalTrim(turn, "delete-above").catch((error) => alert(error.message || String(error)));
      });

      const below = document.createElement("button");
      below.type = "button";
      below.dataset.direction = "below";
      below.textContent = "Trim ↓";
      below.title = "Keep this turn and delete every newer turn below it";
      below.disabled = index === turns.length - 1;
      below.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startDirectionalTrim(turn, "delete-below").catch((error) => alert(error.message || String(error)));
      });

      actions.append(above, below);
      turn.style.position = "relative";
      turn.appendChild(actions);
    }
  }

  function startActionObserver() {
    const session = document.querySelector("ms-chat-session");
    if (!session) {
      setTimeout(startActionObserver, 500);
      return;
    }

    addDirectActionButtons();
    const observer = new MutationObserver(() => {
      if (actionObserverTimer) return;
      actionObserverTimer = setTimeout(async () => {
        actionObserverTimer = null;
        addDirectActionButtons();
        try { refreshActionButtons(await getState()); } catch (_) {}
      }, 200);
    });
    observer.observe(session, { childList: true, subtree: true });
  }

  async function waitForCondition(fn, timeoutMs, intervalMs = 50) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const value = fn();
        if (value) return value;
      } catch (_) {}
      await sleep(intervalMs);
    }
    return false;
  }

  async function detectStableCount() {
    const first = await waitForCondition(() => getTurnCount() || false, FIRST_TURN_TIMEOUT_MS, 100);
    if (!first) throw new Error("No AI Studio turns were detected");

    let previous = getTurnCount();
    let stable = 0;
    const started = Date.now();

    while (Date.now() - started < currentProfile.maxStabilizeMs) {
      await sleep(currentProfile.stableIntervalMs);
      const current = getTurnCount();
      if (current === previous && current > 0) {
        stable += 1;
        if (stable >= currentProfile.requiredStableReadings) return current;
      } else {
        previous = current;
        stable = 0;
      }
    }

    const finalCount = getTurnCount();
    if (!finalCount) throw new Error("The conversation count did not stabilize");
    return finalCount;
  }

  function getOptionsButton(turn) {
    const root = turn.querySelector("ms-chat-turn-options") || turn;
    const buttons = Array.from(root.querySelectorAll("button")).filter((button) => !button.closest(`.${ACTIONS_CLASS}`));
    return buttons.find((button) => {
      const aria = (button.getAttribute("aria-label") || "").toLowerCase();
      return button.matches(".mat-mdc-menu-trigger") || button.getAttribute("aria-haspopup") === "menu" || aria.includes("more") || aria.includes("option");
    }) || null;
  }

  function getOpenMenu() {
    const nodes = Array.from(document.querySelectorAll(
      ".cdk-overlay-container [role='menu'], .cdk-overlay-container .mat-mdc-menu-panel, .cdk-overlay-container .mat-mdc-menu-content"
    ));
    return nodes.find(visible) || null;
  }

  function findDeleteButton(menu) {
    if (!menu) return null;
    const items = Array.from(menu.querySelectorAll("button, [role='menuitem']"));
    return items.find((item) => {
      const text = (item.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "delete" || text.includes("delete turn") || text.includes("delete message")) return true;
      const icon = item.querySelector(".material-symbols-outlined, mat-icon");
      return icon && icon.textContent.trim().toLowerCase() === "delete";
    }) || null;
  }

  function findConfirmButton() {
    const dialogs = Array.from(document.querySelectorAll("mat-dialog-container, .mat-mdc-dialog-container, [role='dialog']"));
    const dialog = dialogs.find(visible);
    if (!dialog) return null;
    const buttons = Array.from(dialog.querySelectorAll("button"));
    return buttons.find((button) => {
      const text = (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return text === "delete" || text === "confirm" || (button.type === "submit" && text !== "cancel");
    }) || null;
  }

  async function closeOverlays() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await sleep(currentProfile.overlaySettleMs);
  }

  async function deleteTurn(turn) {
    if (!turn) return { success: false, reason: "No target turn found" };
    const before = getTurnCount();
    turn.scrollIntoView({ block: "center", behavior: "auto" });
    await sleep(currentProfile.scrollSettleMs);
    await closeOverlays();

    const options = getOptionsButton(turn);
    if (!options) return { success: false, reason: "Options button not found" };

    options.click();
    const menu = await waitForCondition(getOpenMenu, currentProfile.menuTimeoutMs, 30);
    if (!menu) return { success: false, reason: "Turn menu did not open" };

    const deleteButton = findDeleteButton(menu);
    if (!deleteButton) return { success: false, reason: "Delete action not found" };

    deleteButton.click();
    const confirm = await waitForCondition(findConfirmButton, currentProfile.confirmGraceMs, 25);
    if (confirm) confirm.click();

    const removed = await waitForCondition(() => getTurnCount() < before, currentProfile.removalTimeoutMs, 40);
    if (!removed) return { success: false, reason: `Turn count stayed at ${before}` };

    return { success: true, before, after: getTurnCount() };
  }

  async function waitForTokenDecrease(beforeTokens) {
    if (beforeTokens == null) return null;
    const changed = await waitForCondition(() => {
      const current = getDisplayedTokenCount();
      return current != null && current < beforeTokens ? current : false;
    }, currentProfile.tokenUpdateTimeoutMs, 50);
    return changed || null;
  }

  function normalizedBoundaryIndex(state, count) {
    if (!Number.isInteger(state.boundaryIndexHint)) return -1;
    if (count <= 0) return -1;
    return Math.max(0, Math.min(count - 1, state.boundaryIndexHint));
  }

  function getDeletionPlan(state) {
    const turns = getTurns();
    const count = turns.length;
    const tokenCount = getDisplayedTokenCount();
    const tokenMode = state.limitMode === "tokens";
    const targetTokens = Math.max(1000, Number(state.targetTokens) || 100000);

    if (tokenMode && tokenCount == null) {
      throw new Error("Token counter not detected, including inside AI Studio shadow DOM. Reload the page once and reopen the popup. The popup will show token diagnostics.");
    }

    const tokenTargetReached = tokenMode && tokenCount <= targetTokens;

    if (state.mode === "delete-above" || state.mode === "delete-below") {
      const boundaryIndex = normalizedBoundaryIndex(state, count);
      if (boundaryIndex < 0) throw new Error("The direct-trim position was lost. Restart by clicking Trim Up or Trim Down on the turn again.");
      const remaining = state.mode === "delete-above" ? boundaryIndex : count - boundaryIndex - 1;
      const target = state.mode === "delete-above" ? turns[0] : turns[count - 1];
      return {
        complete: remaining <= 0 || tokenTargetReached,
        completionReason: tokenTargetReached ? "token-target" : (remaining <= 0 ? "boundary" : null),
        remaining, target, boundaryIndex, count, tokenCount, targetTokens, tokenMode
      };
    }

    if (tokenMode) {
      const remaining = Math.max(0, count - 1);
      return {
        complete: tokenTargetReached || remaining <= 0,
        completionReason: tokenTargetReached ? "token-target" : (remaining <= 0 ? "last-turn" : null),
        remaining, target: turns[0], boundaryIndex: -1, count, tokenCount, targetTokens, tokenMode
      };
    }

    const remaining = count - state.keepCount;
    return { complete: remaining <= 0, completionReason: remaining <= 0 ? "turn-target" : null, remaining, target: turns[0], boundaryIndex: -1, count, tokenCount, targetTokens, tokenMode };
  }

  async function verifyPendingBatch(state, currentCount) {
    if (!state.pendingBatch) return state;

    const persisted = Math.max(0, (state.beforeCount ?? currentCount) - currentCount);
    if (persisted > 0) {
      const patch = {
        pendingBatch: false,
        beforeTokenCount: null,
        verifiedDeleted: (state.verifiedDeleted || 0) + persisted,
        zeroProgressBatches: 0,
        status: `Verified ${persisted} saved deletions. Current turns: ${currentCount}. Current tokens: ${formatNumber(getDisplayedTokenCount())}`
      };
      if (state.mode === "delete-above" && Number.isInteger(state.boundaryIndexHint)) {
        patch.boundaryIndexHint = Math.max(0, state.boundaryIndexHint - persisted);
      } else if (state.mode === "delete-below" && Number.isInteger(state.boundaryIndexHint)) {
        patch.boundaryIndexHint = Math.min(Math.max(0, currentCount - 1), state.boundaryIndexHint);
      }
      return setState(patch);
    }

    const failures = (state.zeroProgressBatches || 0) + 1;
    if (failures >= MAX_ZERO_PROGRESS_BATCHES) {
      return setState({
        active: false,
        pendingBatch: false,
        beforeTokenCount: null,
        zeroProgressBatches: failures,
        status: "Stopped because three consecutive batches made no saved progress"
      });
    }

    return setState({
      pendingBatch: false,
      beforeTokenCount: null,
      zeroProgressBatches: failures,
      status: `No saved progress in the last batch. Retrying (${failures}/${MAX_ZERO_PROGRESS_BATCHES})`
    });
  }

  async function runBatch(state) {
    let plan = getDeletionPlan(state);
    const intended = Math.min(state.batchSize, plan.remaining);
    let locallyDeleted = 0;

    for (let index = 0; index < intended; index += 1) {
      if (stopRequested) break;
      state = await getState();
      if (!state.active) break;

      plan = getDeletionPlan(state);
      if (plan.complete) break;

      await setState({
        status: `Deleting ${index + 1} of ${intended} in this batch. Visible turns: ${plan.count}. Current tokens: ${formatNumber(plan.tokenCount)}. Mode: ${modeLabel(state.mode)}`
      });

      const beforeTokens = plan.tokenMode ? plan.tokenCount : null;
      const result = await deleteTurn(plan.target);
      if (!result.success) {
        await setState({ status: `Batch stopped early: ${result.reason}` });
        break;
      }

      locallyDeleted += 1;

      if (plan.tokenMode) {
        const afterTokens = await waitForTokenDecrease(beforeTokens);
        if (afterTokens == null) {
          await setState({ status: "Token counter did not refresh after deletion. Reloading early to verify accurately." });
          break;
        }
        if (afterTokens <= plan.targetTokens) {
          await setState({ status: `Token target reached locally: ${formatNumber(afterTokens)} tokens.` });
          break;
        }
      }

      await sleep(currentProfile.betweenDeletionsMs);
    }

    return locallyDeleted;
  }

  async function runLoop() {
    if (loopRunning) return;
    loopRunning = true;
    stopRequested = false;

    try {
      let state = await getState();
      currentProfile = SPEED_PROFILES[state.speedMode] || SPEED_PROFILES.turbo;
      updateOverlay(state);
      refreshActionButtons(state);
      if (!state.active) return;

      if (state.conversationKey && state.conversationKey !== currentConversationKey()) {
        await setState({ active: false, pendingBatch: false, status: "Stopped because the AI Studio conversation changed" });
        return;
      }

      await send("REGISTER_TARGET", {
        path: location.pathname,
        url: location.href,
        conversationKey: currentConversationKey()
      });

      const currentCount = await detectStableCount();
      state = await verifyPendingBatch(state, currentCount);
      if (!state.active) return;

      const plan = getDeletionPlan(state);
      if (plan.complete) {
        let status;
        if (plan.completionReason === "token-target") {
          status = `Complete. Token target reached: ${formatNumber(plan.tokenCount)} tokens (target ${formatNumber(plan.targetTokens)}).`;
        } else if (state.mode === "keep-newest") {
          status = plan.completionReason === "last-turn"
            ? `Complete at one remaining turn. Current tokens: ${formatNumber(plan.tokenCount)}; the token target could not be reached without deleting the final turn.`
            : `Complete. Retained ${getTurnCount()} turns.`;
        } else {
          status = state.limitMode === "tokens"
            ? `Complete at the clicked boundary. Current tokens: ${formatNumber(plan.tokenCount)}; target ${formatNumber(plan.targetTokens)} was not reached before the boundary.`
            : `Complete. Kept the clicked turn and deleted all turns ${state.mode === "delete-above" ? "above" : "below"} it.`;
        }
        await setState({ active: false, pendingBatch: false, beforeTokenCount: null, status });
        await send("JOB_COMPLETE", { status });
        return;
      }

      const beforeCount = getTurnCount();
      const beforeTokenCount = getDisplayedTokenCount();
      const locallyDeleted = await runBatch(state);
      state = await getState();
      if (!state.active || stopRequested) return;

      if (locallyDeleted <= 0) {
        await setState({ active: false, pendingBatch: false, status: "Stopped because no turn could be deleted" });
        return;
      }

      await setState({
        beforeCount,
        beforeTokenCount,
        locallyDeleted,
        pendingBatch: true,
        status: `Deleted ${locallyDeleted} locally. Waiting for AI Studio to save before reloading.`
      });

      await sleep(currentProfile.saveWaitMs);
      state = await getState();
      if (state.active && !stopRequested) location.reload();
    } catch (error) {
      await setState({ active: false, pendingBatch: false, status: `Stopped: ${error.message || error}` });
    } finally {
      loopRunning = false;
      try { refreshActionButtons(await getState()); } catch (_) {}
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message?.type === "PING") {
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "START_TRIM") {
        stopRequested = false;
        await setState({
          active: true,
          mode: "keep-newest",
          limitMode: message.limitMode === "turns" ? "turns" : "tokens",
          targetTokens: Math.max(1000, Math.min(10000000, Number(message.targetTokens) || 100000)),
          keepCount: Math.max(1, Number(message.keepCount) || 100),
          batchSize: Math.max(1, Math.min(50, Number(message.batchSize) || 20)),
          speedMode: ["turbo", "balanced", "safe"].includes(message.speedMode) ? message.speedMode : "turbo",
          boundaryIndexHint: null,
          boundaryPreview: null,
          beforeCount: null,
          beforeTokenCount: null,
          pendingBatch: false,
          locallyDeleted: 0,
          verifiedDeleted: 0,
          zeroProgressBatches: 0,
          conversationKey: currentConversationKey(),
          conversationPath: location.pathname,
          conversationUrl: location.href,
          status: "Starting from the beginning"
        });
        await send("REGISTER_TARGET", {
          path: location.pathname,
          url: location.href,
          conversationKey: currentConversationKey()
        });
        sendResponse({ ok: true });
        runLoop();
        return;
      }

      if (message?.type === "RESUME_TRIM") {
        sendResponse({ ok: true });
        runLoop();
        return;
      }

      if (message?.type === "STOP_TRIM") {
        stopRequested = true;
        await setState({ active: false, pendingBatch: false, status: "Stopped by user" });
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "RESET_TRIM") {
        stopRequested = true;
        await send("RESET_STATE");
        updateOverlay(await getState());
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "PAGE_STATUS") {
        const state = await getState();
        sendResponse({
          ok: true,
          turnCount: getTurnCount(),
          tokenCount: getDisplayedTokenCount(),
          tokenInfo: getDisplayedTokenInfo(),
          path: location.pathname,
          url: location.href,
          conversationKey: currentConversationKey(),
          mode: state.mode,
          boundaryIndex: state.boundaryIndexHint,
          boundaryPreview: state.boundaryPreview
        });
        return;
      }

      sendResponse({ ok: false, error: "Unknown content message" });
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));

    return true;
  });

  (async () => {
    ensureOverlay();
    document.querySelectorAll(".ai-studio-turn-trimmer-boundary-button").forEach((node) => node.remove());
    startActionObserver();
    await send("REGISTER_TARGET", {
      path: location.pathname,
      url: location.href,
      conversationKey: currentConversationKey()
    });
    const state = await getState();
    addDirectActionButtons();
    refreshActionButtons(state);
    updateOverlay(state);
    if (state.active && (!state.conversationKey || state.conversationKey === currentConversationKey())) runLoop();
  })();
})();
