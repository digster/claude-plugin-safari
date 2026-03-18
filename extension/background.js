/* background.js — Message routing, storage, and native messaging bridge for Claude Assistant */

const APP_IDENTIFIER = "com.digster.Claude-Assistant.Extension";

const DEFAULT_SETTINGS = {
  prefix: 'Summarize',
  cliPath: '/Users/ishan/.local/bin/claude',
  allowedTools: 'WebFetch,WebSearch',
  effort: '',
  model: ''
};

// ── Storage helpers ──────────────────────────────────────────

async function getSettings() {
  try {
    const { settings } = await browser.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch (err) {
    console.error('Failed to read settings from storage:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  try {
    await browser.storage.local.set({ settings: merged });
  } catch (err) {
    console.error('Failed to write settings to storage:', err);
  }
  return merged;
}

async function getLastResult(url) {
  try {
    const payload = { action: 'getStoredResult' };
    if (url) payload.url = url;
    const response = await sendNativeMessage(payload);
    return response?.result || null;
  } catch (err) {
    console.error('Failed to read result from disk:', err);
    return null;
  }
}

async function saveLastResult(result) {
  try {
    await sendNativeMessage({ action: 'storeResult', result: result });
  } catch (err) {
    console.error('Failed to save result to disk:', err);
  }
}

async function getHistory() {
  try {
    const { history } = await browser.storage.local.get('history');
    return history || [];
  } catch (err) {
    console.error('Failed to read history from storage:', err);
    return [];
  }
}

async function addToHistory(entry) {
  const history = await getHistory();
  // Keep last 25 entries (small footprint in browser.storage.local)
  history.unshift(entry);
  if (history.length > 25) history.pop();
  try {
    await browser.storage.local.set({ history });
  } catch (err) {
    console.error('Failed to write history to storage:', err);
  }
}

// ── Cache management ────────────────────────────────────────

/**
 * Clear all cached results from native disk and history from browser storage.
 * Deletes lastResult.json, all per-URL cache files, and the history array.
 */
async function clearAllCache() {
  let clearedCount = 0;

  // Clear native disk files (lastResult.json + results/ directory)
  try {
    const response = await sendNativeMessage({ action: 'clearAllResults' });
    clearedCount = response?.clearedCount || 0;
  } catch (err) {
    console.error('Failed to clear native disk cache:', err);
  }

  // Clear history from browser.storage.local
  try {
    await browser.storage.local.remove('history');
  } catch (err) {
    console.error('Failed to clear history from storage:', err);
  }

  return { success: true, clearedCount };
}

// ── Native messaging bridge ─────────────────────────────────

/**
 * Send a message to the Swift native handler via browser.runtime.sendNativeMessage.
 * The native handler (SafariWebExtensionHandler.swift) receives this and can execute
 * Process() calls to run the Claude CLI.
 */
async function sendNativeMessage(payload) {
  return browser.runtime.sendNativeMessage(APP_IDENTIFIER, payload);
}

// ── Claude CLI execution ────────────────────────────────────

/**
 * Build the full prompt from prefix + URL and send to native handler
 * for CLI execution. Stores the result for recovery if popup closes.
 * Checks for cancellation after CLI completes to handle the race condition
 * where cancel arrives while the CLI is still running.
 */
async function runClaude(url) {
  const settings = await getSettings();
  const prompt = settings.prefix ? `${settings.prefix} ${url}` : url;

  // Save running state so popup can show loading if reopened
  await saveLastResult({
    status: 'running',
    prompt,
    url,
    startTime: Date.now()
  });

  try {
    // Parse comma-separated allowedTools string into an array for the native handler
    const allowedTools = settings.allowedTools
      ? settings.allowedTools.split(',').map(t => t.trim()).filter(Boolean)
      : [];

    const response = await sendNativeMessage({
      action: 'runClaude',
      prompt,
      cliPath: settings.cliPath,
      outputFormat: 'json',
      allowedTools,
      effort: settings.effort || '',
      model: settings.model || ''
    });

    // Check if request was cancelled while CLI was running
    const currentState = await getLastResult(url);
    if (currentState?.status === 'cancelled') {
      return currentState;
    }

    // Parse the response from the native handler
    const result = {
      status: 'complete',
      prompt,
      url,
      startTime: (await getLastResult())?.startTime || Date.now(),
      endTime: Date.now(),
      response: response
    };

    await saveLastResult(result);

    // Add to history
    await addToHistory({
      prompt,
      url,
      timestamp: Date.now(),
      resultPreview: typeof response?.result === 'string'
        ? response.result.substring(0, 100)
        : JSON.stringify(response).substring(0, 100)
    });

    return result;
  } catch (err) {
    // Check if request was cancelled (cancel saves state before killing process)
    const currentState = await getLastResult(url);
    if (currentState?.status === 'cancelled') {
      return currentState;
    }

    const errorResult = {
      status: 'error',
      prompt,
      url,
      error: err.message || String(err)
    };
    await saveLastResult(errorResult);
    return errorResult;
  }
}

/**
 * Cancel a running Claude CLI request.
 * Saves cancelled state to disk FIRST (so runClaude's completion check sees it),
 * then sends the native kill message (best-effort).
 */
async function cancelClaude(url) {
  // Save cancelled state before sending kill — handles the race where
  // CLI completes before the kill arrives
  await saveLastResult({
    status: 'cancelled',
    url,
    cancelledAt: Date.now()
  });

  // Send kill signal via native handler (best-effort — process may already be done)
  try {
    await sendNativeMessage({ action: 'cancelClaude' });
  } catch (err) {
    console.error('Failed to send cancel signal:', err);
  }

  return { status: 'cancelled' };
}

// ── CLI verification ────────────────────────────────────────

async function verifyCli(cliPath) {
  try {
    const response = await sendNativeMessage({
      action: 'verifyCli',
      cliPath: cliPath || (await getSettings()).cliPath
    });
    return response;
  } catch (err) {
    return { exists: false, error: err.message || String(err) };
  }
}

// ── Message handler ──────────────────────────────────────────

// Promise-based listener — Safari MV3 natively resolves the returned Promise
// as the message response. No sendResponse callback or `return true` needed,
// which avoids channel-closing race conditions when the popup closes.
browser.runtime.onMessage.addListener((message, _sender) => {
  return (async () => {
    try {
      switch (message.action) {
        case 'runClaude':
          return await runClaude(message.url);

        case 'cancelClaude':
          return await cancelClaude(message.url);

        case 'getSettings':
          return await getSettings();

        case 'saveSettings':
          return await saveSettings(message.settings);

        case 'getLastResult':
          return await getLastResult(message.url);

        case 'clearLastResult':
          try {
            const clearPayload = { action: 'clearStoredResult' };
            if (message.url) clearPayload.url = message.url;
            await sendNativeMessage(clearPayload);
          } catch (err) {
            console.error('Failed to clear stored result:', err);
          }
          return { success: true };

        case 'getHistory':
          return await getHistory();

        case 'clearAllCache':
          return await clearAllCache();

        case 'verifyCli':
          return await verifyCli(message.cliPath);

        default:
          return { error: `Unknown action: ${message.action}` };
      }
    } catch (err) {
      console.error('Message handler error:', err);
      return { error: err.message || 'Unknown error' };
    }
  })();
});

// ── Initialization ───────────────────────────────────────────

browser.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await browser.storage.local.get('settings');
    if (!settings) {
      await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  } catch (err) {
    console.error('Failed to initialize settings on install:', err);
  }

  // Migration: remove lastResult from browser.storage.local
  // (now stored on native disk to avoid ~5MB storage quota)
  try {
    await browser.storage.local.remove('lastResult');
  } catch (err) {
    console.error('Failed to remove legacy lastResult from storage:', err);
  }
});

// ── Exports for testing ──────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
    getLastResult,
    saveLastResult,
    getHistory,
    addToHistory,
    clearAllCache,
    runClaude,
    cancelClaude,
    verifyCli,
    sendNativeMessage
  };
}
