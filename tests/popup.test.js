/**
 * popup.test.js — Unit tests for Claude Assistant popup.js URL-specific cache guards
 *
 * Run with: node tests/popup.test.js
 *
 * Tests the two URL guards added to popup.js:
 * 1. DOMContentLoaded: only restore cached results when lastResult.url === currentUrl
 * 2. pollForResult: stop polling when result.url !== currentUrl
 *
 * Uses the same minimal test harness as background.test.js (no external deps).
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

// ── Mock factory ─────────────────────────────────────────────

/**
 * Creates a fresh set of DOM and browser mocks for each test.
 * Returns an object with references to all mocks so tests can
 * inspect state after popup.js runs.
 */
function createMocks({ tabUrl, lastResult, settings } = {}) {
  // Track classList state per element for assertion
  function makeClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
      _classes: classes
    };
  }

  // Create a mock DOM element with common properties
  function makeElement(id, initialClasses = []) {
    const listeners = {};
    return {
      id,
      textContent: '',
      innerHTML: '',
      innerText: '',
      disabled: false,
      classList: makeClassList(initialClasses),
      addEventListener(event, handler) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      },
      _listeners: listeners
    };
  }

  // DOM elements — IDs match what popup.js looks up
  const elements = {
    'ask-btn': makeElement('ask-btn'),
    'settings-btn': makeElement('settings-btn'),
    'prefix-display': makeElement('prefix-display'),
    'url-display': makeElement('url-display'),
    'loading': makeElement('loading', ['hidden']),
    'elapsed': makeElement('elapsed'),
    'result-area': makeElement('result-area', ['hidden']),
    'result-content': makeElement('result-content'),
    'result-meta': makeElement('result-meta'),
    'copy-btn': makeElement('copy-btn'),
    'popout-btn': makeElement('popout-btn'),
    'error-area': makeElement('error-area', ['hidden']),
    'stop-btn': makeElement('stop-btn'),
    'cancelled-area': makeElement('cancelled-area', ['hidden'])
  };

  // Capture DOMContentLoaded callback
  let domContentLoadedCb = null;

  // Capture setTimeout calls so we can invoke them manually
  const timeouts = [];
  const intervals = [];

  const mocks = {
    elements,
    domContentLoadedCb: null,
    timeouts,
    intervals,
  };

  // Global document mock
  global.document = {
    getElementById(id) {
      return elements[id] || makeElement(id);
    },
    addEventListener(event, cb) {
      if (event === 'DOMContentLoaded') {
        mocks.domContentLoadedCb = cb;
      }
    },
    createElement(tag) {
      // Used by escapeHtml — simple mock that mimics textContent→innerHTML
      return {
        textContent: '',
        get innerHTML() {
          // Basic HTML escaping for test purposes
          return this.textContent
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        }
      };
    }
  };

  // Global navigator mock (for clipboard in copy handler)
  global.navigator = {
    clipboard: {
      writeText: async () => {}
    }
  };

  // Track messages for verification
  const getLastResultMessages = [];
  const cancelMessages = [];
  const clearBadgeMessages = [];
  const runClaudeMessages = [];

  // Global browser mock — configurable per test
  global.browser = {
    tabs: {
      query: async () => {
        if (tabUrl) return [{ id: 123, url: tabUrl }];
        return [{ id: 123, url: 'https://example.com' }];
      },
      create: async () => ({})
    },
    runtime: {
      sendMessage(msg) {
        // Track getLastResult messages so tests can verify URL is included
        if (msg.action === 'getLastResult') {
          getLastResultMessages.push(msg);
          return Promise.resolve(lastResult || null);
        } else if (msg.action === 'getSettings') {
          return Promise.resolve(settings || { prefix: 'Summarize' });
        } else if (msg.action === 'cancelClaude') {
          cancelMessages.push(msg);
          return Promise.resolve({ status: 'cancelled' });
        } else if (msg.action === 'clearBadge') {
          clearBadgeMessages.push(msg);
          return Promise.resolve({ success: true });
        } else if (msg.action === 'runClaude') {
          runClaudeMessages.push(msg);
          return Promise.resolve(null);
        } else {
          return Promise.resolve(null);
        }
      },
      openOptionsPage: () => {},
      getURL: (path) => `extension://${path}`
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {}
      }
    }
  };

  mocks.getLastResultMessages = getLastResultMessages;
  mocks.cancelMessages = cancelMessages;
  mocks.clearBadgeMessages = clearBadgeMessages;
  mocks.runClaudeMessages = runClaudeMessages;
  global.chrome = global.browser;

  // Mock timers — capture callbacks for manual invocation
  global.setTimeout = (fn, delay) => {
    const id = timeouts.length;
    timeouts.push({ fn, delay });
    return id;
  };
  global.setInterval = (fn, delay) => {
    const id = intervals.length;
    intervals.push({ fn, delay });
    return id;
  };
  global.clearInterval = (id) => {
    if (intervals[id]) intervals[id].fn = null;
  };

  // Date.now for elapsed timer
  global.Date = { now: () => 1000000 };

  return mocks;
}

