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
    getURL: (path) => path,
    onMessage: { addListener: (cb) => { browser.runtime._onMessageCallback = cb; } },
    onInstalled: { addListener: () => {} },
    _onMessageCallback: null
  },
  tabs: {
    query: async () => [{ url: 'https://example.com' }],
    onUpdated: {
      addListener: (cb) => { browser.tabs._onUpdatedCallback = cb; },
    },
    onRemoved: {
      addListener: (cb) => { browser.tabs._onRemovedCallback = cb; },
    },
    _onUpdatedCallback: null,
    _onRemovedCallback: null
  },
  action: {
    _icons: {},
    setIcon: ({ path, imageData, tabId }) => {
      browser.action._icons[tabId] = path ? { path } : { imageData };
    }
  }
};

// Make browser available globally for the module
global.browser = browser;
global.chrome = browser;

// Mock Image constructor for canvas compositing in setBadge.
// Handlers are attached BEFORE src is set, so onload fires from the src setter.
global.Image = class {
  constructor() { this._onload = null; this._onerror = null; this._complete = false; }
  set onload(fn) { this._onload = fn; }
  get onload() { return this._onload; }
  set onerror(fn) { this._onerror = fn; }
  get onerror() { return this._onerror; }
  set src(val) {
    this._src = val;
    this._complete = true;
    // Simulate async image load completion (handlers are already attached)
    if (this._onload) Promise.resolve().then(() => this._onload());
  }
  get src() { return this._src; }
  get complete() { return this._complete; }
};

