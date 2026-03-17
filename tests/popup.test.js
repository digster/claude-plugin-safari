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
    'error-area': makeElement('error-area', ['hidden'])
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

  // Global browser mock — configurable per test
  global.browser = {
    tabs: {
      query: async () => {
        if (tabUrl) return [{ url: tabUrl }];
        return [{ url: 'https://example.com' }];
      },
      create: async () => ({})
    },
    runtime: {
      sendMessage(msg, callback) {
        // Route based on action, matching popup.js's sendMessage usage
        if (msg.action === 'getSettings') {
          callback(settings || { prefix: 'Summarize' });
        } else if (msg.action === 'getLastResult') {
          callback(lastResult || null);
        } else {
          callback(null);
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

  // Test 2: Mismatched URL — nothing shown
  {
    const mocks = createMocks({
      tabUrl: 'https://example.com/page-A',
      lastResult: {
        status: 'complete',
        url: 'https://other-site.com/page-B',
        response: { result: 'Old result' }
      }
    });
    requireFreshPopup();

    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-area'].classList.contains('hidden'),
      'mismatched URL + complete → result area stays hidden'
    );
    assert(
      mocks.elements['loading'].classList.contains('hidden'),
      'mismatched URL + complete → loading stays hidden'
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
    global.browser.runtime.sendMessage = (msg, callback) => {
      if (msg.action === 'getLastResult') {
        callback({
          status: 'complete',
          url: 'https://other-site.com/different',
          response: { result: 'Wrong page result' }
        });
      } else {
        callback(null);
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
    global.browser.runtime.sendMessage = (msg, callback) => {
      if (msg.action === 'getLastResult') {
        callback(null);
      } else {
        callback(null);
      }
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