/**
 * Requires a fresh copy of popup.js by clearing the module cache.
 * Must be called AFTER createMocks() sets up globals.
 */
function requireFreshPopup() {
  const modulePath = require.resolve('../extension/popup/popup.js');
  delete require.cache[modulePath];
  return require('../extension/popup/popup.js');
}

// ── Tests ────────────────────────────────────────────────────

async function runTests() {
  console.log('\nClaude Assistant — popup.js URL cache guard tests\n');

  // ── Cached result restore (DOMContentLoaded) ──────────────

  console.log('Cached result restore:');

  // Test 1: Matching URL — complete result is shown
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page',
      lastResult: {
        status: 'complete',
        url: 'https://example.com/page',
        response: { result: 'A summary of the page' }
      }
    });
    requireFreshPopup();

    // Fire the DOMContentLoaded callback
    await mocks.domContentLoadedCb();

    assert(
      !mocks.elements['result-area'].classList.contains('hidden'),
      'matching URL + complete → result area is visible'
    );
    assert(
      mocks.elements['result-content'].innerHTML.length > 0,
      'matching URL + complete → result content is populated'
    );
  }

  // Test 1b: getLastResult is called with the current tab URL
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/specific-page',
      lastResult: null
    });
    requireFreshPopup();
    await mocks.domContentLoadedCb();

    assert(
      mocks.getLastResultMessages.length > 0,
      'getLastResult was called during init'
    );
    assertEqual(
      mocks.getLastResultMessages[0].url,
      'https://example.com/specific-page',
      'getLastResult is called with the current tab URL'
    );
  }

  // Test 2: Per-URL miss — nothing shown (simulates no cached result for this URL)
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page-A',
      lastResult: null  // per-URL cache miss returns null
    });
    requireFreshPopup();

    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-area'].classList.contains('hidden'),
      'per-URL miss → result area stays hidden'
    );
    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'per-URL miss → loading stays hidden'
    );
  }

  // Test 3: Matching URL — running state shows loading
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/running',
      lastResult: {
        status: 'running',
        url: 'https://example.com/running',
        startTime: 999000
      }
    });
    requireFreshPopup();

    await mocks.domContentLoadedCb();

    assert(
      !mocks.elements['loading'].classList.contains('hidden'),
      'matching URL + running → loading is visible'
    );
  }

  // Test 4: Mismatched URL — running state does NOT show loading
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/current',
      lastResult: {
        status: 'running',
        url: 'https://example.com/old-tab',
        startTime: 999000
      }
    });
    requireFreshPopup();

    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'mismatched URL + running → loading stays hidden'
    );
  }

  // Test 5: Legacy result without url field is not shown
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page',
      lastResult: {
        status: 'complete',
        response: { result: 'Legacy data without url field' }
        // Note: no .url property
      }
    });
    requireFreshPopup();

    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-area'].classList.contains('hidden'),
      'legacy result (no url field) → result area stays hidden'
    );
  }

  // ── Polling (pollForResult) ────────────────────────────────

  console.log('\nPolling behavior:');

  // Test 6: Poll returns result for different URL → stops polling, no result displayed
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/current',
      lastResult: {
        status: 'running',
        url: 'https://example.com/current',
        startTime: 999000
      }
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Loading should be visible after DOMContentLoaded (running + matching URL)
    assert(
      !mocks.elements['loading'].classList.contains('hidden'),
      'poll setup: loading is visible before poll fires'
    );
    assert(mocks.timeouts.length > 0, 'poll setup: setTimeout was called');

    // NOW override sendMessage so the poll callback gets a different-URL result
    global.browser.runtime.sendMessage = (msg) => {
      if (msg.action === 'getLastResult') {
        return Promise.resolve({
          status: 'complete',
          url: 'https://other-site.com/different',
          response: { result: 'Wrong page result' }
        });
      } else {
        return Promise.resolve(null);
      }
    };

    // Execute the poll timeout(s)
    for (const t of mocks.timeouts) {
      if (t.fn) await t.fn();
    }

    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'poll: different URL → loading is hidden (stopped)'
    );
    assert(
      mocks.elements['result-area'].classList.contains('hidden'),
      'poll: different URL → result area stays hidden (not displayed)'
    );
  }

  // Test 7: Poll returns null → stops polling
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/current',
      lastResult: {
        status: 'running',
        url: 'https://example.com/current',
        startTime: 999000
      }
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Override sendMessage so poll gets null
    global.browser.runtime.sendMessage = (msg) => {
      return Promise.resolve(null);
    };

    // Execute poll timeout(s)
    for (const t of mocks.timeouts) {
      if (t.fn) await t.fn();
    }

    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'poll: null result → loading is hidden (stopped)'
    );
  }

  // ── Null/error result handling ──────────────────────────────

  console.log('\nNull/error result handling:');

  // Test 8: Click handler with null result shows error
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page',
      lastResult: null
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Override sendMessage to return null for runClaude (simulating no response)
    global.browser.runtime.sendMessage = (msg) => {
      return Promise.resolve(null);
    };

    // Trigger the click handler
    const clickHandlers = mocks.elements['ask-btn']._listeners['click'];
    assert(clickHandlers && clickHandlers.length > 0, 'click handler is registered');
    await clickHandlers[0]();

    assert(
      !mocks.elements['error-area'].classList.contains('hidden'),
      'null result from click → error area is visible'
    );
    assert(
      mocks.elements['error-area'].textContent.includes('No response received'),
      'null result from click → shows "No response received" message'
    );
    assert(
      !mocks.elements['ask-btn'].disabled,
      'null result from click → ask button is re-enabled'
    );
  }

  // Test 9: Click handler with unknown status shows error
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page',
      lastResult: null
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Override sendMessage to return an unexpected status
    global.browser.runtime.sendMessage = (msg) => {
      if (msg.action === 'runClaude') {
        return Promise.resolve({ status: 'unknown', error: 'Something went wrong' });
      }
      return Promise.resolve(null);
    };

    const clickHandlers = mocks.elements['ask-btn']._listeners['click'];
    await clickHandlers[0]();

    assert(
      !mocks.elements['error-area'].classList.contains('hidden'),
      'unknown status from click → error area is visible'
    );
    assert(
      mocks.elements['error-area'].textContent.includes('Something went wrong'),
      'unknown status from click → shows the error message from result'
    );
  }

  // Test 10: DOMContentLoaded initialization error is caught
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page',
      lastResult: null
    });

    // Override tabs.query to throw an error
    global.browser.tabs.query = async () => {
      throw new Error('Tabs API unavailable');
    };

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    assert(
      !mocks.elements['error-area'].classList.contains('hidden'),
      'initialization error → error area is visible'
    );
    assert(
      mocks.elements['error-area'].textContent.includes('Failed to initialize'),
      'initialization error → shows init failure message'
    );
  }

  // ── Stop button and cancelled state ─────────────────────────

  console.log('\nStop button:');

  // Test 11: Stop button sends cancelClaude and shows cancelled state
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/running',
      lastResult: {
        status: 'running',
        url: 'https://example.com/running',
        startTime: 999000
      }
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Loading should be visible (running state)
    assert(
      !mocks.elements['loading'].classList.contains('hidden'),
      'stop button setup: loading is visible'
    );

    // Click the stop button
    const stopHandlers = mocks.elements['stop-btn']._listeners['click'];
    assert(stopHandlers && stopHandlers.length > 0, 'stop button has click handler');
    await stopHandlers[0]();

    assert(
      mocks.cancelMessages.length > 0,
      'stop button sends cancelClaude message'
    );
    assertEqual(
      mocks.cancelMessages[0].url,
      'https://example.com/running',
      'cancelClaude message includes current URL'
    );
    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'stop button click → loading is hidden'
    );
    assert(
      !mocks.elements['cancelled-area'].classList.contains('hidden'),
      'stop button click → cancelled area is visible'
    );
    assert(
      !mocks.elements['ask-btn'].disabled,
      'stop button click → ask button is re-enabled'
    );
    assert(
      mocks.elements['stop-btn'].disabled,
      'stop button is disabled after click (prevents double-click)'
    );
  }

  // Test 12: Cancelled status from init shows cancelled area
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/was-cancelled',
      lastResult: {
        status: 'cancelled',
        url: 'https://example.com/was-cancelled',
        cancelledAt: 999500
      }
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    assert(
      !mocks.elements['cancelled-area'].classList.contains('hidden'),
      'cancelled status from init → cancelled area is visible'
    );
    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'cancelled status from init → loading stays hidden'
    );
    assert(
      mocks.elements['result-area'].classList.contains('hidden'),
      'cancelled status from init → result area stays hidden'
    );
  }

  // Test 13: Cancelled status from polling shows cancelled area
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/current',
      lastResult: {
        status: 'running',
        url: 'https://example.com/current',
        startTime: 999000
      }
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Override sendMessage so poll callback gets cancelled status
    global.browser.runtime.sendMessage = (msg) => {
      if (msg.action === 'getLastResult') {
        return Promise.resolve({
          status: 'cancelled',
          url: 'https://example.com/current',
          cancelledAt: 999500
        });
      }
      return Promise.resolve(null);
    };

    // Execute poll timeout(s)
    for (const t of mocks.timeouts) {
      if (t.fn) await t.fn();
    }

    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'poll: cancelled status → loading is hidden'
    );
    assert(
      !mocks.elements['cancelled-area'].classList.contains('hidden'),
      'poll: cancelled status → cancelled area is visible'
    );
  }

  // Test 14: Cancelled state from click handler shows cancelled area
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page',
      lastResult: null
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Override sendMessage to return cancelled for runClaude
    global.browser.runtime.sendMessage = (msg) => {
      if (msg.action === 'runClaude') {
        return Promise.resolve({ status: 'cancelled', url: 'https://example.com/page' });
      }
      return Promise.resolve(null);
    };

    const clickHandlers = mocks.elements['ask-btn']._listeners['click'];
    await clickHandlers[0]();

    assert(
      !mocks.elements['cancelled-area'].classList.contains('hidden'),
      'cancelled from click handler → cancelled area is visible'
    );
    assert(
      !mocks.elements['ask-btn'].disabled,
      'cancelled from click handler → ask button is re-enabled'
    );
  }

  // ── Badge clearing from popup ──────────────────────────────

  console.log('\nBadge clearing:');

  // Test 15: Popup sends clearBadge on init when complete result found
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/badge-clear',
      lastResult: {
        status: 'complete',
        url: 'https://example.com/badge-clear',
        response: { result: 'A summary' }
      }
    });
    requireFreshPopup();
    await mocks.domContentLoadedCb();

    assert(
      mocks.clearBadgeMessages.length > 0,
      'popup sends clearBadge on init when complete result found'
    );
    assertEqual(
      mocks.clearBadgeMessages[0].url,
      'https://example.com/badge-clear',
      'clearBadge message includes current URL'
    );
  }

  // Test 16: Popup sends clearBadge on init when error result found
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/badge-error',
      lastResult: {
        status: 'error',
        url: 'https://example.com/badge-error',
        error: 'CLI failed'
      }
    });
    requireFreshPopup();
    await mocks.domContentLoadedCb();

    assert(
      mocks.clearBadgeMessages.length > 0,
      'popup sends clearBadge on init when error result found'
    );
  }

  // Test 17: Popup does NOT send clearBadge when status is running
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/running',
      lastResult: {
        status: 'running',
        url: 'https://example.com/running',
        startTime: 999000
      }
    });
    requireFreshPopup();
    await mocks.domContentLoadedCb();

    assertEqual(
      mocks.clearBadgeMessages.length,
      0,
      'popup does NOT send clearBadge when status is running'
    );
  }

  // Test 18: Popup sends tabId in runClaude message
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/with-tab',
      lastResult: null
    });
    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Trigger the click handler
    const clickHandlers = mocks.elements['ask-btn']._listeners['click'];
    await clickHandlers[0]();

    assert(
      mocks.runClaudeMessages.length > 0,
      'runClaude message was sent'
    );
    assertEqual(
      mocks.runClaudeMessages[0].tabId,
      123,
      'runClaude message includes tabId from active tab'
    );
    assertEqual(
      mocks.runClaudeMessages[0].url,
      'https://example.com/with-tab',
      'runClaude message includes current URL'
    );
  }

  // Test 19: Poll sends clearBadge when result completes
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/poll-badge',
      lastResult: {
        status: 'running',
        url: 'https://example.com/poll-badge',
        startTime: 999000
      }
    });

    requireFreshPopup();
    await mocks.domContentLoadedCb();

    // Override sendMessage so poll gets a complete result
    global.browser.runtime.sendMessage = (msg) => {
      if (msg.action === 'getLastResult') {
        return Promise.resolve({
          status: 'complete',
          url: 'https://example.com/poll-badge',
          response: { result: 'Done' }
        });
      } else if (msg.action === 'clearBadge') {
        mocks.clearBadgeMessages.push(msg);
        return Promise.resolve({ success: true });
      }
      return Promise.resolve(null);
    };

    // Execute poll timeout(s)
    for (const t of mocks.timeouts) {
      if (t.fn) await t.fn();
    }

    assert(
      mocks.clearBadgeMessages.length > 0,
      'poll sends clearBadge when result completes'
    );
  }

  // ── Utility function exports ──────────────────────────────

  console.log('\nExported utility functions:');

  // Test: formatElapsed
  {
    const mocks = createMocks();
    const popup = requireFreshPopup();

    assertEqual(popup.formatElapsed(0), '0s', 'formatElapsed: 0 seconds');
    assertEqual(popup.formatElapsed(45), '45s', 'formatElapsed: 45 seconds');
    assertEqual(popup.formatElapsed(60), '1m 0s', 'formatElapsed: 60 seconds');
    assertEqual(popup.formatElapsed(125), '2m 5s', 'formatElapsed: 125 seconds');
  }

  // Test: renderMarkdown
  {
    const mocks = createMocks();
    const popup = requireFreshPopup();

    assert(popup.renderMarkdown('').length === 0, 'renderMarkdown: empty string returns empty');
    assert(popup.renderMarkdown('hello').includes('hello'), 'renderMarkdown: plain text passes through');
    assert(popup.renderMarkdown('**bold**').includes('<strong>'), 'renderMarkdown: bold markdown');
    assert(popup.renderMarkdown('*italic*').includes('<em>'), 'renderMarkdown: italic markdown');
  }

  // ── Summary ────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
  console.log(`${'─'.repeat(40)}\n`);

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
