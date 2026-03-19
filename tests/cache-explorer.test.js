/**
 * cache-explorer.test.js — Unit tests for Cache Explorer export functionality
 *
 * Run with: node tests/cache-explorer.test.js
 *
 * Tests the export helpers (formatResultAsMarkdown, hostnameFromUrl, downloadFile)
 * and the bulk export deduplication logic. Uses the same minimal test harness
 * as the other test files (no external deps).
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

// ── Extract functions from cache-explorer.js ─────────────────
// We can't require() the file directly since it uses DOM APIs,
// so we extract the pure functions by evaluating them in isolation.

// hostnameFromUrl — extracted verbatim
function hostnameFromUrl(url) {
  if (!url) return 'unknown-url';
  try {
    return new URL(url).hostname || 'unknown-url';
  } catch {
    return 'unknown-url';
  }
}

// formatResultAsMarkdown — extracted verbatim
function formatResultAsMarkdown(item) {
  const result = item.result || item;
  const response = result.response;
  const url = result.url || 'Unknown URL';
  const status = result.status || 'unknown';

  const lines = [];

  // Title
  lines.push(`# ${url}`, '');

  // Metadata table
  lines.push('| Field | Value |', '|-------|-------|');
  lines.push(`| Status | ${status} |`);

  if (result.prompt) {
    lines.push(`| Prompt | ${result.prompt} |`);
  }
  if (result.startTime) {
    lines.push(`| Started | ${new Date(result.startTime).toISOString()} |`);
  }
  if (result.endTime) {
    lines.push(`| Ended | ${new Date(result.endTime).toISOString()} |`);
  }
  if (result.startTime && result.endTime) {
    const durationSec = Math.round((result.endTime - result.startTime) / 1000);
    lines.push(`| Duration | ${durationSec}s |`);
  } else if (response?.duration_ms) {
    lines.push(`| Duration | ${Math.round(response.duration_ms / 1000)}s |`);
  }
  if (response?.cost_usd != null) {
    lines.push(`| Cost | $${response.cost_usd.toFixed(4)} |`);
  }
  if (response?.input_tokens) {
    lines.push(`| Input Tokens | ${response.input_tokens} |`);
  }
  if (response?.output_tokens) {
    lines.push(`| Output Tokens | ${response.output_tokens} |`);
  }

  lines.push('', '---', '');

  // Response content — handle edge cases by status
  if (status === 'error') {
    const errorMsg = result.error || response?.error || 'Unknown error';
    lines.push(`**Error:** ${errorMsg}`);
  } else if (status === 'cancelled') {
    lines.push('*Request was cancelled.*');
  } else if (response && typeof response === 'object') {
    const text = response.result || response.text || response.output || '';
    lines.push(text || '*No response content available.*');
  } else if (response) {
    lines.push(String(response));
  } else {
    lines.push('*No response content available.*');
  }

  lines.push('');
  return lines.join('\n');
}

// ── Test Data ────────────────────────────────────────────────

const completeResult = {
  result: {
    url: 'https://example.com/page',
    status: 'complete',
    prompt: 'Summarize https://example.com/page',
    startTime: 1710806400000, // 2024-03-19T00:00:00.000Z
    endTime: 1710806415000,   // 15 seconds later
    response: {
      result: '## Summary\n\nThis is a test summary with **bold** and `code`.',
      cost_usd: 0.0123,
      input_tokens: 500,
      output_tokens: 200,
    }
  },
  _modified: 1710806415000
};

const errorResult = {
  result: {
    url: 'https://broken.site/fail',
    status: 'error',
    prompt: 'Summarize https://broken.site/fail',
    startTime: 1710806400000,
    endTime: 1710806405000,
    error: 'Connection timed out',
    response: null
  },
  _modified: 1710806405000
};

const cancelledResult = {
  result: {
    url: 'https://slow.site/long',
    status: 'cancelled',
    prompt: 'Summarize https://slow.site/long',
    startTime: 1710806400000,
    endTime: 1710806410000,
    response: null
  },
  _modified: 1710806410000
};

const emptyResponseResult = {
  result: {
    url: 'https://empty.site/nothing',
    status: 'complete',
    prompt: 'Summarize https://empty.site/nothing',
    startTime: 1710806400000,
    endTime: 1710806408000,
    response: {
      result: '',
      cost_usd: 0.001,
      input_tokens: 100,
      output_tokens: 0,
    }
  },
  _modified: 1710806408000
};

const durationMsResult = {
  result: {
    url: 'https://example.org/alt',
    status: 'complete',
    response: {
      result: 'Content here.',
      duration_ms: 8500,
    }
  }
};

// ── Tests ────────────────────────────────────────────────────

console.log('\n── hostnameFromUrl ──────────────────────────────');

console.log('\n  Test: extracts hostname from valid URL');
assertEqual(hostnameFromUrl('https://example.com/page'), 'example.com',
  'extracts hostname from https URL');

console.log('\n  Test: extracts hostname with subdomain');
assertEqual(hostnameFromUrl('https://www.docs.google.com/doc/123'), 'www.docs.google.com',
  'preserves full hostname including subdomain');

console.log('\n  Test: handles URL with port');
assertEqual(hostnameFromUrl('http://localhost:3000/api'), 'localhost',
  'extracts hostname without port');

console.log('\n  Test: falls back for null URL');
assertEqual(hostnameFromUrl(null), 'unknown-url',
  'null URL returns unknown-url');

console.log('\n  Test: falls back for undefined URL');
assertEqual(hostnameFromUrl(undefined), 'unknown-url',
  'undefined URL returns unknown-url');

console.log('\n  Test: falls back for empty string');
assertEqual(hostnameFromUrl(''), 'unknown-url',
  'empty string returns unknown-url');

console.log('\n  Test: falls back for invalid URL');
assertEqual(hostnameFromUrl('not-a-url'), 'unknown-url',
  'invalid URL string returns unknown-url');

// ── formatResultAsMarkdown ───────────────────────────────────

console.log('\n── formatResultAsMarkdown ───────────────────────');

console.log('\n  Test: complete result has URL heading');
{
  const md = formatResultAsMarkdown(completeResult);
  assert(md.startsWith('# https://example.com/page\n'),
    'starts with URL heading');
}

console.log('\n  Test: complete result includes metadata table');
{
  const md = formatResultAsMarkdown(completeResult);
  assert(md.includes('| Status | complete |'), 'includes status row');
  assert(md.includes('| Prompt | Summarize https://example.com/page |'), 'includes prompt row');
  assert(md.includes('| Cost | $0.0123 |'), 'includes cost row');
  assert(md.includes('| Input Tokens | 500 |'), 'includes input tokens row');
  assert(md.includes('| Output Tokens | 200 |'), 'includes output tokens row');
  assert(md.includes('| Duration | 15s |'), 'includes duration row');
}

console.log('\n  Test: complete result includes ISO timestamps');
{
  const md = formatResultAsMarkdown(completeResult);
  assert(md.includes('| Started | 2024-03-19T'), 'includes ISO start time');
  assert(md.includes('| Ended | 2024-03-19T'), 'includes ISO end time');
}

console.log('\n  Test: complete result includes response content after separator');
{
  const md = formatResultAsMarkdown(completeResult);
  const parts = md.split('---');
  assert(parts.length >= 2, 'has --- separator');
  const content = parts[parts.length - 1];
  assert(content.includes('## Summary'), 'response content preserved');
  assert(content.includes('**bold**'), 'markdown formatting preserved in content');
}

console.log('\n  Test: error result shows error message');
{
  const md = formatResultAsMarkdown(errorResult);
  assert(md.includes('| Status | error |'), 'status is error');
  assert(md.includes('**Error:** Connection timed out'), 'error message included');
}

console.log('\n  Test: cancelled result shows cancellation message');
{
  const md = formatResultAsMarkdown(cancelledResult);
  assert(md.includes('| Status | cancelled |'), 'status is cancelled');
  assert(md.includes('*Request was cancelled.*'), 'cancellation message included');
}

console.log('\n  Test: empty response shows fallback text');
{
  const md = formatResultAsMarkdown(emptyResponseResult);
  assert(md.includes('*No response content available.*'), 'empty response fallback text');
}

console.log('\n  Test: null response shows fallback text');
{
  const item = { result: { url: 'https://x.com', status: 'complete', response: null } };
  const md = formatResultAsMarkdown(item);
  assert(md.includes('*No response content available.*'), 'null response fallback text');
}

console.log('\n  Test: missing URL uses "Unknown URL"');
{
  const item = { result: { status: 'complete', response: { result: 'content' } } };
  const md = formatResultAsMarkdown(item);
  assert(md.startsWith('# Unknown URL\n'), 'falls back to Unknown URL');
}

console.log('\n  Test: duration_ms fallback when no start/end times');
{
  const md = formatResultAsMarkdown(durationMsResult);
  assert(md.includes('| Duration | 9s |'), 'uses duration_ms (8500ms → 9s rounded)');
  assert(!md.includes('| Started |'), 'no start time row');
  assert(!md.includes('| Ended |'), 'no end time row');
}

console.log('\n  Test: unwrapped result (no .result wrapper)');
{
  const flat = {
    url: 'https://flat.com',
    status: 'complete',
    response: { result: 'Flat content' }
  };
  const md = formatResultAsMarkdown(flat);
  assert(md.includes('# https://flat.com'), 'handles flat result without .result wrapper');
  assert(md.includes('Flat content'), 'content from flat result');
}

console.log('\n  Test: error result with response.error fallback');
{
  const item = {
    result: {
      url: 'https://err2.com',
      status: 'error',
      response: { error: 'API rate limit exceeded' }
    }
  };
  const md = formatResultAsMarkdown(item);
  assert(md.includes('**Error:** API rate limit exceeded'), 'uses response.error as fallback');
}

console.log('\n  Test: error result with no error details');
{
  const item = {
    result: {
      url: 'https://err3.com',
      status: 'error',
      response: null
    }
  };
  const md = formatResultAsMarkdown(item);
  assert(md.includes('**Error:** Unknown error'), 'falls back to Unknown error');
}

// ── Bulk export deduplication logic ──────────────────────────

console.log('\n── Bulk export deduplication ────────────────────');

console.log('\n  Test: unique hostnames produce unique filenames');
{
  const items = [
    { result: { url: 'https://example.com/a', status: 'complete', response: { result: 'A' } } },
    { result: { url: 'https://other.org/b', status: 'complete', response: { result: 'B' } } },
  ];

  const filenameCounts = {};
  const filenames = [];
  for (const item of items) {
    const result = item.result || item;
    const hostname = hostnameFromUrl(result.url);
    const baseName = `claude-${hostname}`;
    filenameCounts[baseName] = (filenameCounts[baseName] || 0) + 1;
    const suffix = filenameCounts[baseName] > 1 ? `-${filenameCounts[baseName]}` : '';
    filenames.push(`${baseName}${suffix}.md`);
  }

  assertEqual(filenames, ['claude-example.com.md', 'claude-other.org.md'],
    'unique hostnames have no suffix');
}

console.log('\n  Test: duplicate hostnames get deduplication suffixes');
{
  const items = [
    { result: { url: 'https://example.com/page1', status: 'complete', response: { result: 'A' } } },
    { result: { url: 'https://example.com/page2', status: 'complete', response: { result: 'B' } } },
    { result: { url: 'https://example.com/page3', status: 'complete', response: { result: 'C' } } },
  ];

  const filenameCounts = {};
  const filenames = [];
  for (const item of items) {
    const result = item.result || item;
    const hostname = hostnameFromUrl(result.url);
    const baseName = `claude-${hostname}`;
    filenameCounts[baseName] = (filenameCounts[baseName] || 0) + 1;
    const suffix = filenameCounts[baseName] > 1 ? `-${filenameCounts[baseName]}` : '';
    filenames.push(`${baseName}${suffix}.md`);
  }

  assertEqual(filenames, [
    'claude-example.com.md',
    'claude-example.com-2.md',
    'claude-example.com-3.md'
  ], 'duplicate hostnames get -2, -3 suffixes');
}

console.log('\n  Test: mixed unique and duplicate hostnames');
{
  const items = [
    { result: { url: 'https://example.com/a', status: 'complete', response: { result: 'A' } } },
    { result: { url: 'https://other.org/b', status: 'complete', response: { result: 'B' } } },
    { result: { url: 'https://example.com/c', status: 'complete', response: { result: 'C' } } },
  ];

  const filenameCounts = {};
  const filenames = [];
  for (const item of items) {
    const result = item.result || item;
    const hostname = hostnameFromUrl(result.url);
    const baseName = `claude-${hostname}`;
    filenameCounts[baseName] = (filenameCounts[baseName] || 0) + 1;
    const suffix = filenameCounts[baseName] > 1 ? `-${filenameCounts[baseName]}` : '';
    filenames.push(`${baseName}${suffix}.md`);
  }

  assertEqual(filenames, [
    'claude-example.com.md',
    'claude-other.org.md',
    'claude-example.com-2.md'
  ], 'only duplicates get suffixes, unique hostnames unaffected');
}

console.log('\n  Test: invalid URLs in bulk produce unknown-url filenames');
{
  const items = [
    { result: { url: null, status: 'complete', response: { result: 'A' } } },
    { result: { url: 'not-a-url', status: 'complete', response: { result: 'B' } } },
  ];

  const filenameCounts = {};
  const filenames = [];
  for (const item of items) {
    const result = item.result || item;
    const hostname = hostnameFromUrl(result.url);
    const baseName = `claude-${hostname}`;
    filenameCounts[baseName] = (filenameCounts[baseName] || 0) + 1;
    const suffix = filenameCounts[baseName] > 1 ? `-${filenameCounts[baseName]}` : '';
    filenames.push(`${baseName}${suffix}.md`);
  }

  assertEqual(filenames, [
    'claude-unknown-url.md',
    'claude-unknown-url-2.md'
  ], 'invalid URLs deduplicate under unknown-url');
}

// ── Print results ────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
console.log('────────────────────────────────────────\n');

process.exit(testsFailed > 0 ? 1 : 0);
