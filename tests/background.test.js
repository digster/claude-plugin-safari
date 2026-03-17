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
      // Route storage actions to in-memory disk store
      switch (payload.action) {
        case 'storeResult':
          nativeDiskStore.lastResult = payload.result;
          return { success: true };
        case 'getStoredResult':
          return { result: nativeDiskStore.lastResult || null };
        case 'clearStoredResult':
          delete nativeDiskStore.lastResult;
          return { success: true };
        default:
          return { result: 'mock response' };
      }
    },
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} }
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
    if (payload.action && ['storeResult', 'getStoredResult', 'clearStoredResult'].includes(payload.action)) {
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