// Mock document.createElement for canvas used by createDotIcon
global.document = {
  createElement: (tag) => {
    if (tag === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          beginPath: () => {},
          arc: () => {},
          fill: () => {},
          getImageData: (x, y, w, h) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4)
          }),
          set fillStyle(v) { this._fillStyle = v; },
          get fillStyle() { return this._fillStyle; }
        })
      };
    }
    return {};
  }
};

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

  // ── Badge notification tests (canvas-based icon overlay) ──

  // Test: setBadge sets green dot icon for 'complete'
  console.log('\nsetBadge:');
  browser.action._icons = {};
  await bg.setBadge(42, 'complete');
  assert(browser.action._icons[42]?.imageData, 'setBadge complete sets imageData');
  assert(browser.action._icons[42].imageData[16], 'setBadge complete includes 16px icon');
  assert(browser.action._icons[42].imageData[32], 'setBadge complete includes 32px icon');

  // Test: setBadge sets red dot icon for 'error'
  browser.action._icons = {};
  await bg.setBadge(42, 'error');
  assert(browser.action._icons[42]?.imageData, 'setBadge error sets imageData');
  assert(browser.action._icons[42].imageData[16], 'setBadge error includes 16px icon');

  // Test: setBadge(null) restores original icon paths
  browser.action._icons = {};
  await bg.setBadge(42, null);
  assert(browser.action._icons[42]?.path, 'setBadge null restores path');
  assertEqual(browser.action._icons[42].path[16], 'icons/icon-16.png', 'setBadge null restores 16px path');
  assertEqual(browser.action._icons[42].path[32], 'icons/icon-32.png', 'setBadge null restores 32px path');

  // Test: clearBadge shorthand
  console.log('\nclearBadge:');
  browser.action._icons = {};
  await bg.setBadge(99, 'complete');
  await bg.clearBadge(99);
  assert(browser.action._icons[99]?.path, 'clearBadge restores original icon');

  // Test: clearBadgeForUrl clears badge and removes map entry
  console.log('\nclearBadgeForUrl:');
  browser.action._icons = {};
  bg.urlToTabId.set('https://badge-test.com', 55);
  await bg.setBadge(55, 'complete');
  await bg.clearBadgeForUrl('https://badge-test.com');
  assert(browser.action._icons[55]?.path, 'clearBadgeForUrl restores original icon');
  assert(!bg.urlToTabId.has('https://badge-test.com'), 'clearBadgeForUrl removes map entry');

  // Test: clearBadgeForUrl with unknown URL is a no-op
  browser.action._icons = {};
  await bg.clearBadgeForUrl('https://unknown.com');
  assertEqual(Object.keys(browser.action._icons).length, 0, 'clearBadgeForUrl no-op for unknown URL');

  // Test: clearBadgeForTab clears badge and removes all map entries for tab
  console.log('\nclearBadgeForTab:');
  browser.action._icons = {};
  bg.urlToTabId.clear();
  bg.urlToTabId.set('https://tab-url-a.com', 77);
  bg.urlToTabId.set('https://tab-url-b.com', 77);
  bg.urlToTabId.set('https://other-tab.com', 88);
  await bg.setBadge(77, 'complete');
  await bg.clearBadgeForTab(77);
  assert(browser.action._icons[77]?.path, 'clearBadgeForTab restores original icon');
  assert(!bg.urlToTabId.has('https://tab-url-a.com'), 'clearBadgeForTab removes URL A for tab');
  assert(!bg.urlToTabId.has('https://tab-url-b.com'), 'clearBadgeForTab removes URL B for tab');
  assert(bg.urlToTabId.has('https://other-tab.com'), 'clearBadgeForTab keeps URLs for other tabs');

  // Test: badge set to green on runClaude complete
  console.log('\nbadge on runClaude complete:');
  nativeDiskStore = {};
  browser.action._icons = {};
  bg.urlToTabId.clear();
  delete mockStorage.settings;
  await bg.saveSettings({ prefix: 'Summarize', allowedTools: '' });
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action && ['storeResult', 'getStoredResult', 'clearStoredResult', 'clearAllResults'].includes(payload.action)) {
      return originalSendNative(_id, payload);
    }
    return { result: 'mock response' };
  };
  await bg.runClaude('https://badge-complete.com', 77);
  // setBadge is fire-and-forget — flush microtasks so the async badge settles
  await new Promise(r => setTimeout(r, 0));
  assert(browser.action._icons[77]?.imageData, 'runClaude complete sets dot icon');
  assert(browser.action._icons[77].imageData[16], 'runClaude complete icon has 16px');

  // Test: badge set to red on runClaude error
  console.log('\nbadge on runClaude error:');
  nativeDiskStore = {};
  browser.action._icons = {};
  bg.urlToTabId.clear();
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action && ['storeResult', 'getStoredResult', 'clearStoredResult', 'clearAllResults'].includes(payload.action)) {
      return originalSendNative(_id, payload);
    }
    throw new Error('CLI failed');
  };
  await bg.runClaude('https://badge-error.com', 88);
  // setBadge is fire-and-forget — flush microtasks so the async badge settles
  await new Promise(r => setTimeout(r, 0));
  assert(browser.action._icons[88]?.imageData, 'runClaude error sets dot icon');
  assert(browser.action._icons[88].imageData[16], 'runClaude error icon has 16px');

  // Test: badge cleared on cancelClaude
  console.log('\nbadge on cancelClaude:');
  nativeDiskStore = {};
  browser.action._icons = {};
  bg.urlToTabId.clear();
  browser.runtime.sendNativeMessage = originalSendNative;
  bg.urlToTabId.set('https://badge-cancel.com', 66);
  await bg.setBadge(66, 'complete');
  await bg.cancelClaude('https://badge-cancel.com');
  assert(browser.action._icons[66]?.path, 'cancelClaude restores original icon');
  assert(!bg.urlToTabId.has('https://badge-cancel.com'), 'cancelClaude removes map entry');

  // Test: clearBadge message action (by URL)
  console.log('\nclearBadge message action (by URL):');
  nativeDiskStore = {};
  browser.action._icons = {};
  bg.urlToTabId.clear();
  bg.urlToTabId.set('https://msg-badge.com', 44);
  await bg.setBadge(44, 'complete');
  const clearBadgeHandler = browser.runtime._onMessageCallback;
  const clearBadgeResult = await clearBadgeHandler({ action: 'clearBadge', url: 'https://msg-badge.com' }, {});
  assertEqual(clearBadgeResult.success, true, 'clearBadge by URL returns success');
  assert(browser.action._icons[44]?.path, 'clearBadge by URL restores original icon');
  assert(!bg.urlToTabId.has('https://msg-badge.com'), 'clearBadge by URL removes map entry');

  // Test: clearBadge message action (by tabId)
  console.log('\nclearBadge message action (by tabId):');
  browser.action._icons = {};
  bg.urlToTabId.clear();
  bg.urlToTabId.set('https://tab-clear-a.com', 55);
  bg.urlToTabId.set('https://tab-clear-b.com', 55);
  await bg.setBadge(55, 'complete');
  const clearTabResult = await clearBadgeHandler({ action: 'clearBadge', tabId: 55 }, {});
  assertEqual(clearTabResult.success, true, 'clearBadge by tabId returns success');
  assert(browser.action._icons[55]?.path, 'clearBadge by tabId restores original icon');
  assert(!bg.urlToTabId.has('https://tab-clear-a.com'), 'clearBadge by tabId removes URL A');
  assert(!bg.urlToTabId.has('https://tab-clear-b.com'), 'clearBadge by tabId removes URL B');

  // Test: tab navigation clears badge for old URL
  console.log('\ntab navigation badge cleanup:');
  browser.action._icons = {};
  bg.urlToTabId.clear();
  bg.urlToTabId.set('https://old-page.com', 33);
  await bg.setBadge(33, 'complete');
  // Simulate tab navigating to a new URL (listener is now async)
  await browser.tabs._onUpdatedCallback(33, { url: 'https://new-page.com' }, {});
  assert(browser.action._icons[33]?.path, 'tab navigation restores original icon');
  assert(!bg.urlToTabId.has('https://old-page.com'), 'tab navigation removes old URL from map');

  // Test: tab close cleans up map entry
  console.log('\ntab close cleanup:');
  bg.urlToTabId.clear();
  bg.urlToTabId.set('https://closed-tab.com', 22);
  browser.tabs._onRemovedCallback(22);
  assert(!bg.urlToTabId.has('https://closed-tab.com'), 'tab close removes URL from map');

  // Test: setIcon API failure doesn't break runClaude
  console.log('\nsetIcon API failure resilience:');
  nativeDiskStore = {};
  bg.urlToTabId.clear();
  delete mockStorage.settings;
  await bg.saveSettings({ prefix: 'Summarize', allowedTools: '' });
  // Make setIcon throw
  const originalSetIcon = browser.action.setIcon;
  browser.action.setIcon = () => { throw new Error('setIcon API unavailable'); };
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action && ['storeResult', 'getStoredResult', 'clearStoredResult', 'clearAllResults'].includes(payload.action)) {
      return originalSendNative(_id, payload);
    }
    return { result: 'mock response' };
  };
  let badgeError = null;
  try {
    const badgeResult = await bg.runClaude('https://badge-fail.com', 11);
    assertEqual(badgeResult.status, 'complete', 'runClaude completes despite setIcon failure');
  } catch (err) {
    badgeError = err;
  }
  assertEqual(badgeError, null, 'setIcon failure does not throw from runClaude');
  browser.action.setIcon = originalSetIcon;
  browser.runtime.sendNativeMessage = originalSendNative;

  // Test: runClaude without tabId does not crash badge logic
  console.log('\nrunClaude without tabId:');
  nativeDiskStore = {};
  browser.action._icons = {};
  bg.urlToTabId.clear();
  delete mockStorage.settings;
  await bg.saveSettings({ prefix: 'Summarize', allowedTools: '' });
  browser.runtime.sendNativeMessage = async (_id, payload) => {
    if (payload.action && ['storeResult', 'getStoredResult', 'clearStoredResult', 'clearAllResults'].includes(payload.action)) {
      return originalSendNative(_id, payload);
    }
    return { result: 'mock response' };
  };
  let noTabError = null;
  try {
    const noTabResult = await bg.runClaude('https://no-tab.com');
    assertEqual(noTabResult.status, 'complete', 'runClaude completes without tabId');
  } catch (err) {
    noTabError = err;
  }
  assertEqual(noTabError, null, 'runClaude without tabId does not throw');
  assertEqual(Object.keys(browser.action._icons).length, 0, 'no icon set when tabId is undefined');
  browser.runtime.sendNativeMessage = originalSendNative;

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
