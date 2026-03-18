/**
 * background.test.js — Unit tests for Claude Assistant background.js message routing
 *
 * Run with: node tests/background.test.js
 *
 * Uses a minimal test harness (no external deps) since the extension runs
 * in a browser environment. We mock browser.* APIs to test the logic.
 */

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    testsPassed++;
    console.log(`  PASS: ${message}`);
  } else {
    testsFailed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) {
    testsPassed++;
    console.log(`  PASS: ${message}`);
  } else {
    testsFailed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

// ── Mock browser.* APIs ─────────────────────────────────────

const mockStorage = {};

// In-memory store that simulates native disk storage for lastResult
// Includes per-URL storage map to simulate the results/ directory
let nativeDiskStore = {};

const browser = {
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === 'string') {
          return { [key]: mockStorage[key] };
        }
        return key.reduce((acc, k) => ({ ...acc, [k]: mockStorage[k] }), {});
      },
      set: async (items) => {
        Object.assign(mockStorage, items);
      },
      remove: async (key) => {
        if (typeof key === 'string') {
          delete mockStorage[key];
        }
      }
    }
  },
  runtime: {
    sendNativeMessage: async (_id, payload) => {
      // Route storage actions to in-memory disk store (simulates Swift handler)
      switch (payload.action) {
        case 'storeResult': {
          nativeDiskStore.lastResult = payload.result;
          // Also store per-URL if result has a url field
          if (payload.result && payload.result.url) {
            if (!nativeDiskStore.perUrl) nativeDiskStore.perUrl = {};
            nativeDiskStore.perUrl[payload.result.url] = payload.result;
          }
          return { success: true };
        }
        case 'getStoredResult': {
          // Per-URL lookup — return null on miss (no fallback to lastResult)
          if (payload.url) {
            if (nativeDiskStore.perUrl && nativeDiskStore.perUrl[payload.url]) {
              return { result: nativeDiskStore.perUrl[payload.url] };
            }
            return { result: null };
          }
          // No URL — return lastResult (pop-out view)
          return { result: nativeDiskStore.lastResult || null };
        }
        case 'clearStoredResult': {
          if (payload.url && nativeDiskStore.perUrl) {
            delete nativeDiskStore.perUrl[payload.url];
          } else {
            delete nativeDiskStore.lastResult;
          }
          return { success: true };
        }
        case 'clearAllResults': {
          let clearedCount = 0;
          if (nativeDiskStore.lastResult) {
            delete nativeDiskStore.lastResult;
            clearedCount++;
          }
          if (nativeDiskStore.perUrl) {
            clearedCount += Object.keys(nativeDiskStore.perUrl).length;
            nativeDiskStore.perUrl = {};
          }
          return { success: true, clearedCount };
        }
        default:
          return { result: 'mock response' };
      }
    },
    onMessage: { addListener: (cb) => { browser.runtime._onMessageCallback = cb; } },
    onInstalled: { addListener: () => {} },
    _onMessageCallback: null
  },
  tabs: {
    query: async () => [{ url: 'https://example.com' }]
  }
};

// Make browser available globally for the module
global.browser = browser;
global.chrome = browser;

// ── Load the module ─────────────────────────────────────────

const bg = require('../extension/background.js');

// ── Tests ───────────────────────────────────────────────────

