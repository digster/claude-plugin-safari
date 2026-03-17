/* background.js — Message routing, storage, and native messaging bridge for Claude Assistant */

const APP_IDENTIFIER = "com.digster.Claude-Assistant.Extension";

const DEFAULT_SETTINGS = {
  prefix: 'Summarize',
  cliPath: '/Users/ishan/.local/bin/claude',
  allowedTools: 'WebFetch,WebSearch'
};

// ── Storage helpers ──────────────────────────────────────────

async function getSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await browser.storage.local.set({ settings: merged });
  return merged;
}

async function getLastResult() {
  try {
    const response = await sendNativeMessage({ action: 'getStoredResult' });
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
  const { history } = await browser.storage.local.get('history');
  return history || [];
}

async function addToHistory(entry) {
  const history = await getHistory();
  // Keep last 25 entries (small footprint in browser.storage.local)
  history.unshift(entry);
  if (history.length > 25) history.pop();
  await browser.storage.local.set({ history });
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
      allowedTools
    });

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

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (message.action) {
        case 'runClaude':
          return await runClaude(message.url);

        case 'getSettings':
          return await getSettings();

        case 'saveSettings':
          return await saveSettings(message.settings);

        case 'getLastResult':
          return await getLastResult();

        case 'clearLastResult':
          try {
            await sendNativeMessage({ action: 'clearStoredResult' });
          } catch (err) {
            console.error('Failed to clear stored result:', err);
          }
          return { success: true };

        case 'getHistory':
          return await getHistory();

        case 'verifyCli':
          return await verifyCli(message.cliPath);

        default:
          return { error: `Unknown action: ${message.action}` };
      }
    } catch (err) {
      return { error: err.message };
    }
  };

  handler().then(sendResponse).catch(err => {
    console.error('Message handler error:', err);
    try { sendResponse({ error: err.message || 'Unknown error' }); } catch (_) {}
  });
  return true; // keep message channel open for async response
});

// ── Initialization ───────────────────────────────────────────

browser.runtime.onInstalled.addListener(async () => {
  const { settings } = await browser.storage.local.get('settings');
  if (!settings) {
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  }

  // Migration: remove lastResult from browser.storage.local
  // (now stored on native disk to avoid ~5MB storage quota)
  browser.storage.local.remove('lastResult');
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
    runClaude,
    verifyCli,
    sendNativeMessage
  };
}
