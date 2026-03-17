/**
 * result.test.js — Unit tests for Claude Assistant result/result.js pop-out page
 *
 * Run with: node tests/result.test.js
 *
 * Tests the retry logic for getLastResult and rendering behavior.
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
 * Tracks sendMessage call count to verify retry behavior.
 */
function createMocks({ getLastResultResponses = [] } = {}) {
  // Track classList state per element
  function makeClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
      _classes: classes
    };
  }

  function makeElement(id) {
    const listeners = {};
    return {
      id,
      textContent: '',
      innerHTML: '',
      innerText: '',
      get innerText() { return this.textContent || this.innerHTML.replace(/<[^>]+>/g, ''); },
      classList: makeClassList(),
      addEventListener(event, handler) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      },
      _listeners: listeners
    };
  }

  const elements = {
    'result-content': makeElement('result-content'),
    'prompt-display': makeElement('prompt-display'),
    'result-meta': makeElement('result-meta'),
    'copy-btn': makeElement('copy-btn')
  };

  let domContentLoadedCb = null;
  let sendMessageCallCount = 0;
  let responseIndex = 0;

  const mocks = {
    elements,
    domContentLoadedCb: null,
    getSendMessageCallCount: () => sendMessageCallCount,
    timeouts: []
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
      return {
        textContent: '',
        get innerHTML() {
          return this.textContent
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        }
      };
    }
  };

  // Global navigator mock
  global.navigator = {
    clipboard: {
      writeText: async () => {}
    }
  };

  // Global browser mock — returns responses from the array in order
  global.browser = {
    runtime: {
      sendMessage(msg) {
        sendMessageCallCount++;
        if (msg.action === 'getLastResult') {
          const response = getLastResultResponses[responseIndex] ?? null;
          responseIndex++;
          return Promise.resolve(response);
        }
        return Promise.resolve(null);
      }
    }
  };
  global.chrome = global.browser;

  // Mock setTimeout — track calls and execute immediately for tests
  global.setTimeout = (fn, delay) => {
    const id = mocks.timeouts.length;
    mocks.timeouts.push({ fn, delay });
    // Return a fake timeout ID
    return id;
  };

  // Override the real setTimeout so the retry delay resolves immediately.
  // We patch Promise constructor to intercept the setTimeout-based delay.
  // Actually, we need setTimeout to call fn immediately for the retry to work
  // during test execution. Let's use a different approach — make setTimeout
  // call the function synchronously (delay is irrelevant in tests).
  global.setTimeout = (fn, delay) => {
    const id = mocks.timeouts.length;
    mocks.timeouts.push({ fn, delay });
    // Execute immediately so the await resolves
    if (fn) fn();
    return id;
  };

  return mocks;
}

/**
 * Requires a fresh copy of result.js by clearing the module cache.
 * Must be called AFTER createMocks() sets up globals.
 */
function requireFreshResult() {
  const modulePath = require.resolve('../extension/result/result.js');
  delete require.cache[modulePath];
  return require('../extension/result/result.js');
}

// ── Tests ────────────────────────────────────────────────────

async function runTests() {
  console.log('\nClaude Assistant — result.js tests\n');

  // ── Successful getLastResult on first try ──────────────────

  console.log('Successful getLastResult (first try):');
  {
    const mocks = createMocks({
      getLastResultResponses: [
        {
          status: 'complete',
          prompt: 'Summarize https://example.com',
          url: 'https://example.com',
          response: { result: 'A summary of the page' },
          startTime: 1000,
          endTime: 2000
        }
      ]
    });
    requireFreshResult();
    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-content'].innerHTML.includes('A summary of the page'),
      'result content is rendered'
    );
    assert(
      mocks.elements['prompt-display'].innerHTML.includes('Summarize'),
      'prompt is displayed'
    );
    assertEqual(
      mocks.getSendMessageCallCount(), 1,
      'only one sendMessage call (no retry needed)'
    );
  }

  // ── First call null, retry succeeds ────────────────────────

  console.log('\nRetry logic (first null, second succeeds):');
  {
    const mocks = createMocks({
      getLastResultResponses: [
        null, // first call returns null
        {     // retry succeeds
          status: 'complete',
          prompt: 'Explain https://test.com',
          url: 'https://test.com',
          response: { result: 'An explanation' },
          startTime: 1000,
          endTime: 3000
        }
      ]
    });
    requireFreshResult();
    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-content'].innerHTML.includes('An explanation'),
      'result content rendered after retry'
    );
    assert(
      mocks.elements['prompt-display'].innerHTML.includes('Explain'),
      'prompt displayed after retry'
    );
    assertEqual(
      mocks.getSendMessageCallCount(), 2,
      'two sendMessage calls (initial + retry)'
    );
    assert(
      mocks.timeouts.length > 0 && mocks.timeouts[0].delay === 500,
      'retry delay is 500ms'
    );
  }

  // ── Both calls return null → shows placeholder ─────────────

  console.log('\nBoth calls null (shows placeholder):');
  {
    const mocks = createMocks({
      getLastResultResponses: [null, null]
    });
    requireFreshResult();
    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-content'].innerHTML.includes('No result available'),
      'placeholder message shown when both calls return null'
    );
    assertEqual(
      mocks.getSendMessageCallCount(), 2,
      'two sendMessage calls (initial + retry)'
    );
  }

  // ── Result with non-complete status → shows placeholder ────

  console.log('\nNon-complete status (shows placeholder):');
  {
    const mocks = createMocks({
      getLastResultResponses: [{
        status: 'running',
        prompt: 'Summarize https://example.com',
        url: 'https://example.com'
      }]
    });
    requireFreshResult();
    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-content'].innerHTML.includes('No result available'),
      'placeholder shown for running status'
    );
    assertEqual(
      mocks.getSendMessageCallCount(), 1,
      'no retry for non-null result with wrong status'
    );
  }

  // ── Error status → shows placeholder ───────────────────────

  console.log('\nError status (shows placeholder):');
  {
    const mocks = createMocks({
      getLastResultResponses: [{
        status: 'error',
        error: 'CLI not found'
      }]
    });
    requireFreshResult();
    await mocks.domContentLoadedCb();

    assert(
      mocks.elements['result-content'].innerHTML.includes('No result available'),
      'placeholder shown for error status'
    );
  }

  // ── Metadata rendering ─────────────────────────────────────

  console.log('\nMetadata rendering:');
  {
    const mocks = createMocks({
      getLastResultResponses: [{
        status: 'complete',
        prompt: 'Review https://example.com',
        url: 'https://example.com',
        startTime: 1000,
        endTime: 4000,
        response: {
          result: 'Review content',
          cost_usd: 0.0123,
          input_tokens: 500,
          output_tokens: 200
        }
      }]
    });
    requireFreshResult();
    await mocks.domContentLoadedCb();

    const metaHtml = mocks.elements['result-meta'].innerHTML;
    assert(metaHtml.includes('0.0123'), 'cost is displayed in metadata');
    assert(metaHtml.includes('500'), 'input tokens in metadata');
    assert(metaHtml.includes('200'), 'output tokens in metadata');
    assert(metaHtml.includes('3s'), 'duration calculated from start/end time');
    assert(metaHtml.includes('example.com'), 'URL in metadata');
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