async function runTests() {
  console.log('\nClaude Assistant — background.js tests\n');

  // Test: DEFAULT_SETTINGS
  console.log('DEFAULT_SETTINGS:');
  assert(bg.DEFAULT_SETTINGS.prefix === 'Summarize', 'default prefix is "Summarize"');
  assert(bg.DEFAULT_SETTINGS.cliPath.includes('claude'), 'default CLI path includes "claude"');

  // Test: getSettings returns defaults when no settings stored
  console.log('\ngetSettings:');
  delete mockStorage.settings;
  const defaults = await bg.getSettings();
  assertEqual(defaults.prefix, 'Summarize', 'returns default prefix when none stored');
  assertEqual(defaults.cliPath, '/Users/ishan/.local/bin/claude', 'returns default CLI path when none stored');

  // Test: saveSettings merges with existing
  console.log('\nsaveSettings:');
  await bg.saveSettings({ prefix: 'Explain' });
  const saved = await bg.getSettings();
  assertEqual(saved.prefix, 'Explain', 'saves new prefix');
  assertEqual(saved.cliPath, '/Users/ishan/.local/bin/claude', 'preserves CLI path when not updated');

  // Test: saveSettings overwrites
  await bg.saveSettings({ prefix: 'Review', cliPath: '/usr/local/bin/claude' });
  const overwritten = await bg.getSettings();
  assertEqual(overwritten.prefix, 'Review', 'overwrites prefix');
  assertEqual(overwritten.cliPath, '/usr/local/bin/claude', 'overwrites CLI path');

  // Test: getLastResult when empty (uses native disk storage)
  console.log('\ngetLastResult (native disk):');
  nativeDiskStore = {};
  const noResult = await bg.getLastResult();
  assertEqual(noResult, null, 'returns null when no result stored on disk');

  // Test: saveLastResult and getLastResult via native messaging
  console.log('\nsaveLastResult (native disk):');
  const mockResult = {
    status: 'complete',
    prompt: 'Summarize https://example.com',
    url: 'https://example.com',
    response: { result: 'A summary' }
  };
  await bg.saveLastResult(mockResult);
  const retrieved = await bg.getLastResult();
  assertEqual(retrieved.status, 'complete', 'stores and retrieves result status via native disk');
  assertEqual(retrieved.prompt, 'Summarize https://example.com', 'stores and retrieves prompt via native disk');

  // Test: saveLastResult sends storeResult action to native handler
  console.log('\nsaveLastResult native message format:');
  let capturedPayload = null;
  const originalSendNative = browser.runtime.sendNativeMessage;
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    capturedPayload = payload;
    // Still route through the real mock for storage
    return originalSendNative(_id, payload);
  };
  await bg.saveLastResult({ status: 'test' });
  assertEqual(capturedPayload.action, 'storeResult', 'sends storeResult action');
  assert(capturedPayload.result !== undefined, 'includes result in payload');
  assertEqual(capturedPayload.result.status, 'test', 'result data is passed through');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: getLastResult sends getStoredResult action to native handler
  console.log('\ngetLastResult native message format:');
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    capturedPayload = payload;
    return originalSendNative(_id, payload);
  };
  await bg.getLastResult();
  assertEqual(capturedPayload.action, 'getStoredResult', 'sends getStoredResult action');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: getHistory when empty
  console.log('\ngetHistory:');
  delete mockStorage.history;
  const emptyHistory = await bg.getHistory();
  assert(Array.isArray(emptyHistory), 'returns array when no history');
  assertEqual(emptyHistory.length, 0, 'returns empty array');

  // Test: addToHistory
  console.log('\naddToHistory:');
  delete mockStorage.history;
  await bg.addToHistory({ prompt: 'test1', timestamp: 1 });
  await bg.addToHistory({ prompt: 'test2', timestamp: 2 });
  const history = await bg.getHistory();
  assertEqual(history.length, 2, 'adds entries to history');
  assertEqual(history[0].prompt, 'test2', 'most recent entry is first (unshift)');
  assertEqual(history[1].prompt, 'test1', 'older entry is second');

  // Test: addToHistory caps at 25 (reduced from 50 to save storage quota)
  console.log('\naddToHistory (cap at 25):');
  delete mockStorage.history;
  for (let i = 0; i < 30; i++) {
    await bg.addToHistory({ prompt: `entry-${i}`, timestamp: i });
  }
  const cappedHistory = await bg.getHistory();
  assertEqual(cappedHistory.length, 25, 'caps history at 25 entries');
  assertEqual(cappedHistory[0].prompt, 'entry-29', 'most recent entry is first after cap');

  // Test: clearLastResult via saveLastResult(null)
  console.log('\nclearLastResult:');
  await bg.saveLastResult(null);
  const cleared = await bg.getLastResult();
  assertEqual(cleared, null, 'clears last result on native disk');

  // Test: DEFAULT_SETTINGS.allowedTools exists
  console.log('\nallowedTools defaults:');
  assert(typeof bg.DEFAULT_SETTINGS.allowedTools === 'string', 'allowedTools is a string in DEFAULT_SETTINGS');
  assert(bg.DEFAULT_SETTINGS.allowedTools.includes('WebFetch'), 'default allowedTools includes WebFetch');
  assert(bg.DEFAULT_SETTINGS.allowedTools.includes('WebSearch'), 'default allowedTools includes WebSearch');

  // Test: allowedTools parsing (comma-separated → array)
  console.log('\nallowedTools parsing:');
  delete mockStorage.settings;
  await bg.saveSettings({ allowedTools: 'WebFetch, Read , Bash' });

  // Capture what gets sent to native handler (for runClaude action)
  let capturedNativePayload = null;
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    // Capture runClaude payloads, route storage through the original mock
    if (payload.action && ['storeResult', 'getStoredResult', 'clearStoredResult', 'clearAllResults'].includes(payload.action)) {
      return originalSendNative(_id, payload);
    }
    capturedNativePayload = payload;
    return { result: 'mock response' };
  };

  await bg.runClaude('https://example.com');
  assert(capturedNativePayload !== null, 'native message was sent');
  assertEqual(capturedNativePayload.allowedTools, ['WebFetch', 'Read', 'Bash'],
    'parses comma-separated allowedTools with trimming');

  // Test: empty allowedTools string → empty array
  console.log('\nallowedTools empty parsing:');
  await bg.saveSettings({ allowedTools: '' });
  capturedNativePayload = null;
  await bg.runClaude('https://example.com');
  assertEqual(capturedNativePayload.allowedTools, [],
    'empty allowedTools string produces empty array');

  // Test: allowedTools included in native message payload
  console.log('\nallowedTools in native payload:');
  await bg.saveSettings({ allowedTools: 'WebFetch,WebSearch' });
  capturedNativePayload = null;
  await bg.runClaude('https://example.com');
  assert(Array.isArray(capturedNativePayload.allowedTools), 'allowedTools is an array in native payload');
  assertEqual(capturedNativePayload.allowedTools, ['WebFetch', 'WebSearch'],
    'allowedTools array matches parsed setting');

  // Restore original mock
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: DEFAULT_SETTINGS includes effort and model
  console.log('\neffort and model defaults:');
  assert(bg.DEFAULT_SETTINGS.effort === '', 'default effort is empty string');
  assert(bg.DEFAULT_SETTINGS.model === '', 'default model is empty string');

  // Test: save/load round-trip for effort and model
  console.log('\neffort and model save/load:');
  delete mockStorage.settings;
  await bg.saveSettings({ effort: 'high', model: 'sonnet' });
  const effortModelSettings = await bg.getSettings();
  assertEqual(effortModelSettings.effort, 'high', 'saves and retrieves effort');
  assertEqual(effortModelSettings.model, 'sonnet', 'saves and retrieves model');

  // Test: effort and model don't clobber existing settings
  console.log('\neffort and model don\'t clobber:');
  delete mockStorage.settings;
  await bg.saveSettings({ prefix: 'Explain', allowedTools: 'Read' });
  await bg.saveSettings({ effort: 'max', model: 'opus' });
  const nonClobbered = await bg.getSettings();
  assertEqual(nonClobbered.prefix, 'Explain', 'effort/model save does not clobber prefix');
  assertEqual(nonClobbered.allowedTools, 'Read', 'effort/model save does not clobber allowedTools');
  assertEqual(nonClobbered.effort, 'max', 'effort is saved alongside existing settings');
  assertEqual(nonClobbered.model, 'opus', 'model is saved alongside existing settings');

  // Test: effort and model included in native payload
  console.log('\neffort and model in native payload:');
  delete mockStorage.settings;
  await bg.saveSettings({ effort: 'high', model: 'claude-sonnet-4-6' });
  capturedNativePayload = null;
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action && ['storeResult', 'getStoredResult', 'clearStoredResult', 'clearAllResults'].includes(payload.action)) {
      return originalSendNative(_id, payload);
    }
    capturedNativePayload = payload;
    return { result: 'mock response' };
  };
  await bg.runClaude('https://example.com');
  assertEqual(capturedNativePayload.effort, 'high', 'effort is included in native payload');
  assertEqual(capturedNativePayload.model, 'claude-sonnet-4-6', 'model is included in native payload');

  // Test: empty effort and model still sent as empty strings
  console.log('\nempty effort and model in native payload:');
  await bg.saveSettings({ effort: '', model: '' });
  capturedNativePayload = null;
  await bg.runClaude('https://example.com');
  assertEqual(capturedNativePayload.effort, '', 'empty effort is sent as empty string');
  assertEqual(capturedNativePayload.model, '', 'empty model is sent as empty string');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: saveLastResult handles native message failure gracefully
  console.log('\nsaveLastResult error handling:');
  browser.runtime.sendNativeMessage = async () => {
    throw new Error('Native messaging unavailable');
  };
  // Should not throw — just logs the error
  let saveError = null;
  try {
    await bg.saveLastResult({ status: 'test' });
  } catch (err) {
    saveError = err;
  }
  assertEqual(saveError, null, 'saveLastResult does not throw on native message failure');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: getLastResult returns null on native message failure
  console.log('\ngetLastResult error handling:');
  browser.runtime.sendNativeMessage = async () => {
    throw new Error('Native messaging unavailable');
  };
  const failedResult = await bg.getLastResult();
  assertEqual(failedResult, null, 'getLastResult returns null on native message failure');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: getSettings falls back to DEFAULT_SETTINGS when storage.get() throws
  console.log('\ngetSettings storage failure fallback:');
  const originalGet = browser.storage.local.get;
  browser.storage.local.get = async () => {
    throw new Error('Invalid call to storageArea.get()');
  };
  const fallbackSettings = await bg.getSettings();
  assertEqual(fallbackSettings.prefix, bg.DEFAULT_SETTINGS.prefix,
    'getSettings returns DEFAULT_SETTINGS.prefix when storage.get() throws');
  assertEqual(fallbackSettings.cliPath, bg.DEFAULT_SETTINGS.cliPath,
    'getSettings returns DEFAULT_SETTINGS.cliPath when storage.get() throws');
  browser.storage.local.get = originalGet;

  // Test: getHistory falls back to [] when storage.get() throws
  console.log('\ngetHistory storage failure fallback:');
  browser.storage.local.get = async () => {
    throw new Error('Invalid call to storageArea.get()');
  };
  const fallbackHistory = await bg.getHistory();
  assert(Array.isArray(fallbackHistory), 'getHistory returns array when storage.get() throws');
  assertEqual(fallbackHistory.length, 0, 'getHistory returns empty array when storage.get() throws');
  browser.storage.local.get = originalGet;

  // Test: saveSettings doesn't throw when storage.set() fails
  console.log('\nsaveSettings storage failure resilience:');
  const originalSet = browser.storage.local.set;
  browser.storage.local.set = async () => {
    throw new Error('Exceeded storage quota');
  };
  let saveSettingsError = null;
  try {
    const result = await bg.saveSettings({ prefix: 'Test' });
    assert(result.prefix === 'Test', 'saveSettings returns merged settings even when storage.set() fails');
  } catch (err) {
    saveSettingsError = err;
  }
  assertEqual(saveSettingsError, null, 'saveSettings does not throw when storage.set() fails');
  browser.storage.local.set = originalSet;

  // Test: addToHistory doesn't throw when storage.set() fails
  console.log('\naddToHistory storage failure resilience:');
  browser.storage.local.set = async () => {
    throw new Error('Exceeded storage quota');
  };
  let addHistoryError = null;
  try {
    await bg.addToHistory({ prompt: 'should not throw', timestamp: Date.now() });
  } catch (err) {
    addHistoryError = err;
  }
  assertEqual(addHistoryError, null, 'addToHistory does not throw when storage.set() fails');
  browser.storage.local.set = originalSet;

  // Test: getLastResult(url) includes url key in native payload
  console.log('\ngetLastResult per-URL payload:');
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    capturedPayload = payload;
    return originalSendNative(_id, payload);
  };
  capturedPayload = null;
  await bg.getLastResult('https://example.com/page-A');
  assertEqual(capturedPayload.action, 'getStoredResult', 'sends getStoredResult action with URL');
  assertEqual(capturedPayload.url, 'https://example.com/page-A', 'includes url in payload');

  // Test: getLastResult() without URL does not include url key
  console.log('\ngetLastResult without URL:');
  capturedPayload = null;
  await bg.getLastResult();
  assertEqual(capturedPayload.action, 'getStoredResult', 'sends getStoredResult action without URL');
  assert(!('url' in capturedPayload), 'no url key in payload when called without URL');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: per-URL cache isolation — store A, store B, fetch A returns A, fetch B returns B
  console.log('\nper-URL cache isolation:');
  nativeDiskStore = {};
  const resultA = {
    status: 'complete',
    prompt: 'Summarize https://site-a.com',
    url: 'https://site-a.com',
    response: { result: 'Summary of A' }
  };
  const resultB = {
    status: 'complete',
    prompt: 'Summarize https://site-b.com',
    url: 'https://site-b.com',
    response: { result: 'Summary of B' }
  };
  await bg.saveLastResult(resultA);
  await bg.saveLastResult(resultB);

  const fetchedA = await bg.getLastResult('https://site-a.com');
  assertEqual(fetchedA.url, 'https://site-a.com', 'fetching by URL A returns result A');
  assertEqual(fetchedA.response.result, 'Summary of A', 'result A content is correct');

  const fetchedB = await bg.getLastResult('https://site-b.com');
  assertEqual(fetchedB.url, 'https://site-b.com', 'fetching by URL B returns result B');
  assertEqual(fetchedB.response.result, 'Summary of B', 'result B content is correct');

  // Fetching without URL returns the latest (B, since it was stored last)
  const fetchedLatest = await bg.getLastResult();
  assertEqual(fetchedLatest.url, 'https://site-b.com', 'fetching without URL returns latest (B)');

  // Test: clearLastResult with URL only clears that URL's cache
  console.log('\nclearLastResult per-URL:');
  nativeDiskStore = {};
  await bg.saveLastResult(resultA);
  await bg.saveLastResult(resultB);

  // Clear only URL A's cache via the message handler
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    capturedPayload = payload;
    return originalSendNative(_id, payload);
  };
  const clearHandler = browser.runtime._onMessageCallback;
  await clearHandler({ action: 'clearLastResult', url: 'https://site-a.com' }, {});
  assertEqual(capturedPayload.action, 'clearStoredResult', 'clearLastResult sends clearStoredResult');
  assertEqual(capturedPayload.url, 'https://site-a.com', 'clearLastResult forwards url to native handler');

  // URL A should be gone (returns null, no stale fallback) but URL B remains
  const afterClearA = await bg.getLastResult('https://site-a.com');
  assertEqual(afterClearA, null, 'after clearing A, fetching A returns null (no stale fallback)');

  const afterClearB = await bg.getLastResult('https://site-b.com');
  assertEqual(afterClearB.url, 'https://site-b.com', 'URL B still cached after clearing A');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: getLastResult message handler forwards URL
  console.log('\nonMessage getLastResult forwards URL:');
  nativeDiskStore = {};
  await bg.saveLastResult(resultA);
  await bg.saveLastResult(resultB);
  const handler = browser.runtime._onMessageCallback;
  const handlerResultA = await handler({ action: 'getLastResult', url: 'https://site-a.com' }, {});
  assertEqual(handlerResultA.url, 'https://site-a.com', 'message handler returns per-URL result for A');
  const handlerResultNoUrl = await handler({ action: 'getLastResult' }, {});
  assertEqual(handlerResultNoUrl.url, 'https://site-b.com', 'message handler returns latest when no URL');

  // Test: onMessage listener uses Promise-based pattern (not callback-based)
  console.log('\nonMessage listener pattern:');
  assert(
    typeof browser.runtime._onMessageCallback === 'function',
    'onMessage.addListener was called with a callback'
  );

  // The listener should return a thenable (Promise) — NOT `true`
  const listenerReturn = browser.runtime._onMessageCallback(
    { action: 'getSettings' }, {} /* sender */
  );
  assert(
    listenerReturn && typeof listenerReturn.then === 'function',
    'listener returns a Promise (not true/undefined)'
  );

  // Verify the Promise resolves to a valid settings object
  const listenerResult = await listenerReturn;
  assert(
    listenerResult && typeof listenerResult === 'object' && 'prefix' in listenerResult,
    'listener Promise resolves with settings object for getSettings action'
  );

  // Test: unknown action returns error via Promise
  const unknownReturn = browser.runtime._onMessageCallback(
    { action: 'nonExistentAction' }, {}
  );
  const unknownResult = await unknownReturn;
  assert(
    unknownResult && unknownResult.error && unknownResult.error.includes('nonExistentAction'),
    'unknown action returns error message via Promise'
  );

  // Test: clearAllCache clears disk files and history
  console.log('\nclearAllCache:');
  nativeDiskStore = {};
  delete mockStorage.history;
  await bg.saveLastResult(resultA);
  await bg.saveLastResult(resultB);
  await bg.addToHistory({ prompt: 'entry-1', timestamp: 1 });
  await bg.addToHistory({ prompt: 'entry-2', timestamp: 2 });

  const clearResult = await bg.clearAllCache();
  assertEqual(clearResult.success, true, 'clearAllCache returns success');
  // 1 lastResult + 2 per-URL files = 3
  assertEqual(clearResult.clearedCount, 3, 'clearAllCache reports correct cleared count');

  // Verify disk is empty
  const afterClearAll = await bg.getLastResult();
  assertEqual(afterClearAll, null, 'lastResult is null after clearAllCache');
  const afterClearUrlA = await bg.getLastResult('https://site-a.com');
  assertEqual(afterClearUrlA, null, 'per-URL A is null after clearAllCache');
  const afterClearUrlB = await bg.getLastResult('https://site-b.com');
  assertEqual(afterClearUrlB, null, 'per-URL B is null after clearAllCache');

  // Verify history is cleared
  const afterClearHistory = await bg.getHistory();
  assertEqual(afterClearHistory.length, 0, 'history is empty after clearAllCache');

  // Test: clearAllCache when already empty
  console.log('\nclearAllCache (already empty):');
  nativeDiskStore = {};
  delete mockStorage.history;
  const emptyResult = await bg.clearAllCache();
  assertEqual(emptyResult.success, true, 'clearAllCache succeeds when already empty');
  assertEqual(emptyResult.clearedCount, 0, 'clearAllCache reports 0 cleared when empty');

  // Test: clearAllCache resilience to native failure
  console.log('\nclearAllCache native failure resilience:');
  browser.runtime.sendNativeMessage = async () => {
    throw new Error('Native messaging unavailable');
  };
  let clearAllError = null;
  try {
    const failedClear = await bg.clearAllCache();
    assertEqual(failedClear.success, true, 'clearAllCache returns success even on native failure');
    assertEqual(failedClear.clearedCount, 0, 'clearedCount is 0 on native failure');
  } catch (err) {
    clearAllError = err;
  }
  assertEqual(clearAllError, null, 'clearAllCache does not throw on native message failure');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: clearAllCache message handler integration
  console.log('\nclearAllCache message handler:');
  nativeDiskStore = {};
  delete mockStorage.history;
  await bg.saveLastResult(resultA);
  await bg.addToHistory({ prompt: 'entry-1', timestamp: 1 });
  const clearAllHandler = browser.runtime._onMessageCallback;
  const handlerClearResult = await clearAllHandler({ action: 'clearAllCache' }, {});
  assertEqual(handlerClearResult.success, true, 'message handler returns success for clearAllCache');
  assert(handlerClearResult.clearedCount >= 0, 'message handler returns clearedCount for clearAllCache');

  // Test: no stale fallback — fetching uncached URL returns null, not lastResult
  console.log('\nno stale fallback for uncached URL:');
  nativeDiskStore = {};
  await bg.saveLastResult(resultA);
  const uncachedResult = await bg.getLastResult('https://never-cached.com');
  assertEqual(uncachedResult, null, 'fetching uncached URL returns null, not stale lastResult');
  // But lastResult is still accessible without URL (pop-out view)
  const latestResult = await bg.getLastResult();
  assertEqual(latestResult.url, 'https://site-a.com', 'lastResult still accessible without URL param');

  // ── Cancel tests ──────────────────────────────────────────

  // Test: cancelClaude saves cancelled state to disk
  console.log('\ncancelClaude saves cancelled state:');
  nativeDiskStore = {};
  browser.runtime.sendNativeMessage = originalSendNative;
  const cancelResult = await bg.cancelClaude('https://cancel-test.com');
  assertEqual(cancelResult.status, 'cancelled', 'cancelClaude returns cancelled status');
  const cancelledState = await bg.getLastResult('https://cancel-test.com');
  assertEqual(cancelledState.status, 'cancelled', 'cancelled state is saved to per-URL cache');
  assertEqual(cancelledState.url, 'https://cancel-test.com', 'cancelled state has correct URL');
  assert(cancelledState.cancelledAt > 0, 'cancelled state has cancelledAt timestamp');

  // Test: cancelClaude sends cancelClaude action to native handler
  console.log('\ncancelClaude native message:');
  let cancelNativePayload = null;
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action === 'cancelClaude') {
      cancelNativePayload = payload;
      return { success: true };
    }
    return originalSendNative(_id, payload);
  };
  await bg.cancelClaude('https://cancel-test.com');
  assertEqual(cancelNativePayload.action, 'cancelClaude', 'sends cancelClaude action to native handler');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: cancelClaude handles native message failure gracefully
  console.log('\ncancelClaude native failure resilience:');
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action === 'cancelClaude') {
      throw new Error('Native messaging unavailable');
    }
    return originalSendNative(_id, payload);
  };
  let cancelError = null;
  try {
    const failedCancel = await bg.cancelClaude('https://cancel-test.com');
    assertEqual(failedCancel.status, 'cancelled', 'cancelClaude returns cancelled even on native failure');
  } catch (err) {
    cancelError = err;
  }
  assertEqual(cancelError, null, 'cancelClaude does not throw on native message failure');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: runClaude respects cancelled state (race condition — cancel arrives during CLI run)
  console.log('\nrunClaude respects cancelled state (race condition):');
  nativeDiskStore = {};
  delete mockStorage.settings;
  await bg.saveSettings({ prefix: 'Summarize', allowedTools: '' });

  // Mock sendNativeMessage: when runClaude action is sent, simulate cancel arriving
  // during the CLI execution by saving cancelled state before returning
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action === 'runClaude') {
      // Simulate: cancel was triggered while CLI was running — save cancelled state
      await originalSendNative(_id, {
        action: 'storeResult',
        result: { status: 'cancelled', url: 'https://race-test.com', cancelledAt: Date.now() }
      });
      return { result: 'This should be discarded' };
    }
    return originalSendNative(_id, payload);
  };
  const raceResult = await bg.runClaude('https://race-test.com');
  assertEqual(raceResult.status, 'cancelled', 'runClaude returns cancelled when cancel arrives during execution');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: runClaude respects cancelled state in error path
  console.log('\nrunClaude respects cancelled state on error:');
  nativeDiskStore = {};
  delete mockStorage.settings;
  await bg.saveSettings({ prefix: 'Summarize', allowedTools: '' });

  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action === 'runClaude') {
      // Simulate: cancel was triggered, then CLI errors out
      await originalSendNative(_id, {
        action: 'storeResult',
        result: { status: 'cancelled', url: 'https://error-race.com', cancelledAt: Date.now() }
      });
      throw new Error('Process terminated');
    }
    return originalSendNative(_id, payload);
  };
  const errorRaceResult = await bg.runClaude('https://error-race.com');
  assertEqual(errorRaceResult.status, 'cancelled', 'runClaude returns cancelled when cancel arrives before error');
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: cancelClaude message handler integration
  console.log('\ncancelClaude message handler:');
  nativeDiskStore = {};
  const cancelHandler = browser.runtime._onMessageCallback;
  const handlerCancelResult = await cancelHandler({ action: 'cancelClaude', url: 'https://handler-cancel.com' }, {});
  assertEqual(handlerCancelResult.status, 'cancelled', 'message handler returns cancelled for cancelClaude');
  const handlerCancelState = await bg.getLastResult('https://handler-cancel.com');
  assertEqual(handlerCancelState.status, 'cancelled', 'message handler saves cancelled state via cancelClaude');

  // ── Summary ──────────────────────────────────────────────

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
  console.log(`${'─'.repeat(40)}\n`);

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
